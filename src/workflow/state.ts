import type { PhaseRecord, WorkflowMetrics, WorkflowState } from "./types.js";

export function createWorkflowMetrics(): WorkflowMetrics {
    return {
        rawToolTokens: 0,
        visibleToolTokens: 0,
        preIngestSavedTokens: 0,
        pendingDropTokens: 0,
        rollovers: 0,
        checkpointTokens: 0,
        rawRetrievals: 0,
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
        metrics: createWorkflowMetrics(),
    };
}

export function mergeWorkflowState(value: WorkflowState | undefined): WorkflowState {
    const fresh = createInitialWorkflowState();
    if (!value || value.version !== 1) return fresh;
    return {
        ...fresh,
        ...value,
        seenPlanCallIds: Array.isArray(value.seenPlanCallIds) ? value.seenPlanCallIds : [],
        checkpointQueue: Array.isArray(value.checkpointQueue) ? value.checkpointQueue : [],
        operations: value.operations ?? {},
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
        metrics: { ...fresh.metrics, ...(value.metrics ?? {}) },
    };
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
        startedAt: Date.now(),
    };
    state.phases[phaseId] = phase;
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
