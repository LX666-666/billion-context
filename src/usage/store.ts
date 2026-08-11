/**
 * Request ledger store — a zero-dependency JSONL append file.
 *
 * Rationale: the project targets Node ≥20 with no runtime deps and no SQLite;
 * `node:sqlite` needs 22.5+ and better-sqlite3 is a native module. A JSONL
 * append log fits the existing file-based persistence (persist.ts) and, for a
 * personal proxy's request volume, scanning a few MB on demand is fast.
 *
 * Reads are incremental: we remember the byte offset of the last read and only
 * parse new bytes on the next query, so repeated aggregations are O(new data).
 * The file never gets rewritten in place; rotation is a future concern.
 */

import { appendFile, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../paths.js";
import type { Protocol, UsageRecord } from "./types.js";

export type UsageQuery = {
    from?: number;      // ms epoch, inclusive
    to?: number;        // ms epoch, inclusive
    protocol?: Protocol;
    provider?: string;
    model?: string;
    /** Filter by origin (proxy vs offline importers). */
    dataSource?: string;
};

export function usageFile(): string {
    const env = process.env.BILI_USAGE_FILE;
    if (env && env.length > 0) return path.resolve(env);
    return path.join(dataDir(), "usage.jsonl");
}

/** Cache of every parsed record so far, plus the file size we read up to. */
let cache: UsageRecord[] = [];
let cacheLoaded = false;
let lastSize = 0;
let lastLoadedMs = 0;
let writeChain: Promise<void> = Promise.resolve();

function parseLine(line: string): UsageRecord | undefined {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    try {
        const rec = JSON.parse(trimmed) as UsageRecord;
        if (typeof rec?.id !== "string" || typeof rec?.timestamp !== "string") return undefined;
        return rec;
    } catch {
        return undefined;
    }
}

/** Append a record to the ledger. Serialized through a promise chain so
 *  concurrent request handlers never interleave partial lines. */
export function appendUsage(record: UsageRecord): Promise<void> {
    writeChain = writeChain.then(async () => {
        const file = usageFile();
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, JSON.stringify(record) + "\n", "utf-8");
    });
    return writeChain;
}

/** Read the ledger, pulling in any bytes appended since the last read.
 *  On first call the whole file is loaded. */
export async function loadUsage(): Promise<UsageRecord[]> {
    const file = usageFile();
    let size = 0;
    try {
        size = (await stat(file)).size;
    } catch {
        // File does not exist yet — nothing to read.
        return cacheLoaded ? [...cache] : [];
    }
    if (cacheLoaded && size === lastSize) return [...cache];
    const handle = await open(file, "r");
    try {
        const start = cacheLoaded ? lastSize : 0;
        const remaining = size - start;
        const buffer = Buffer.alloc(remaining);
        await handle.read(buffer, 0, remaining, start);
        const text = buffer.toString("utf-8");
        const fresh: UsageRecord[] = [];
        for (const line of text.split("\n")) {
            const rec = parseLine(line);
            if (rec) fresh.push(rec);
        }
        if (cacheLoaded) {
            cache = cache.concat(fresh);
        } else {
            cache = fresh;
        }
        lastSize = size;
        cacheLoaded = true;
        lastLoadedMs = Date.now();
    } finally {
        await handle.close().catch(() => {});
    }
    return [...cache];
}

/** Query the ledger with filters. Never touches the network. */
export async function queryUsage(query: UsageQuery = {}): Promise<UsageRecord[]> {
    const all = await loadUsage();
    const fromMs = query.from ?? Number.NEGATIVE_INFINITY;
    const toMs = query.to ?? Number.POSITIVE_INFINITY;
    const out: UsageRecord[] = [];
    for (const rec of all) {
        const ts = Date.parse(rec.timestamp);
        if (Number.isNaN(ts)) continue;
        if (ts < fromMs || ts > toMs) continue;
        if (query.protocol && rec.protocol !== query.protocol) continue;
        if (query.provider && rec.provider !== query.provider) continue;
        if (query.model && rec.model !== query.model) continue;
        if (query.dataSource && (rec.dataSource ?? "proxy") !== query.dataSource) continue;
        out.push(rec);
    }
    return out;
}

/** Reset cached state and file pointer (test hook). */
export function _resetUsageStoreForTest(): void {
    cache = [];
    cacheLoaded = false;
    lastSize = 0;
    lastLoadedMs = 0;
    writeChain = Promise.resolve();
}
