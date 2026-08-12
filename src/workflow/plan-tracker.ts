import { ensureActivePhase } from "./state.js";
import { markPhaseRepositoryStateStale } from "./repo-bridge.js";
import { markActiveTaskCompleteCandidate } from "./project-memory.js";
import type { PlanStepRecord, PlanStepStatus, WorkflowState } from "./types.js";

type UpdatePlanArgs = {
    explanation?: string;
    plan: PlanStepRecord[];
};

function isStatus(value: unknown): value is PlanStepStatus {
    return value === "pending" || value === "in_progress" || value === "completed";
}

function parsePlan(argumentsText: string): UpdatePlanArgs | undefined {
    let value: unknown;
    try {
        value = JSON.parse(argumentsText);
    } catch {
        return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const rawPlan = record.plan;
    if (!Array.isArray(rawPlan)) return undefined;
    const plan: PlanStepRecord[] = [];
    for (const item of rawPlan) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
        const itemRecord = item as Record<string, unknown>;
        const step = itemRecord.step;
        const status = itemRecord.status;
        if (typeof step !== "string" || !step.trim() || !isStatus(status)) return undefined;
        plan.push({ step: step.trim(), status });
    }
    return {
        ...(typeof record.explanation === "string" ? { explanation: record.explanation } : {}),
        plan,
    };
}

function normalized(step: string): string {
    return step.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function similarity(left: string, right: string): number {
    const a = new Set(normalized(left).split(/\s+/).filter(Boolean));
    const b = new Set(normalized(right).split(/\s+/).filter(Boolean));
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const token of a) if (b.has(token)) intersection++;
    return intersection / (a.size + b.size - intersection);
}

function assignStableIds(state: WorkflowState, previous: PlanStepRecord[] | undefined, next: PlanStepRecord[]): PlanStepRecord[] {
    const previousItems = previous ?? [];
    const previousWithIds = previousItems.map((item) => ({
        item,
        index: previousItems.indexOf(item),
        planItemId: item.planItemId ?? `planItem${String(state.nextPlanItemNumber++).padStart(5, "0")}`,
    }));
    const score = (candidate: typeof previousWithIds[number], item: PlanStepRecord, index: number): number => {
        const exact = normalized(candidate.item.step) === normalized(item.step);
        const lexical = similarity(candidate.item.step, item.step);
        let status = -30;
        if (candidate.item.status === item.status) status = 35;
        else if (candidate.item.status === "in_progress" && item.status === "completed") status = 60;
        else if (candidate.item.status === "pending" && item.status === "in_progress") status = 60;
        else if (candidate.item.status === "completed" && item.status === "completed") status = 45;
        return (exact ? 1_000 : lexical * 100) + status + Math.max(0, 12 - Math.abs(candidate.index - index));
    };
    const pairs = next.flatMap((item, nextIndex) => previousWithIds.map((candidate) => ({
        nextIndex,
        candidate,
        score: score(candidate, item, nextIndex),
    })))
        .sort((left, right) => right.score - left.score);
    const matchedNext = new Set<number>();
    const matchedPrevious = new Set<string>();
    const ids = new Map<number, string>();
    for (const pair of pairs) {
        if (matchedNext.has(pair.nextIndex) || matchedPrevious.has(pair.candidate.planItemId)) continue;
        const exact = normalized(pair.candidate.item.step) === normalized(next[pair.nextIndex]?.step ?? "");
        const lexical = similarity(pair.candidate.item.step, next[pair.nextIndex]?.step ?? "");
        const statusTransition = (pair.candidate.item.status === "in_progress" && next[pair.nextIndex]?.status === "completed")
            || (pair.candidate.item.status === "pending" && next[pair.nextIndex]?.status === "in_progress");
        if (!exact && lexical < 0.2 && !(statusTransition && pair.candidate.index === pair.nextIndex)) continue;
        matchedNext.add(pair.nextIndex);
        matchedPrevious.add(pair.candidate.planItemId);
        ids.set(pair.nextIndex, pair.candidate.planItemId);
    }
    return next.map((item, index) => ({
        ...item,
        planItemId: ids.get(index) ?? `planItem${String(state.nextPlanItemNumber++).padStart(5, "0")}`,
    }));
}

function closeActivePhase(state: WorkflowState): void {
    if (!state.activePhaseId) return;
    const phase = state.phases[state.activePhaseId];
    if (!phase || phase.status !== "ACTIVE") return;
    phase.status = "CHECKPOINT_PENDING";
    phase.completedAt = Date.now();
    markPhaseRepositoryStateStale(state, phase.phaseId);
    if (!state.checkpointQueue.includes(phase.phaseId)) state.checkpointQueue.push(phase.phaseId);
    state.activePhaseId = undefined;
}

export function applyPlanUpdate(state: WorkflowState, callId: string, argumentsText: string): boolean {
    if (state.seenPlanCallIds.includes(callId)) return false;
    const next = parsePlan(argumentsText);
    if (!next) return false;
    state.seenPlanCallIds.push(callId);
    const previous = state.activePlan;
    const nextItems = assignStableIds(state, previous?.items, next.plan);
    const previousItems = previous?.items ?? [];
    const previousActive = previousItems.filter((item) => item.status === "in_progress");
    const nextById = new Map(nextItems.map((item) => [item.planItemId, item]));
    const currentActive = nextItems.find((item) => item.status === "in_progress");
    const oldActiveProgressed = previousActive.some((item) => {
        const mapped = item.planItemId ? nextById.get(item.planItemId) : undefined;
        return !mapped || mapped.status !== "in_progress";
    });
    const crossedBoundary = previousActive.length > 0 && oldActiveProgressed && Boolean(currentActive);
    if (crossedBoundary) closeActivePhase(state);
    if (!state.activePhaseId && currentActive) ensureActivePhase(state, currentActive.step).planItemId = currentActive.planItemId;
    if (state.activePhaseId && currentActive) {
        const phase = state.phases[state.activePhaseId];
        if (phase?.status === "ACTIVE") {
            phase.objective = currentActive.step;
            phase.planItemId = currentActive.planItemId;
        }
    }
    const allCompleted = nextItems.length > 0 && nextItems.every((item) => item.status === "completed");
    if (!currentActive && allCompleted) {
        if (previousActive.length > 0 && !crossedBoundary) closeActivePhase(state);
        state.sessionStatus = "COMPLETE_CANDIDATE";
        markActiveTaskCompleteCandidate(state);
    } else {
        state.sessionStatus = "ACTIVE";
    }
    state.activePlan = {
        ...(next.explanation ? { explanation: next.explanation } : {}),
        items: nextItems,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: Date.now(),
    };
    return true;
}

export function planWireShape(argumentsText: string): boolean {
    return Boolean(parsePlan(argumentsText));
}
