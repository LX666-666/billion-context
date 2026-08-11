import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _resetUsageStoreForTest } from "../src/usage/store.ts";
import type { UsageRecord } from "../src/usage/types.ts";

function listen(server: http.Server): Promise<void> {
    return once(server, "listening").then(() => undefined);
}
function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function rec(overrides: Partial<UsageRecord> = {}): UsageRecord {
    return {
        id: overrides.id ?? "r",
        timestamp: overrides.timestamp ?? "2026-08-10T08:00:00.000Z",
        protocol: overrides.protocol ?? "codex",
        provider: overrides.provider ?? "chatgpt.com",
        model: overrides.model ?? "gpt-5.6-sol",
        inputTokens: overrides.inputTokens ?? 1000,
        freshInputTokens: overrides.freshInputTokens ?? 200,
        outputTokens: overrides.outputTokens ?? 100,
        cacheReadTokens: overrides.cacheReadTokens ?? 800,
        cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
        totalCost: overrides.totalCost ?? 1,
        ...overrides,
    };
}

test("usage API: summary/trends/models/providers/requests/pricing", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const tmp = mkdtempSync(path.join(tmpdir(), "bili-usage-api-"));
    const usageFile = path.join(tmp, "usage.jsonl");
    const prevUsage = process.env.BILI_USAGE_FILE;
    const prevPricing = process.env.BILI_USAGE_PRICING_FILE;
    process.env.BILI_USAGE_FILE = usageFile;
    process.env.BILI_USAGE_PRICING_FILE = path.join(tmp, "pricing.json");
    _resetUsageStoreForTest();

    // Seed the ledger with a few records across time/protocol/provider/model.
    const rows: UsageRecord[] = [
        rec({ id: "a", timestamp: "2026-08-10T08:10:00.000Z", protocol: "codex", provider: "chatgpt.com", model: "gpt-5.6-sol", inputTokens: 1000, freshInputTokens: 200, outputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 0, totalCost: 1, acpSavedTokens: 3000 }),
        rec({ id: "b", timestamp: "2026-08-10T09:20:00.000Z", protocol: "anthropic", provider: "claude.ai", model: "claude-opus", inputTokens: 500, freshInputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 100, totalCost: 2 }),
        rec({ id: "c", timestamp: "2026-08-10T09:40:00.000Z", protocol: "openai", provider: "api.openai.com", model: "gpt-5", inputTokens: 300, freshInputTokens: 100, outputTokens: 30, cacheReadTokens: 200, cacheCreationTokens: 0, totalCost: 0.5 }),
    ];
    writeFileSync(usageFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        updateMode: "auto",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    try {
        // The Web UI shell renders the sidebar + nav + client script.
        // Usage page content is now client-rendered by the IIFE in client.ts.
        const ui = await (await fetch(`${base}/__bili/`)).text();
        assert.match(ui, /用量统计/, "sidebar + page title");
        assert.match(ui, /data-page="usage"/, "nav entry");
        assert.match(ui, /theme-row/, "theme toggle present");
        assert.match(ui, /sync-btn/, "sync button present");

        // Summary.
        const summary = await (await fetch(`${base}/__bili/usage/summary`)).json() as {
            summary: { requests: number; inputTokens: number; freshInputTokens: number; cacheReadTokens: number; cacheHitRate: number; totalCost: number; acpSavedTokens: number };
        };
        assert.equal(summary.summary.requests, 3);
        assert.equal(summary.summary.inputTokens, 1800);
        assert.equal(summary.summary.freshInputTokens, 800);
        assert.equal(summary.summary.cacheReadTokens, 1000);
        assert.equal(summary.summary.totalCost, 3.5);
        assert.equal(summary.summary.acpSavedTokens, 3000);
        // cacheable = fresh 800 + read 1000 + creation 100 = 1900; hit = 1000/1900.
        assert.ok(Math.abs(summary.summary.cacheHitRate - 1000 / 1900) < 1e-9);

        // Filters narrow the summary.
        const claudeOnly = await (await fetch(`${base}/__bili/usage/summary?provider=claude.ai`)).json() as { summary: { requests: number; model?: unknown } };
        assert.equal(claudeOnly.summary.requests, 1);
        const gptModel = await (await fetch(`${base}/__bili/usage/summary?model=gpt-5`)).json() as { summary: { requests: number } };
        assert.equal(gptModel.summary.requests, 1);
        const range = await (await fetch(`${base}/__bili/usage/summary?from=2026-08-10T09:00:00.000Z`)).json() as { summary: { requests: number } };
        assert.equal(range.summary.requests, 2, "from filter excludes the 08:10 record");

        // Trends: hourly buckets.
        const trends = await (await fetch(`${base}/__bili/usage/trends?granularity=hour`)).json() as { points: Array<{ requests: number }> };
        assert.equal(trends.points.length, 2, "08:00 bucket + 09:00 bucket");
        assert.equal(trends.points[0]!.requests, 1);
        assert.equal(trends.points[1]!.requests, 2);

        // Grouped breakdowns.
        const models = await (await fetch(`${base}/__bili/usage/models`)).json() as { models: Array<{ key: string; requests: number }> };
        assert.equal(models.models.length, 3);
        const providers = await (await fetch(`${base}/__bili/usage/providers`)).json() as { providers: Array<{ key: string; requests: number }> };
        assert.equal(providers.providers.length, 3);

        // Request log: newest first, paginated.
        const log = await (await fetch(`${base}/__bili/usage/requests`)).json() as { total: number; requests: Array<{ id: string }> };
        assert.equal(log.total, 3);
        assert.equal(log.requests[0]!.id, "c", "newest first");
        const paged = await (await fetch(`${base}/__bili/usage/requests?limit=2&offset=1`)).json() as { requests: Array<{ id: string }> };
        assert.equal(paged.requests.length, 2);
        assert.equal(paged.requests[0]!.id, "b");

        // Request by id.
        const detail = await (await fetch(`${base}/__bili/usage/requests/a`)).json() as { request: { id: string; protocol: string } };
        assert.equal(detail.request.id, "a");
        assert.equal(detail.request.protocol, "codex");
        const missing = await fetch(`${base}/__bili/usage/requests/nope`);
        assert.equal(missing.status, 404);

        // Pricing GET/PUT.
        const pricingGet = await (await fetch(`${base}/__bili/usage/pricing`)).json() as { overrides: Record<string, unknown> };
        assert.deepEqual(pricingGet.overrides, {});
        const put = await fetch(`${base}/__bili/usage/pricing/gpt-5.6-sol`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: 10, output: 30, cacheRead: 1, cacheCreation: 12.5 }),
        });
        assert.equal(put.status, 200);
        const pricingAfter = await (await fetch(`${base}/__bili/usage/pricing`)).json() as { overrides: Record<string, { input: number }> };
        assert.equal(pricingAfter.overrides["gpt-5.6-sol"]!.input, 10);
        assert.ok(readFileSync(path.join(tmp, "pricing.json"), "utf8").includes("gpt-5.6-sol"), "override persisted to disk");

        // Pricing sync (models.dev empty registry → nothing synced, no crash).
        const sync = await (await fetch(`${base}/__bili/usage/pricing/sync`, { method: "POST" })).json() as { synced: number; skipped: number };
        assert.equal(sync.synced, 0, "empty models.dev registry syncs nothing");
        assert.equal(sync.skipped, 3, "three models skipped");
    } finally {
        await close(proxy);
        if (prevUsage === undefined) delete process.env.BILI_USAGE_FILE; else process.env.BILI_USAGE_FILE = prevUsage;
        if (prevPricing === undefined) delete process.env.BILI_USAGE_PRICING_FILE; else process.env.BILI_USAGE_PRICING_FILE = prevPricing;
        _resetUsageStoreForTest();
        rmSync(tmp, { recursive: true, force: true });
    }
});
