import { estimateTokensFast } from "acp-kernel";
import { evaluateCachePolicy } from "./cache-policy.js";
import { recomputeWorkflowMetrics } from "./state.js";
import type { OperationRecord, WorkflowCheckpoint, WorkflowOptions, WorkflowState } from "./types.js";

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decisions(value: unknown): WorkflowCheckpoint["decisions"] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const decision = text(record.decision);
        const reason = text(record.reason);
        if (!decision || !reason) return [];
        return [{ decision, reason, refs: strings(record.refs) }];
    });
}

function requirementUpdates(value: unknown): WorkflowCheckpoint["requirementUpdates"] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const id = text(record.id);
        const status = record.status;
        if (!id || (status !== "ACTIVE" && status !== "SATISFIED" && status !== "SUPERSEDED" && status !== "CANCELLED")) return [];
        return [{ id, status, ...(text(record.supersededBy) ? { supersededBy: text(record.supersededBy) } : {}) }];
    });
}

function operationIsKept(operation: OperationRecord, keepRefs: Set<string>): boolean {
    if (operation.importance === "CRITICAL") return true;
    if (keepRefs.has(operation.opId)) return true;
    return [...operation.callRefs, ...operation.resultRefs].some((ref) => keepRefs.has(ref));
}

function archivePendingPhase(state: WorkflowState, phaseId: string): void {
    const phase = state.phases[phaseId];
    if (!phase || phase.status !== "PENDING_ROLLOVER") return;
    for (const opId of phase.operationIds) {
        const operation = state.operations[opId];
        if (operation?.lifecycle === "PENDING_DROP") operation.lifecycle = "ARCHIVED";
    }
    phase.status = "ARCHIVED";
    state.metrics.rollovers++;
}

export function applyDeferredRollover(
    state: WorkflowState,
    options: WorkflowOptions,
    contextTokens: number,
    modelContextLimit: number,
): boolean {
    recomputeWorkflowMetrics(state);
    const decision = evaluateCachePolicy(state, options, contextTokens, modelContextLimit);
    if (decision.action !== "ROLLOVER") return false;
    const pending = Object.values(state.phases).filter((phase) => phase.status === "PENDING_ROLLOVER");
    for (const phase of pending) archivePendingPhase(state, phase.phaseId);
    recomputeWorkflowMetrics(state);
    return pending.length > 0;
}

export function recordWorkflowCheckpoint(
    state: WorkflowState,
    args: Record<string, unknown>,
    options: WorkflowOptions,
    contextTokens: number,
    modelContextLimit: number,
): string {
    const requestedPhase = text(args.phaseId);
    const phaseId = requestedPhase && state.checkpointQueue.includes(requestedPhase)
        ? requestedPhase
        : state.checkpointQueue[0];
    if (!phaseId) return "[workflow_checkpoint FAILED: no phase is awaiting a checkpoint]";
    const phase = state.phases[phaseId];
    if (!phase || phase.status !== "CHECKPOINT_PENDING") {
        return `[workflow_checkpoint FAILED: phase ${phaseId} is not awaiting a checkpoint]`;
    }
    const completedWork = text(args.completedWork);
    const currentState = text(args.currentState);
    if (!completedWork || !currentState) {
        return "[workflow_checkpoint FAILED: completedWork and currentState are required]";
    }
    const checkpointId = `checkpoint${String(state.nextCheckpointNumber++).padStart(5, "0")}`;
    const updates = requirementUpdates(args.requirementUpdates);
    const checkpoint: WorkflowCheckpoint = {
        checkpointId,
        phaseId,
        objective: text(args.objective) ?? phase.objective,
        ...(text(args.requirementState) ? { requirementState: text(args.requirementState) } : {}),
        requirementUpdates: updates,
        completedWork,
        changedFiles: strings(args.changedFiles),
        currentState,
        decisions: decisions(args.decisions),
        rejectedApproaches: strings(args.rejectedApproaches),
        failedAttempts: strings(args.failedAttempts),
        validation: strings(args.validation),
        blockers: strings(args.blockers),
        unresolvedIssues: strings(args.unresolvedIssues),
        ...(text(args.nextAction) ? { nextAction: text(args.nextAction) } : {}),
        criticalRefs: strings(args.criticalRefs),
        keepRefs: strings(args.keepRefs),
        createdAt: Date.now(),
    };
    state.checkpoints[checkpointId] = checkpoint;
    for (const update of updates) {
        const requirement = state.requirements[update.id];
        if (!requirement) continue;
        requirement.status = update.status;
        if (update.supersededBy) requirement.supersededBy = update.supersededBy;
    }
    state.checkpointQueue = state.checkpointQueue.filter((queued) => queued !== phaseId);
    phase.checkpointId = checkpointId;
    phase.status = "PENDING_ROLLOVER";
    const keepRefs = new Set([...checkpoint.criticalRefs, ...checkpoint.keepRefs]);
    for (const opId of phase.operationIds) {
        const operation = state.operations[opId];
        if (operation && !operationIsKept(operation, keepRefs)) operation.lifecycle = "PENDING_DROP";
    }
    state.metrics.checkpointTokens += estimateTokensFast(JSON.stringify(checkpoint));
    recomputeWorkflowMetrics(state);
    applyDeferredRollover(state, options, contextTokens, modelContextLimit);
    return `[workflow_checkpoint OK: ${checkpointId} recorded for ${phaseId}]`;
}

