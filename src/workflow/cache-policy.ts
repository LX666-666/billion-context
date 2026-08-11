import type {
    CachePolicyDecision,
    CacheUsageSample,
    WorkflowOptions,
    WorkflowState,
} from "./types.js";

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

function finiteTokens(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function recordWorkflowUsage(
    state: WorkflowState | undefined,
    totalInputTokens: number,
    cachedInputTokens?: number,
): void {
    if (!state) return;
    const total = finiteTokens(totalInputTokens);
    const cached = typeof cachedInputTokens === "number"
        ? Math.min(total, finiteTokens(cachedInputTokens))
        : undefined;
    const previous = state.cacheTelemetry.lastContextTokens;
    const growth = previous > 0 ? total - previous : 0;
    const growthRate = previous > 0 ? growth / previous : 0;
    const sample: CacheUsageSample = {
        totalInputTokens: total,
        freshInputTokens: Math.max(0, total - (cached ?? 0)),
        ...(cached !== undefined ? {
            cachedInputTokens: cached,
            cacheHitRatio: total > 0 ? cached / total : 0,
        } : {}),
        recordedAt: Date.now(),
    };
    state.cacheTelemetry.previousContextTokens = previous;
    state.cacheTelemetry.lastContextTokens = total;
    state.cacheTelemetry.contextGrowthTokens = growth;
    state.cacheTelemetry.contextGrowthRate = growthRate;
    state.cacheTelemetry.sampleCount++;
    state.cacheTelemetry.recentUsage.push(sample);
    if (state.cacheTelemetry.recentUsage.length > 12) state.cacheTelemetry.recentUsage.splice(0, state.cacheTelemetry.recentUsage.length - 12);
    if (cached !== undefined) {
        state.cacheTelemetry.lastCachedTokens = cached;
        state.cacheTelemetry.lastCacheHitRatio = sample.cacheHitRatio;
    } else {
        state.cacheTelemetry.lastCachedTokens = undefined;
        state.cacheTelemetry.lastCacheHitRatio = undefined;
    }
}

function debuggingActive(state: WorkflowState, window: number): boolean {
    const phase = state.activePhaseId ? state.phases[state.activePhaseId] : undefined;
    if (!phase) return false;
    const operations = phase.operationIds
        .map((opId) => state.operations[opId])
        .filter((operation) => Boolean(operation))
        .slice(-window);
    const validations = operations.filter((operation) => operation.type === "TEST" || operation.type === "BUILD" || operation.type === "RUN");
    const latestValidation = validations.at(-1);
    if (latestValidation?.outcome === "FAIL") return true;
    const failed = validations.some((operation) => operation.outcome === "FAIL");
    const mutations = operations.filter((operation) => operation.type === "PATCH" || operation.type === "WRITE").length;
    return failed && mutations >= 2;
}

function expectedNextWorkTokens(state: WorkflowState, options: WorkflowOptions, debugging: boolean): number {
    if (state.sessionStatus === "COMPLETE_CANDIDATE") return 0;
    const planItems = state.activePlan?.items ?? [];
    let steps = planItems.filter((item) => item.status === "pending" || item.status === "in_progress").length;
    if (steps === 0 && state.activePhaseId) steps = 1;
    if (debugging) steps++;
    const phase = state.activePhaseId ? state.phases[state.activePhaseId] : undefined;
    const visible = phase?.operationIds
        .map((opId) => state.operations[opId]?.visibleTokens ?? 0)
        .filter((tokens) => tokens > 0) ?? [];
    const averageVisible = visible.length > 0 ? visible.reduce((sum, tokens) => sum + tokens, 0) / visible.length : 0;
    const perStep = Math.max(options.cachePolicy.expectedTokensPerStep, Math.min(32_000, Math.round(averageVisible * 2)));
    return Math.min(options.cachePolicy.maxExpectedNextWorkTokens, steps * perStep);
}

function decisionReasons(values: {
    contextRatio: number;
    targetRatio: number;
    pendingDropTokens: number;
    phaseCount: number;
    growthRate: number;
    highGrowthRate: number;
    toolGrowth: number;
    cacheHitRatio?: number;
    protectCacheHitRatio: number;
    debugging: boolean;
    projectedContextTokens: number;
    contextTokens: number;
}): string[] {
    const reasons: string[] = [];
    if (values.phaseCount > 0) reasons.push(`${values.phaseCount} phase boundary${values.phaseCount === 1 ? "" : "ies"}`);
    if (values.pendingDropTokens > 0) reasons.push(`${values.pendingDropTokens} pending-drop tokens`);
    if (values.contextRatio >= values.targetRatio) reasons.push(`context ratio ${values.contextRatio.toFixed(3)} exceeds target ${values.targetRatio.toFixed(3)}`);
    if (values.growthRate >= values.highGrowthRate) reasons.push(`context growth rate ${(values.growthRate * 100).toFixed(1)}% is high`);
    if (values.toolGrowth > 0) reasons.push(`${values.toolGrowth} new visible tool tokens`);
    if (values.cacheHitRatio !== undefined && values.cacheHitRatio >= values.protectCacheHitRatio) reasons.push(`cache hit ratio ${(values.cacheHitRatio * 100).toFixed(1)}% raises rewrite cost`);
    if (values.debugging) reasons.push("active debugging loop favors retaining recent evidence");
    if (values.projectedContextTokens > values.contextTokens) reasons.push(`expected next work projects ${values.projectedContextTokens} context tokens`);
    return reasons;
}

export function evaluateCachePolicy(
    state: WorkflowState,
    options: WorkflowOptions,
    contextTokens: number,
    modelContextLimit: number,
): CachePolicyDecision {
    const telemetry = state.cacheTelemetry;
    const context = finiteTokens(contextTokens || telemetry.lastContextTokens);
    const limit = finiteTokens(modelContextLimit);
    const pendingPhases = Object.values(state.phases).filter((phase) => phase.status === "PENDING_ROLLOVER");
    const phaseBoundary = pendingPhases.length > 0;
    const pendingDropTokens = state.metrics.pendingDropTokens;
    const contextRatio = limit > 0 ? context / limit : 0;
    const debugging = debuggingActive(state, options.cachePolicy.debuggingWindowOperations);
    const expected = expectedNextWorkTokens(state, options, debugging);
    const projected = context + expected;
    const projectedRatio = limit > 0 ? projected / limit : 0;
    const growthRate = telemetry.contextGrowthRate;
    const toolGrowth = Math.max(0, state.metrics.visibleToolTokens - telemetry.lastVisibleToolTokens);
    telemetry.lastVisibleToolTokens = state.metrics.visibleToolTokens;
    const cached = telemetry.lastCachedTokens;
    const cacheHitRatio = telemetry.lastCacheHitRatio;
    const activeAfterDrop = Math.max(0, context - pendingDropTokens);
    const rewriteCost = Math.min(context, Math.max(activeAfterDrop, cached ?? 0));
    const target = options.targetContextRatio;
    const contextPressure = Math.max(0, contextRatio - target) / Math.max(target, 0.01) * 1.4;
    const projectedPressure = Math.max(0, projectedRatio - target) / Math.max(target, 0.01) * 0.8;
    const garbagePressure = Math.min(2, pendingDropTokens / Math.max(1, options.rolloverMinTokens)) * 0.9;
    const boundaryPressure = phaseBoundary ? 0.55 : 0;
    const growthPressure = Math.min(1.5, Math.max(0, growthRate) / options.cachePolicy.highGrowthRate) * 0.5;
    const toolPressure = Math.min(1.5, toolGrowth / Math.max(1, options.rolloverMinTokens)) * 0.3;
    const cacheProtection = cacheHitRatio !== undefined && cacheHitRatio >= options.cachePolicy.protectCacheHitRatio
        ? cacheHitRatio * (rewriteCost / Math.max(1, context)) * options.cachePolicy.rewriteCostWeight
        : 0;
    const debuggingProtection = debugging ? 1 : 0;
    const score = contextPressure
        + projectedPressure
        + garbagePressure
        + boundaryPressure
        + growthPressure
        + toolPressure
        - cacheProtection
        - debuggingProtection;
    const reasons = decisionReasons({
        contextRatio,
        targetRatio: target,
        pendingDropTokens,
        phaseCount: pendingPhases.length,
        growthRate,
        highGrowthRate: options.cachePolicy.highGrowthRate,
        toolGrowth,
        cacheHitRatio,
        protectCacheHitRatio: options.cachePolicy.protectCacheHitRatio,
        debugging,
        projectedContextTokens: projected,
        contextTokens: context,
    });
    let action: CachePolicyDecision["action"] = "DEFER";
    if (!options.phaseGc || !phaseBoundary) action = "IDLE";
    else if (state.sessionStatus === "COMPLETE_CANDIDATE") {
        action = "ROLLOVER";
        reasons.push("session is complete candidate");
    } else if (pendingPhases.length > 1) {
        action = "ROLLOVER";
        reasons.push("multiple completed phases are waiting");
    } else if (contextRatio >= Math.min(0.9, target * 1.75)) {
        action = "ROLLOVER";
        reasons.push("context pressure reached the hard rollover band");
    } else if (score >= 1.15) {
        action = "ROLLOVER";
        reasons.push(`GC desire score ${score.toFixed(2)} reached threshold`);
    } else if (phaseBoundary) {
        reasons.push(`GC desire score ${score.toFixed(2)} preserves the cached working set`);
    }
    const decision: CachePolicyDecision = {
        action,
        score: Number(score.toFixed(4)),
        reasons,
        contextTokens: context,
        modelContextLimit: limit,
        contextRatio,
        targetContextRatio: target,
        ...(cached !== undefined ? { cachedTokens: cached } : {}),
        ...(cacheHitRatio !== undefined ? { cacheHitRatio: clamp(cacheHitRatio, 0, 1) } : {}),
        pendingDropTokens,
        pendingPhaseCount: pendingPhases.length,
        phaseBoundary,
        contextGrowthTokens: telemetry.contextGrowthTokens,
        contextGrowthRate: growthRate,
        toolOutputGrowthTokens: toolGrowth,
        debuggingActive: debugging,
        rewriteCostTokens: rewriteCost,
        expectedNextWorkTokens: expected,
        projectedContextTokens: projected,
        evaluatedAt: Date.now(),
    };
    telemetry.lastDecision = decision;
    state.metrics.rolloverEvaluations++;
    if (action === "DEFER") state.metrics.rolloverDeferrals++;
    return decision;
}
