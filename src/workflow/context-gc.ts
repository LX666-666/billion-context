import { estimateTokensFast } from "acp-kernel";
import { archivePhase, verifyArchiveCommit } from "./archive.js";
import { evaluateCachePolicy } from "./cache-policy.js";
import { validateCheckpointAgainstPhase } from "./checkpoint-validator.js";
import { attachCheckpointToTask } from "./project-memory.js";
import { archiveHistoricalRequirements, refreshRequirementHistory } from "./requirements.js";
import { markPhaseMessagesPendingDrop, recomputeWorkflowMetrics } from "./state.js";
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
        if (!id || (
            status !== "ACTIVE"
            && status !== "ACTIVE_CURRENT"
            && status !== "ACTIVE_STABLE"
            && status !== "SATISFIED"
            && status !== "SUPERSEDED"
            && status !== "CANCELLED"
            && status !== "HISTORICAL"
        )) return [];
        return [{ id, status, ...(text(record.supersededBy) ? { supersededBy: text(record.supersededBy) } : {}) }];
    });
}

function operationIsKept(operation: OperationRecord, keepRefs: Set<string>): boolean {
    if (operation.lifecycle === "KEEP" || operation.lifecycle === "CRITICAL") return true;
    if (operation.importance === "CRITICAL") return true;
    if (keepRefs.has(operation.opId)) return true;
    return [...operation.callRefs, ...operation.resultRefs].some((ref) => keepRefs.has(ref));
}

function archivePendingPhase(state: WorkflowState, phaseId: string): boolean {
    const phase = state.phases[phaseId];
    if (!phase || phase.status !== "PENDING_ROLLOVER") return false;
    if (phase.archiveStatus !== "COMMITTED" || !phase.archiveChecksum) return false;
    const archiveSessionId = state.archiveSessionId ?? "workflow-state";
    if (!verifyArchiveCommit(archiveSessionId, phaseId, phase.archiveChecksum, state)) {
        phase.archiveStatus = "FAILED";
        phase.archiveError = "phase archive commit is missing or failed verification";
        return false;
    }
    for (const opId of phase.operationIds) {
        const operation = state.operations[opId];
        if (operation?.lifecycle === "PENDING_DROP") operation.lifecycle = "ARCHIVED";
    }
    for (const message of Object.values(state.phaseMessages)) {
        if (message.phaseId === phaseId && message.lifecycle === "PENDING_DROP") message.lifecycle = "ARCHIVED";
    }
    archiveHistoricalRequirements(state);
    phase.status = "ARCHIVED";
    state.metrics.rollovers++;
    return true;
}

export function applyDeferredRollover(
    state: WorkflowState,
    options: WorkflowOptions,
    contextTokens: number,
    modelContextLimit: number,
    model?: string,
): boolean {
    recomputeWorkflowMetrics(state);
    const decision = evaluateCachePolicy(state, options, contextTokens, modelContextLimit, model);
    if (decision.action !== "ROLLOVER") return false;
    const pending = Object.values(state.phases).filter((phase) => phase.status === "PENDING_ROLLOVER");
    const archiveSessionId = state.archiveSessionId ?? "workflow-state";
    if (pending.some((phase) =>
        phase.archiveStatus !== "COMMITTED"
        || !phase.archiveChecksum
        || !verifyArchiveCommit(archiveSessionId, phase.phaseId, phase.archiveChecksum, state),
    )) return false;
    let archived = false;
    for (const phase of pending) archived = archivePendingPhase(state, phase.phaseId) || archived;
    recomputeWorkflowMetrics(state);
    return archived;
}

