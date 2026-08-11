/**
 * Cross-source dedup index.
 *
 * The unified ledger receives records from the real-time proxy AND from
 * offline client importers (Claude/Codex/Gemini/OpenCode/Grok). The same
 * physical API request may appear in both, so we dedup.
 *
 * Strategy (matching cc-switch `should_skip_session_insert`):
 *   1. Primary key: `(protocol, sourceRequestId)`.
 *   2. Conservative fallback: protocol, normalized model, the four billing
 *      dimensions, and a ±SETTLE_WINDOW timestamp match.
 *   3. Tuple fallback only merges proxy ↔ session records.
 *
 * The index is a snapshot of what's already in the ledger. It is rebuilt
 * lazily on first access and updated as the ledger grows.
 */

import { open, stat } from "node:fs/promises";
import path from "node:path";
import { usageFile } from "../store.js";
import type { Protocol, UsageRecord } from "../types.js";

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

type TupleEntry = {
    dataSource: string;
    model: string;
    timestamp: number;
};

let stableIndex: Set<string> | undefined;
let tupleIndex: Map<string, TupleEntry[]> | undefined;
let indexedSize = 0;
let indexedFile = "";
let indexLock: Promise<void> = Promise.resolve();

function usageFilePath(): string {
    const env = process.env.BILI_USAGE_FILE;
    return env && env.length > 0 ? path.resolve(env) : usageFile();
}

/** Build (or extend) the in-memory dedup index from the ledger file. */
async function ensureIndex(): Promise<void> {
    const previous = indexLock;
    let release: () => void = () => {};
    indexLock = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        await ensureIndexLocked();
    } finally {
        release();
    }
}

async function ensureIndexLocked(): Promise<void> {
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
    if (rec.sourceRequestId) {
        stableIndex!.add(stableKey(rec.protocol, rec.sourceRequestId));
    }
    const ts = Date.parse(rec.timestamp);
    if (Number.isNaN(ts)) return;
    const sig: TokenSig = {
        freshInput: rec.freshInputTokens,
        output: rec.outputTokens,
        cacheRead: rec.cacheReadTokens,
        cacheCreation: rec.cacheCreationTokens,
    };
    const tupleKey = tupleKeyOf(rec.protocol, sig);
    const arr = tupleIndex!.get(tupleKey) ?? [];
    arr.push({ dataSource: ds, model: normalizeModel(rec.model), timestamp: ts });
    tupleIndex!.set(tupleKey, arr);
}

function stableKey(protocol: Protocol, sourceRequestId: string): string {
    return `${protocol}|${sourceRequestId}`;
}

function tupleKeyOf(protocol: Protocol, sig: TokenSig): string {
    return `${protocol}|${sig.freshInput}|${sig.output}|${sig.cacheRead}|${sig.cacheCreation}`;
}

function normalizeModel(model?: string): string {
    const normalized = model?.trim().toLowerCase() || "unknown";
    const withoutDate = normalized.replace(
        /(?:[-_.]?20\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01]))$/u,
        "",
    );
    return withoutDate.replace(/[-_.]+$/u, "") || "unknown";
}

function modelsCompatible(left: string, right: string): boolean {
    return left === right || left === "unknown" || right === "unknown";
}

function isCrossSourcePair(left: string, right: string): boolean {
    return (left === "proxy") !== (right === "proxy");
}

/** Decide whether a candidate record should be skipped because the ledger
 *  already has it. Returns the reason, or `undefined` if it's new.
 *
 *  Stable-id check: same `(protocol, sourceRequestId)` already indexed.
 *  Tuple check: a proxy/session counterpart with compatible model and token
 *  signature lies within ±SETTLE_WINDOW_MS of the candidate timestamp.
 */
export async function shouldSkip(candidate: {
    dataSource: string;
    protocol: Protocol;
    sourceRequestId?: string;
    model?: string;
    sig: TokenSig;
    timestamp: number;
}): Promise<string | undefined> {
    await ensureIndex();
    const ds = candidate.dataSource;
    if (candidate.sourceRequestId) {
        const key = stableKey(candidate.protocol, candidate.sourceRequestId);
        if (stableIndex!.has(key)) return `duplicate-stable:${key}`;
    }
    const model = normalizeModel(candidate.model);
    const tupleKey = tupleKeyOf(candidate.protocol, candidate.sig);
    const existing = tupleIndex!.get(tupleKey);
    if (existing) {
        for (const entry of existing) {
            if (
                isCrossSourcePair(entry.dataSource, ds)
                && modelsCompatible(entry.model, model)
                && Math.abs(entry.timestamp - candidate.timestamp) <= SETTLE_WINDOW_MS
            ) {
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
    indexLock = Promise.resolve();
}
