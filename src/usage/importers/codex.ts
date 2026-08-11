/**
 * Codex CLI offline usage importer.
 *
 * Scans `$CODEX_HOME/sessions/` (date-partitioned: `YYYY/MM/DD/*.jsonl`) and
 * `$CODEX_HOME/archived_sessions/*.jsonl` for rollout transcripts and
 * backfills them into the unified usage ledger.
 *
 * Codex rollouts emit cumulative `total_token_usage` snapshots at each turn.
 * To get per-turn deltas we subtract the previous snapshot for the same
 * thread, clamping negatives to zero (counter reset on session resumption).
 * This mirrors cc-switch `compute_delta` / `sync_codex_usage`.
 *
 * Each event line carries one of:
 *   - `session_meta` — establishes thread id + model
 *   - `turn_context` — turn boundary, may carry `model`
 *   - `event_msg` with `token_count` — the cumulative snapshot we delta
 *
 * Only events whose cumulative counters advance produce a delta record.
 * The stable id is the rollout's thread id (extracted from the filename or
 * `session_meta`), making re-runs idempotent.
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendUsage } from "../store.js";
import { shouldSkip, notifyAppended, type TokenSig } from "./dedup.js";
import { codexSessionsDir, codexArchivedSessionsDir } from "./paths.js";
import { setCursor, getCursor, type SyncCursor } from "./sync-state.js";
import type { UsageRecord, DataSource } from "../types.js";

export type CodexImportResult = {
    scannedFiles: number;
    imported: number;
    skipped: number;
    deferred: number;
    errors: string[];
};

const DATA_SOURCE: DataSource = "codex_session";

type Cumulative = {
    input: number;
    cachedInput: number;
    output: number;
    lastTotalInput?: number;
    lastTotalOutput?: number;
    lastTotalCached?: number;
};

type ParsedEvent = {
    threadId?: string;
    model: string;
    timestamp?: string;
    cumulative: Cumulative;
    lineOffset: number;
};

/** Top-level entry: scan both live and archived session dirs. */
export async function syncCodex(): Promise<CodexImportResult> {
    const result: CodexImportResult = {
        scannedFiles: 0,
        imported: 0,
        skipped: 0,
        deferred: 0,
        errors: [],
    };

    const sessionFiles = await collectSessionFiles(codexSessionsDir(), true);
    const archivedFiles = await collectSessionFiles(codexArchivedSessionsDir(), false);
    const allFiles = [...sessionFiles, ...archivedFiles];
    result.scannedFiles = allFiles.length;

    for (const file of allFiles) {
        try {
            const r = await syncSingleFile(file);
            result.imported += r.imported;
            result.skipped += r.skipped;
            result.deferred += r.deferred;
        } catch (e) {
            result.errors.push(`${file}: ${(e as Error).message}`);
        }
    }

    return result;
}

/** Collect rollout JSONL files. `datePartitioned=true` descends into
 *  `YYYY/MM/DD/` subdirectories (live sessions layout). */
async function collectSessionFiles(dir: string, datePartitioned: boolean): Promise<string[]> {
    let dirExists = false;
    try {
        const st = await stat(dir);
        dirExists = st.isDirectory();
    } catch {
        return [];
    }
    if (!dirExists) return [];

    const files: string[] = [];
    if (datePartitioned) {
        // sessions/YYYY/MM/DD/*.jsonl
        const years = await safeReaddir(dir);
        for (const year of years) {
            const months = await safeReaddir(path.join(dir, year));
            for (const month of months) {
                const days = await safeReaddir(path.join(dir, year, month));
                for (const day of days) {
                    const dayDir = path.join(dir, year, month, day);
                    const dayFiles = await safeReaddir(dayDir);
                    for (const f of dayFiles) {
                        if (f.endsWith(".jsonl")) files.push(path.join(dayDir, f));
                    }
                }
            }
        }
    } else {
        // archived_sessions/*.jsonl (flat)
        const entries = await safeReaddir(dir);
        for (const f of entries) {
            if (f.endsWith(".jsonl")) files.push(path.join(dir, f));
        }
    }
    return files;
}

