import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeCodexUsage, normalizeOpenaiUsage, normalizeAnthropicUsage, cacheableInput, cacheHitRate } from "../src/usage/normalizer.ts";
import { costOf, costWithoutCache, fromModelsDevPricing, setPricing, loadPricing, _resetPricingForTest, priceFor } from "../src/usage/pricing.ts";
import { appendUsage, queryUsage, loadUsage, _resetUsageStoreForTest } from "../src/usage/store.ts";
import { summarize, trends, groupByModel, groupByProvider, savingsBreakdown, compressionRate } from "../src/usage/stats.ts";
import { makeUsageRecord } from "../src/usage/record.ts";
import type { PriceEntry, UsageRecord } from "../src/usage/types.ts";

const PRICE: PriceEntry = { input: 10, output: 30, cacheRead: 1, cacheCreation: 12.5 };

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function withUsageFile(dir: string, fn: () => Promise<void>): Promise<void> {
    const prev = process.env.BILI_USAGE_FILE;
    process.env.BILI_USAGE_FILE = path.join(dir, "usage.jsonl");
    _resetUsageStoreForTest();
    return fn().finally(() => {
        if (prev === undefined) delete process.env.BILI_USAGE_FILE; else process.env.BILI_USAGE_FILE = prev;
        _resetUsageStoreForTest();
    });
}

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
    return {
        id: overrides.id ?? "r",
        timestamp: overrides.timestamp ?? "2026-08-10T08:00:00.000Z",
        protocol: overrides.protocol ?? "codex",
        provider: overrides.provider ?? "chatgpt.com",
        model: overrides.model ?? "gpt-5.6-sol",
        inputTokens: overrides.inputTokens ?? 1000,
        freshInputTokens: overrides.freshInputTokens ?? 800,
        outputTokens: overrides.outputTokens ?? 200,
        cacheReadTokens: overrides.cacheReadTokens ?? 200,
        cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
        ...overrides,
    };
}

/* ------------------------------------------------------------------------- */
test("normalizer: Codex input includes cached → fresh = input - cached", () => {
    const u = normalizeCodexUsage({
        input_tokens: 1000,
        output_tokens: 200,
        input_tokens_details: { cached_tokens: 800, cache_write_tokens: 50 },
    });
    assert.equal(u.freshInputTokens, 200, "fresh = 1000 - 800");
    assert.equal(u.cacheReadTokens, 800);
    assert.equal(u.cacheCreationTokens, 50);
    assert.equal(u.outputTokens, 200);
});

test("normalizer: Codex prompt_tokens fallback and negative-clamp", () => {
    const u = normalizeCodexUsage({ prompt_tokens: 100, output_tokens: 5, prompt_tokens_details: { cached_tokens: 300 } });
    assert.equal(u.freshInputTokens, 0, "cached > input must clamp to 0, not negative");
    assert.equal(u.cacheReadTokens, 300);
});

test("normalizer: OpenAI uses prompt_tokens + prompt_tokens_details", () => {
    const u = normalizeOpenaiUsage({
        prompt_tokens: 500,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 300 },
    });
    assert.equal(u.freshInputTokens, 200);
    assert.equal(u.cacheReadTokens, 300);
    assert.equal(u.outputTokens, 100);
});

test("normalizer: Anthropic input is fresh, cache read separate", () => {
    const u = normalizeAnthropicUsage({
        input_tokens: 400,
        output_tokens: 80,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 30,
    });
    assert.equal(u.freshInputTokens, 400, "Anthropic input_tokens must NOT be reduced by cache_read");
    assert.equal(u.cacheReadTokens, 900);
    assert.equal(u.cacheCreationTokens, 30);
    assert.equal(u.outputTokens, 80);
});

test("cacheableInput / cacheHitRate are token-based, not request-based", () => {
    const u = { freshInputTokens: 200, outputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 0 };
    assert.equal(cacheableInput(u), 1000);
    assert.equal(cacheHitRate(u), 0.8, "800 / (200+800) = 0.8");
});

/* ------------------------------------------------------------------------- */
test("costOf computes four-way pricing × multiplier", () => {
    const u = { freshInputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheCreationTokens: 100_000 };
    const c = costOf(u, PRICE);
    assert.equal(c.inputCost, 10);
    assert.equal(c.outputCost, 15);
    assert.equal(c.cacheReadCost, 2);
    assert.equal(c.cacheCreationCost, 1.25);
    assert.equal(c.totalCost, 28.25);
    const c2 = costOf(u, PRICE, 2);
    assert.equal(c2.totalCost, 56.5, "costMultiplier applies to the total");
});

test("costWithoutCache bills all cacheable input as fresh", () => {
    const u = { freshInputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheCreationTokens: 100 };
    // 1100 fresh + 50 output
    assert.equal(costWithoutCache(u, PRICE), (1100 * 10 + 50 * 30) / 1e6);
});

