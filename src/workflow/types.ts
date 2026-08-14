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

export type OperationLifecycle =
    | "ACTIVE"
    | "DELIVERED"
    | "CONSUMED"
    | "KEEP"
    | "CRITICAL"
    | "PENDING_DROP"
    | "ARCHIVED";

export type RequirementStatus =
    | "ACTIVE"
    | "ACTIVE_CURRENT"
    | "ACTIVE_STABLE"
    | "SATISFIED"
    | "SUPERSEDED"
    | "CANCELLED"
    | "HISTORICAL";

export type RequirementProvenance =
    | "REAL_USER_REQUIREMENT"
    | "USER_REQUIREMENT_POINTER"
    | "USER_REQUIREMENT_DOCUMENT"
    | "HOST_CONTEXT"
    | "PROJECT_INSTRUCTIONS"
    | "ENVIRONMENT_CONTEXT"
    | "INTERNAL_WORKFLOW";

export type PhaseMessageLifecycle = "ACTIVE" | "PENDING_DROP" | "ARCHIVED";

export type RequirementMessageLifecycle = "ACTIVE" | "PENDING_DROP" | "ARCHIVED";

export type CodexNestedOperation = {
    type: OperationType;
    command?: string;
    workdir?: string;
    paths: string[];
    addedPaths: string[];
};

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
    codexNested?: CodexNestedOperation[];
    rawRef?: string;
    rawChecksum?: string;
    rawTokens: number;
    visibleTokens: number;
    lifecycle: OperationLifecycle;
    importance: "NORMAL" | "CRITICAL";
    outcome?: "PASS" | "FAIL" | "UNKNOWN";
    repositoryGuard?: {
        status: "POST_MUTATION_REREAD_REQUIRED" | "SATISFIED";
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
    messageId?: string;
    parentMessageId?: string;
    detail: string;
    status: RequirementStatus;
    supersededBy?: string;
    importance: "NORMAL" | "CRITICAL";
    provenance?: RequirementProvenance;
    preserveRaw: boolean;
    rawRef?: string;
    historicalDetail?: string;
    resolvedStatus?: Exclude<RequirementStatus, "HISTORICAL">;
    taskId?: string;
    createdAt: number;
};

export type RequirementMessageRecord = {
    messageId: string;
    sourceRefs: string[];
    detail: string;
    requirementIds: string[];
    rawRef?: string;
    tokenSize: number;
    lifecycle: RequirementMessageLifecycle;
    createdAt: number;
    historicalAt?: number;
};

export type HistoricalRequirementMessage = Pick<
    RequirementMessageRecord,
    "messageId" | "sourceRefs" | "detail" | "requirementIds" | "rawRef" | "tokenSize"
> & {
    historicalAt?: number;
};

export type RequirementDocumentPointer = {
    path: string;
    sourceRef: string;
    pointerRequirementId?: string;
    requirementMessageId?: string;
    rawRef?: string;
    ingested: boolean;
    createdAt: number;
    ingestedAt?: number;
};

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export type PlanStepRecord = {
    step: string;
    status: PlanStepStatus;
    planItemId?: string;
};

export type PlanRecord = {
    explanation?: string;
    items: PlanStepRecord[];
    revision: number;
    updatedAt: number;
};

export type ExecutionSupervisorPlanSyncKey = string;

export type ExecutionSupervisorState = {
    planSyncSent: ExecutionSupervisorPlanSyncKey[];
    readOnlyStallSentPhaseId?: string;
    redundantReadSent: Record<string, number>;
    observationCount: number;
    observationTokens: number;
    mutationSeen: boolean;
    completionEvidenceSeen: boolean;
};

export type WorkflowCheckpoint = {
    checkpointId: string;
    phaseId: string;
    taskId?: string;
    objective: string;
    requirementState?: string;
    /** Ledger version captured atomically with this checkpoint's effective requirement
     *  snapshot. Reflects the version AFTER the checkpoint's `requirementUpdates` are
     *  applied, so the snapshot and version are consistent. */
    requirementLedgerVersion?: number;
    /** Effective requirement status snapshot after applying `requirementUpdates`. */
    requirementSnapshot?: Array<{ id: string; status: RequirementStatus }>;
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
    taskId?: string;
    planItemId?: string;
    archiveStatus?: "PENDING" | "COMMITTED" | "FAILED";
    archiveRef?: string;
    archiveChecksum?: string;
    archiveError?: string;
};

export type PhaseMessageRecord = {
    messageRef: string;
    phaseId: string;
    role: string;
    contentType: string;
    tokenSize: number;
    lifecycle: PhaseMessageLifecycle;
    operationId?: string;
    requirementMessageId?: string;
    payload?: string;
    payloadRef?: string;
    createdAt: number;
    updatedAt: number;
};

