/**
 * Grok Build offline usage importer.
 *
 * Scans Grok Build session `updates.jsonl` files for `turn_completed`
 * events carrying per-model usage counters, and backfills them into the
 * unified usage ledger.
 *
 * Event shape (matches cc-switch `parse_grok_usage_events`):
 *   {
 *     "timestamp": <epoch-seconds>,
 *     "method": "_x.ai/session/update",
 *     "params": { "update": {
 *       "sessionUpdate": "turn_completed",
 *       "prompt_id": "<uuid>",
 *       "usage": {
 *         "costIsPartial": false,
 *         "modelUsage": { "<model>": {
 *           "inputTokens", "outputTokens", "cachedReadTokens",
 *           "apiDurationMs", "modelCalls", "costUsdTicks", "costIsPartial"
 *         } }
 *       }
 *     } }
 *   }
 *
 * Records are deduped by stable id `grok_session:<sessionId>:<prompt_id>`.
 * The settle window (±5min) defers events too close to a proxy capture of
 * the same request.
 */

import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendUsage } from "../store.js";
import { shouldSkip, notifyAppended, type TokenSig } from "./dedup.js";
import { grokbuildRoots } from "./paths.js";
import { setCursor, getCursor, type SyncCursor } from "./sync-state.js";
import type { UsageRecord, DataSource } from "../types.js";

export type GrokBuildImportResult = {
    scannedFiles: number;
    imported: number;
    skipped: number;
    deferred: number;
    errors: string[];
};

const DATA_SOURCE: DataSource = "grok_session";
const SETTLE_WINDOW_MS = 5 * 60 * 1000;

type GrokCounters = {
    input: number;
    output: number;
    cached: number;
    apiMs: number;
    costTicks: number;
    costPartial: boolean;
};

type GrokUsageEvent = {
    createdAt: number;
    promptId: string;
    costIsPartial: boolean;
    perModel: Array<{ model: string; counters: GrokCounters }>;
};

/** Top-level entry: scan every Grok Build session root for updates.jsonl. */
export async function syncGrokBuild(): Promise<GrokBuildImportResult> {
    const result: GrokBuildImportResult = {
        scannedFiles: 0,
        imported: 0,
        skipped: 0,
        deferred: 0,
        errors: [],
    };

    const files = await collectGrokFiles();
    result.scannedFiles = files.length;

    for (const file of files) {
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

async function collectGrokFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const root of grokbuildRoots()) {
        let rootExists = false;
        try {
            rootExists = (await stat(root)).isDirectory();
        } catch {
            rootExists = false;
        }
        if (!rootExists) continue;
        const found = await collectFilesNamed(root, "updates.jsonl", 0);
        files.push(...found);
    }
    return files;
}

async function collectFilesNamed(
    root: string,
    name: string,
    depth: number,
): Promise<string[]> {
    const MAX_DEPTH = 16;
    if (depth > MAX_DEPTH) return [];
    const out: string[] = [];
    const entries = await safeReaddir(root, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            const sub = await collectFilesNamed(fullPath, name, depth + 1);
            out.push(...sub);
        } else if (entry.name === name) {
            out.push(fullPath);
        }
    }
    return out;
}