test("fromModelsDevPricing converts per-token → per-million", () => {
    const p = fromModelsDevPricing({ prompt: 0.000003, completion: 0.000015 });
    assert.equal(p.input, 3);
    assert.equal(p.output, 15);
    assert.equal(p.cacheRead, 3);
    assert.equal(p.cacheCreation, 3);
});

test("pricing overrides persist to file and load back", async () => {
    const { dir, cleanup } = tempDir("bili-price-");
    const prev = process.env.BILI_USAGE_PRICING_FILE;
    process.env.BILI_USAGE_PRICING_FILE = path.join(dir, "pricing.json");
    _resetPricingForTest();
    try {
        await setPricing("gpt-x", { input: 5, output: 20, cacheRead: 0.5, cacheCreation: 2 });
        assert.equal(priceFor("gpt-x").input, 5);
        assert.ok(existsSync(path.join(dir, "pricing.json")), "pricing file written");
        _resetPricingForTest();
        const loaded = await loadPricing();
        assert.equal(loaded["gpt-x"].input, 5);
        assert.equal(priceFor("gpt-x").input, 5);
        assert.equal(priceFor("unpriced-model").input, 0, "unpriced model costs zero");
    } finally {
        if (prev === undefined) delete process.env.BILI_USAGE_PRICING_FILE; else process.env.BILI_USAGE_PRICING_FILE = prev;
        _resetPricingForTest();
        cleanup();
    }
});

/* ------------------------------------------------------------------------- */
test("makeUsageRecord prices a normalized usage and fills raw input", async () => {
    _resetPricingForTest();
    process.env.BILI_USAGE_PRICING_FILE = path.join(tempDir("bili-price-").dir, "p.json");
    try {
        const rec = makeUsageRecord(
            { freshInputTokens: 800, outputTokens: 200, cacheReadTokens: 200, cacheCreationTokens: 50 },
            { originalContextTokens: 3000, forwardedContextTokens: 1050, acpSavedTokens: 1950 },
            { sessionId: "s1", protocol: "codex", provider: "chatgpt.com", model: "gpt-5.6-sol", statusCode: 200, streaming: true, latencyMs: 1234 },
            PRICE,
        );
        assert.equal(rec.inputTokens, 1000, "codex raw input = fresh + cacheRead");
        assert.equal(rec.freshInputTokens, 800);
        assert.equal(rec.acpSavedTokens, 1950);
        assert.equal(rec.totalCost, costOf({ freshInputTokens: 800, outputTokens: 200, cacheReadTokens: 200, cacheCreationTokens: 50 }, PRICE).totalCost);
        assert.equal(rec.statusCode, 200);
        assert.equal(rec.latencyMs, 1234);
    } finally {
        _resetPricingForTest();
        delete process.env.BILI_USAGE_PRICING_FILE;
    }
});

test("makeUsageRecord: anthropic raw input = fresh (cache read separate)", () => {
    const rec = makeUsageRecord(
        { freshInputTokens: 400, outputTokens: 80, cacheReadTokens: 900, cacheCreationTokens: 30 },
        undefined,
        { protocol: "anthropic", provider: "claude.ai", model: "claude-opus" },
        PRICE,
    );
    assert.equal(rec.inputTokens, 400, "anthropic input_tokens does not include cache_read");
});

/* ------------------------------------------------------------------------- */
test("store: append + incremental query with filters", async () => {
    const { dir, cleanup } = tempDir("bili-usage-");
    await withUsageFile(dir, async () => {
        const a = record({ id: "a", timestamp: "2026-08-10T08:00:00.000Z", protocol: "codex", provider: "chatgpt.com", model: "gpt-5.6-sol", freshInputTokens: 800 });
        const b = record({ id: "b", timestamp: "2026-08-10T09:00:00.000Z", protocol: "anthropic", provider: "claude.ai", model: "claude-opus", freshInputTokens: 400 });
        await appendUsage(a);
        await appendUsage(b);

        // First query loads the whole file.
        const all = await queryUsage();
        assert.equal(all.length, 2);

        // Append more, query again — must pick up only the delta.
        await appendUsage(record({ id: "c", timestamp: "2026-08-10T10:00:00.000Z", protocol: "codex", model: "gpt-5.6-sol" }));
        const all2 = await queryUsage();
        assert.equal(all2.length, 3, "incremental read picks up new lines only");

        // Filters.
        const codex = await queryUsage({ protocol: "codex" });
        assert.equal(codex.length, 2);
        const claude = await queryUsage({ provider: "claude.ai" });
        assert.equal(claude.length, 1);
        assert.equal(claude[0]!.model, "claude-opus");
        const range = await queryUsage({ from: Date.parse("2026-08-10T08:30:00.000Z"), to: Date.parse("2026-08-10T09:30:00.000Z") });
        assert.equal(range.length, 1);
        assert.equal(range[0]!.id, "b");
        const modelFilter = await queryUsage({ model: "gpt-5.6-sol" });
        assert.equal(modelFilter.length, 2);
    });
    cleanup();
});