export function checkpointRequest(state: WorkflowState, textProtocol: boolean): string | undefined {
    const phaseId = state.checkpointQueue[0];
    if (!phaseId) return undefined;
    const phase = state.phases[phaseId];
    if (!phase) return undefined;
    const operationSummary = phase.operationIds.map((opId) => {
        const operation = state.operations[opId];
        return operation ? `${operation.opId}:${operation.type}` : opId;
    });
    const action = textProtocol
        ? `Emit exactly <workflow_checkpoint>{"phaseId":"${phaseId}","objective":"...","requirementUpdates":[],"completedWork":"...","changedFiles":[],"currentState":"...","decisions":[],"rejectedApproaches":[],"failedAttempts":[],"validation":[],"blockers":[],"unresolvedIssues":[],"criticalRefs":[],"keepRefs":[]}</workflow_checkpoint> with no surrounding prose.`
        : `Call workflow_checkpoint with phaseId "${phaseId}" and the structured result.`;
    return `<workflow-checkpoint-request>\nPhase ${phaseId} has completed.\nObjective: ${phase.objective}\nOperations: ${operationSummary.join(", ")}\nBefore continuing, checkpoint final results, decisions and validation. Do not copy old source code or full logs. Repository state remains authoritative.\n${action}\n</workflow-checkpoint-request>`;
}

export function workflowMemory(state: WorkflowState, rereadAfterPhase: boolean): string | undefined {
    if (state.metrics.rollovers === 0 && !state.projectHistory?.sessions.length) return undefined;
    const requirements = Object.values(state.requirements)
        .filter((requirement) => requirement.status === "ACTIVE")
        .map((requirement) => `${requirement.id} [${requirement.importance}] ${requirement.detail}${requirement.rawRef ? ` [raw_ref: ${requirement.rawRef}]` : ""}`);
    const checkpoints = Object.values(state.checkpoints)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-4)
        .map((checkpoint) => JSON.stringify(checkpoint));
    const history = state.projectHistory?.sessions.map((session) => JSON.stringify({
        updatedAt: session.updatedAt,
        requirements: session.requirements,
        checkpoint: session.checkpoint,
    })) ?? [];
    return `<workflow-memory>\nActive requirements:\n${requirements.join("\n")}\n\nRecent phase checkpoints:\n${checkpoints.join("\n")}\n\nPrior project sessions:\n${history.join("\n")}\n${rereadAfterPhase ? "\nFor code needed in the current phase, re-read the repository; old patch chains are not authoritative." : ""}\n</workflow-memory>`;
}
