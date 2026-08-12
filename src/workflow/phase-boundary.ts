import type { BiliMessage } from "../bili-message.js";
import { ensureActivePhase } from "./state.js";
import { markPhaseRepositoryStateStale } from "./repo-bridge.js";
import type { OperationRecord, WorkflowState } from "./types.js";

const EXPLICIT_SWITCH = /(?:now|next|switch|move on|another|different)\b|(?:已经|已完成|完成了|现在|接下来).*(?:改|处理|开始|另一个|下一个)|(?:this|that)\s+(?:is\s+)?(?:done|complete|finished)/i;

function closeCandidate(state: WorkflowState): void {
    const phaseId = state.activePhaseId;
    if (!phaseId) return;
    const phase = state.phases[phaseId];
    if (!phase || phase.status !== "ACTIVE") return;
    phase.status = "CHECKPOINT_PENDING";
    phase.completedAt = Date.now();
    markPhaseRepositoryStateStale(state, phaseId);
    if (!state.checkpointQueue.includes(phaseId)) state.checkpointQueue.push(phaseId);
    state.activePhaseId = undefined;
    state.phaseBoundaryCandidate = undefined;
}

function phaseHasSuccessfulValidation(state: WorkflowState, phaseId: string): boolean {
    return state.phases[phaseId]?.operationIds.some((opId) => {
        const operation = state.operations[opId];
        return Boolean(operation && (operation.type === "TEST" || operation.type === "BUILD" || operation.type === "RUN") && operation.outcome === "PASS");
    }) ?? false;
}

function targetChanged(state: WorkflowState, phaseId: string, operation: OperationRecord): boolean {
    if (operation.type !== "PATCH" && operation.type !== "WRITE" && operation.type !== "READ") return false;
    const oldTargets = new Set(
        (state.phases[phaseId]?.operationIds ?? [])
            .map((opId) => state.operations[opId])
            .flatMap((candidate) => candidate?.paths ?? [])
            .map((value) => value.replace(/\\/g, "/").toLowerCase()),
    );
    return operation.paths.length > 0 && operation.paths.some((value) => !oldTargets.has(value.replace(/\\/g, "/").toLowerCase()));
}

export function observePhaseBoundaryFallback(state: WorkflowState, messages: BiliMessage[]): void {
    if (state.activePlan?.items.some((item) => item.status === "in_progress") || !state.activePhaseId) return;
    const explicit = messages.slice(-8).some((message) =>
        (message.role === "user" || message.role === "assistant") && EXPLICIT_SWITCH.test(message.text ?? ""),
    );
    if (!explicit) return;
    state.phaseBoundaryCandidate = {
        phaseId: state.activePhaseId,
        reason: "explicit objective switch without update_plan",
        createdAt: Date.now(),
    };
}

export function beforeFallbackOperation(state: WorkflowState, operation: OperationRecord): void {
    const activePhaseId = state.activePhaseId;
    const candidate = state.phaseBoundaryCandidate;
    if (!activePhaseId) return;
    if (!candidate && phaseHasSuccessfulValidation(state, activePhaseId) && targetChanged(state, activePhaseId, operation)) {
        state.phaseBoundaryCandidate = {
            phaseId: activePhaseId,
            reason: "new target after successful validation without update_plan",
            createdAt: Date.now(),
        };
        return;
    }
    if (!candidate || candidate.phaseId !== activePhaseId) return;
    if (!phaseHasSuccessfulValidation(state, activePhaseId) && !candidate.reason.includes("explicit")) return;
    if (targetChanged(state, activePhaseId, operation) || candidate.reason.includes("explicit")) closeCandidate(state);
}

export function phaseBoundaryCandidate(state: WorkflowState): boolean {
    return Boolean(state.phaseBoundaryCandidate);
}

export function closeFallbackPhaseForTest(state: WorkflowState): void {
    closeCandidate(state);
}

export function ensureFallbackPhase(state: WorkflowState, objective: string): string {
    return ensureActivePhase(state, objective).phaseId;
}
