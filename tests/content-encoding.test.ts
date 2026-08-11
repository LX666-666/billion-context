import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { defaultConfig } from "acp-kernel";
import { decodeRequestBody } from "../src/content-encoding.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";

const JSON_BODY = Buffer.from('{"model":"gpt-5","input":"hello"}');

test("decodeRequestBody leaves identity requests untouched", async () => {
    const decoded = await decodeRequestBody(undefined, JSON_BODY, 1024);
    assert.equal(decoded.body, JSON_BODY);
    assert.equal(decoded.decoded, false);
});

test("decodeRequestBody supports gzip and stacked codings", async () => {
    const gzip = gzipSync(JSON_BODY);
    assert.deepEqual((await decodeRequestBody("gzip", gzip, 1024)).body, JSON_BODY);
    const stacked = brotliCompressSync(gzip);
    assert.deepEqual((await decodeRequestBody("gzip, br", stacked, 1024)).body, JSON_BODY);
});

test("decodeRequestBody supports Codex Desktop zstd bodies on Node 20+", async () => {
    const zstd = Buffer.from("KLUv/SAhCQEAeyJtb2RlbCI6ImdwdC01IiwiaW5wdXQiOiJoZWxsbyJ9", "base64");
    assert.deepEqual((await decodeRequestBody("zstd", zstd, 1024)).body, JSON_BODY);
});

test("decodeRequestBody rejects unsupported encodings and oversized output", async () => {
    await assert.rejects(() => decodeRequestBody("snappy", Buffer.from("x"), 1024), /unsupported/);
    await assert.rejects(() => decodeRequestBody("gzip", gzipSync(Buffer.alloc(4096)), 128));
});

test("non-protocol passthrough does not decode an empty zstd request", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let forwarded = false;
    const upstream = http.createServer((req, res) => {
        forwarded = true;
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
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
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/models`, {
            headers: { "content-encoding": "zstd" },
        });
        assert.equal(response.status, 200);
        assert.equal(forwarded, true);
    } finally {
        await Promise.all([
            new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve())),
            new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())),
        ]);
    }
});
