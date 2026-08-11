/**
 * Unified usage sync — the single entry that runs every offline importer
 * and returns a per-source breakdown.
 *
 *   POST /__bili/usage/sync        — run all importers (or a subset via ?source=)
 *   GET  /__bili/usage/sync/status — last sync result + per-source presence
 *
 * Response shape (matches the spec):
 *   {
 *     total: { scannedFiles, imported, skipped, duplicates, deferred, errors },
 *     sources: {
 *       claude:        SourceResult,
 *       codex:         SourceResult,
 *       gemini:        SourceResult,
 *       opencode:      SourceResult,
 *       grokbuild:     SourceResult
 *     }
 *   }
 *
 * The status endpoint returns the cached last-sync result plus a `present`
 * boolean per source so the UI can show "○ 无数据" vs "● 已同步 N".
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../../paths.js";
import { syncClaude } from "./claude.js";
import { syncCodex } from "./codex.js";
import { syncGemini } from "./gemini.js";
import { syncOpenCode } from "./opencode.js";
import { syncGrokBuild } from "./grokbuild.js";
import {
    claudeProjectsDir,
    codexSessionsDir,
    codexArchivedSessionsDir,
    geminiHome,
    opencodeDbPath,
    grokbuildRoots,
} from "./paths.js";

export type SourceResult = {
    /** Whether this client's logs exist on the current machine. */
    present: boolean;
    scannedFiles: number;
    imported: number;
    skipped: number;
    duplicates: number;
    deferred: number;
    errors: string[];
    /** "ok" | "no-data" | "deferred" | "error" */
    status: "ok" | "no-data" | "deferred" | "error";
};

export type SyncResult = {
    total: {
        scannedFiles: number;
        imported: number;
        skipped: number;
        duplicates: number;
        deferred: number;
        errors: number;
    };
    sources: {
        claude: SourceResult;
        codex: SourceResult;
        gemini: SourceResult;
        opencode: SourceResult;
        grokbuild: SourceResult;
    };
    startedAt: number;
    finishedAt: number;
    durationMs: number;
};

function syncResultFile(): string {
    const env = process.env.BILI_SYNC_RESULT_FILE;
    return env && env.length > 0 ? path.resolve(env) : path.join(dataDir(), "last-sync.json");
}

let lastSyncResult: SyncResult | undefined;
let syncing = false;

async function loadLastSync(): Promise<SyncResult | undefined> {
    if (lastSyncResult) return lastSyncResult;
    try {
        const raw = await readFile(syncResultFile(), "utf-8");
        lastSyncResult = JSON.parse(raw) as SyncResult;
    } catch {
        // no last sync yet
    }
    return lastSyncResult;
}

async function persistLastSync(result: SyncResult): Promise<void> {
    lastSyncResult = result;
    const file = syncResultFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(result, null, 2) + "\n", "utf-8");
}

function queryParams(url: string): URLSearchParams {
    const q = url.indexOf("?");
    return new URLSearchParams(q >= 0 ? url.slice(q + 1) : "");
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
}

/** Check presence of each client's log directory on this machine. */
async function presence(): Promise<{
    claude: boolean;
    codex: boolean;
    gemini: boolean;
    opencode: boolean;
    grokbuild: boolean;
}> {
    const { stat } = await import("node:fs/promises");
    const check = async (p: string): Promise<boolean> => {
        try {
            return (await stat(p)).isDirectory();
        } catch {
            return false;
        }
    };
    const checkFile = async (p: string): Promise<boolean> => {
        try {
            return (await stat(p)).isFile();
        } catch {
            return false;
        }
    };
    const claudeDir = claudeProjectsDir();
    const codexDir = codexSessionsDir();
    const codexArchDir = codexArchivedSessionsDir();
    const geminiTmp = path.join(geminiHome(), "tmp");
    const grokRoots = grokbuildRoots();
    return {
        claude: await check(claudeDir),
        codex: await check(codexDir),
        gemini: await check(geminiTmp),
        opencode: await checkFile(opencodeDbPath()),
        grokbuild: grokRoots.length > 0 && (await Promise.all(grokRoots.map(check))).some(Boolean),
    };
}

function emptySource(present: boolean): SourceResult {
    return {
        present,
        scannedFiles: 0,
        imported: 0,
        skipped: 0,
        duplicates: 0,
        deferred: 0,
        errors: [],
        status: present ? "no-data" : "no-data",
    };
}

