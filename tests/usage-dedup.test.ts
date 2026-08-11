import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureUsage } from "../src/usage/capture.ts";
import {
    SETTLE_WINDOW_MS,
    _resetDedupIndexForTest,
    shouldSkip,
    type TokenSig,
} from "../src/usage/importers/dedup.ts";
import { syncCodex } from "../src/usage/importers/codex.ts";
import { resetCursors } from "../src/usage/importers/sync-state.ts";
import { _resetPricingForTest, setPricing } from "../src/usage/pricing.ts";
import { _resetUsageStoreForTest, appendUsage, loadUsage } from "../src/usage/store.ts";
import type { UsageRecord } from "../src/usage/types.ts";

const SIG: TokenSig = {
    freshInput: 200,
    output: 50,
    cacheRead: 800,
    cacheCreation: 0,
};

function usageRecord(overrides: Partial<UsageRecord>): UsageRecord {
    return {
        id: overrides.id ?? "record",
        timestamp: overrides.timestamp ?? new Date().toISOString(),
        protocol: overrides.protocol ?? "codex",
        dataSource: overrides.dataSource ?? "proxy",
        sourceRequestId: overrides.sourceRequestId,
        provider: overrides.provider,
        model: overrides.model ?? "gpt-5",
        inputTokens: overrides.inputTokens ?? 1000,
        freshInputTokens: overrides.freshInputTokens ?? SIG.freshInput,
        outputTokens: overrides.outputTokens ?? SIG.output,
        cacheReadTokens: overrides.cacheReadTokens ?? SIG.cacheRead,
        cacheCreationTokens: overrides.cacheCreationTokens ?? SIG.cacheCreation,
    };
}

