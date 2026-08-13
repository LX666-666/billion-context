import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { estimateTokensFast } from "acp-kernel";
import { dataDir } from "../paths.js";
import { log as loggerLog } from "../logger.js";
import { markPhaseRepositoryStateStale } from "./repo-bridge.js";
import type {
    HistoricalRequirement,
    HistoricalRequirementMessage,
    ProjectCheckpoint,
    ProjectHistorySession,
    ProjectHistorySnapshot,
    RequirementRecord,
    SessionCheckpoint,
    TaskRecord,
    WorkflowCheckpoint,
    WorkflowOptions,
    WorkflowState,
} from "./types.js";

function projectFile(projectId: string): string {
    const key = createHash("sha256").update(projectId).digest("hex").slice(0, 32);
    return path.join(dataDir(), "project-memory", `${key}.json`);
}

function sessionKey(sessionId: string): string {
    return createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
}

function validSnapshot(value: unknown, projectId: string): value is ProjectHistorySnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Partial<ProjectHistorySnapshot>;
    return record.projectId === projectId && typeof record.updatedAt === "number" && Array.isArray(record.sessions);
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter((value) => value.trim()))];
}

function uniqueDecisions(values: WorkflowCheckpoint["decisions"]): WorkflowCheckpoint["decisions"] {
    const seen = new Set<string>();
    return values.filter((value) => {
        const key = JSON.stringify([value.decision, value.reason, value.refs]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function historicalRequirement(requirement: RequirementRecord): HistoricalRequirement {
    return {
        id: requirement.id,
        detail: requirement.detail,
        status: requirement.status,
        importance: requirement.importance,
        sourceRefs: [...requirement.sourceRefs],
        preserveRaw: requirement.preserveRaw,
        ...(requirement.rawRef ? { rawRef: requirement.rawRef } : {}),
        ...(requirement.resolvedStatus ? { resolvedStatus: requirement.resolvedStatus } : {}),
        ...(requirement.taskId ? { taskId: requirement.taskId } : {}),
    };
}

function historicalRequirementMessage(
    message: import("./types.js").RequirementMessageRecord,
): HistoricalRequirementMessage {
    return {
        messageId: message.messageId,
        sourceRefs: [...message.sourceRefs],
        detail: message.detail,
        requirementIds: [...message.requirementIds],
        ...(message.rawRef ? { rawRef: message.rawRef } : {}),
        tokenSize: message.tokenSize,
        ...(message.historicalAt ? { historicalAt: message.historicalAt } : {}),
    };
}

function taskCheckpoints(state: WorkflowState, task: TaskRecord | undefined): WorkflowCheckpoint[] {
    const selected = task
        ? task.checkpointIds.map((checkpointId) => state.checkpoints[checkpointId]).filter((checkpoint) => Boolean(checkpoint))
        : Object.values(state.checkpoints);
    return selected.sort((a, b) => a.createdAt - b.createdAt);
}

function taskRequirements(state: WorkflowState, task: TaskRecord | undefined): RequirementRecord[] {
    return task
        ? task.requirementIds.map((requirementId) => state.requirements[requirementId]).filter((requirement) => Boolean(requirement))
        : Object.values(state.requirements);
}

function repositorySnapshot(state: WorkflowState): SessionCheckpoint["repository"] {
    const repo = state.repoBridge;
    if (!repo.repoRoot && !repo.remoteIdentity && !repo.head && repo.dirty === undefined) return undefined;
    return {
        ...(repo.repoRoot ? { repoRoot: repo.repoRoot } : {}),
        ...(repo.remoteIdentity ? { remoteIdentity: repo.remoteIdentity } : {}),
        ...(repo.head ? { head: repo.head } : {}),
        ...(repo.dirty !== undefined ? { dirty: repo.dirty } : {}),
    };
}

export function buildSessionCheckpoint(state: WorkflowState, taskId?: string): SessionCheckpoint {
    const task = taskId ? state.tasks[taskId] : undefined;
    const checkpoints = taskCheckpoints(state, task);
    const requirements = taskRequirements(state, task).map(historicalRequirement);
    const requirementIds = new Set(requirements.map((requirement) => requirement.id));
    const requirementMessages = Object.values(state.requirementMessages)
        .filter((message) => message.requirementIds.some((id) => requirementIds.has(id)))
        .map((message) => historicalRequirementMessage(message));
    const failedAttempts = uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.failedAttempts));
    const blockers = uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.blockers));
    const phaseIds = new Set(task?.phaseIds ?? checkpoints.map((checkpoint) => checkpoint.phaseId));
    const operations = Object.values(state.operations).filter((operation) => phaseIds.has(operation.phaseId));
    const previousHistorian = task?.sessionCheckpoint?.historian;
    return {
        level: "SESSION",
        ...(task ? { taskId: task.taskId, taskStatus: task.status } : {}),
        phaseCheckpointIds: checkpoints.map((checkpoint) => checkpoint.checkpointId),
        requirements,
        requirementMessages,
        requirementStates: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.requirementState ? [checkpoint.requirementState] : [])),
        objectives: uniqueStrings([...(task ? [task.objective] : []), ...checkpoints.map((checkpoint) => checkpoint.objective)]),
        completedWork: uniqueStrings(checkpoints.map((checkpoint) => checkpoint.completedWork)),
        changedFiles: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.changedFiles)),
        currentState: checkpoints.at(-1)?.currentState ?? "",
        decisions: uniqueDecisions(checkpoints.flatMap((checkpoint) => checkpoint.decisions)),
        rejectedApproaches: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.rejectedApproaches)),
        failedAttempts,
        validation: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.validation)),
        blockers,
        unresolvedIssues: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.unresolvedIssues)),
        nextActions: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.nextAction ? [checkpoint.nextAction] : [])),
        importantErrors: uniqueStrings([...failedAttempts, ...blockers]),
        importantCommands: uniqueStrings(operations.flatMap((operation) => operation.command ? [operation.command] : [])),
        criticalRefs: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.criticalRefs)),
        keepRefs: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.keepRefs)),
        rawRefs: uniqueStrings([
            ...requirements.flatMap((requirement) => requirement.rawRef ? [requirement.rawRef] : []),
            ...operations.flatMap((operation) => operation.rawRef ? [operation.rawRef] : []),
            ...checkpoints.flatMap((checkpoint) => checkpoint.criticalRefs),
        ]),
        ...(repositorySnapshot(state) ? { repository: repositorySnapshot(state) } : {}),
        ...(previousHistorian ? { historian: previousHistorian } : {}),
        createdAt: Date.now(),
    };
}