export type PhaseArchiveMessageEntry = {
    messageRef: string;
    role: string;
    contentType: string;
    tokenSize: number;
    operationId?: string;
    requirementMessageId?: string;
    payload?: string;
    payloadRef?: string;
};

export type PhaseArchiveOperationEntry = {
    opId: string;
    type: OperationType;
    lifecycle: OperationLifecycle;
    callRefs: string[];
    resultRefs: string[];
    toolCallId?: string;
    command?: string;
    workdir?: string;
    path?: string;
    paths: string[];
    addedPaths: string[];
    rawRef?: string;
    callPayloadRef?: string;
    resultPayloadRef?: string;
    outcome?: OperationRecord["outcome"];
};

export type PhaseArchive = {
    phaseId: string;
    taskId?: string;
    objective: string;
    createdAt: number;
    completedAt?: number;
    checkpointId?: string;
    messageEntries: PhaseArchiveMessageEntry[];
    operations: PhaseArchiveOperationEntry[];
    changedFiles: string[];
    checkpointRef?: string;
    checkpoint?: WorkflowCheckpoint;
    checksum: string;
};

export type CheckpointValidationResult = {
    valid: boolean;
    errors: string[];
    warnings: string[];
};

export type RawArchiveIndexRecord = {
    rawRef: string;
    opId?: string;
    requirementId?: string;
    phaseId?: string;
    type: OperationType | "REQUIREMENT" | "MESSAGE";
    tokenCount: number;
    checksum: string;
    createdAt: number;
};

export type WorkflowMetrics = {
    rawToolTokens: number;
    visibleToolTokens: number;
    preIngestSavedTokens: number;
    pendingDropTokens: number;
    pendingDropOperationTokens: number;
    pendingDropMessageTokens: number;
    pendingDropRequirementTokens: number;
    pendingDropTotalTokens: number;
    rollovers: number;
    checkpointTokens: number;
    rawRetrievals: number;
    repoRefreshes: number;
    repoGuardBlocks: number;
    staleFiles: number;
    rolloverEvaluations: number;
    rolloverDeferrals: number;
    taskBoundaries: number;
    historianRuns: number;
    historianFailures: number;
    checkpointRejects: number;
    checkpointRetries: number;
};

export type CacheUsageSample = {
    totalInputTokens: number;
    freshInputTokens: number;
    cachedInputTokens?: number;
    cacheHitRatio?: number;
    recordedAt: number;
};

export type CachePolicyDecision = {
    action: "IDLE" | "DEFER" | "ROLLOVER";
    score: number;
    reasons: string[];
    contextTokens: number;
    modelContextLimit: number;
    contextRatio: number;
    targetContextRatio: number;
    model?: string;
    cachedTokens?: number;
    cacheHitRatio?: number;
    pendingDropTokens: number;
    pendingDropOperationTokens: number;
    pendingDropMessageTokens: number;
    pendingDropRequirementTokens: number;
    pendingDropTotalTokens: number;
    pendingPhaseCount: number;
    phaseBoundary: boolean;
    contextGrowthTokens: number;
    contextGrowthRate: number;
    toolOutputGrowthTokens: number;
    debuggingActive: boolean;
    rewriteCostTokens: number;
    expectedNextWorkTokens: number;
    projectedContextTokens: number;
    evaluatedAt: number;
};

