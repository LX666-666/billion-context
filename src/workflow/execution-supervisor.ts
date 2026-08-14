import type { OperationRecord, OperationType, WorkflowState } from "./types.js";

const READ_ONLY_OPERATION_TYPES: ReadonlySet<OperationType> = new Set(["READ", "SEARCH", "LIST"]);
const MUTATION_OPERATION_TYPES: ReadonlySet<OperationType> = new Set(["PATCH", "WRITE"]);
const VALIDATION_OPERATION_TYPES: ReadonlySet<OperationType> = new Set(["TEST", "BUILD", "RUN"]);

const READ_ONLY_STALL_OPERATION_THRESHOLD = 8;
const READ_ONLY_STALL_TOKEN_THRESHOLD = 12_000;

function planSyncKey(planItemId: string | undefined, revision: number | undefined): string {
    return `${planItemId ?? "none"}#${revision ?? 0}`;
}

function planSyncNudgeAlreadySent(state: WorkflowState, key: string): boolean {
    return state.supervisor.planSyncSent.includes(key);
}

function recordPlanSyncNudge(state: WorkflowState, key: string): void {
    if (state.supervisor.planSyncSent.length > 64) state.supervisor.planSyncSent.shift();
    state.supervisor.planSyncSent.push(key);
}

function hasCompletionEvidence(state: WorkflowState, phaseId: string): boolean {
    const phase = state.phases[phaseId];
    if (!phase) return false;
    let mutationSeen = false;
    let validationPassed = false;
    for (const opId of phase.operationIds) {
        const operation = state.operations[opId];
        if (!operation) continue;
        if (MUTATION_OPERATION_TYPES.has(operation.type)) mutationSeen = true;
        if (VALIDATION_OPERATION_TYPES.has(operation.type) && operation.outcome === "PASS") validationPassed = true;
    }
    return mutationSeen && validationPassed;
}

function planObjectiveAdvanced(state: WorkflowState): boolean {
    const plan = state.activePlan;
    if (!plan) return false;
    const completed = plan.items.filter((item) => item.status === "completed").length;
    const inProgress = plan.items.find((item) => item.status === "in_progress");
    return completed > 0 && Boolean(inProgress);
}

function buildPlanSyncNudge(): string {
    return `<workflow-plan-sync>
Observed workflow evidence suggests that the current plan step may be complete.
Review the actual work and validation.
If it is complete, update_plan and mark it completed.
If it is not complete, leave it in_progress and continue.
Do not mark it complete merely because of this reminder.
</workflow-plan-sync>`;
}

function buildReadOnlyStallNudge(): string {
    return `<workflow-read-only-stall>
Recent operations are mostly READ/SEARCH/LIST without converging on a mutation.
With enough evidence, start the smallest possible PATCH/WRITE plus validation.
If information is missing, do targeted reads only.
If the plan is no longer accurate, update_plan before continuing.
If there is a blocker, state it explicitly.
</workflow-read-only-stall>`;
}

function buildRedundantReadNudge(relativePath: string): string {
    return `<workflow-redundant-read>
${relativePath} was already read this phase and the repository signature has not changed.
Skip the full re-read unless a mutation invalidated the snapshot or a repository guard requires it.
</workflow-redundant-read>`;
}

function shouldTriggerPlanSync(state: WorkflowState): string | undefined {
    const plan = state.activePlan;
    if (!plan) return undefined;
    const inProgress = plan.items.find((item) => item.status === "in_progress");
    if (!inProgress?.planItemId) return undefined;
    const phaseId = state.activePhaseId;
    if (!phaseId) return undefined;
    if (!hasCompletionEvidence(state, phaseId) && !planObjectiveAdvanced(state)) return undefined;
    const key = planSyncKey(inProgress.planItemId, plan.revision);
    if (planSyncNudgeAlreadySent(state, key)) return undefined;
    recordPlanSyncNudge(state, key);
    return buildPlanSyncNudge();
}

function shouldTriggerReadOnlyStall(state: WorkflowState): string | undefined {
    const phaseId = state.activePhaseId;
    if (!phaseId) return undefined;
    if (state.supervisor.readOnlyStallSentPhaseId === phaseId) return undefined;
    if (state.supervisor.mutationSeen) return undefined;
    const observationCount = state.supervisor.observationCount;
    const observationTokens = state.supervisor.observationTokens;
    if (observationCount < READ_ONLY_STALL_OPERATION_THRESHOLD && observationTokens < READ_ONLY_STALL_TOKEN_THRESHOLD) {
        return undefined;
    }
    state.supervisor.readOnlyStallSentPhaseId = phaseId;
    return buildReadOnlyStallNudge();
}

function normalizedPath(value: string): string {
    return value.replace(/\\/g, "/").toLowerCase();
}

function fileSignatureUnchanged(state: WorkflowState, relativePath: string): boolean {
    const repo = state.repoBridge;
    if (!repo.repoRoot) return false;
    const file = Object.values(repo.files).find((snapshot) => normalizedPath(snapshot.relativePath) === normalizedPath(relativePath));
    if (!file) return false;
    if (file.stale) return false;
    if (file.lastReadPhaseId !== state.activePhaseId) return false;
    return true;
}

function shouldTriggerRedundantRead(state: WorkflowState, operation: OperationRecord): string | undefined {
    if (operation.type !== "READ") return undefined;
    const phaseId = state.activePhaseId;
    if (!phaseId || phaseId !== operation.phaseId) return undefined;
    if (operation.repositoryGuard?.status === "POST_MUTATION_REREAD_REQUIRED") return undefined;
    for (const candidate of operation.paths) {
        const normalized = normalizedPath(candidate);
        if (!normalized) continue;
        if (!fileSignatureUnchanged(state, candidate)) continue;
        const lastSentAt = state.supervisor.redundantReadSent[normalized];
        if (lastSentAt !== undefined && Date.now() - lastSentAt < 60_000) continue;
        state.supervisor.redundantReadSent[normalized] = Date.now();
        return buildRedundantReadNudge(candidate);
    }
    return undefined;
}

export function observeOperationForSupervisor(state: WorkflowState, operation: OperationRecord): void {
    if (operation.phaseId !== state.activePhaseId) return;
    if (READ_ONLY_OPERATION_TYPES.has(operation.type)) {
        state.supervisor.observationCount += 1;
        state.supervisor.observationTokens += operation.visibleTokens;
    } else if (MUTATION_OPERATION_TYPES.has(operation.type)) {
        state.supervisor.mutationSeen = true;
    } else if (VALIDATION_OPERATION_TYPES.has(operation.type) && operation.outcome === "PASS") {
        state.supervisor.completionEvidenceSeen = true;
    }
}

export function redundantReadNudgeForOperation(state: WorkflowState, operation: OperationRecord): string | undefined {
    return shouldTriggerRedundantRead(state, operation);
}

export function executionSupervisorNudge(state: WorkflowState): string | undefined {
    const planSync = shouldTriggerPlanSync(state);
    if (planSync) return planSync;
    const readOnlyStall = shouldTriggerReadOnlyStall(state);
    if (readOnlyStall) return readOnlyStall;
    return undefined;
}