/** Parse one rollout file into delta events. */
async function syncSingleFile(filePath: string): Promise<{ imported: number; skipped: number; deferred: number }> {
    const fileStat = await stat(filePath);
    const lastModifiedMs = fileStat.mtimeMs;
    const prev = await getCursor(filePath);
    if (prev && lastModifiedMs <= prev.lastModified) {
        return { imported: 0, skipped: 0, deferred: 0 };
    }

    // Extract thread id from filename: rollout-<uuid>.jsonl or rollout-<timestamp>-<uuid>.jsonl
    const fileName = path.basename(filePath);
    const threadId = extractThreadId(fileName) ?? fileName.replace(/\.jsonl$/, "");

    let currentModel = "unknown";
    let currentThreadId: string | undefined = threadId;
    let previousCumulative: Cumulative | undefined;
    let lineOffset = 0;
    let imported = 0;
    let skipped = 0;
    // Turn index within this rollout — distinguishes each cumulative snapshot
    // so the stable-id dedup key (ds:sourceRequestId) is unique per turn,
    // not shared across the whole thread (which would drop all but the first).
    let turnIndex = 0;

    const rl = createInterface({
        input: createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        lineOffset++;
        if (!line.trim()) continue;

        // Quick filter: only lines that could carry metadata or tokens
        const isMeta = line.includes('"session_meta"');
        const isTurnContext = line.includes('"turn_context"');
        const isEventMsg = line.includes('"event_msg"');
        if (!isMeta && !isTurnContext && !isEventMsg) continue;
        if (isEventMsg && !line.includes('"token_count"')) continue;

        let value: Record<string, unknown>;
        try {
            value = JSON.parse(line) as Record<string, unknown>;
        } catch {
            continue;
        }

        // session_meta: extract thread_id + model
        if (isMeta) {
            const payload = value.payload as Record<string, unknown> | undefined;
            if (payload) {
                const id = payload.thread_id as string | undefined;
                if (id) currentThreadId = id;
                const model = payload.model as string | undefined;
                if (model) currentModel = normalizeCodexModel(model);
            }
            continue;
        }

        // turn_context: may update model
        if (isTurnContext) {
            const payload = value.payload as Record<string, unknown> | undefined;
            if (payload) {
                const model = payload.model as string | undefined;
                if (model) currentModel = normalizeCodexModel(model);
            }
            continue;
        }

        // event_msg with payload.type == "token_count": cumulative snapshot.
        // Codex rollouts store the counters at payload.info.total_token_usage
        // (and last_token_usage) — NOT at payload.token_count. Older builds
        // once used payload.token_count directly; accept both shapes.
        const payload = value.payload as Record<string, unknown> | undefined;
        if (!payload) continue;
        const payloadType = typeof payload.type === "string" ? (payload.type as string) : "";
        if (payloadType !== "token_count") continue;

        const info = payload.info as Record<string, unknown> | undefined;
        const tokenCount = (info && (info.total_token_usage as Record<string, unknown> | undefined))
            ?? (payload.token_count as Record<string, unknown> | undefined);
        if (!tokenCount) continue;

        const cumulative = parseCumulative(tokenCount);
        if (!cumulative) continue;
        turnIndex++;

        const timestamp = value.timestamp as string | undefined;
        const delta = computeDelta(previousCumulative, cumulative);

        if (!delta.isZero()) {
            const ts = timestamp ? Date.parse(timestamp) : Date.now();
            const sig: TokenSig = {
                freshInput: delta.input,
                output: delta.output,
                cacheRead: delta.cachedInput,
                cacheCreation: 0,
            };
            // Stable id must be unique per turn, not per thread — otherwise
            // the dedup index drops every turn after the first in the same
            // rollout (they'd all share the same ds:threadId key).
            const turnRequestId = `${currentThreadId}:turn${turnIndex}`;
            const skip = await shouldSkip({
                dataSource: DATA_SOURCE,
                sourceRequestId: turnRequestId,
                model: currentModel,
                sig,
                timestamp: Number.isNaN(ts) ? Date.now() : ts,
            });
            if (skip) {
                skipped++;
            } else {
                const rec = buildCodexRecord({
                    threadId: currentThreadId,
                    model: currentModel,
                    timestamp: timestamp ?? new Date().toISOString(),
                    delta,
                });
                await appendUsage(rec);
                notifyAppended(rec);
                imported++;
            }
        }

        previousCumulative = cumulative;
    }

    const cursor: SyncCursor = {
        lastModified: lastModifiedMs,
        lastLineOffset: lineOffset,
        importedCount: imported,
        lastSyncedAt: Date.now(),
    };
    await setCursor(filePath, cursor);
    return { imported, skipped, deferred: 0 };
}

type DeltaTokens = {
    input: number;
    cachedInput: number;
    output: number;
    isZero: () => boolean;
};

function computeDelta(prev: Cumulative | undefined, current: Cumulative): DeltaTokens {
    const input = prev ? Math.max(0, current.input - prev.input) : current.input;
    const cachedInput = prev ? Math.max(0, current.cachedInput - prev.cachedInput) : current.cachedInput;
    const output = prev ? Math.max(0, current.output - prev.output) : current.output;
    return {
        input,
        cachedInput,
        output,
        isZero: () => input === 0 && cachedInput === 0 && output === 0,
    };
}

function parseCumulative(tokenCount: Record<string, unknown>): Cumulative | undefined {
    const input = num(tokenCount.input_tokens);
    const cachedInput = num(tokenCount.cached_input_tokens ?? tokenCount.cache_read_input_tokens);
    const output = num(tokenCount.output_tokens);
    // Reject empty objects that carry no counters
    if (
        !("input_tokens" in tokenCount) &&
        !("cached_input_tokens" in tokenCount) &&
        !("cache_read_input_tokens" in tokenCount) &&
        !("output_tokens" in tokenCount) &&
        !("reasoning_output_tokens" in tokenCount) &&
        !("total_tokens" in tokenCount)
    ) {
        return undefined;
    }
    return { input, cachedInput, output };
}

function buildCodexRecord(opts: {
    threadId: string | undefined;
    model: string;
    timestamp: string;
    delta: DeltaTokens;
}): UsageRecord {
    // Codex/OpenAI semantics: input_tokens includes cached; fresh = input - cached.
    // The delta's `input` is the cumulative input delta, `cachedInput` the cached portion.
    const freshInput = Math.max(0, opts.delta.input - opts.delta.cachedInput);
    const rec: UsageRecord = {
        id: randomUUID(),
        timestamp: opts.timestamp,
        protocol: "codex",
        dataSource: DATA_SOURCE,
        sourceRequestId: opts.threadId,
        provider: "chatgpt.com",
        model: opts.model,
        inputTokens: opts.delta.input,
        freshInputTokens: freshInput,
        outputTokens: opts.delta.output,
        cacheReadTokens: opts.delta.cachedInput,
        cacheCreationTokens: 0,
    };
    return rec;
}

/** Extract trailing UUID from a rollout filename. */
function extractThreadId(fileName: string): string | undefined {
    const stem = fileName.replace(/\.jsonl$/, "");
    // rollout-<uuid> or rollout-<timestamp>-<uuid>
    const uuidMatch = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    return uuidMatch?.[0];
}

/** Normalize Codex model names: strip ISO dates, compact dates, lowercase. */
function normalizeCodexModel(raw: string): string {
    let s = raw.trim();
    // Strip ISO date suffix: model-2026-08-10
    s = s.replace(/-\d{4}-\d{2}-\d{2}$/, "");
    // Strip compact date: model-20260810
    s = s.replace(/-\d{8}$/, "");
    return s.toLowerCase();
}

function num(v: unknown): number {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return 0;
}

async function safeReaddir(dir: string): Promise<string[]> {
    try {
        return await readdir(dir);
    } catch {
        return [];
    }
}
