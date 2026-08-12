import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startServer } from "../src/server.ts";
import { DEFAULT_WORKFLOW_OPTIONS } from "../src/workflow/types.ts";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("Responses workflow tools remain intercepted when ACP compression tools are disabled", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: Array<Record<string, unknown>> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            if (captured.length === 1) {
                res.end(JSON.stringify({
                    id: "response-1",
                    status: "completed",
                    output: [{
                        type: "function_call",
                        id: "proxy-item",
                        call_id: "proxy-call",
                        name: "expand_operation",
                        arguments: JSON.stringify({ opId: "op00001" }),
                    }],
                }));
            } else {
                res.end(JSON.stringify({
                    id: "response-2",
                    status: "completed",
                    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "continued" }] }],
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        workflow: DEFAULT_WORKFLOW_OPTIONS,
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        updateMode: "manual",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "workflow-only-tools" },
            body: JSON.stringify({
                model: "test-model",
                stream: false,
                input: [
                    { type: "function_call", call_id: "client-call", name: "shell_command", arguments: JSON.stringify({ command: "npm test" }) },
                    { type: "function_call_output", call_id: "client-call", output: "pass 1\nfail 0" },
                ],
            }),
        });
        assert.equal(response.status, 200);
        const body = await response.json() as Record<string, unknown>;
        assert.match(JSON.stringify(body), /continued/);
        assert.doesNotMatch(JSON.stringify(body), /expand_operation/);
        assert.equal(captured.length, 2);
        const firstTools = captured[0].tools as Array<Record<string, unknown>>;
        assert.deepEqual(firstTools.map((tool) => tool.name), ["workflow_checkpoint", "workflow_mark", "retrieve_raw", "expand_operation"]);
        const secondInput = captured[1].input as Array<Record<string, unknown>>;
        const toolResult = secondInput.find((item) => item.type === "function_call_output" && item.call_id === "proxy-call");
        assert.ok(toolResult);
        const expanded = JSON.parse(String(toolResult.output)) as Record<string, unknown>;
        assert.equal(expanded.opId, "op00001");
        assert.equal(expanded.type, "TEST");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
