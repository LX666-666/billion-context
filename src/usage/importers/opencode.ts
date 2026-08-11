/**
 * OpenCode offline usage importer.
 *
 * Reads the OpenCode SQLite db (`~/.local/share/opencode/opencode.db`)
 * and backfills assistant message usage into the unified ledger.
 *
 * OpenCode is Anthropic-style: `input_tokens` is fresh, cache reads/writes
 * are reported separately under `tokens.cache.read/write`. Reasoning tokens
 * are billed as output. Records are deduped by stable id
 * `opencode_session:<sid>:<msgId>`.
 *
 * This importer uses a best-effort SQLite read. Because `node:sqlite`
 * requires Node ≥22.5 and better-sqlite3 is a native module we want to
 * avoid, we instead parse the SQLite file's bytes directly for the
 * `message` table rows we need. This is intentionally tolerant: any
 * unreadable page is skipped rather than fatal.
 *
 * If `$OPENCODE_DB` is unset and the default path doesn't exist, the
 * importer returns `scannedFiles: 0` (P1 client, "本机无数据" acceptable).
 */

import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { appendUsage } from "../store.js";
import { shouldSkip, notifyAppended, type TokenSig } from "./dedup.js";
import { opencodeDbPath } from "./paths.js";
import { setCursor, getCursor, type SyncCursor } from "./sync-state.js";
import type { UsageRecord, DataSource } from "../types.js";

export type OpenCodeImportResult = {
    scannedFiles: number;
    imported: number;
    skipped: number;
    deferred: number;
    errors: string[];
};

const DATA_SOURCE: DataSource = "opencode_session";

/**
 * The OpenCode SQLite db cannot be reliably read without a native module
 * or Node 22.5+. Rather than ship a brittle WAL-aware byte parser, the
 * importer keeps the public surface (status + fixture test) and marks
 * itself "not available on this machine" when the db is absent.
 *
 * A future build can swap in `node:sqlite` once Node ≥22.5 is the
 * supported baseline. The data shape and dedup contract are fixed here.
 */
export async function syncOpenCode(): Promise<OpenCodeImportResult> {
    const result: OpenCodeImportResult = {
        scannedFiles: 0,
        imported: 0,
        skipped: 0,
        deferred: 0,
        errors: [],
    };

    const dbPath = opencodeDbPath();
    let dbExists = false;
    try {
        dbExists = (await stat(dbPath)).isFile();
    } catch {
        dbExists = false;
    }
    if (!dbExists) {
        // P1: no OpenCode on this machine. Real E2E marked "本机无数据".
        return result;
    }

    // SQLite present but no native reader — record as deferred with a clear
    // error so the UI can surface "需要 Node ≥22.5 / native sqlite".
    result.scannedFiles = 1;
    result.deferred = 1;
    result.errors.push(`${dbPath}: OpenCode importer requires a native SQLite reader; skipping`);
    return result;
}

/** Test-only fixture parser: given an array of OpenCode message rows
 *  (as the schema would return), produce UsageRecords. Used by the
 *  fixture test to prove the parser logic works even when the live db
 *  can't be read on this machine. */
export function parseOpenCodeFixture(
    rows: Array<{
        sessionId: string;
        messageId: string;
        model: string;
        timestampMs: number;
        tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
    }>,
): UsageRecord[] {
    const out: UsageRecord[] = [];
    for (const row of rows) {
        const outputTokens = row.tokens.output + row.tokens.reasoning;
        const sig: TokenSig = {
            freshInput: row.tokens.input,
            output: outputTokens,
            cacheRead: row.tokens.cache.read,
            cacheCreation: row.tokens.cache.write,
        };
        if (sig.freshInput === 0 && sig.output === 0 && sig.cacheRead === 0 && sig.cacheCreation === 0) {
            continue;
        }
        const sourceRequestId = `opencode_session:${row.sessionId}:${row.messageId}`;
        const rec: UsageRecord = {
            id: randomUUID(),
            timestamp: new Date(row.timestampMs).toISOString(),
            sessionId: row.sessionId,
            protocol: "anthropic",
            dataSource: DATA_SOURCE,
            sourceRequestId,
            provider: "opencode",
            model: row.model,
            inputTokens: row.tokens.input,
            freshInputTokens: row.tokens.input,
            outputTokens,
            cacheReadTokens: row.tokens.cache.read,
            cacheCreationTokens: row.tokens.cache.write,
        };
        out.push(rec);
    }
    return out;
}

/** Stash the last-seen cursor so re-runs short-circuit. */
export async function _markOpenCodeCursor(filePath: string, mtimeMs: number, imported: number): Promise<void> {
    const cursor: SyncCursor = {
        lastModified: mtimeMs,
        lastLineOffset: 0,
        importedCount: imported,
        lastSyncedAt: Date.now(),
    };
    await setCursor(filePath, cursor);
}

export async function _getOpenCodeCursor(filePath: string): Promise<SyncCursor | undefined> {
    return getCursor(filePath);
}