function normalizedTerms(value: string): Set<string> {
    const normalized = value.toLowerCase();
    const terms = normalized.match(/[a-z0-9_.\/-]{2,}|[\u3400-\u9fff]/g) ?? [];
    const chinese = terms.filter((term) => /^[\u3400-\u9fff]$/.test(term));
    const bigrams = chinese.slice(0, -1).map((term, index) => `${term}${chinese[index + 1]}`);
    return new Set([...terms.filter((term) => term.length > 1), ...bigrams]);
}

function similarity(left: string, right: string): number {
    const a = normalizedTerms(left);
    const b = normalizedTerms(right);
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const term of a) if (b.has(term)) intersection++;
    return intersection / Math.max(1, Math.min(a.size, b.size));
}

function taskContext(state: WorkflowState, task: TaskRecord): string {
    const checkpoint = task.sessionCheckpoint;
    const requirements = task.requirementIds.map((id) => state.requirements[id]?.detail ?? "");
    return [
        task.objective,
        ...requirements,
        ...(checkpoint?.changedFiles ?? []),
        ...(checkpoint?.nextActions ?? []),
        ...(checkpoint?.unresolvedIssues ?? []),
    ].join("\n");
}

function shouldStartNewTask(state: WorkflowState, task: TaskRecord, detail: string): boolean {
    if (/\b(?:new|separate|unrelated)\s+task\b|(?:新任务|另一个任务|无关任务|单独任务)/i.test(detail)) return true;
    if (/\b(?:continue|continuing|follow[- ]?up|same task|also)\b|(?:继续|接着|上面|刚才|另外|还有|补充|修正)/i.test(detail)) return false;
    if (task.status !== "COMPLETE_CANDIDATE" && state.sessionStatus !== "COMPLETE_CANDIDATE") return false;
    return similarity(detail, taskContext(state, task)) < 0.14;
}

