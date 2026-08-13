import { estimateTokensFast } from "acp-kernel";
import type {
    PhaseMessageRecord,
    PhaseRecord,
    RequirementMessageRecord,
    TaskRecord,
    WorkflowMetrics,
    WorkflowState,
} from "./types.js";

export function createWorkflowMetrics(): WorkflowMetrics {
    return {
        rawToolTokens: 0,
        visibleToolTokens: 0,
        preIngestSavedTokens: 0,
        pendingDropTokens: 0,
        pendingDropOperationTokens: 0,
        pendingDropMessageTokens: 0,
        pendingDropRequirementTokens: 0,
        pendingDropTotalTokens: 0,
        rollovers: 0,
        checkpointTokens: 0,
        rawRetrievals: 0,
        repoRefreshes: 0,
        repoGuardBlocks: 0,
        staleFiles: 0,
        rolloverEvaluations: 0,
        rolloverDeferrals: 0,
        taskBoundaries: 0,
        historianRuns: 0,
        historianFailures: 0,
        checkpointRejects: 0,
        checkpointRetries: 0,
    };
}

export function createInitialWorkflowState(): WorkflowState {
    return {
        version: 1,
        nextOperationNumber: 1,
        nextPhaseNumber: 1,
        nextRequirementNumber: 1,
        nextCheckpointNumber: 1,
        nextRawNumber: 1,
        nextRequirementMessageNumber: 1,
        requirementLedgerVersion: 0,
        nextPlanItemNumber: 1,
        nextTaskNumber: 1,
        checkpointRetryCount: 0,
        sessionStatus: "ACTIVE",
        seenPlanCallIds: [],
        seenBoundarySignalRefs: [],
        checkpointQueue: [],
        operations: {},
        operationByCallId: {},
        itemPhaseByKey: {},
        requirements: {},
        requirementMessages: {},
        requirementBySourceRef: {},
        phases: {},
        checkpoints: {},
        rawArchive: {},
        phaseMessages: {},
        tasks: {},
        historian: { pendingTaskIds: [] },
        repoBridge: {
            nextViolationNumber: 1,
            refreshGeneration: 0,
            files: {},
            violations: [],
        },
        cacheTelemetry: {
            sampleCount: 0,
            recentUsage: [],
            lastContextTokens: 0,
            previousContextTokens: 0,
            contextGrowthTokens: 0,
            contextGrowthRate: 0,
            lastVisibleToolTokens: 0,
        },
        metrics: createWorkflowMetrics(),
    };
}

export function mergeWorkflowState(value: WorkflowState | undefined): WorkflowState {
    const fresh = createInitialWorkflowState();
    if (!value || value.version !== 1) return fresh;
    const merged: WorkflowState = {
        ...fresh,
        ...value,
        nextRequirementMessageNumber: value.nextRequirementMessageNumber ?? fresh.nextRequirementMessageNumber,
        requirementLedgerVersion: value.requirementLedgerVersion ?? fresh.requirementLedgerVersion,
        nextPlanItemNumber: value.nextPlanItemNumber ?? fresh.nextPlanItemNumber,
        checkpointRetryCount: value.checkpointRetryCount ?? fresh.checkpointRetryCount,
        seenPlanCallIds: Array.isArray(value.seenPlanCallIds) ? value.seenPlanCallIds : [],
        seenBoundarySignalRefs: Array.isArray(value.seenBoundarySignalRefs) ? value.seenBoundarySignalRefs : [],
        checkpointQueue: Array.isArray(value.checkpointQueue) ? value.checkpointQueue : [],
        operations: Object.fromEntries(Object.entries(value.operations ?? {}).map(([opId, operation]) => [
            opId,
            {
                ...operation,
                paths: Array.isArray(operation.paths) ? operation.paths : operation.path ? [operation.path] : [],
                addedPaths: Array.isArray(operation.addedPaths) ? operation.addedPaths : [],
            },
        ])),
        operationByCallId: value.operationByCallId ?? {},
        itemPhaseByKey: value.itemPhaseByKey ?? {},
        requirements: value.requirements ?? {},
        requirementMessages: value.requirementMessages ?? {},
        requirementBySourceRef: value.requirementBySourceRef ?? {},
        phases: Object.fromEntries(Object.entries(value.phases ?? {}).map(([phaseId, phase]) => [
            phaseId,
            { ...phase, itemKeys: Array.isArray(phase.itemKeys) ? phase.itemKeys : [] },
        ])),
        checkpoints: value.checkpoints ?? {},
        rawArchive: value.rawArchive ?? {},
        phaseMessages: value.phaseMessages ?? {},
        tasks: Object.fromEntries(Object.entries(value.tasks ?? {}).map(([taskId, task]) => [
            taskId,
            {
                ...task,
                requirementIds: Array.isArray(task.requirementIds) ? task.requirementIds : [],
                phaseIds: Array.isArray(task.phaseIds) ? task.phaseIds : [],
                checkpointIds: Array.isArray(task.checkpointIds) ? task.checkpointIds : [],
            },
        ])),
        historian: {
            ...(value.historian ?? fresh.historian),
            pendingTaskIds: Array.isArray(value.historian?.pendingTaskIds) ? value.historian.pendingTaskIds : [],
        },
        repoBridge: {
            ...fresh.repoBridge,
            ...(value.repoBridge ?? {}),
            files: value.repoBridge?.files ?? {},
            violations: Array.isArray(value.repoBridge?.violations) ? value.repoBridge.violations : [],
        },
        cacheTelemetry: {
            ...fresh.cacheTelemetry,
            ...(value.cacheTelemetry ?? {}),
            recentUsage: Array.isArray(value.cacheTelemetry?.recentUsage) ? value.cacheTelemetry.recentUsage : [],
        },
        metrics: { ...fresh.metrics, ...(value.metrics ?? {}) },
    };
    return migrateTaskState(merged);
}

