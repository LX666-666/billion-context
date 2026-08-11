export type OperationType =
    | "READ"
    | "SEARCH"
    | "LIST"
    | "PATCH"
    | "WRITE"
    | "BUILD"
    | "TEST"
    | "RUN"
    | "DIFF"
    | "INSTALL"
    | "PLAN"
    | "OTHER";

export type OperationLifecycle = "ACTIVE" | "CONSUMED" | "PENDING_DROP" | "ARCHIVED";

export type OperationRecord = {
    opId: string;
    phaseId: string;
    type: OperationType;
    callRefs: string[];
    resultRefs: string[];
    toolCallId?: string;
    toolName?: string;
    path?: string;
    command?: string;
    workdir?: string;
    paths: string[];
    addedPaths: string[];
    rawRef?: string;
    rawChecksum?: string;
    rawTokens: number;
    visibleTokens: number;
    lifecycle: OperationLifecycle;
    importance: "NORMAL" | "CRITICAL";
    repositoryGuard?: {
        status: "BLOCKED_REREAD" | "SATISFIED";
        paths: string[];
        reason: string;
        violationId: string;
    };
    repositoryObservedAt?: number;
    createdAt: number;
    updatedAt: number;
};

export type RequirementRecord = {
    id: string;
    sourceRefs: string[];
    detail: string;
    status: "ACTIVE" | "SATISFIED" | "SUPERSEDED" | "CANCELLED";
    supersededBy?: string;
    importance: "NORMAL" | "CRITICAL";
    preserveRaw: boolean;
    rawRef?: string;
    createdAt: number;
};

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export type PlanStepRecord = {
    step: string;
    status: PlanStepStatus;
};

export type PlanRecord = {
    explanation?: string;
    items: PlanStepRecord[];
    revision: number;
    updatedAt: number;
};

export type WorkflowCheckpoint = {
    checkpointId: string;
    phaseId: string;
    objective: string;
    requirementState?: string;
    requirementUpdates: Array<{
        id: string;
        status: RequirementRecord["status"];
        supersededBy?: string;
    }>;
    completedWork: string;
    changedFiles: string[];
    currentState: string;
    decisions: Array<{ decision: string; reason: string; refs: string[] }>;
    rejectedApproaches: string[];
    failedAttempts: string[];
    validation: string[];
    blockers: string[];
    unresolvedIssues: string[];
    nextAction?: string;
    criticalRefs: string[];
    keepRefs: string[];
    createdAt: number;
};

export type PhaseRecord = {
    phaseId: string;
    objective: string;
    status: "ACTIVE" | "CHECKPOINT_PENDING" | "PENDING_ROLLOVER" | "ARCHIVED";
    operationIds: string[];
    itemKeys: string[];
    startedAt: number;
    completedAt?: number;
    checkpointId?: string;
};

export type RawArchiveIndexRecord = {
    rawRef: string;
    opId?: string;
    requirementId?: string;
    phaseId?: string;
    type: OperationType | "REQUIREMENT";
    tokenCount: number;
    checksum: string;
    createdAt: number;
};

export type WorkflowMetrics = {
    rawToolTokens: number;
    visibleToolTokens: number;
    preIngestSavedTokens: number;
    pendingDropTokens: number;
    rollovers: number;
    checkpointTokens: number;
    rawRetrievals: number;
    repoRefreshes: number;
    repoGuardBlocks: number;
    staleFiles: number;
};

export type RepoFileSnapshot = {
    path: string;
    relativePath: string;
    exists: boolean;
    tracked: boolean;
    size: number;
    mtimeMs: number;
    signature: string;
    lastReadPhaseId?: string;
    lastMutationPhaseId?: string;
    stale: boolean;
    staleReason?: "PHASE_BOUNDARY" | "HEAD_CHANGED" | "FILE_CHANGED";
    staleGeneration?: number;
    observedAt: number;
};

export type RepoGuardViolation = {
    violationId: string;
    phaseId: string;
    opId: string;
    paths: string[];
    reason: string;
    createdAt: number;
    resolvedAt?: number;
};

export type RepoBridgeState = {
    workspaceRoot?: string;
    repoRoot?: string;
    remoteIdentity?: string;
    head?: string;
    dirty?: boolean;
    observedAt?: number;
    lastError?: string;
    nextViolationNumber: number;
    refreshGeneration: number;
    files: Record<string, RepoFileSnapshot>;
    violations: RepoGuardViolation[];
};

export type ProjectHistorySession = {
    sessionKey: string;
    updatedAt: number;
    requirements: Array<Pick<RequirementRecord, "id" | "detail" | "status" | "importance">>;
    checkpoint: SessionCheckpoint;
};

export type SessionCheckpoint = {
    objectives: string[];
    completedWork: string[];
    changedFiles: string[];
    currentState: string;
    decisions: WorkflowCheckpoint["decisions"];
    rejectedApproaches: string[];
    failedAttempts: string[];
    validation: string[];
    blockers: string[];
    unresolvedIssues: string[];
    nextActions: string[];
};

export type ProjectHistorySnapshot = {
    projectId: string;
    updatedAt: number;
    sessions: ProjectHistorySession[];
};

export type WorkflowState = {
    version: 1;
    projectId?: string;
    nextOperationNumber: number;
    nextPhaseNumber: number;
    nextRequirementNumber: number;
    nextCheckpointNumber: number;
    nextRawNumber: number;
    activePhaseId?: string;
    activePlan?: PlanRecord;
    sessionStatus: "ACTIVE" | "COMPLETE_CANDIDATE";
    seenPlanCallIds: string[];
    checkpointQueue: string[];
    operations: Record<string, OperationRecord>;
    operationByCallId: Record<string, string>;
    itemPhaseByKey: Record<string, string>;
    requirements: Record<string, RequirementRecord>;
    requirementBySourceRef: Record<string, string>;
    phases: Record<string, PhaseRecord>;
    checkpoints: Record<string, WorkflowCheckpoint>;
    rawArchive: Record<string, RawArchiveIndexRecord>;
    projectMemoryLoadedAt?: number;
    projectHistory?: ProjectHistorySnapshot;
    repoBridge: RepoBridgeState;
    metrics: WorkflowMetrics;
};

export type WorkflowOptions = {
    enabled: boolean;
    targetContextRatio: number;
    phaseGc: boolean;
    sessionGc: boolean;
    rereadAfterPhase: boolean;
    deterministicPruner: boolean;
    prunerMinTokens: number;
    cheapModel: {
        enabled: boolean;
        endpoint?: string;
        model?: string;
        apiKey?: string;
        minTokens: number;
        maxOutputTokens: number;
        timeoutMs: number;
    };
    rolloverMinTokens: number;
    archiveSemanticRaw: boolean;
    projectKey?: string;
    repoBridge: {
        enabled: boolean;
        enforceReread: boolean;
        workspaceRoot?: string;
        hashMaxBytes: number;
        gitTimeoutMs: number;
    };
};

export const DEFAULT_WORKFLOW_OPTIONS: WorkflowOptions = {
    enabled: true,
    targetContextRatio: 0.2,
    phaseGc: true,
    sessionGc: true,
    rereadAfterPhase: true,
    deterministicPruner: true,
    prunerMinTokens: 2_000,
    cheapModel: {
        enabled: false,
        minTokens: 8_000,
        maxOutputTokens: 2_000,
        timeoutMs: 30_000,
    },
    rolloverMinTokens: 12_000,
    archiveSemanticRaw: true,
    repoBridge: {
        enabled: true,
        enforceReread: true,
        hashMaxBytes: 4 * 1024 * 1024,
        gitTimeoutMs: 2_000,
    },
};