function newTask(state: WorkflowState, objective: string): TaskRecord {
    const now = Date.now();
    const taskId = `task${String(state.nextTaskNumber++).padStart(5, "0")}`;
    const task: TaskRecord = {
        taskId,
        objective,
        status: "ACTIVE",
        requirementIds: [],
        phaseIds: [],
        checkpointIds: [],
        startedAt: now,
        updatedAt: now,
    };
    state.tasks[taskId] = task;
    state.activeTaskId = taskId;
    state.sessionStatus = "ACTIVE";
    return task;
}

function queueHistorian(state: WorkflowState, taskId: string): void {
    if (!state.historian.pendingTaskIds.includes(taskId)) state.historian.pendingTaskIds.push(taskId);
}

export function assignRequirementToTask(state: WorkflowState, requirement: RequirementRecord, sessionId?: string): TaskRecord {
    let task = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
    let crossedBoundary = false;
    if (task && shouldStartNewTask(state, task, requirement.detail)) {
        if (state.activePhaseId) {
            const phase = state.phases[state.activePhaseId];
            if (phase?.status === "ACTIVE") {
                phase.status = "CHECKPOINT_PENDING";
                phase.completedAt = Date.now();
                markPhaseRepositoryStateStale(state, phase.phaseId);
                if (!state.checkpointQueue.includes(phase.phaseId)) state.checkpointQueue.push(phase.phaseId);
            }
            state.activePhaseId = undefined;
        }
        task.status = task.status === "COMPLETE_CANDIDATE" || state.sessionStatus === "COMPLETE_CANDIDATE" ? "COMPLETE" : "SUPERSEDED";
        task.completedAt = Date.now();
        task.updatedAt = task.completedAt;
        task.sessionCheckpoint = buildSessionCheckpoint(state, task.taskId);
        queueHistorian(state, task.taskId);
        state.metrics.taskBoundaries++;
        crossedBoundary = true;
        task = undefined;
    }
    if (!task) task = newTask(state, requirement.detail);
    else if (task.status === "COMPLETE_CANDIDATE") {
        task.status = "ACTIVE";
        task.completedAt = undefined;
        state.sessionStatus = "ACTIVE";
    }
    requirement.taskId = task.taskId;
    if (!task.requirementIds.includes(requirement.id)) task.requirementIds.push(requirement.id);
    task.updatedAt = Date.now();
    if (state.activePhaseId) {
        const phase = state.phases[state.activePhaseId];
        if (phase && !phase.taskId) phase.taskId = task.taskId;
        if (phase?.taskId === task.taskId && !task.phaseIds.includes(phase.phaseId)) task.phaseIds.push(phase.phaseId);
    }
    if (crossedBoundary && sessionId) saveProjectMemory(sessionId, state);
    return task;
}

export function markActiveTaskCompleteCandidate(state: WorkflowState): void {
    const task = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
    if (!task) return;
    task.status = "COMPLETE_CANDIDATE";
    task.updatedAt = Date.now();
}

export function attachCheckpointToTask(state: WorkflowState, checkpoint: WorkflowCheckpoint): void {
    const taskId = checkpoint.taskId ?? state.phases[checkpoint.phaseId]?.taskId ?? state.activeTaskId;
    if (!taskId) return;
    checkpoint.taskId = taskId;
    const task = state.tasks[taskId];
    if (!task) return;
    if (!task.checkpointIds.includes(checkpoint.checkpointId)) task.checkpointIds.push(checkpoint.checkpointId);
    if (!task.phaseIds.includes(checkpoint.phaseId)) task.phaseIds.push(checkpoint.phaseId);
    task.updatedAt = Date.now();
    task.sessionCheckpoint = buildSessionCheckpoint(state, taskId);
    if (task.status !== "ACTIVE" || state.sessionStatus === "COMPLETE_CANDIDATE") queueHistorian(state, taskId);
}