/** Run all (or a subset of) offline importers. */
export async function handleUsageSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (syncing) {
        sendJson(res, { error: "sync already in progress" }, 409);
        return;
    }
    syncing = true;
    const startedAt = Date.now();
    const p = queryParams(req.url ?? "");
    const requestedSource = p.get("source");

    try {
        const present = await presence();
        const sources: SyncResult["sources"] = {
            claude: emptySource(present.claude),
            codex: emptySource(present.codex),
            gemini: emptySource(present.gemini),
            opencode: emptySource(present.opencode),
            grokbuild: emptySource(present.grokbuild),
        };

        const runClaude = !requestedSource || requestedSource === "claude";
        const runCodex = !requestedSource || requestedSource === "codex";
        const runGemini = !requestedSource || requestedSource === "gemini";
        const runOpenCode = !requestedSource || requestedSource === "opencode";
        const runGrok = !requestedSource || requestedSource === "grokbuild";

        const tasks: Array<Promise<void>> = [];
        if (runClaude && present.claude) {
            tasks.push(
                (async () => {
                    const r = await syncClaude();
                    sources.claude = toSourceResult(r, present.claude);
                })(),
            );
        }
        if (runCodex && present.codex) {
            tasks.push(
                (async () => {
                    const r = await syncCodex();
                    sources.codex = toSourceResult(r, present.codex);
                })(),
            );
        }
        if (runGemini && present.gemini) {
            tasks.push(
                (async () => {
                    const r = await syncGemini();
                    sources.gemini = toSourceResult(r, present.gemini);
                })(),
            );
        }
        if (runOpenCode && present.opencode) {
            tasks.push(
                (async () => {
                    const r = await syncOpenCode();
                    sources.opencode = toSourceResult(r, present.opencode);
                })(),
            );
        }
        if (runGrok && present.grokbuild) {
            tasks.push(
                (async () => {
                    const r = await syncGrokBuild();
                    sources.grokbuild = toSourceResult(r, present.grokbuild);
                })(),
            );
        }
        await Promise.all(tasks);

        const total = {
            scannedFiles: sum(sources, "scannedFiles"),
            imported: sum(sources, "imported"),
            skipped: sum(sources, "skipped"),
            duplicates: sum(sources, "duplicates"),
            deferred: sum(sources, "deferred"),
            errors: sum(sources, "errors"),
        };
        const result: SyncResult = {
            total,
            sources,
            startedAt,
            finishedAt: Date.now(),
            durationMs: Date.now() - startedAt,
        };
        await persistLastSync(result);
        sendJson(res, result);
    } catch (e) {
        sendJson(res, { error: (e as Error).message }, 500);
    } finally {
        syncing = false;
    }
}

function toSourceResult(
    r: { scannedFiles: number; imported: number; skipped: number; deferred: number; errors: string[] },
    present: boolean,
): SourceResult {
    const hasErrors = r.errors.length > 0;
    let status: SourceResult["status"] = "ok";
    if (r.imported === 0 && r.scannedFiles === 0 && !hasErrors) status = "no-data";
    else if (r.deferred > 0 && r.imported === 0) status = "deferred";
    else if (hasErrors && r.imported === 0) status = "error";
    return {
        present,
        scannedFiles: r.scannedFiles,
        imported: r.imported,
        skipped: r.skipped,
        duplicates: 0,
        deferred: r.deferred,
        errors: r.errors,
        status,
    };
}

function sum(sources: SyncResult["sources"], key: keyof SourceResult): number {
    let total = 0;
    for (const k of Object.keys(sources) as Array<keyof SyncResult["sources"]>) {
        const v = sources[k][key];
        if (typeof v === "number") total += v;
    }
    return total;
}

/** GET /__bili/usage/sync/status — last sync result + per-source presence. */
export async function handleUsageSyncStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const present = await presence();
    const last = await loadLastSync();
    if (!last) {
        const result: SyncResult = {
            total: {
                scannedFiles: 0,
                imported: 0,
                skipped: 0,
                duplicates: 0,
                deferred: 0,
                errors: 0,
            },
            sources: {
                claude: emptySource(present.claude),
                codex: emptySource(present.codex),
                gemini: emptySource(present.gemini),
                opencode: emptySource(present.opencode),
                grokbuild: emptySource(present.grokbuild),
            },
            startedAt: 0,
            finishedAt: 0,
            durationMs: 0,
        };
        sendJson(res, { lastSync: null, present, result });
        return;
    }
    sendJson(res, { lastSync: last.finishedAt, present, result: last });
}
