import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../paths.js";
import { log as loggerLog } from "../logger.js";
import type { ProjectHistorySession, ProjectHistorySnapshot, WorkflowState } from "./types.js";

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

export function hydrateProjectMemory(sessionId: string, state: WorkflowState): void {
    if (!state.projectId || state.projectMemoryLoadedAt) return;
    const loaded = loadProjectMemory(state.projectId);
    if (loaded) {
        const current = sessionKey(sessionId);
        state.projectHistory = {
            ...loaded,
            sessions: loaded.sessions.filter((session) => session.sessionKey !== current).slice(-4),
        };
    }
    state.projectMemoryLoadedAt = Date.now();
}

export function saveProjectMemory(sessionId: string, state: WorkflowState): boolean {
    if (!state.projectId) return false;
    const key = sessionKey(sessionId);
    const existing = loadProjectMemory(state.projectId);
    const checkpoints = Object.values(state.checkpoints).sort((a, b) => a.createdAt - b.createdAt);
    const current: ProjectHistorySession = {
        sessionKey: key,
        updatedAt: Date.now(),
        requirements: Object.values(state.requirements).map((requirement) => ({
            id: requirement.id,
            detail: requirement.detail,
            status: requirement.status,
            importance: requirement.importance,
        })),
        checkpoint: {
            objectives: [...new Set(checkpoints.map((checkpoint) => checkpoint.objective))],
            completedWork: checkpoints.map((checkpoint) => checkpoint.completedWork),
            changedFiles: [...new Set(checkpoints.flatMap((checkpoint) => checkpoint.changedFiles))],
            currentState: checkpoints.at(-1)?.currentState ?? "",
            decisions: checkpoints.flatMap((checkpoint) => checkpoint.decisions),
            rejectedApproaches: checkpoints.flatMap((checkpoint) => checkpoint.rejectedApproaches),
            failedAttempts: checkpoints.flatMap((checkpoint) => checkpoint.failedAttempts),
            validation: checkpoints.flatMap((checkpoint) => checkpoint.validation),
            blockers: checkpoints.flatMap((checkpoint) => checkpoint.blockers),
            unresolvedIssues: checkpoints.flatMap((checkpoint) => checkpoint.unresolvedIssues),
            nextActions: checkpoints.flatMap((checkpoint) => checkpoint.nextAction ? [checkpoint.nextAction] : []),
        },
    };
    const sessions = (existing?.sessions ?? []).filter((session) => session.sessionKey !== key);
    sessions.push(current);
    const snapshot: ProjectHistorySnapshot = {
        projectId: state.projectId,
        updatedAt: current.updatedAt,
        sessions: sessions.sort((a, b) => a.updatedAt - b.updatedAt).slice(-20),
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