function migrateTaskState(state: WorkflowState): WorkflowState {
    const existingNumbers = Object.keys(state.tasks).flatMap((taskId) => {
        const match = /^task(\d+)$/.exec(taskId);
        return match ? [Number(match[1])] : [];
    });
    state.nextTaskNumber = Math.max(state.nextTaskNumber, ...existingNumbers.map((value) => value + 1));
    if (Object.keys(state.tasks).length > 0) return state;
    const requirementIds = Object.keys(state.requirements);
    const phaseIds = Object.keys(state.phases);
    const checkpointIds = Object.keys(state.checkpoints);
    if (requirementIds.length === 0 && phaseIds.length === 0 && checkpointIds.length === 0) return state;
    const now = Date.now();
    const timestamps = [
        ...Object.values(state.requirements).map((requirement) => requirement.createdAt),
        ...Object.values(state.phases).map((phase) => phase.startedAt),
        ...Object.values(state.checkpoints).map((checkpoint) => checkpoint.createdAt),
    ].filter((value) => Number.isFinite(value));
    const taskId = `task${String(state.nextTaskNumber++).padStart(5, "0")}`;
    const activePhase = state.activePhaseId ? state.phases[state.activePhaseId] : undefined;
    const firstRequirement = requirementIds[0] ? state.requirements[requirementIds[0]] : undefined;
    const task: TaskRecord = {
        taskId,
        objective: activePhase?.objective ?? firstRequirement?.detail ?? "Migrated workflow task",
        status: state.sessionStatus === "COMPLETE_CANDIDATE" ? "COMPLETE_CANDIDATE" : "ACTIVE",
        requirementIds,
        phaseIds,
        checkpointIds,
        startedAt: timestamps.length > 0 ? Math.min(...timestamps) : now,
        updatedAt: timestamps.length > 0 ? Math.max(...timestamps) : now,
    };
    state.tasks[taskId] = task;
    state.activeTaskId = taskId;
    for (const requirement of Object.values(state.requirements)) requirement.taskId = taskId;
    for (const phase of Object.values(state.phases)) phase.taskId = taskId;
    for (const checkpoint of Object.values(state.checkpoints)) checkpoint.taskId = taskId;
    return state;
}

export function ensureActivePhase(state: WorkflowState, objective = "Unplanned work"): PhaseRecord {
    if (state.activePhaseId) {
        const active = state.phases[state.activePhaseId];
        if (active?.status === "ACTIVE") return active;
    }
    const phaseId = `phase${String(state.nextPhaseNumber++).padStart(5, "0")}`;
    const phase: PhaseRecord = {
        phaseId,
        objective,
        status: "ACTIVE",
        operationIds: [],
        itemKeys: [],
        ...(state.activeTaskId ? { taskId: state.activeTaskId } : {}),
        startedAt: Date.now(),
    };
    state.phases[phaseId] = phase;
    if (state.activeTaskId) {
        const task = state.tasks[state.activeTaskId];
        if (task && !task.phaseIds.includes(phaseId)) task.phaseIds.push(phaseId);
    }
    state.activePhaseId = phaseId;
    state.phaseBoundaryCandidate = undefined;
    state.sessionStatus = "ACTIVE";
    return phase;
}

export type CapturePhaseMessageInput = {
    phaseId: string;
    messageRef: string;
    role: string;
    contentType: string;
    payload?: string;
    tokenSize?: number;
    operationId?: string;
    requirementMessageId?: string;
};

