import type { PhaseRecord, TaskRecord, WorkflowMetrics, WorkflowState } from "./types.js";

export function createWorkflowMetrics(): WorkflowMetrics {
    return {
        rawToolTokens: 0,
        visibleToolTokens: 0,
        preIngestSavedTokens: 0,
        pendingDropTokens: 0,
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
        nextTaskNumber: 1,
        sessionStatus: "ACTIVE",
        seenPlanCallIds: [],
        checkpointQueue: [],
        operations: {},
        operationByCallId: {},
        itemPhaseByKey: {},
        requirements: {},
        requirementBySourceRef: {},
        phases: {},
        checkpoints: {},
        rawArchive: {},
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
        seenPlanCallIds: Array.isArray(value.seenPlanCallIds) ? value.seenPlanCallIds : [],
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
        requirementBySourceRef: value.requirementBySourceRef ?? {},
        phases: Object.fromEntries(Object.entries(value.phases ?? {}).map(([phaseId, phase]) => [
            phaseId,
            { ...phase, itemKeys: Array.isArray(phase.itemKeys) ? phase.itemKeys : [] },
        ])),
        checkpoints: value.checkpoints ?? {},
        rawArchive: value.rawArchive ?? {},
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
    state.sessionStatus = "ACTIVE";
    return phase;
}

export function recomputeWorkflowMetrics(state: WorkflowState): void {
    let rawToolTokens = 0;
    let visibleToolTokens = 0;
    let pendingDropTokens = 0;
    for (const operation of Object.values(state.operations)) {
        rawToolTokens += operation.rawTokens;
        visibleToolTokens += operation.visibleTokens;
        if (operation.lifecycle === "PENDING_DROP") pendingDropTokens += operation.visibleTokens;
    }
    state.metrics.rawToolTokens = rawToolTokens;
    state.metrics.visibleToolTokens = visibleToolTokens;
    state.metrics.preIngestSavedTokens = Math.max(0, rawToolTokens - visibleToolTokens);
    state.metrics.pendingDropTokens = pendingDropTokens;
}
