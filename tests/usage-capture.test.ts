import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

test("proxied request with usage writes a normalized, priced ledger record", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const usageTmp = mkdtempSync(path.join(tmpdir(), "bili-capture-"));
    const usageFile = path.join(usageTmp, "usage.jsonl");
    const prevUsageFile = process.env.BILI_USAGE_FILE;
    process.env.BILI_USAGE_FILE = usageFile;
    _resetUsageStoreForTest();
    const prevPricing = process.env.BILI_USAGE_PRICING_FILE;
    process.env.BILI_USAGE_PRICING_FILE = path.join(usageTmp, "pricing.json");
    const { _resetPricingForTest } = await import("../src/usage/pricing.ts");
    _resetPricingForTest();
    const pricing = await import("../src/usage/pricing.ts");
    await pricing.setPricing("gpt-5", { input: 10, output: 30, cacheRead: 1, cacheCreation: 12.5 });

    const upstream = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            id: "resp_cap",
            status: "completed",
            output: [],
            usage: {
                input_tokens: 1000,
                output_tokens: 200,
                input_tokens_details: { cached_tokens: 800, cache_write_tokens: 50 },
            },
        }));
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
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
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    try {
        const res = await fetch(`${base}/responses`, {
            method: "POST",
            headers: { authorization: "Bearer AbCdEf", "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5", input: "hello" }),
        });
        assert.equal(res.status, 200);
        await res.arrayBuffer();

        // The capture is async (fire-and-forget); wait for the ledger write.
        let content = "";
        for (let i = 0; i < 100; i++) {
            try {
                content = readFileSync(usageFile, "utf8");
                if (content.trim().length > 0) break;
            } catch {
                // file not written yet
            }
            await new Promise((r) => setTimeout(r, 20));
        }
        const lines = content.trim().split("\n").filter(Boolean);
        assert.equal(lines.length, 1, "one ledger record per proxied request");
        const rec = JSON.parse(lines[0]!) as UsageRecord;
        // Codex normalization: fresh = input - cached = 200; cache read = 800.
        assert.equal(rec.protocol, "codex");
        assert.equal(rec.model, "gpt-5");
        assert.equal(rec.inputTokens, 1000);
        assert.equal(rec.freshInputTokens, 200);
        assert.equal(rec.cacheReadTokens, 800);
        assert.equal(rec.cacheCreationTokens, 50);
        assert.equal(rec.outputTokens, 200);
        // Priced: 200×10 + 200×30 + 800×1 + 50×12.5 all /1e6.
        assert.equal(rec.totalCost, (200 * 10 + 200 * 30 + 800 * 1 + 50 * 12.5) / 1e6);
        assert.equal(rec.streaming, false);
    } finally {
        await close(proxy);
        await close(upstream);
        if (prevUsageFile === undefined) delete process.env.BILI_USAGE_FILE; else process.env.BILI_USAGE_FILE = prevUsageFile;
        if (prevPricing === undefined) delete process.env.BILI_USAGE_PRICING_FILE; else process.env.BILI_USAGE_PRICING_FILE = prevPricing;
        _resetUsageStoreForTest();
        _resetPricingForTest();
        rmSync(usageTmp, { recursive: true, force: true });
    }
});
