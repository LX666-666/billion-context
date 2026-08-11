/**
 * Claude Code offline usage importer.
 *
 * Scans the projects directory (env CLAUDE_CONFIG_DIR,
 * BILI_CLAUDE_PROJECTS_DIR) for assistant message JSONL transcripts and
 * backfills them into the unified usage ledger.
 *
 * Layout covered (matches cc-switch collect_jsonl_files):
 *   projects / project / star.jsonl                       (main)
 *   projects / project / session / subagents / star.jsonl (subagent)
 *   projects / project / session / subagents / workflows / wf_id / star.jsonl
 *                                                          (workflow)
 *
 * Workflow sub-agents are explicitly traversed - skipping them
 * systematically under-counts usage by roughly 4 percent in practice.
 *
 * Each line of a transcript JSONL is one event. We only care about
 * type == "assistant" lines whose message.usage block carries
 * billing dimensions. Dedup is by message.id (stable across re-reads),
 * preferring the snapshot with a stop_reason, else larger output_tokens.
 */

import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendUsage } from "../store.js";
import { shouldSkip, notifyAppended, type TokenSig } from "./dedup.js";
import { claudeProjectsDir } from "./paths.js";
import { setCursor, getCursor, type SyncCursor } from "./sync-state.js";
import type { UsageRecord, DataSource } from "../types.js";

export type ClaudeImportResult = {
    scannedFiles: number;
    imported: number;
    skipped: number;
    deferred: number;
    errors: string[];
};

const DATA_SOURCE: DataSource = "claude_session";

type ParsedAssistant = {
    messageId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    stopReason: string | undefined;
    timestamp: string | undefined;
    sessionId: string | undefined;
};