export function loadProjectMemory(projectId: string): ProjectHistorySnapshot | undefined {
    const file = projectFile(projectId);
    if (!existsSync(file)) return undefined;
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        return validSnapshot(parsed, projectId) ? parsed : undefined;
    } catch (error) {
        loggerLog("warn", `[project-memory] could not load ${projectId}: ${String(error)}`);
        return undefined;
    }
}

export function hydrateProjectMemory(sessionId: string, state: WorkflowState, maxSessions = 6): void {
    if (!state.projectId || state.projectMemoryLoadedAt) return;
    const loaded = loadProjectMemory(state.projectId);
    if (loaded) {
        const current = sessionKey(sessionId);
        const sessions = loaded.sessions.filter((session) => session.sessionKey !== current).slice(-maxSessions);
        state.projectHistory = {
            ...loaded,
            sessions,
            ...(sessions.length > 0 ? { projectCheckpoint: mergeProjectCheckpoint(sessions) } : { projectCheckpoint: undefined }),
        };
    }
    state.projectMemoryLoadedAt = Date.now();
}

function mergeRequirements(values: HistoricalRequirement[]): HistoricalRequirement[] {
    const seen = new Set<string>();
    return values.filter((requirement) => {
        const key = JSON.stringify([requirement.detail, requirement.status, requirement.resolvedStatus, requirement.rawRef, requirement.sourceRefs]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function mergeRequirementMessages(values: HistoricalRequirementMessage[]): HistoricalRequirementMessage[] {
    const seen = new Set<string>();
    return values.filter((message) => {
        const key = JSON.stringify([message.messageId, message.detail, message.rawRef, message.requirementIds]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function mergeProjectCheckpoint(sessions: ProjectHistorySession[]): ProjectCheckpoint {
    const checkpoints = sessions.map((session) => session.checkpoint);
    return {
        level: "PROJECT",
        sessionKeys: uniqueStrings(sessions.map((session) => session.sessionKey)),
        requirements: mergeRequirements(sessions.flatMap((session) => session.requirements)),
        requirementMessages: mergeRequirementMessages(sessions.flatMap((session) => session.checkpoint.requirementMessages ?? session.requirementMessages ?? [])),
        requirementStates: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.requirementStates ?? [])),
        objectives: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.objectives)),
        completedWork: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.completedWork)),
        changedFiles: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.changedFiles)),
        currentState: checkpoints.at(-1)?.currentState ?? "",
        decisions: uniqueDecisions(checkpoints.flatMap((checkpoint) => checkpoint.decisions)),
        rejectedApproaches: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.rejectedApproaches)),
        failedAttempts: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.failedAttempts)),
        validation: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.validation)),
        blockers: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.blockers)),
        unresolvedIssues: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.unresolvedIssues)),
        nextActions: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.nextActions)),
        importantErrors: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.importantErrors ?? [])),
        importantCommands: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.importantCommands ?? [])),
        criticalRefs: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.criticalRefs ?? [])),
        keepRefs: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.keepRefs ?? [])),
        rawRefs: uniqueStrings(checkpoints.flatMap((checkpoint) => checkpoint.rawRefs ?? [])),
        repository: checkpoints.at(-1)?.repository,
        createdAt: Date.now(),
    };
}

function taskEntries(sessionId: string, state: WorkflowState): ProjectHistorySession[] {
    const key = sessionKey(sessionId);
    const tasks = Object.values(state.tasks).sort((a, b) => a.startedAt - b.startedAt);
    if (tasks.length === 0) {
        const checkpoint = buildSessionCheckpoint(state);
        return (checkpoint.phaseCheckpointIds?.length || checkpoint.requirements?.length) ? [{
            sessionKey: key,
            updatedAt: Date.now(),
            requirements: checkpoint.requirements ?? [],
            requirementMessages: checkpoint.requirementMessages,
            checkpoint,
        }] : [];
    }
    return tasks.flatMap((task) => {
        const checkpoint = buildSessionCheckpoint(state, task.taskId);
        task.sessionCheckpoint = checkpoint;
        if ((checkpoint.phaseCheckpointIds?.length ?? 0) === 0 && (checkpoint.requirements?.length ?? 0) === 0) return [];
        return [{
            sessionKey: key,
            taskId: task.taskId,
            taskStatus: task.status,
            updatedAt: task.updatedAt,
            requirements: checkpoint.requirements ?? [],
            requirementMessages: checkpoint.requirementMessages,
            checkpoint,
        }];
    });
}