async function syncSingleFile(filePath: string): Promise<{ imported: number; skipped: number; deferred: number }> {
    const fileStat = await stat(filePath);
    const lastModifiedMs = fileStat.mtimeMs;
    const prev = await getCursor(filePath);
    if (prev && lastModifiedMs <= prev.lastModified) {
        return { imported: 0, skipped: 0, deferred: 0 };
    }

    const sessionId = path.basename(path.dirname(filePath));
    const events: GrokUsageEvent[] = [];
    const rl = createInterface({
        input: createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        if (!line.trim()) continue;
        let value: Record<string, unknown>;
        try {
            value = JSON.parse(line) as Record<string, unknown>;
        } catch {
            continue;
        }
        if (value.method !== "_x.ai/session/update") continue;
        const params = value.params as Record<string, unknown> | undefined;
        const update = params?.update as Record<string, unknown> | undefined;
        if (!update) continue;
        const kind = update.sessionUpdate as string | undefined;
        if (kind && kind !== "turn_completed") continue;
        const usage = update.usage as Record<string, unknown> | undefined;
        if (!usage || typeof usage !== "object") continue;
        const createdAt = parseEventTimestamp(value.timestamp);
        if (createdAt === undefined) continue;
        const promptId = (update.prompt_id as string | undefined) ?? "";
        const costIsPartial = (usage.costIsPartial as boolean | undefined) ?? false;
        const perModel = parseModelUsage(usage);
        events.push({ createdAt, promptId, costIsPartial, perModel });
    }

    let imported = 0;
    let skipped = 0;
    let deferred = 0;
    const now = Date.now();

    for (const event of events) {
        if (now - event.createdAt < SETTLE_WINDOW_MS) {
            deferred++;
            continue;
        }
        for (const { model, counters } of event.perModel) {
            if (counters.input === 0 && counters.output === 0 && counters.cached === 0) continue;
            const sig: TokenSig = {
                freshInput: counters.input,
                output: counters.output,
                cacheRead: counters.cached,
                cacheCreation: 0,
            };
            const turnKey = event.promptId || `idx${imported + skipped}`;
            const sourceRequestId = `grok_session:${sessionId}:${turnKey}:${model}`;
            const skip = await shouldSkip({
                dataSource: DATA_SOURCE,
                protocol: "openai",
                sourceRequestId,
                model,
                sig,
                timestamp: event.createdAt,
            });
            if (skip) {
                skipped++;
                continue;
            }
            const rec = buildGrokRecord({
                sessionId,
                model,
                timestamp: new Date(event.createdAt).toISOString(),
                counters,
                costIsPartial: event.costIsPartial || counters.costPartial,
                sourceRequestId,
            });
            await appendUsage(rec);
            notifyAppended(rec);
            imported++;
        }
    }

    const cursor: SyncCursor = {
        lastModified: lastModifiedMs,
        lastLineOffset: 0,
        importedCount: imported,
        lastSyncedAt: Date.now(),
    };
    await setCursor(filePath, cursor);
    return { imported, skipped, deferred };
}

function parseModelUsage(usage: Record<string, unknown>): Array<{ model: string; counters: GrokCounters }> {
    const modelUsage = usage.modelUsage as Record<string, Record<string, unknown>> | undefined;
    const out: Array<{ model: string; counters: GrokCounters }> = [];
    if (modelUsage) {
        for (const [model, counters] of Object.entries(modelUsage)) {
            out.push({ model, counters: parseGrokCounters(counters) });
        }
    } else {
        // Fallback: top-level per-turn values
        out.push({ model: "unknown", counters: parseGrokCounters(usage) });
    }
    out.sort((a, b) => a.model.localeCompare(b.model));
    return out;
}

function parseGrokCounters(value: Record<string, unknown>): GrokCounters {
    return {
        input: num(value.inputTokens),
        output: num(value.outputTokens),
        cached: num(value.cachedReadTokens),
        apiMs: num(value.apiDurationMs),
        costTicks: num(value.costUsdTicks),
        costPartial: (value.costIsPartial as boolean | undefined) ?? false,
    };
}

function parseEventTimestamp(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "number") {
        // epoch seconds (or ms if > 1e11)
        return value > 100_000_000_000 ? value : value * 1000;
    }
    if (typeof value === "string") {
        const d = Date.parse(value);
        if (!Number.isNaN(d)) return d;
    }
    return undefined;
}

function buildGrokRecord(opts: {
    sessionId: string;
    model: string;
    timestamp: string;
    counters: GrokCounters;
    costIsPartial: boolean;
    sourceRequestId: string;
}): UsageRecord {
    // Grok Build: inputTokens INCLUDES cachedReadTokens (TOTAL semantics).
    // fresh = input - cached.
    const freshInput = Math.max(0, opts.counters.input - opts.counters.cached);
    const rec: UsageRecord = {
        id: randomUUID(),
        timestamp: opts.timestamp,
        sessionId: opts.sessionId,
        protocol: "openai",
        dataSource: DATA_SOURCE,
        sourceRequestId: opts.sourceRequestId,
        provider: "grok",
        model: opts.model,
        inputTokens: opts.counters.input,
        freshInputTokens: freshInput,
        outputTokens: opts.counters.output,
        cacheReadTokens: opts.counters.cached,
        cacheCreationTokens: 0,
        latencyMs: opts.counters.apiMs,
    };
    return rec;
}

function num(v: unknown): number {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return 0;
}

async function safeReaddir(
    dir: string,
    opts: { withFileTypes: true },
): Promise<import("node:fs").Dirent[]> {
    try {
        const { readdir } = await import("node:fs/promises");
        return await readdir(dir, opts);
    } catch {
        return [];
    }
}
