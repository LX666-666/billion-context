/**
 * Gemini CLI offline usage importer.
 *
 * Scans `$GEMINI_HOME/tmp/<project_hash>/chats/session-*.json` for chat
 * transcripts and backfills them into the unified usage ledger.
 *
 * Session file shape (matches cc-switch `sync_gemini_usage`):
 *   {
 *     "sessionId": "...",
 *     "messages": [
 *       { "type": "gemini", "id": "...", "model": "...",
 *         "timestamp": "RFC3339", "tokens": { "input", "output",
 *         "cached", "thoughts" } }, ...
 *     ]
 *   }
 *
 * `thoughts` are merged into `output` (reasoning tokens are billed as
 * output). Records are deduped by stable id `gemini_session:<sid>:<msgId>`.
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendUsage } from "../store.js";
import { shouldSkip, notifyAppended, type TokenSig } from "./dedup.js";
import { geminiHome } from "./paths.js";
import { setCursor, getCursor, type SyncCursor } from "./sync-state.js";
import type { UsageRecord, DataSource } from "../types.js";

export type GeminiImportResult = {
    scannedFiles: number;
    imported: number;
    skipped: number;
    deferred: number;
    errors: string[];
};

const DATA_SOURCE: DataSource = "gemini_session";

/** Top-level entry: scan `$GEMINI_HOME/tmp/<hash>/chats/session-*.json`. */
export async function syncGemini(): Promise<GeminiImportResult> {
    const result: GeminiImportResult = {
        scannedFiles: 0,
        imported: 0,
        skipped: 0,
        deferred: 0,
        errors: [],
    };

    const chatsRoot = path.join(geminiHome(), "tmp");
    let rootExists = false;
    try {
        rootExists = (await stat(chatsRoot)).isDirectory();
    } catch {
        rootExists = false;
    }
    if (!rootExists) return result;

    const files = await collectGeminiFiles(chatsRoot);
    result.scannedFiles = files.length;

    for (const file of files) {
        try {
            const r = await syncSingleFile(file);
            result.imported += r.imported;
            result.skipped += r.skipped;
        } catch (e) {
            result.errors.push(`${file}: ${(e as Error).message}`);
        }
    }

    return result;
}

async function collectGeminiFiles(chatsRoot: string): Promise<string[]> {
    const files: string[] = [];
    const projectHashes = await safeReaddir(chatsRoot);
    for (const hash of projectHashes) {
        const chatsDir = path.join(chatsRoot, hash, "chats");
        try {
            if (!(await stat(chatsDir)).isDirectory()) continue;
        } catch {
            continue;
        }
        const chatFiles = await safeReaddir(chatsDir);
        for (const f of chatFiles) {
            if (f.startsWith("session-") && f.endsWith(".json")) {
                files.push(path.join(chatsDir, f));
            }
        }
    }
    return files;
}

type GeminiTokens = {
    input: number;
    output: number;
    cached: number;
    thoughts: number;
};

function parseGeminiTokens(tokens: Record<string, unknown>): GeminiTokens {
    return {
        input: num(tokens.input),
        output: num(tokens.output),
        cached: num(tokens.cached),
        thoughts: num(tokens.thoughts),
    };
}

async function syncSingleFile(filePath: string): Promise<{ imported: number; skipped: number }> {
    const fileStat = await stat(filePath);
    const lastModifiedMs = fileStat.mtimeMs;
    const prev = await getCursor(filePath);
    if (prev && lastModifiedMs <= prev.lastModified) {
        return { imported: 0, skipped: 0 };
    }

    const content = await readFile(filePath, "utf-8");
    let value: Record<string, unknown>;
    try {
        value = JSON.parse(content) as Record<string, unknown>;
    } catch {
        return { imported: 0, skipped: 0 };
    }

    const sessionId = typeof value.sessionId === "string" ? value.sessionId : "unknown";
    const messages = value.messages;
    if (!Array.isArray(messages)) {
        return { imported: 0, skipped: 0 };
    }

    let imported = 0;
    let skipped = 0;

    for (const msg of messages as Record<string, unknown>[]) {
        if (msg.type !== "gemini") continue;
        const tokensObj = msg.tokens;
        if (!tokensObj || typeof tokensObj !== "object") continue;
        const tokens = parseGeminiTokens(tokensObj as Record<string, unknown>);
        if (tokens.input === 0 && tokens.output === 0 && tokens.thoughts === 0 && tokens.cached === 0) {
            continue;
        }

        const messageId = typeof msg.id === "string" ? msg.id : "unknown";
        const model = typeof msg.model === "string" ? msg.model : "unknown";
        const timestamp = typeof msg.timestamp === "string" ? (msg.timestamp as string) : new Date().toISOString();
        const ts = Date.parse(timestamp);

        // Output includes reasoning/thoughts tokens (billed as output)
        const outputTokens = tokens.output + tokens.thoughts;
        const sig: TokenSig = {
            freshInput: tokens.input,
            output: outputTokens,
            cacheRead: tokens.cached,
            cacheCreation: 0,
        };

        const sourceRequestId = `gemini_session:${sessionId}:${messageId}`;
        const skip = await shouldSkip({
            dataSource: DATA_SOURCE,
            sourceRequestId,
            model,
            sig,
            timestamp: Number.isNaN(ts) ? Date.now() : ts,
        });
        if (skip) {
            skipped++;
            continue;
        }

        const rec: UsageRecord = {
            id: randomUUID(),
            timestamp,
            sessionId,
            protocol: "openai", // Gemini tokens are OpenAI-like (input includes cached)
            dataSource: DATA_SOURCE,
            sourceRequestId,
            provider: "gemini",
            model,
            inputTokens: tokens.input,
            freshInputTokens: Math.max(0, tokens.input - tokens.cached),
            outputTokens,
            cacheReadTokens: tokens.cached,
            cacheCreationTokens: 0,
        };
        await appendUsage(rec);
        notifyAppended(rec);
        imported++;
    }

    const cursor: SyncCursor = {
        lastModified: lastModifiedMs,
        lastLineOffset: 0,
        importedCount: imported,
        lastSyncedAt: Date.now(),
    };
    await setCursor(filePath, cursor);
    return { imported, skipped };
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
