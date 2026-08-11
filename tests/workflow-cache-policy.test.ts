import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCachePolicy, recordWorkflowUsage } from "../src/workflow/cache-policy.ts";
import { applyDeferredRollover } from "../src/workflow/context-gc.ts";
import { trackOperationCall, updateOperationResult } from "../src/workflow/operation-tracker.ts";
import { ensureActivePhase, createInitialWorkflowState, recomputeWorkflowMetrics } from "../src/workflow/state.ts";
import { DEFAULT_WORKFLOW_OPTIONS, type WorkflowOptions, type WorkflowState } from "../src/workflow/types.ts";

function options(overrides: Partial<WorkflowOptions> = {}): WorkflowOptions {
    return {
        ...DEFAULT_WORKFLOW_OPTIONS,
        ...overrides,
        cheapModel: { ...DEFAULT_WORKFLOW_OPTIONS.cheapModel, ...overrides.cheapModel },
        repoBridge: { ...DEFAULT_WORKFLOW_OPTIONS.repoBridge, ...overrides.repoBridge },
        cachePolicy: { ...DEFAULT_WORKFLOW_OPTIONS.cachePolicy, ...overrides.cachePolicy },
    };
}

function pendingPhase(state: WorkflowState, visibleTokens: number): void {
    const operation = trackOperationCall(state, `work-${Object.keys(state.operations).length}`, "shell_command", JSON.stringify({ command: "npm test" }));
    updateOperationResult(state, operation, visibleTokens * 2, visibleTokens, "[TEST PASS]\nexit_code: 0");
    operation.lifecycle = "PENDING_DROP";
    const phase = state.phases[operation.phaseId];
    phase.status = "PENDING_ROLLOVER";
    state.activePhaseId = undefined;
    recomputeWorkflowMetrics(state);
}

function activeDebugLoop(state: WorkflowState): void {
    const phase = ensureActivePhase(state, "Debug failing integration test");
    const patch = trackOperationCall(state, "debug-patch", "apply_patch", JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch" }));
    updateOperationResult(state, patch, 500, 500, "Done");
    const testOperation = trackOperationCall(state, "debug-test", "shell_command", JSON.stringify({ command: "npm test" }));
    updateOperationResult(state, testOperation, 2_000, 1_000, "[TEST FAILED]\nexit_code: 1\nAssertionError");
    assert.equal(testOperation.phaseId, phase.phaseId);
}

test("cache telemetry normalizes hit ratio and context growth from per-round samples", () => {
    const state = createInitialWorkflowState();
    recordWorkflowUsage(state, 100_000, 80_000);
    recordWorkflowUsage(state, 125_000, 90_000);
    assert.equal(state.cacheTelemetry.sampleCount, 2);
    assert.equal(state.cacheTelemetry.lastCacheHitRatio, 0.72);
    assert.equal(state.cacheTelemetry.contextGrowthTokens, 25_000);
    assert.equal(state.cacheTelemetry.contextGrowthRate, 0.25);
    assert.equal(state.cacheTelemetry.recentUsage[1]?.freshInputTokens, 35_000);
});

test("high cache rewrite cost and an active debugging loop defer a small phase rollover", () => {
    const state = createInitialWorkflowState();
    pendingPhase(state, 4_000);
    activeDebugLoop(state);
    state.activePlan = {
        items: [{ step: "debug", status: "in_progress" }],
        revision: 1,
        updatedAt: Date.now(),
    };
    recordWorkflowUsage(state, 48_000, 43_200);
    recordWorkflowUsage(state, 50_000, 45_000);
    const decision = evaluateCachePolicy(state, options({ targetContextRatio: 0.35 }), 50_000, 200_000);
    assert.equal(decision.action, "DEFER");
    assert.equal(decision.debuggingActive, true);
    assert.equal(decision.cacheHitRatio, 0.9);
    assert.ok(decision.rewriteCostTokens >= 45_000);
    assert.ok(decision.expectedNextWorkTokens >= 16_000);
    assert.match(decision.reasons.join("\n"), /cache hit ratio|debugging loop|preserves the cached working set/);
});

test("context pressure, pending garbage and high growth trigger rollover", () => {
    const state = createInitialWorkflowState();
    pendingPhase(state, 20_000);
    recordWorkflowUsage(state, 40_000, 2_000);
    recordWorkflowUsage(state, 90_000, 4_000);
    const applied = applyDeferredRollover(state, options({ targetContextRatio: 0.2 }), 90_000, 200_000);
    assert.equal(applied, true);
    assert.equal(Object.values(state.phases)[0]?.status, "ARCHIVED");
    assert.equal(state.cacheTelemetry.lastDecision?.action, "ROLLOVER");
    assert.ok((state.cacheTelemetry.lastDecision?.contextGrowthRate ?? 0) > 1);
    assert.equal(state.metrics.rollovers, 1);
});

test("expected next work can justify rollover before the current context crosses target", () => {
    const state = createInitialWorkflowState();
    pendingPhase(state, 5_000);
    ensureActivePhase(state, "Continue implementation");
    state.activePlan = {
        items: [
            { step: "one", status: "in_progress" },
            { step: "two", status: "pending" },
            { step: "three", status: "pending" },
            { step: "four", status: "pending" },
        ],
        revision: 1,
        updatedAt: Date.now(),
    };
    recordWorkflowUsage(state, 30_000, 2_000);
    const decision = evaluateCachePolicy(state, options({ targetContextRatio: 0.2 }), 30_000, 200_000);
    assert.equal(decision.contextRatio, 0.15);
    assert.equal(decision.expectedNextWorkTokens, 32_000);
    assert.equal(decision.projectedContextTokens, 62_000);
    assert.equal(decision.action, "ROLLOVER");
});

test("complete sessions and multiple pending phases are hard rollover boundaries", () => {
    const complete = createInitialWorkflowState();
    pendingPhase(complete, 1_000);
    complete.sessionStatus = "COMPLETE_CANDIDATE";
    assert.equal(evaluateCachePolicy(complete, options(), 5_000, 200_000).action, "ROLLOVER");

    const multiple = createInitialWorkflowState();
    pendingPhase(multiple, 1_000);
    ensureActivePhase(multiple, "second");
    pendingPhase(multiple, 1_000);
    assert.equal(evaluateCachePolicy(multiple, options(), 5_000, 200_000).action, "ROLLOVER");
});