export function saveProjectMemory(sessionId: string, state: WorkflowState): boolean {
    if (!state.projectId) return false;
    const key = sessionKey(sessionId);
    const existing = loadProjectMemory(state.projectId);
    const currentEntries = taskEntries(sessionId, state);
    const currentTaskIds = new Set(currentEntries.map((entry) => entry.taskId ?? "legacy"));
    const sessions = (existing?.sessions ?? []).filter((entry) => {
        if (entry.sessionKey !== key) return true;
        return !currentTaskIds.has(entry.taskId ?? "legacy");
    });
    sessions.push(...currentEntries);
    const retained = sessions.sort((a, b) => a.updatedAt - b.updatedAt).slice(-40);
    const snapshot: ProjectHistorySnapshot = {
        projectId: state.projectId,
        updatedAt: Date.now(),
        sessions: retained,
        projectCheckpoint: mergeProjectCheckpoint(retained),
    };
    try {
        const file = projectFile(state.projectId);
        const dir = path.dirname(file);
        mkdirSync(dir, { recursive: true });
        const temporary = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
        writeFileSync(temporary, JSON.stringify(snapshot), "utf8");
        renameSync(temporary, file);
        return true;
    } catch (error) {
        loggerLog("warn", `[project-memory] could not save ${state.projectId}: ${String(error)}`);
        return false;
    }
}

function responseText(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const choices = record.choices;
    if (Array.isArray(choices)) {
        const message = choices[0] && typeof choices[0] === "object" && !Array.isArray(choices[0])
            ? (choices[0] as Record<string, unknown>).message
            : undefined;
        if (message && typeof message === "object" && !Array.isArray(message)) {
            const content = (message as Record<string, unknown>).content;
            if (typeof content === "string") return content.trim();
        }
    }
    return typeof record.output_text === "string" ? record.output_text.trim() : undefined;
}

function narrative(value: string): string | undefined {
    try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const result = (parsed as Record<string, unknown>).narrative;
            if (typeof result === "string" && result.trim()) return result.trim();
        }
    } catch {
    }
    return value.trim() || undefined;
}

function stableHistorianCheckpoint<T extends SessionCheckpoint | ProjectCheckpoint>(checkpoint: T | undefined): T | undefined {
    if (!checkpoint) return undefined;
    const stable = { ...checkpoint };
    delete stable.historian;
    delete stable.createdAt;
    return stable;
}

