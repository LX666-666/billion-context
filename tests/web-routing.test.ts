import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { publicWorkflowOptions } from "../src/web/api.ts";
import { DEFAULT_WORKFLOW_OPTIONS } from "../src/workflow/types.ts";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("embedded Web client is valid JavaScript", () => {
    assert.doesNotThrow(() => new Function(WEB_CLIENT));
});

test("public workflow settings strip API keys and embedded endpoint credentials", () => {
    const exposed = publicWorkflowOptions({
        ...DEFAULT_WORKFLOW_OPTIONS,
        cheapModel: {
            ...DEFAULT_WORKFLOW_OPTIONS.cheapModel,
            endpoint: "https://user:password@models.example/v1/chat/completions",
            apiKey: "secret-key",
        },
    });
    const cheapModel = exposed.cheapModel as Record<string, unknown>;
    assert.equal(cheapModel.apiKey, undefined);
    assert.equal(cheapModel.apiKeyConfigured, true);
    assert.equal(cheapModel.endpoint, "https://models.example/v1/chat/completions");
});

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

test("Web UI exposes upstream controls without inline handlers", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-web-routing-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");

    const previous = {
        config: process.env.BILI_CONFIG_FILE,
    };
    process.env.BILI_CONFIG_FILE = biliConfig;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const ui = await (await fetch(`${base}/__bili/`)).text();
        assert.match(ui, /Codex（ChatGPT 登录）/);
        assert.match(ui, /上游网络/);
        assert.match(ui, /上下文管理/);
        assert.match(ui, /输出压缩模型/);
        assert.match(ui, /Cheap Historian/);
        assert.match(ui, /Cache-aware Scheduler/);
        assert.match(ui, /Fork me on GitHub/);
        assert.match(ui, /addEventListener/);
        assert.doesNotMatch(ui, /\sonclick=/i);
        assert.match(ui, /escapeHtml/);

        const saveProxy = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ upstreamProxyMode: "manual", upstreamProxy: "http://127.0.0.1:9999" }),
        });
        assert.equal(saveProxy.status, 200);
        const config = await (await fetch(`${base}/__bili/config`)).json() as { upstreamProxy: string; upstreamProxyMode: string };
        assert.equal(config.upstreamProxy, "http://127.0.0.1:9999");
        assert.equal(config.upstreamProxyMode, "manual");
        const upstream = await (await fetch(`${base}/__bili/upstream`)).json() as { proxy: string; source: string };
        assert.equal(upstream.proxy, "http://127.0.0.1:9999/");
        assert.equal(upstream.source, "web-manual");

    } finally {
        await close(proxy);
        if (previous.config === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous.config;
        rmSync(root, { recursive: true, force: true });
    }
});

test("workflow model settings hot-reload while API keys remain write-only", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-workflow-ui-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const previousConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const response = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                workflow: {
                    enabled: true,
                    context: { targetRatio: 0.24, phaseGc: true, sessionGc: true, rolloverMinTokens: 15_000 },
                    code: { rereadAfterPhase: true },
                    pruner: {
                        enabled: true,
                        minTokens: 1_500,
                        cheapModel: {
                            enabled: true,
                            endpoint: "https://models.example/v1/chat/completions",
                            model: "cheap-pruner-test",
                            apiKey: "cheap-secret-value",
                            minTokens: 7_000,
                            maxOutputTokens: 1_500,
                            timeoutMs: 20_000,
                        },
                    },
                    archive: { semanticRaw: true },
                    repoBridge: { enabled: true, enforceReread: true, hashMaxBytes: 2_000_000, gitTimeoutMs: 3_000 },
                    cache: {
                        protectCacheHitRatio: 0.7,
                        highGrowthRate: 0.2,
                        expectedTokensPerStep: 9_000,
                        maxExpectedNextWorkTokens: 70_000,
                        debuggingWindowOperations: 12,
                        rewriteCostWeight: 1.3,
                    },
                    memory: { maxInjectedTokens: 14_000, maxProjectSessions: 8 },
                    historian: {
                        enabled: true,
                        endpoint: "https://models.example/v1/chat/completions",
                        model: "historian-test",
                        apiKey: "historian-secret-value",
                        maxInputTokens: 18_000,
                        maxOutputTokens: 1_800,
                        timeoutMs: 25_000,
                    },
                },
            }),
        });
        assert.equal(response.status, 200);
        assert.equal(opts.workflow?.cheapModel.model, "cheap-pruner-test");
        assert.equal(opts.workflow?.historian.model, "historian-test");
        assert.equal(opts.workflow?.cachePolicy.protectCacheHitRatio, 0.7);

        const configResponse = await fetch(`${base}/__bili/config`);
        const configText = await configResponse.text();
        assert.doesNotMatch(configText, /cheap-secret-value|historian-secret-value/);
        const config = JSON.parse(configText) as {
            workflow: {
                cheapModel: { apiKey?: string; apiKeyConfigured: boolean; model: string };
                historian: { apiKey?: string; apiKeyConfigured: boolean; model: string };
            };
        };
        assert.equal(config.workflow.cheapModel.apiKeyConfigured, true);
        assert.equal(config.workflow.historian.apiKeyConfigured, true);
        assert.equal(config.workflow.cheapModel.apiKey, undefined);
        assert.equal(config.workflow.historian.apiKey, undefined);
        const stored = readFileSync(biliConfig, "utf8");
        assert.match(stored, /cheap-secret-value/);
        assert.match(stored, /historian-secret-value/);

        const statsText = await (await fetch(`${base}/__bili/stats`)).text();
        assert.doesNotMatch(statsText, /cheap-secret-value|historian-secret-value/);
        const stats = JSON.parse(statsText) as { workflow: { cheapModel: { apiKeyConfigured: boolean } } };
        assert.equal(stats.workflow.cheapModel.apiKeyConfigured, true);

        const invalid = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workflow: { pruner: { cheapModel: { endpoint: "ftp://bad.example/model" } } } }),
        });
        assert.equal(invalid.status, 400);
        assert.equal(opts.workflow?.cheapModel.endpoint, "https://models.example/v1/chat/completions");
    } finally {
        await close(proxy);
        if (previousConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previousConfig;
        rmSync(root, { recursive: true, force: true });
    }
});

test("PUT /__bili/config with providers takes effect without a separate reload call", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-put-providers-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const providers = { "https://api.example.com/v1": { models: { "gpt-test": { context: 123456 } } } };
        const put = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ providers }),
        });
        assert.equal(put.status, 200);
        const after = await (await fetch(`${base}/__bili/config`)).json() as { providers: Record<string, unknown> };
        assert.deepEqual(after.providers, providers, "providers saved and visible after PUT without /reload");
    } finally {
        await close(proxy);
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        rmSync(root, { recursive: true, force: true });
    }
});
