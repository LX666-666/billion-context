import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type {
    OperationRecord,
    RepoBridgeState,
    RepoFileSnapshot,
    RepoGuardViolation,
    WorkflowOptions,
    WorkflowState,
} from "./types.js";

function git(root: string, args: string[], timeoutMs: number): string | undefined {
    try {
        return execFileSync("git", ["-C", root, ...args], {
            encoding: "utf8",
            timeout: timeoutMs,
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return undefined;
    }
}

function normalizeRoot(candidate: string | undefined): string | undefined {
    if (!candidate?.trim()) return undefined;
    try {
        const resolved = path.resolve(candidate.trim());
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return undefined;
        return realpathSync(resolved);
    } catch {
        return undefined;
    }
}

export function workspaceRootFromText(sources: Array<string | undefined>): string | undefined {
    for (const source of sources) {
        if (!source) continue;
        const match = /\x3c(?:cwd|workspace_root)\x3e([^<]+)\x3c\/(?:cwd|workspace_root)\x3e/i.exec(source);
        if (match?.[1]?.trim()) return match[1].trim();
    }
    return undefined;
}

function sanitizedRemote(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const scp = /^(?:[^@/\s]+)@([^:]+):(.+)$/.exec(value.trim());
    if (scp) return `ssh://${scp[1]}/${scp[2]}`.replace(/\.git$/, "");
    try {
        const parsed = new URL(value);
        parsed.username = "";
        parsed.password = "";
        parsed.hash = "";
        parsed.search = "";
        return parsed.toString().replace(/\.git\/?$/, "").replace(/\/$/, "");
    } catch {
        return value.replace(/\.git$/, "");
    }
}

function inside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalInside(root: string, target: string): string | undefined {
    const missing: string[] = [];
    let cursor = path.resolve(target);
    try {
        while (!existsSync(cursor)) {
            const parent = path.dirname(cursor);
            if (parent === cursor) return undefined;
            missing.push(path.basename(cursor));
            cursor = parent;
        }
        const canonical = path.resolve(realpathSync(cursor), ...missing.reverse());
        return inside(root, canonical) ? canonical : undefined;
    } catch {
        return undefined;
    }
}

function pathKey(value: string): string {
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function storedFile(repo: RepoBridgeState, relativePath: string): RepoFileSnapshot | undefined {
    return repo.files[pathKey(relativePath)];
}

function storeFile(repo: RepoBridgeState, snapshot: RepoFileSnapshot): void {
    repo.files[pathKey(snapshot.relativePath)] = snapshot;
}

function operationBase(repo: RepoBridgeState, operation: OperationRecord): string | undefined {
    const root = repo.repoRoot ?? repo.workspaceRoot;
    if (!root) return undefined;
    if (!operation.workdir) return root;
    const candidate = path.isAbsolute(operation.workdir)
        ? path.resolve(operation.workdir)
        : path.resolve(repo.workspaceRoot ?? root, operation.workdir);
    return canonicalInside(root, candidate);
}

function resolveOperationPath(repo: RepoBridgeState, operation: OperationRecord, value: string): { absolute: string; relative: string } | undefined {
    const root = repo.repoRoot ?? repo.workspaceRoot;
    const base = operationBase(repo, operation);
    if (!root || !base || !value.trim()) return undefined;
    const cleaned = value.trim().replace(/^['"]|['"]$/g, "");
    const candidate = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(base, cleaned);
    const absolute = canonicalInside(root, candidate);
    if (!absolute) return undefined;
    return { absolute, relative: path.relative(root, absolute).replace(/\\/g, "/") || "." };
}

function fileSignature(absolute: string, maxBytes: number): { exists: boolean; size: number; mtimeMs: number; signature: string } {
    if (!existsSync(absolute)) return { exists: false, size: 0, mtimeMs: 0, signature: "missing" };
    const stat = statSync(absolute);
    if (!stat.isFile()) {
        return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, signature: `other:${stat.size}:${stat.mtimeMs}` };
    }
    const signature = stat.size <= maxBytes
        ? createHash("sha256").update(readFileSync(absolute)).digest("hex")
        : `stat:${stat.size}:${stat.mtimeMs}`;
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, signature };
}

function captureFile(
    repo: RepoBridgeState,
    operation: OperationRecord,
    value: string,
    options: WorkflowOptions["repoBridge"],
): RepoFileSnapshot | undefined {
    const resolved = resolveOperationPath(repo, operation, value);
    const root = repo.repoRoot ?? repo.workspaceRoot;
    if (!resolved || !root) return undefined;
    const file = fileSignature(resolved.absolute, options.hashMaxBytes);
    const tracked = Boolean(git(root, ["ls-files", "--error-unmatch", "--", resolved.relative], options.gitTimeoutMs));
    return {
        path: resolved.absolute,
        relativePath: resolved.relative,
        ...file,
        tracked,
        stale: false,
        observedAt: Date.now(),
    };
}

function updateStaleMetric(state: WorkflowState): void {
    state.metrics.staleFiles = Object.values(state.repoBridge.files).filter((file) => file.stale).length;
}

function markAllStale(state: WorkflowState, reason: RepoFileSnapshot["staleReason"]): void {
    for (const file of Object.values(state.repoBridge.files)) {
        file.stale = true;
        file.staleReason = reason;
        file.staleGeneration ??= state.repoBridge.refreshGeneration;
    }
    updateStaleMetric(state);
}

export function refreshRepoBridge(
    state: WorkflowState,
    workspaceCandidate: string | undefined,
    options: WorkflowOptions["repoBridge"],
): RepoBridgeState {
    const repo = state.repoBridge;
    if (!options.enabled) return repo;
    const workspaceRoot = normalizeRoot(workspaceCandidate ?? options.workspaceRoot ?? repo.workspaceRoot);
    if (!workspaceRoot) {
        repo.lastError = workspaceCandidate || options.workspaceRoot ? "workspace root is unavailable" : undefined;
        return repo;
    }
    const repoRoot = normalizeRoot(git(workspaceRoot, ["rev-parse", "--show-toplevel"], options.gitTimeoutMs)) ?? workspaceRoot;
    const previousRoot = repo.repoRoot;
    const previousHead = repo.head;
    repo.refreshGeneration++;
    if (previousRoot && previousRoot !== repoRoot) {
        repo.files = {};
        repo.violations = [];
    }
    repo.workspaceRoot = workspaceRoot;
    repo.repoRoot = repoRoot;
    repo.remoteIdentity = sanitizedRemote(git(repoRoot, ["remote", "get-url", "origin"], options.gitTimeoutMs));
    repo.head = git(repoRoot, ["rev-parse", "HEAD"], options.gitTimeoutMs);
    const status = git(repoRoot, ["status", "--porcelain=v1"], options.gitTimeoutMs);
    repo.dirty = status !== undefined ? status.length > 0 : undefined;
    repo.observedAt = Date.now();
    repo.lastError = undefined;
    state.metrics.repoRefreshes++;
    if (previousHead && repo.head && previousHead !== repo.head) markAllStale(state, "HEAD_CHANGED");
    for (const [relative, previous] of Object.entries(repo.files)) {
        try {
            const current = fileSignature(previous.path, options.hashMaxBytes);
            const changed = current.signature !== previous.signature;
            repo.files[relative] = {
                ...previous,
                ...current,
                stale: previous.stale || changed,
                ...(changed ? {
                    staleReason: previous.staleReason ?? "FILE_CHANGED" as const,
                    staleGeneration: previous.staleGeneration ?? repo.refreshGeneration,
                } : {}),
                observedAt: Date.now(),
            };
        } catch {
            previous.stale = true;
            previous.staleReason = "FILE_CHANGED";
            previous.staleGeneration ??= repo.refreshGeneration;
        }
    }
    updateStaleMetric(state);
    return repo;
}

export function repoProjectId(repo: RepoBridgeState): string | undefined {
    const root = repo.repoRoot ?? repo.workspaceRoot;
    if (!root) return undefined;
    const identity = `${repo.remoteIdentity ?? "local"}\n${root.replace(/\\/g, "/").toLowerCase()}`;
    return `project-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function phaseBoundaryExists(state: WorkflowState, phaseId: string): boolean {
    return Object.values(state.phases).some((phase) => phase.phaseId !== phaseId && phase.status !== "ACTIVE");
}

function unresolvedViolations(state: WorkflowState): RepoGuardViolation[] {
    return state.repoBridge.violations.filter((violation) => violation.resolvedAt === undefined);
}

function resolveViolationsAfterRead(state: WorkflowState, operation: OperationRecord, observed: RepoFileSnapshot[]): void {
    for (const violation of unresolvedViolations(state)) {
        if (violation.phaseId !== operation.phaseId) continue;
        const generic = violation.paths.length === 0;
        const allRead = generic
            ? observed.length > 0
            : violation.paths.every((value) => storedFile(state.repoBridge, value)?.lastReadPhaseId === operation.phaseId);
        if (!allRead) continue;
        violation.resolvedAt = Date.now();
        const guarded = state.operations[violation.opId];
        if (guarded?.repositoryGuard?.violationId === violation.violationId) guarded.repositoryGuard.status = "SATISFIED";
    }
}

function blockOperation(state: WorkflowState, operation: OperationRecord, paths: string[], reason: string): void {
    if (operation.repositoryGuard) return;
    const violationId = `guard${String(state.repoBridge.nextViolationNumber++).padStart(5, "0")}`;
    const violation: RepoGuardViolation = {
        violationId,
        phaseId: operation.phaseId,
        opId: operation.opId,
        paths,
        reason,
        createdAt: Date.now(),
    };
    state.repoBridge.violations.push(violation);
    operation.repositoryGuard = { status: "BLOCKED_REREAD", paths, reason, violationId };
    state.metrics.repoGuardBlocks++;
}

export function observeRepositoryOperation(
    state: WorkflowState,
    operation: OperationRecord,
    options: WorkflowOptions["repoBridge"],
): void {
    if (!options.enabled || !state.repoBridge.repoRoot || operation.repositoryObservedAt) return;
    const paths = Array.isArray(operation.paths) ? operation.paths : [];
    const observed = paths.flatMap((value) => {
        try {
            const snapshot = captureFile(state.repoBridge, operation, value, options);
            return snapshot ? [snapshot] : [];
        } catch {
            return [];
        }
    });
    if (operation.type === "READ") {
        for (const snapshot of observed) {
            const previous = storedFile(state.repoBridge, snapshot.relativePath);
            storeFile(state.repoBridge, {
                ...snapshot,
                ...(previous?.lastMutationPhaseId ? { lastMutationPhaseId: previous.lastMutationPhaseId } : {}),
                lastReadPhaseId: operation.phaseId,
                stale: false,
                staleReason: undefined,
                staleGeneration: undefined,
            });
        }
        resolveViolationsAfterRead(state, operation, observed);
        operation.repositoryObservedAt = Date.now();
        updateStaleMetric(state);
        return;
    }
    if (operation.type !== "PATCH" && operation.type !== "WRITE") return;
    const added = new Set((operation.addedPaths ?? []).map(pathKey));
    const requiringRead: string[] = [];
    const crossedBoundary = phaseBoundaryExists(state, operation.phaseId);
    const unresolvedTargets = Math.max(0, paths.length - observed.length);
    const staleFromEarlierRefresh = observed.some((snapshot) => {
        const previous = storedFile(state.repoBridge, snapshot.relativePath);
        return previous?.stale === true
            && previous.staleGeneration !== undefined
            && previous.staleGeneration < state.repoBridge.refreshGeneration;
    });
    if (options.enforceReread && (crossedBoundary || staleFromEarlierRefresh)) {
        if (paths.length === 0 || unresolvedTargets > 0) {
            blockOperation(state, operation, [], "mutation target is outside the repository or could not be resolved safely");
        } else {
            for (const snapshot of observed) {
                if (added.has(pathKey(snapshot.relativePath))) continue;
                const previous = storedFile(state.repoBridge, snapshot.relativePath);
                if (previous?.lastReadPhaseId !== operation.phaseId || previous.stale) requiringRead.push(snapshot.relativePath);
            }
            if (requiringRead.length > 0) {
                blockOperation(state, operation, requiringRead, "current-phase repository read is required before mutation");
            }
        }
    }
    for (const snapshot of observed) {
        const previous = storedFile(state.repoBridge, snapshot.relativePath);
        const blocked = operation.repositoryGuard?.status === "BLOCKED_REREAD";
        storeFile(state.repoBridge, {
            ...snapshot,
            ...(previous?.lastReadPhaseId ? { lastReadPhaseId: previous.lastReadPhaseId } : {}),
            lastMutationPhaseId: operation.phaseId,
            stale: blocked,
            ...(blocked ? {
                staleReason: previous?.staleReason ?? "PHASE_BOUNDARY" as const,
                staleGeneration: previous?.staleGeneration ?? state.repoBridge.refreshGeneration,
            } : { staleReason: undefined, staleGeneration: undefined }),
        });
    }
    operation.repositoryObservedAt = Date.now();
    updateStaleMetric(state);
}

export function markPhaseRepositoryStateStale(state: WorkflowState, phaseId: string): void {
    for (const file of Object.values(state.repoBridge.files)) {
        if (file.lastReadPhaseId !== phaseId && file.lastMutationPhaseId !== phaseId) continue;
        file.stale = true;
        file.staleReason = "PHASE_BOUNDARY";
        file.staleGeneration ??= state.repoBridge.refreshGeneration;
    }
    updateStaleMetric(state);
}

export function repositoryGuardMessage(state: WorkflowState): string | undefined {
    const violations = unresolvedViolations(state);
    const stale = Object.values(state.repoBridge.files).filter((file) => file.stale).slice(-12);
    if (violations.length === 0 && stale.length === 0) return undefined;
    const violationLines = violations.slice(-6).map((violation) => {
        const targets = violation.paths.length > 0 ? violation.paths.join(", ") : "unresolved mutation target";
        return `${violation.violationId} ${violation.opId}: ${targets} — ${violation.reason}`;
    });
    const staleLines = stale.map((file) => `${file.relativePath}: ${file.staleReason ?? "STALE"}`);
    const heading = violations.length > 0
        ? "CONTEXT BLOCKED until repository re-read."
        : "REPOSITORY SNAPSHOTS ARE STALE; re-read before mutation.";
    return `<workflow-repository-guard>\n${heading}\n${[...violationLines, ...staleLines].join("\n")}\nA local mutation may already have run, so do not infer success or current code from old context. Re-read the current repository files, then validate before any further PATCH or WRITE. Repository state wins over requirements, checkpoints, summaries, READ baselines, and patch history as a source of code facts.\n</workflow-repository-guard>`;
}

export function guardedOperationOutput(operation: OperationRecord): string | undefined {
    const guard = operation.repositoryGuard;
    if (!guard) return undefined;
    const targets = guard.paths.length > 0 ? guard.paths.join(", ") : "unresolved mutation target";
    const status = guard.status === "BLOCKED_REREAD" ? "REPOSITORY REREAD REQUIRED" : "REPOSITORY SNAPSHOT REFRESHED";
    return `[${status}]\nop_id: ${operation.opId}\nviolation: ${guard.violationId}\ntargets: ${targets}\nreason: ${guard.reason}\nThe local tool may already have changed the filesystem. Its original output remains withheld from active context; use the current repository snapshot and fresh validation as the source of truth.`;
}
