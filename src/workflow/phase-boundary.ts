import type { BiliMessage } from "../bili-message.js";
import { ensureActivePhase } from "./state.js";
import { markPhaseRepositoryStateStale } from "./repo-bridge.js";
import type { OperationRecord, WorkflowState } from "./types.js";
import { isWorkflowMessage } from "./workflow-item.js";

const EXPLICIT_SWITCH = /(?:\b(?:switch|move on to|move to|start(?: work)? on|begin(?: work)? on|focus on|work on)\s+(?:the\s+)?(?:next|another|new|different|phase|task|step|target)\b|\b(?:next|another|new|different)\s+(?:phase|task|step|target|feature)\b|\b(?:this|that)\s+(?:is\s+)?(?:done|complete|finished)\b\s*(?:,|;|and|so)?\s*(?:now|next|then|let'?s|we can|I will)?\s*(?:switch|move|start|work|focus)\b)|(?:这个好了|这部分好了|已经完成|已完成|完成了).{0,40}(?:现在|接下来|然后).{0,20}(?:改|处理|开始|切换|转到|另一个|下一个)/i;

export type FallbackOperationDecision =
    | "CONTINUE_CURRENT_PHASE"
    | "CLOSE_AND_START_NEW_PHASE"
    | "WAIT_FOR_PLAN_SYNC";

function closeCandidate(state: WorkflowState): void {
    const phaseId = state.activePhaseId;
    if (!phaseId) return;
    const phase = state.phases[phaseId];
    if (!phase || phase.status !== "ACTIVE") return;
    const candidate = state.phaseBoundaryCandidate;
    if (candidate && typeof candidate.sourceMessageRef === "string" && candidate.sourceMessageRef.startsWith("operation:")) {
        candidate.consumedAt = Date.now();
    }
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

function hasActivePlan(state: WorkflowState): boolean {
    return state.activePlan?.items.some((item) => item.status === "in_progress") ?? false;
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
    const latestUser = [...messages].reverse().find((message) =>
        message.role === "user" && message.contentType === "text" && !isWorkflowMessage(message),
    );
    if (!latestUser || !EXPLICIT_SWITCH.test(latestUser.text ?? "") || state.seenBoundarySignalRefs.includes(latestUser.id)) return;
    state.seenBoundarySignalRefs.push(latestUser.id);
    state.phaseBoundaryCandidate = {
        phaseId: state.activePhaseId,
        reason: "explicit objective switch without update_plan",
        createdAt: Date.now(),
        sourceMessageRef: latestUser.id,
        sourceRevision: state.activePlan?.revision ?? 0,
    };
}

export function beforeFallbackOperation(state: WorkflowState, operation: OperationRecord): FallbackOperationDecision {
    const activePhaseId = state.activePhaseId;
    const candidate = state.phaseBoundaryCandidate;
    if (!activePhaseId) return "CONTINUE_CURRENT_PHASE";
    if (!candidate && phaseHasSuccessfulValidation(state, activePhaseId) && targetChanged(state, activePhaseId, operation)) {
        if (hasActivePlan(state)) return "WAIT_FOR_PLAN_SYNC";
        state.phaseBoundaryCandidate = {
            phaseId: activePhaseId,
            reason: "new target after successful validation without update_plan",
            createdAt: Date.now(),
            sourceMessageRef: `operation:${operation.opId}`,
            sourceRevision: state.activePlan?.revision ?? 0,
        };
        closeCandidate(state);
        return "CLOSE_AND_START_NEW_PHASE";
    }
    if (!candidate || candidate.phaseId !== activePhaseId) return "CONTINUE_CURRENT_PHASE";
    if (!phaseHasSuccessfulValidation(state, activePhaseId) && !candidate.reason.includes("explicit")) {
        return "CONTINUE_CURRENT_PHASE";
    }
    if (targetChanged(state, activePhaseId, operation) || candidate.reason.includes("explicit")) {
        if (hasActivePlan(state)) return "WAIT_FOR_PLAN_SYNC";
        closeCandidate(state);
        return "CLOSE_AND_START_NEW_PHASE";
    }
    return "CONTINUE_CURRENT_PHASE";
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