function historianInput(state: WorkflowState, task: TaskRecord, maxTokens: number): string {
    const checkpoint = task.sessionCheckpoint ?? buildSessionCheckpoint(state, task.taskId);
    const exact = {
        task: { taskId: task.taskId, objective: task.objective, status: task.status },
        checkpoint: stableHistorianCheckpoint(checkpoint),
        project: stableHistorianCheckpoint(state.projectHistory?.projectCheckpoint),
    };
    let serialized = JSON.stringify(exact);
    if (estimateTokensFast(serialized) <= maxTokens) return serialized;
    const bounded = {
        task: exact.task,
        checkpoint: {
            requirements: [...(checkpoint.requirements ?? [])],
            requirementStates: [...(checkpoint.requirementStates ?? [])],
            objectives: [...checkpoint.objectives],
            changedFiles: [...checkpoint.changedFiles],
            currentState: checkpoint.currentState,
            decisions: [...checkpoint.decisions],
            blockers: [...checkpoint.blockers],
            unresolvedIssues: [...checkpoint.unresolvedIssues],
            nextActions: [...checkpoint.nextActions],
            importantErrors: [...(checkpoint.importantErrors ?? [])],
            importantCommands: [...(checkpoint.importantCommands ?? [])],
            criticalRefs: [...(checkpoint.criticalRefs ?? [])],
            rawRefs: [...(checkpoint.rawRefs ?? [])],
            repository: checkpoint.repository,
        },
    };
    serialized = JSON.stringify(bounded);
    const arrays = [
        bounded.checkpoint.requirements,
        bounded.checkpoint.decisions,
        bounded.checkpoint.importantErrors,
        bounded.checkpoint.importantCommands,
        bounded.checkpoint.blockers,
        bounded.checkpoint.unresolvedIssues,
        bounded.checkpoint.changedFiles,
        bounded.checkpoint.objectives,
        bounded.checkpoint.nextActions,
        bounded.checkpoint.criticalRefs,
        bounded.checkpoint.rawRefs,
    ];
    while (estimateTokensFast(serialized) > maxTokens) {
        const target = arrays.sort((a, b) => b.length - a.length).find((values) => values.length > 1);
        if (!target) break;
        target.shift();
        serialized = JSON.stringify(bounded);
    }
    if (estimateTokensFast(serialized) > maxTokens) {
        bounded.checkpoint.currentState = "[oversized exact currentState retained in deterministic session memory]";
        serialized = JSON.stringify(bounded);
    }
    if (estimateTokensFast(serialized) > maxTokens) {
        serialized = JSON.stringify({
            task: { taskId: task.taskId, status: task.status },
            checkpoint: {
                phaseCount: checkpoint.phaseCheckpointIds?.length ?? 0,
                requirementCount: checkpoint.requirements?.length ?? 0,
                decisionCount: checkpoint.decisions.length,
                unresolvedCount: checkpoint.unresolvedIssues.length,
                sourceChecksum: createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex"),
            },
        });
    }
    return serialized;
}

export async function runCheapHistorian(
    sessionId: string,
    state: WorkflowState,
    options: WorkflowOptions,
): Promise<boolean> {
    const historian = options.historian;
    if (!historian.enabled || !historian.endpoint || !historian.model || state.historian.pendingTaskIds.length === 0) return false;
    if (state.historian.lastRunAt && Date.now() - state.historian.lastRunAt < 1_000) return false;
    const taskId = state.historian.pendingTaskIds[0];
    const task = state.tasks[taskId];
    if (!task) {
        state.historian.pendingTaskIds.shift();
        return false;
    }
    task.sessionCheckpoint = buildSessionCheckpoint(state, taskId);
    const input = historianInput(state, task, historian.maxInputTokens);
    const sourceChecksum = createHash("sha256").update(input).digest("hex");
    if (task.sessionCheckpoint.historian?.sourceChecksum === sourceChecksum) {
        state.historian.pendingTaskIds.shift();
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), historian.timeoutMs);
    state.historian.lastRunAt = Date.now();
    try {
        const response = await fetch(historian.endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(historian.apiKey ? { authorization: `Bearer ${historian.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: historian.model,
                temperature: 0,
                max_tokens: historian.maxOutputTokens,
                messages: [
                    {
                        role: "system",
                        content: "You are a loss-averse coding project historian. Return JSON with one narrative field. Summarize only the supplied structured checkpoints. Preserve decision reasons, exact errors, paths, identifiers, blockers and unresolved work. Never infer current repository code.",
                    },
                    { role: "user", content: input },
                ],
            }),
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = responseText(await response.json());
        const result = text ? narrative(text) : undefined;
        if (!result) throw new Error("empty response");
        task.sessionCheckpoint.historian = {
            model: historian.model,
            narrative: result,
            sourceChecksum,
            generatedAt: Date.now(),
        };
        state.historian.pendingTaskIds.shift();
        state.historian.lastModel = historian.model;
        state.historian.lastError = undefined;
        state.metrics.historianRuns++;
        saveProjectMemory(sessionId, state);
        return true;
    } catch (error) {
        state.historian.lastError = String(error);
        state.metrics.historianFailures++;
        loggerLog("warn", `[workflow-historian] ${taskId} fallback: ${String(error)}`);
        return false;
    } finally {
        clearTimeout(timer);
    }
}