export type CacheTelemetry = {
    sampleCount: number;
    recentUsage: CacheUsageSample[];
    lastContextTokens: number;
    previousContextTokens: number;
    lastCachedTokens?: number;
    lastCacheHitRatio?: number;
    contextGrowthTokens: number;
    contextGrowthRate: number;
    lastVisibleToolTokens: number;
    lastDecision?: CachePolicyDecision;
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
    requirementDocument?: boolean;
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

export type HistoricalRequirement = Pick<
    RequirementRecord,
    "id" | "detail" | "status" | "resolvedStatus" | "importance" | "provenance" | "sourceRefs" | "preserveRaw" | "rawRef" | "taskId"
>;

export type HistorianNarrative = {
    model: string;
    narrative: string;
    sourceChecksum: string;
    generatedAt: number;
};

export type SessionCheckpoint = {
    level?: "SESSION" | "PROJECT";
    taskId?: string;
    taskStatus?: TaskRecord["status"];
    phaseCheckpointIds?: string[];
    requirements?: HistoricalRequirement[];
    requirementMessages?: HistoricalRequirementMessage[];
    requirementStates?: string[];
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
    importantErrors?: string[];
    importantCommands?: string[];
    criticalRefs?: string[];
    keepRefs?: string[];
    rawRefs?: string[];
    repository?: Pick<RepoBridgeState, "repoRoot" | "remoteIdentity" | "head" | "dirty">;
    historian?: HistorianNarrative;
    createdAt?: number;
};

export type ProjectCheckpoint = SessionCheckpoint & {
    level: "PROJECT";
    sessionKeys: string[];
};

export type ProjectHistorySession = {
    sessionKey: string;
    taskId?: string;
    taskStatus?: TaskRecord["status"];
    updatedAt: number;
    requirements: HistoricalRequirement[];
    requirementMessages?: HistoricalRequirementMessage[];
    checkpoint: SessionCheckpoint;
};

export type ProjectHistorySnapshot = {
    projectId: string;
    updatedAt: number;
    sessions: ProjectHistorySession[];
    projectCheckpoint?: ProjectCheckpoint;
};

export type TaskRecord = {
    taskId: string;
    objective: string;
    status: "ACTIVE" | "COMPLETE_CANDIDATE" | "COMPLETE" | "SUPERSEDED";
    requirementIds: string[];
    phaseIds: string[];
    checkpointIds: string[];
    startedAt: number;
    updatedAt: number;
    completedAt?: number;
    sessionCheckpoint?: SessionCheckpoint;
};

export type HistorianState = {
    pendingTaskIds: string[];
    lastRunAt?: number;
    lastModel?: string;
    lastError?: string;
};

export type WorkflowState = {
    version: 1;
    projectId?: string;
    nextOperationNumber: number;
    nextPhaseNumber: number;
    nextRequirementNumber: number;
    nextCheckpointNumber: number;
    nextRawNumber: number;
    nextRequirementMessageNumber: number;
    /** Monotonic ledger version. Incremented on every deterministic Ledger state
     *  change (new requirement, status transition via checkpoint updates, or
     *  HISTORICAL archival via refreshRequirementHistory) — not only on inserts. */
    requirementLedgerVersion: number;
    nextPlanItemNumber: number;
    nextTaskNumber: number;
    checkpointRetryPhaseId?: string;
    checkpointRetryCount: number;
    activePhaseId?: string;
    activeTaskId?: string;
    activePlan?: PlanRecord;
    sessionStatus: "ACTIVE" | "COMPLETE_CANDIDATE";
    seenPlanCallIds: string[];
    seenBoundarySignalRefs: string[];
    checkpointQueue: string[];
    operations: Record<string, OperationRecord>;
    operationByCallId: Record<string, string>;
    itemPhaseByKey: Record<string, string>;
    requirements: Record<string, RequirementRecord>;
    requirementMessages: Record<string, RequirementMessageRecord>;
    requirementBySourceRef: Record<string, string>;
    pendingRequirementDocuments: string[];
    requirementDocumentByPath: Record<string, RequirementDocumentPointer>;
    phases: Record<string, PhaseRecord>;
    checkpoints: Record<string, WorkflowCheckpoint>;
    rawArchive: Record<string, RawArchiveIndexRecord>;
    archiveSessionId?: string;
    phaseMessages: Record<string, PhaseMessageRecord>;
    phaseBoundaryCandidate?: {
        phaseId: string;
        reason: string;
        createdAt: number;
        sourceMessageRef: string;
        sourceRevision: number;
        consumedAt?: number;
    };
    tasks: Record<string, TaskRecord>;
    historian: HistorianState;
    projectMemoryLoadedAt?: number;
    projectHistory?: ProjectHistorySnapshot;
    repoBridge: RepoBridgeState;
    cacheTelemetry: CacheTelemetry;
    metrics: WorkflowMetrics;
    supervisor: ExecutionSupervisorState;
};

export type WorkflowOptions = {
    enabled: boolean;
    targetContextRatio: number;
    models?: Record<string, { targetRatio?: number; targetContextRatio?: number }>;
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
        requireRereadAfterPhase: boolean;
        workspaceRoot?: string;
        hashMaxBytes: number;
        gitTimeoutMs: number;
    };
    cachePolicy: {
        protectCacheHitRatio: number;
        highGrowthRate: number;
        expectedTokensPerStep: number;
        maxExpectedNextWorkTokens: number;
        debuggingWindowOperations: number;
        rewriteCostWeight: number;
    };
    memory: {
        maxInjectedTokens: number;
        maxProjectSessions: number;
    };
    historian: {
        enabled: boolean;
        endpoint?: string;
        model?: string;
        apiKey?: string;
        maxInputTokens: number;
        maxOutputTokens: number;
        timeoutMs: number;
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
        requireRereadAfterPhase: true,
        hashMaxBytes: 4 * 1024 * 1024,
        gitTimeoutMs: 2_000,
    },
    cachePolicy: {
        protectCacheHitRatio: 0.65,
        highGrowthRate: 0.18,
        expectedTokensPerStep: 8_000,
        maxExpectedNextWorkTokens: 64_000,
        debuggingWindowOperations: 10,
        rewriteCostWeight: 1.1,
    },
    memory: {
        maxInjectedTokens: 12_000,
        maxProjectSessions: 6,
    },
    historian: {
        enabled: false,
        maxInputTokens: 16_000,
        maxOutputTokens: 2_000,
        timeoutMs: 30_000,
    },
};
