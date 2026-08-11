import { ensureActivePhase } from "./state.js";
import type { PlanStepRecord, PlanStepStatus, WorkflowState } from "./types.js";

type UpdatePlanArgs = {
    explanation?: string;
    plan: PlanStepRecord[];
};

function parsePlan(argumentsText: string): UpdatePlanArgs | undefined {
    let value: unknown;
    try {
        value = JSON.parse(argumentsText);
    } catch {
        return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.plan)) return undefined;
    const plan: PlanStepRecord[] = [];
    for (const item of record.plan) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
        const step = (item as Record<string, unknown>).step;
        const status = (item as Record<string, unknown>).status;
        if (typeof step !== "string" || !isStatus(status)) return undefined;
        plan.push({ step, status });
    }
    return {
        ...(typeof record.explanation === "string" ? { explanation: record.explanation } : {}),
        plan,
    };
}

function isStatus(value: unknown): value is PlanStepStatus {
    return value === "pending" || value === "in_progress" || value === "completed";
}

function closeActivePhase(state: WorkflowState): void {
    if (!state.activePhaseId) return;
    const phase = state.phases[state.activePhaseId];
    if (!phase || phase.status !== "ACTIVE") return;
    phase.status = "CHECKPOINT_PENDING";
    phase.completedAt = Date.now();
    if (!state.checkpointQueue.includes(phase.phaseId)) state.checkpointQueue.push(phase.phaseId);
    state.activePhaseId = undefined;
}

export function applyPlanUpdate(state: WorkflowState, callId: string, argumentsText: string): boolean {
    if (state.seenPlanCallIds.includes(callId)) return false;
    const next = parsePlan(argumentsText);
    if (!next) return false;
    state.seenPlanCallIds.push(callId);
    const previous = state.activePlan;
    const previousActive = previous?.items.find((item) => item.status === "in_progress");
    const currentActive = next.plan.find((item) => item.status === "in_progress");
    const previousNow = previousActive
        ? next.plan.find((item) => item.step === previousActive.step)
        : undefined;
    const crossedBoundary = Boolean(previousActive && previousNow?.status === "completed");
    if (crossedBoundary) closeActivePhase(state);
    if (!state.activePhaseId && currentActive) ensureActivePhase(state, currentActive.step);
    if (state.activePhaseId && currentActive) {
        const phase = state.phases[state.activePhaseId];
        if (phase?.status === "ACTIVE") phase.objective = currentActive.step;
    }
    if (!currentActive && next.plan.length > 0 && next.plan.every((item) => item.status === "completed")) {
        if (previousActive && !crossedBoundary) closeActivePhase(state);
        state.sessionStatus = "COMPLETE_CANDIDATE";
    } else {
        state.sessionStatus = "ACTIVE";
    }
    state.activePlan = {
        ...(next.explanation ? { explanation: next.explanation } : {}),
        items: next.plan,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: Date.now(),
    };
    return true;
}