/** Top-level entry: scan the projects dir and import every transcript. */
export async function syncClaude(): Promise<ClaudeImportResult> {
    const projectsDir = claudeProjectsDir();
    const result: ClaudeImportResult = {
        scannedFiles: 0,
        imported: 0,
        skipped: 0,
        deferred: 0,
        errors: [],
    };
    let dirExists = false;
    try {
        const st = await stat(projectsDir);
        dirExists = st.isDirectory();
    } catch {
        dirExists = false;
    }
    if (!dirExists) return result;

    const files = await collectJsonlFiles(projectsDir);
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

/** Collect every transcript JSONL under the projects dir, including
 *  sub-agent and workflow sub-agent transcripts. */
async function collectJsonlFiles(projectsDir: string): Promise<string[]> {
    const files: string[] = [];
    const projectNames = await safeReaddir(projectsDir);
    for (const projectName of projectNames) {
        const projectDir = path.join(projectsDir, projectName);
        const projectStat = await safeStat(projectDir);
        if (!projectStat?.isDirectory()) continue;
        const entries = await safeReaddir(projectDir);
        for (const entry of entries) {
            const entryPath = path.join(projectDir, entry);
            const entryStat = await safeStat(entryPath);
            if (entryStat?.isFile() && entry.endsWith(".jsonl")) {
                files.push(entryPath);
            }
        }
        // Sub-agent transcripts: project / session / subagents / *.jsonl
        for (const sessionName of entries) {
            const subagentsDir = path.join(projectDir, sessionName, "subagents");
            const subStat = await safeStat(subagentsDir);
            if (!subStat?.isDirectory()) continue;
            const subEntries = await safeReaddir(subagentsDir);
            for (const sub of subEntries) {
                if (sub.endsWith(".jsonl")) {
                    files.push(path.join(subagentsDir, sub));
                }
            }
            // Workflow transcripts: project / session / subagents / workflows / wf_* / *.jsonl
            const workflowsDir = path.join(subagentsDir, "workflows");
            const wfDirs = await safeReaddir(workflowsDir);
            for (const wfDir of wfDirs) {
                if (!wfDir.startsWith("wf_")) continue;
                const wfPath = path.join(workflowsDir, wfDir);
                const wfSt = await safeStat(wfPath);
                if (!wfSt?.isDirectory()) continue;
                const wfFiles = await safeReaddir(wfPath);
                for (const wfFile of wfFiles) {
                    if (wfFile.endsWith(".jsonl")) {
                        files.push(path.join(wfPath, wfFile));
                    }
                }
            }
        }
    }
    return files;
}

async function syncSingleFile(filePath: string): Promise<{ imported: number; skipped: number; deferred: number }> {
    const fileStat = await stat(filePath);
    const lastModifiedMs = fileStat.mtimeMs;
    const prev = await getCursor(filePath);
    if (prev && lastModifiedMs <= prev.lastModified) {
        return { imported: 0, skipped: 0, deferred: 0 };
    }

    // Parse line-by-line, dedup by message.id within the file.
    const byId = new Map<string, ParsedAssistant>();
    let lineOffset = 0;
    const rl = createInterface({
        input: createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        lineOffset++;
        if (!line.trim()) continue;
        let value: Record<string, unknown>;
        try {
            value = JSON.parse(line) as Record<string, unknown>;
        } catch {
            continue;
        }
        if (value.type !== "assistant") continue;
        const message = value.message as Record<string, unknown> | undefined;
        if (!message) continue;
        const msgId = message.id;
        if (typeof msgId !== "string") continue;
        const usage = message.usage as Record<string, unknown> | undefined;
        if (!usage) continue;
        const parsed: ParsedAssistant = {
            messageId: msgId,
            model: typeof message.model === "string" ? message.model : "unknown",
            inputTokens: num(usage.input_tokens),
            outputTokens: num(usage.output_tokens),
            cacheReadTokens: num(usage.cache_read_input_tokens),
            cacheCreationTokens: num(usage.cache_creation_input_tokens),
            stopReason: typeof message.stop_reason === "string" ? message.stop_reason : undefined,
            timestamp: typeof value.timestamp === "string" ? (value.timestamp as string) : undefined,
            sessionId: typeof value.sessionId === "string" ? (value.sessionId as string) : undefined,
        };
        // Dedup within file: prefer stop_reason, else larger output_tokens.
        const existing = byId.get(msgId);
        let replace = false;
        if (!existing) {
            replace = true;
        } else if (parsed.stopReason && !existing.stopReason) {
            replace = true;
        } else if ((parsed.stopReason ? 1 : 0) === (existing.stopReason ? 1 : 0)) {
            replace = parsed.outputTokens > existing.outputTokens;
        }
        if (replace) byId.set(msgId, parsed);
    }

    let imported = 0;
    let skipped = 0;
    for (const msg of byId.values()) {
        // Any billing dimension > 0 -> importable. Workflow/subagent short
        // requests frequently only write a message_start snapshot but their
        // cache/input cost was real.
        const hasBillable =
            msg.inputTokens > 0 ||
            msg.outputTokens > 0 ||
            msg.cacheReadTokens > 0 ||
            msg.cacheCreationTokens > 0;
        if (!hasBillable) {
            skipped++;
            continue;
        }
        const timestamp = msg.timestamp ?? new Date().toISOString();
        const ts = Date.parse(timestamp);
        const sig: TokenSig = {
            freshInput: msg.inputTokens,
            output: msg.outputTokens,
            cacheRead: msg.cacheReadTokens,
            cacheCreation: msg.cacheCreationTokens,
        };
        const skip = await shouldSkip({
            dataSource: DATA_SOURCE,
            protocol: "anthropic",
            sourceRequestId: msg.messageId,
            model: msg.model,
            sig,
            timestamp: Number.isNaN(ts) ? Date.now() : ts,
        });
        if (skip) {
            skipped++;
            continue;
        }
        const rec = buildClaudeRecord(msg, timestamp);
        await appendUsage(rec);
        notifyAppended(rec);
        imported++;
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

function buildClaudeRecord(msg: ParsedAssistant, timestamp: string): UsageRecord {
    // Anthropic semantics: input_tokens is fresh input, cache reads separate.
    const rec: UsageRecord = {
        id: randomUUID(),
        timestamp,
        sessionId: msg.sessionId,
        protocol: "anthropic",
        dataSource: DATA_SOURCE,
        sourceRequestId: msg.messageId,
        provider: "claude.ai",
        model: msg.model,
        inputTokens: msg.inputTokens,
        freshInputTokens: msg.inputTokens,
        outputTokens: msg.outputTokens,
        cacheReadTokens: msg.cacheReadTokens,
        cacheCreationTokens: msg.cacheCreationTokens,
    };
    return rec;
}

function num(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

async function safeReaddir(dir: string): Promise<string[]> {
    try {
        return await readdir(dir);
    } catch {
        return [];
    }
}

async function safeStat(p: string): Promise<import("node:fs").Stats | undefined> {
    try {
        return await stat(p);
    } catch {
        return undefined;
    }
}