async function withLedger(
    run: (ctx: { dir: string; usageFile: string }) => Promise<void>,
): Promise<void> {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-dedup-"));
    const previous = {
        usage: process.env.BILI_USAGE_FILE,
        pricing: process.env.BILI_USAGE_PRICING_FILE,
        cursor: process.env.BILI_IMPORT_CURSOR_FILE,
        codex: process.env.CODEX_HOME,
    };
    const usageFile = path.join(dir, "usage.jsonl");
    process.env.BILI_USAGE_FILE = usageFile;
    process.env.BILI_USAGE_PRICING_FILE = path.join(dir, "pricing.json");
    process.env.BILI_IMPORT_CURSOR_FILE = path.join(dir, "cursors.json");
    process.env.CODEX_HOME = path.join(dir, "codex");
    _resetUsageStoreForTest();
    _resetDedupIndexForTest();
    _resetPricingForTest();
    await resetCursors();
    try {
        await run({ dir, usageFile });
    } finally {
        if (previous.usage === undefined) delete process.env.BILI_USAGE_FILE;
        else process.env.BILI_USAGE_FILE = previous.usage;
        if (previous.pricing === undefined) delete process.env.BILI_USAGE_PRICING_FILE;
        else process.env.BILI_USAGE_PRICING_FILE = previous.pricing;
        if (previous.cursor === undefined) delete process.env.BILI_IMPORT_CURSOR_FILE;
        else process.env.BILI_IMPORT_CURSOR_FILE = previous.cursor;
        if (previous.codex === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous.codex;
        _resetUsageStoreForTest();
        _resetDedupIndexForTest();
        _resetPricingForTest();
        rmSync(dir, { recursive: true, force: true });
    }
}

test("proxy record suppresses the matching Codex session import", async () => {
    await withLedger(async () => {
        const timestamp = Date.now();
        await appendUsage(usageRecord({ timestamp: new Date(timestamp).toISOString() }));
        const reason = await shouldSkip({
            dataSource: "codex_session",
            protocol: "codex",
            sourceRequestId: "thread-a:turn1",
            model: "gpt-5",
            sig: SIG,
            timestamp,
        });
        assert.match(reason ?? "", /^duplicate-tuple:/);
    });
});

test("Codex session record suppresses matching real-time capture", async () => {
    await withLedger(async () => {
        await setPricing("gpt-5", { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
        await appendUsage(usageRecord({ dataSource: "codex_session", sourceRequestId: "thread-a:turn1" }));
        const captured = await captureUsage({
            protocol: "codex",
            usage: {
                input_tokens: 1000,
                output_tokens: 50,
                input_tokens_details: { cached_tokens: 800 },
            },
            sessionId: "proxy-session",
            ctx: { model: "gpt-5", provider: "chatgpt.com" },
            sourceRequestId: "resp-live",
        });
        assert.equal(captured, undefined);
        assert.equal((await loadUsage()).length, 1);
    });
});

test("proxy record suppresses the matching Claude session import", async () => {
    await withLedger(async () => {
        const timestamp = Date.now();
        await appendUsage(usageRecord({
            timestamp: new Date(timestamp).toISOString(),
            protocol: "anthropic",
            model: "claude-sonnet-4",
            inputTokens: 200,
        }));
        const reason = await shouldSkip({
            dataSource: "claude_session",
            protocol: "anthropic",
            sourceRequestId: "msg-session",
            model: "claude-sonnet-4",
            sig: SIG,
            timestamp,
        });
        assert.match(reason ?? "", /^duplicate-tuple:/);
    });
});

test("tuple matching never drops two records from the same source class", async () => {
    await withLedger(async () => {
        const timestamp = Date.now();
        await appendUsage(usageRecord({ timestamp: new Date(timestamp).toISOString() }));
        const proxyReason = await shouldSkip({
            dataSource: "proxy",
            protocol: "codex",
            model: "gpt-5",
            sig: SIG,
            timestamp,
        });
        const sessionReason = await shouldSkip({
            dataSource: "claude_session",
            protocol: "codex",
            model: "gpt-5",
            sig: SIG,
            timestamp,
        });
        assert.equal(proxyReason, undefined);
        assert.match(sessionReason ?? "", /^duplicate-tuple:/);

        _resetUsageStoreForTest();
        _resetDedupIndexForTest();
        process.env.BILI_USAGE_FILE = path.join(path.dirname(process.env.BILI_USAGE_FILE!), "sessions.jsonl");
        await appendUsage(usageRecord({
            dataSource: "codex_session",
            timestamp: new Date(timestamp).toISOString(),
        }));
        const otherSessionReason = await shouldSkip({
            dataSource: "claude_session",
            protocol: "codex",
            model: "gpt-5",
            sig: SIG,
            timestamp,
        });
        assert.equal(otherSessionReason, undefined);
    });
});

test("tuple matching keeps protocol boundaries", async () => {
    await withLedger(async () => {
        const timestamp = Date.now();
        await appendUsage(usageRecord({ timestamp: new Date(timestamp).toISOString() }));
        const reason = await shouldSkip({
            dataSource: "claude_session",
            protocol: "anthropic",
            model: "gpt-5",
            sig: SIG,
            timestamp,
        });
        assert.equal(reason, undefined);
    });
});

test("tuple matching expires outside the settle window", async () => {
    await withLedger(async () => {
        const timestamp = Date.now();
        await appendUsage(usageRecord({ timestamp: new Date(timestamp).toISOString() }));
        const reason = await shouldSkip({
            dataSource: "codex_session",
            protocol: "codex",
            model: "gpt-5",
            sig: SIG,
            timestamp: timestamp + SETTLE_WINDOW_MS + 1,
        });
        assert.equal(reason, undefined);
    });
});

test("tuple matching normalizes model case and date suffixes", async () => {
    await withLedger(async () => {
        const timestamp = Date.now();
        await appendUsage(usageRecord({
            timestamp: new Date(timestamp).toISOString(),
            model: "GPT-5-2025-08-07",
        }));
        const reason = await shouldSkip({
            dataSource: "codex_session",
            protocol: "codex",
            model: "gpt-5",
            sig: SIG,
            timestamp,
        });
        assert.match(reason ?? "", /^duplicate-tuple:/);
    });
});

test("stable response ids deduplicate across sources but not protocols", async () => {
    await withLedger(async () => {
        const timestamp = Date.now();
        await appendUsage(usageRecord({
            timestamp: new Date(timestamp).toISOString(),
            protocol: "anthropic",
            dataSource: "proxy",
            sourceRequestId: "msg-shared",
            model: "claude-sonnet-4",
        }));
        const duplicate = await shouldSkip({
            dataSource: "claude_session",
            protocol: "anthropic",
            sourceRequestId: "msg-shared",
            model: "different-model",
            sig: { ...SIG, output: 999 },
            timestamp,
        });
        const otherProtocol = await shouldSkip({
            dataSource: "codex_session",
            protocol: "codex",
            sourceRequestId: "msg-shared",
            model: "different-model",
            sig: { ...SIG, output: 999 },
            timestamp,
        });
        assert.match(duplicate ?? "", /^duplicate-stable:/);
        assert.equal(otherProtocol, undefined);
    });
});

test("Codex importer uses fresh input in its dedup signature", async () => {
    await withLedger(async ({ dir }) => {
        const timestamp = Date.now();
        await appendUsage(usageRecord({ timestamp: new Date(timestamp).toISOString() }));
        writeCodexRollout(dir, timestamp, "thread-cached");
        const result = await syncCodex();
        assert.equal(result.imported, 0);
        assert.equal(result.skipped, 1);
        assert.equal((await loadUsage()).length, 1);
    });
});

test("Codex importer persists the same per-turn stable id it checks", async () => {
    await withLedger(async ({ dir }) => {
        const timestamp = Date.now();
        writeCodexRollout(dir, timestamp, "thread-stable");
        const result = await syncCodex();
        assert.equal(result.imported, 1);
        const records = await loadUsage();
        assert.equal(records[0]?.sourceRequestId, "thread-stable:turn1");
        assert.equal(records[0]?.sessionId, "thread-stable");
    });
});

function writeCodexRollout(dir: string, timestamp: number, threadId: string): void {
    const sessionDir = path.join(dir, "codex", "sessions", "2026", "08", "11");
    mkdirSync(sessionDir, { recursive: true });
    const lines = [
        {
            timestamp: new Date(timestamp - 1).toISOString(),
            type: "session_meta",
            payload: { thread_id: threadId, model: "gpt-5" },
        },
        {
            timestamp: new Date(timestamp).toISOString(),
            type: "event_msg",
            payload: {
                type: "token_count",
                info: {
                    total_token_usage: {
                        input_tokens: 1000,
                        cached_input_tokens: 800,
                        output_tokens: 50,
                    },
                },
            },
        },
    ];
    writeFileSync(
        path.join(sessionDir, `rollout-${threadId}.jsonl`),
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf8",
    );
}