export function capturePhaseMessage(state: WorkflowState, input: CapturePhaseMessageInput): PhaseMessageRecord {
    const now = Date.now();
    const existing = state.phaseMessages[input.messageRef];
    const tokenSize = input.tokenSize ?? (input.payload ? estimateTokensFast(input.payload) : 0);
    if (existing) {
        if (existing.lifecycle !== "ARCHIVED" && input.payload !== undefined) existing.payload = input.payload;
        existing.tokenSize = Math.max(existing.tokenSize, tokenSize);
        existing.role = input.role;
        existing.contentType = input.contentType;
        if (input.operationId) existing.operationId = input.operationId;
        if (input.requirementMessageId) existing.requirementMessageId = input.requirementMessageId;
        existing.updatedAt = now;
        return existing;
    }
    const record: PhaseMessageRecord = {
        messageRef: input.messageRef,
        phaseId: input.phaseId,
        role: input.role,
        contentType: input.contentType,
        tokenSize: Math.max(0, tokenSize),
        lifecycle: "ACTIVE",
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.requirementMessageId ? { requirementMessageId: input.requirementMessageId } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        createdAt: now,
        updatedAt: now,
    };
    state.phaseMessages[input.messageRef] = record;
    const phase = state.phases[input.phaseId];
    if (phase && !phase.itemKeys.includes(input.messageRef)) phase.itemKeys.push(input.messageRef);
    return record;
}

export function markPhaseMessagesPendingDrop(
    state: WorkflowState,
    phaseId: string,
    keepRefs: Set<string>,
): void {
    const phase = state.phases[phaseId];
    if (!phase) return;
    for (const message of Object.values(state.phaseMessages)) {
        if (message.phaseId !== phaseId || message.lifecycle !== "ACTIVE") continue;
        const operation = message.operationId ? state.operations[message.operationId] : undefined;
        const kept = operation?.lifecycle === "KEEP"
            || operation?.lifecycle === "CRITICAL"
            || (operation ? operation.importance === "CRITICAL" : false)
            || keepRefs.has(message.messageRef)
            || (message.operationId ? keepRefs.has(message.operationId) : false);
        if (kept) continue;
        if (message.requirementMessageId) {
            const requirementMessage = state.requirementMessages[message.requirementMessageId];
            if (!requirementMessage || requirementMessage.lifecycle !== "PENDING_DROP") continue;
        } else if (operation?.lifecycle === "PENDING_DROP") {
        } else if (message.role !== "assistant") {
            continue;
        }
        message.lifecycle = "PENDING_DROP";
        message.updatedAt = Date.now();
    }
}

export function recomputeWorkflowMetrics(state: WorkflowState): void {
    let rawToolTokens = 0;
    let visibleToolTokens = 0;
    let pendingDropOperationTokens = 0;
    let pendingDropMessageTokens = 0;
    let pendingDropRequirementTokens = 0;
    for (const operation of Object.values(state.operations)) {
        rawToolTokens += operation.rawTokens;
        visibleToolTokens += operation.visibleTokens;
        if (operation.lifecycle === "PENDING_DROP") pendingDropOperationTokens += operation.visibleTokens;
    }
    for (const message of Object.values(state.phaseMessages)) {
        if (message.lifecycle !== "PENDING_DROP") continue;
        if (message.messageRef.endsWith(":call") || message.messageRef.endsWith(":result")) continue;
        if (message.requirementMessageId) continue;
        const isToolResult = message.contentType === "tool-result" || message.contentType.endsWith("_output");
        if (message.operationId
            && state.operations[message.operationId]?.lifecycle === "PENDING_DROP"
            && isToolResult) continue;
        pendingDropMessageTokens += message.tokenSize;
    }
    for (const message of Object.values(state.requirementMessages)) {
        if (message.lifecycle === "PENDING_DROP") pendingDropRequirementTokens += message.tokenSize;
    }
    state.metrics.rawToolTokens = rawToolTokens;
    state.metrics.visibleToolTokens = visibleToolTokens;
    state.metrics.preIngestSavedTokens = Math.max(0, rawToolTokens - visibleToolTokens);
    state.metrics.pendingDropOperationTokens = pendingDropOperationTokens;
    state.metrics.pendingDropMessageTokens = pendingDropMessageTokens;
    state.metrics.pendingDropRequirementTokens = pendingDropRequirementTokens;
    state.metrics.pendingDropTotalTokens = pendingDropOperationTokens
        + pendingDropMessageTokens
        + pendingDropRequirementTokens;
    state.metrics.pendingDropTokens = state.metrics.pendingDropTotalTokens;
}
