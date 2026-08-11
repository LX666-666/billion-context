/**
 * Cross-source dedup index.
 *
 * The unified ledger receives records from the real-time proxy AND from
 * offline client importers (Claude/Codex/Gemini/OpenCode/Grok). The same
 * physical API request may appear in both, so we dedup.
 *
 * Strategy (matching cc-switch `should_skip_session_insert`):
 *   1. Primary key: the protocol-stable id (`sourceRequestId`) — Claude
 *      `message.id`, Codex thread id, Grok `prompt_id`. Same id → skip.
 *   2. Conservative fallback when no stable id: a tuple of
 *      (dataSource, model, token-signature, ±SETTLE_WINDOW seconds).
 *      This only fires when both records lack a stable id; we never
 *      aggressively merge two real distinct requests.
 *
 * The index is a snapshot of what's already in the ledger. It is rebuilt
 * lazily on first access and updated as the ledger grows.
 */

import { readdir, readFile, open, stat } from "node:fs/promises";
import path from "node:path";
import { usageFile } from "../store.js";
import type { UsageRecord } from "../types.js";

/** Window in ms during which a proxy record suppresses a session import of
 *  the same logical request (and vice versa). 5 minutes matches cc-switch. */
export const SETTLE_WINDOW_MS = 5 * 60 * 1000;

/** Token signature for conservative dedup: the 4 billing dimensions. */
export type TokenSig = {
    freshInput: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
};

export type DedupKey = {
    dataSource: string;
    model: string;
    sig: TokenSig;
    timestamp: number;
};

let stableIndex: Set<string> | undefined;
let tupleIndex: Map<string, number[]> | undefined;
let indexedSize = 0;
let indexedFile = "";

function usageFilePath(): string {
    const env = process.env.BILI_USAGE_FILE;
    return env && env.length > 0 ? path.resolve(env) : usageFile();
}

/** Build (or extend) the in-memory dedup index from the ledger file. */
async function ensureIndex(): Promise<void> {
    const file = usageFilePath();
    let size = 0;
    try {
        size = (await stat(file)).size;
    } catch {
        stableIndex = new Set();
        tupleIndex = new Map();
        indexedSize = 0;
        indexedFile = file;
        return;
    }
    if (stableIndex && tupleIndex && file === indexedFile && size === indexedSize) return;
    // Rebuild from scratch — for a personal proxy's volume this is fast.
    stableIndex = new Set();
    tupleIndex = new Map();
    const handle = await open(file, "r");
    try {
        const buf = Buffer.alloc(size);
        await handle.read(buf, 0, size, 0);
        const text = buf.toString("utf-8");
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let rec: UsageRecord;
            try {
                rec = JSON.parse(trimmed) as UsageRecord;
            } catch {
                continue;
            }
            indexRecord(rec);
        }
    } finally {
        await handle.close().catch(() => {});
        indexedSize = size;
        indexedFile = file;
    }
}

/** Insert one record into the in-memory index. */
function indexRecord(rec: UsageRecord): void {
    const ds = rec.dataSource ?? "proxy";
    const model = rec.model ?? "";
    if (rec.sourceRequestId) {
        // Key by dataSource + stable id so that proxy and session with
        // the same protocol id still dedup correctly.
        stableIndex!.add(`${ds}:${rec.sourceRequestId}`);
    }
    const ts = Date.parse(rec.timestamp);
    if (Number.isNaN(ts)) return;
    const sig: TokenSig = {
        freshInput: rec.freshInputTokens,
        output: rec.outputTokens,
        cacheRead: rec.cacheReadTokens,
        cacheCreation: rec.cacheCreationTokens,
    };
    const tupleKey = tupleKeyOf({ dataSource: ds, model, sig, timestamp: ts });
    const arr = tupleIndex!.get(tupleKey) ?? [];
    arr.push(ts);
    tupleIndex!.set(tupleKey, arr);
}

function tupleKeyOf(k: DedupKey): string {
    return `${k.dataSource}|${k.model}|${k.sig.freshInput}|${k.sig.output}|${k.sig.cacheRead}|${k.sig.cacheCreation}`;
}

/** Decide whether a candidate record should be skipped because the ledger
 *  already has it. Returns the reason, or `undefined` if it's new.
 *
 *  Stable-id check: same `(dataSource, sourceRequestId)` already indexed.
 *  Tuple check: an existing record with the same token signature tuple
 *  lies within ±SETTLE_WINDOW_MS of the candidate's timestamp.
 */
export async function shouldSkip(candidate: {
    dataSource: string;
    sourceRequestId?: string;
    model?: string;
    sig: TokenSig;
    timestamp: number;
}): Promise<string | undefined> {
    await ensureIndex();
    const ds = candidate.dataSource;
    if (candidate.sourceRequestId) {
        const key = `${ds}:${candidate.sourceRequestId}`;
        if (stableIndex!.has(key)) return `duplicate-stable:${key}`;
    }
    const model = candidate.model ?? "";
    const tupleKey = tupleKeyOf({
        dataSource: ds,
        model,
        sig: candidate.sig,
        timestamp: candidate.timestamp,
    });
    const existing = tupleIndex!.get(tupleKey);
    if (existing) {
        for (const ts of existing) {
            if (Math.abs(ts - candidate.timestamp) <= SETTLE_WINDOW_MS) {
                return `duplicate-tuple:${tupleKey}`;
            }
        }
    }
    return undefined;
}

/** Direct in-memory add (used right after we append a new record so the
 *  index stays current without a re-read). */
export function notifyAppended(rec: UsageRecord): void {
    if (!stableIndex || !tupleIndex) return;
    indexRecord(rec);
}

/** Test hook: wipe the in-memory index. */
export function _resetDedupIndexForTest(): void {
    stableIndex = undefined;
    tupleIndex = undefined;
    indexedSize = 0;
    indexedFile = "";
}