export function recordWorkflowCheckpoint(
    state: WorkflowState,
    args: Record<string, unknown>,
    options: WorkflowOptions,
    contextTokens: number,
    modelContextLimit: number,
    sessionId?: string,
    model?: string,
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
    const checkpointId = `checkpoint${String(state.nextCheckpointNumber).padStart(5, "0")}`;
    const updates = requirementUpdates(args.requirementUpdates);
    const checkpoint: WorkflowCheckpoint = {
        checkpointId,
        phaseId,
        ...(phase.taskId ? { taskId: phase.taskId } : {}),
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
    const phaseOperations = phase.operationIds
        .map((opId) => state.operations[opId])
        .filter((operation): operation is OperationRecord => Boolean(operation));
    const activeOperations = phaseOperations.filter((operation) => operation.lifecycle === "ACTIVE");
    if (activeOperations.length > 0) {
        state.metrics.checkpointRejects++;
        state.metrics.checkpointRetries++;
        return `[workflow_checkpoint REJECTED: undelivered operation(s): ${activeOperations.map((operation) => operation.opId).join(", ")}]`;
    }
    const validation = validateCheckpointAgainstPhase(checkpoint, phase, phaseOperations, state);
    if (!validation.valid) {
        state.metrics.checkpointRejects++;
        state.metrics.checkpointRetries++;
        return `[workflow_checkpoint REJECTED: ${validation.errors.join("; ")}]`;
    }
    const previousOperationLifecycles = new Map(
        phaseOperations.map((operation) => [operation.opId, operation.lifecycle] as const),
    );
    const previousMessageLifecycles = new Map(
        Object.values(state.phaseMessages)
            .filter((message) => message.phaseId === phaseId)
            .map((message) => [message.messageRef, message.lifecycle] as const),
    );
    const keepRefs = new Set([...checkpoint.criticalRefs, ...checkpoint.keepRefs]);
    for (const opId of phase.operationIds) {
        const operation = state.operations[opId];
        if (!operation) continue;
        if (operation.lifecycle === "DELIVERED") operation.lifecycle = "CONSUMED";
        if (operation.importance === "CRITICAL" && operation.lifecycle === "CONSUMED") operation.lifecycle = "CRITICAL";
        if (!operationIsKept(operation, keepRefs) && operation.lifecycle === "CONSUMED") operation.lifecycle = "PENDING_DROP";
    }
    markPhaseMessagesPendingDrop(state, phaseId, keepRefs);
    const archive = archivePhase(sessionId, state, phaseId, checkpoint);
    if (!archive.committed) {
        for (const operation of phaseOperations) {
            const lifecycle = previousOperationLifecycles.get(operation.opId);
            if (lifecycle) operation.lifecycle = lifecycle;
        }
        for (const message of Object.values(state.phaseMessages)) {
            const lifecycle = previousMessageLifecycles.get(message.messageRef);
            if (lifecycle) message.lifecycle = lifecycle;
        }
        recomputeWorkflowMetrics(state);
        state.metrics.checkpointRejects++;
        return `[workflow_checkpoint REJECTED: phase archive failed — ${archive.error ?? "unknown archive error"}]`;
    }
    state.nextCheckpointNumber++;
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
    attachCheckpointToTask(state, checkpoint);
    refreshRequirementHistory(state);
    markPhaseMessagesPendingDrop(state, phaseId, keepRefs);
    state.metrics.checkpointTokens += estimateTokensFast(JSON.stringify(checkpoint));
    recomputeWorkflowMetrics(state);
    applyDeferredRollover(state, options, contextTokens, modelContextLimit, model);
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

export function workflowMemory(state: WorkflowState, rereadAfterPhase: boolean, maxTokens = 12_000): string | undefined {
    const taskCheckpoints = Object.values(state.tasks)
        .filter((task) => task.sessionCheckpoint)
        .sort((a, b) => a.updatedAt - b.updatedAt);
    if (state.metrics.rollovers === 0 && !state.projectHistory?.sessions.length && taskCheckpoints.length === 0) return undefined;
    const requirements = Object.values(state.requirements)
        .filter((requirement) =>
            (requirement.status === "ACTIVE" || requirement.status === "ACTIVE_CURRENT" || requirement.status === "ACTIVE_STABLE")
            && (!state.activeTaskId || !requirement.taskId || requirement.taskId === state.activeTaskId),
        )
        .sort((left, right) => {
            if (left.importance !== right.importance) return left.importance === "CRITICAL" ? -1 : 1;
            return right.createdAt - left.createdAt;
        });
    const prefix = `<workflow-memory>\nActive task: ${state.activeTaskId ?? "untracked"}\nActive requirements:`;
    const reread = rereadAfterPhase
        ? "\nFor code needed in the current phase, re-read the repository; historical memory is not authoritative for code facts."
        : "";
    const suffix = `${reread}\n</workflow-memory>`;
    if (estimateTokensFast(`${prefix}${suffix}`) > maxTokens) return undefined;
    const requirementLines: string[] = [];
    const omittedRequirements: string[] = [];
    for (const requirement of requirements) {
        const line = `${requirement.id} [${requirement.importance}] ${requirement.detail}${requirement.rawRef ? ` [raw_ref: ${requirement.rawRef}]` : ""}`;
        const candidate = `${prefix}\n${[...requirementLines, line].join("\n")}${suffix}`;
        if (estimateTokensFast(candidate) <= maxTokens) requirementLines.push(line);
        else omittedRequirements.push(`${requirement.id}:${requirement.rawRef ?? requirement.sourceRefs[0] ?? "unavailable"}`);
    }
    if (omittedRequirements.length > 0) {
        const marker = `[${omittedRequirements.length} active requirement(s) omitted by memory budget; retrieve refs: ${omittedRequirements.join(", ")}]`;
        const candidate = `${prefix}\n${[...requirementLines, marker].join("\n")}${suffix}`;
        if (estimateTokensFast(candidate) <= maxTokens) requirementLines.push(marker);
    }
    const fixed = `${prefix}\n${requirementLines.join("\n")}`;
    const sections: string[] = [];
    const candidates = [
        ...taskCheckpoints.slice(-3).reverse().map((task) => `Session checkpoint ${task.taskId}:\n${JSON.stringify(task.sessionCheckpoint)}`),
        ...(state.projectHistory?.projectCheckpoint
            ? [`Project checkpoint:\n${JSON.stringify(state.projectHistory.projectCheckpoint)}`]
            : []),
        ...(state.projectHistory?.sessions.slice(-2).reverse().map((session) => {
            const historian = session.checkpoint.historian?.narrative;
            return historian
                ? `Prior task ${session.taskId ?? session.sessionKey} historian:\n${historian}`
                : `Prior task ${session.taskId ?? session.sessionKey}:\n${JSON.stringify(session.checkpoint)}`;
        }) ?? []),
    ];
    for (const candidate of candidates) {
        const next = `${fixed}\n\n${[...sections, candidate].join("\n\n")}${suffix}`;
        if (estimateTokensFast(next) > maxTokens) continue;
        sections.push(candidate);
    }
    return `${fixed}\n\n${sections.join("\n\n")}${suffix}`;
}