/* ------------------------------------------------------------------------- */
test("stats: summarize rolls up tokens, cost, and token-based cache hit rate", () => {
    const s = summarize([
        record({ inputTokens: 1000, freshInputTokens: 200, outputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 0, totalCost: 1 }),
        record({ inputTokens: 500, freshInputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 100, totalCost: 2 }),
    ]);
    assert.equal(s.requests, 2);
    assert.equal(s.inputTokens, 1500);
    assert.equal(s.freshInputTokens, 700);
    assert.equal(s.outputTokens, 150);
    assert.equal(s.cacheReadTokens, 800);
    assert.equal(s.cacheCreationTokens, 100);
    assert.equal(s.realTotalTokens, 700 + 150 + 800 + 100);
    assert.equal(s.totalCost, 3);
    // cacheable = 700 + 800 + 100 = 1600; hit = 800/1600 = 0.5
    assert.equal(s.cacheHitRate, 0.5);
    assert.equal(s.acpSavedTokens, 0);
});

test("stats: trends buckets by hour/day and fills gaps", () => {
    const rows = [
        record({ timestamp: "2026-08-10T08:10:00.000Z", outputTokens: 10 }),
        record({ timestamp: "2026-08-10T08:40:00.000Z", outputTokens: 20 }),
        record({ timestamp: "2026-08-10T09:00:00.000Z", outputTokens: 30 }),
    ];
    const hourly = trends(rows, "hour");
    assert.equal(hourly.length, 2);
    assert.equal(hourly[0]!.requests, 2);
    assert.equal(hourly[1]!.requests, 1);
    assert.equal(hourly[0]!.outputTokens, 30);
    assert.equal(hourly[1]!.outputTokens, 30);
    const daily = trends(rows, "day");
    assert.equal(daily.length, 1);
    assert.equal(daily[0]!.requests, 3);
});

test("stats: groupByModel / groupByProvider with cost sort and hit rate", () => {
    const rows = [
        record({ model: "m1", provider: "p1", inputTokens: 1000, freshInputTokens: 800, cacheReadTokens: 200, totalCost: 5 }),
        record({ model: "m1", provider: "p1", inputTokens: 1000, freshInputTokens: 800, cacheReadTokens: 200, totalCost: 1 }),
        record({ model: "m2", provider: "p2", inputTokens: 100, freshInputTokens: 100, cacheReadTokens: 0, totalCost: 0.5 }),
    ];
    const byModel = groupByModel(rows);
    assert.equal(byModel.length, 2);
    assert.equal(byModel[0]!.key, "m1", "sorted by cost desc");
    assert.equal(byModel[0]!.requests, 2);
    assert.equal(byModel[0]!.cacheHitRate, 0.2, "200 / (input 1000 + creation 0)");
    const byProvider = groupByProvider(rows);
    assert.equal(byProvider.length, 2);
});

test("stats: savingsBreakdown separates cache savings from ACP savings", () => {
    // One compressed request: original 3000 → forwarded 1050 (acpSaved 1950).
    // Cache: fresh 800, cacheRead 200, cacheCreation 50, output 200.
    // Actual cost under PRICE: 800×10 + 200×30 + 200×1 + 50×12.5 all /1e6.
    const actualCost = (800 * 10 + 200 * 30 + 200 * 1 + 50 * 12.5) / 1e6;
    const rows = [
        record({
            originalContextTokens: 3000,
            forwardedContextTokens: 1050,
            acpSavedTokens: 1950,
            freshInputTokens: 800,
            outputTokens: 200,
            cacheReadTokens: 200,
            cacheCreationTokens: 50,
            totalCost: actualCost,
        }),
    ];
    const prices: Record<string, PriceEntry> = { "gpt-5.6-sol": PRICE };
    const s = savingsBreakdown(rows, prices);
    // No-opt: 3000 fresh @10 + 200 @30, all /1e6.
    assert.equal(s.costNoOptimization, (3000 * 10 + 200 * 30) / 1e6);
    // Cache-only (no ACP): original 3000, but 200 cacheRead + 50 cacheCreation
    // are billed at their own rates and the remaining 2750 at input price.
    assert.equal(s.costCacheOnly, (2750 * 10 + 200 * 1 + 50 * 12.5 + 200 * 30) / 1e6);
    assert.equal(s.costActual, actualCost);
    assert.ok(s.cacheSavings > 0, "cache saved something");
    assert.ok(s.acpSavings > 0, "ACP saved something");
    assert.equal(s.totalSavings, (3000 * 10 + 200 * 30) / 1e6 - actualCost);
    assert.ok(s.savingsRate > 0 && s.savingsRate < 1);
});

test("stats: compressionRate is saved/original over recorded contexts", () => {
    const rows = [
        record({ originalContextTokens: 3000, acpSavedTokens: 1950 }),
        record({ originalContextTokens: 1000, acpSavedTokens: 500 }),
        record({}), // no ACP data
    ];
    assert.equal(compressionRate(rows), (1950 + 500) / (3000 + 1000));
});
