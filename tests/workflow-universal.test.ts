import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createInitialState } from "acp-kernel";
import type { BiliMessage } from "../src/bili-message.ts";
import type { Session } from "../src/session.ts";
import { preprocessCoreWorkflow } from "../src/workflow/core-preprocessor.ts";
import { retrieveRawOutput } from "../src/workflow/archive.ts";
import { createInitialWorkflowState } from "../src/workflow/state.ts";
import { DEFAULT_WORKFLOW_OPTIONS } from "../src/workflow/types.ts";

function session(): Session {
    return {
        id: "universal-workflow",
        meta: { protocol: "anthropic" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        workflow: createInitialWorkflowState(),
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("generic Anthropic/OpenAI core path fails open when raw semantic archive is disabled", async () => {
    const current = session();
    const raw = ["Exit code: 0", ...Array.from({ length: 800 }, (_, index) => `runner ${index}`), "pass 50", "fail 0"].join("\n");
    const messages: BiliMessage[] = [
        { id: "m1", role: "assistant", contentType: "tool-call", toolCallId: "call-test", toolName: "shell_command", text: JSON.stringify({ command: "npm test" }) },
        { id: "m2", role: "tool", contentType: "tool-result", toolCallId: "call-test", text: raw },
    ];
    const output = await preprocessCoreWorkflow(messages, current, { ...DEFAULT_WORKFLOW_OPTIONS, prunerMinTokens: 10, archiveSemanticRaw: false });
    assert.doesNotMatch(output[1].text ?? "", /\[TEST PASS\]/);
    assert.equal(output[1].text, raw);
    assert.equal(Object.values(current.workflow.operations)[0].type, "TEST");
});

test("generic core path preserves large source reads", async () => {
    const current = session();
    const raw = Array.from({ length: 800 }, () => "const exact = true;").join("\n");
    const messages: BiliMessage[] = [
        { id: "m1", role: "assistant", contentType: "tool-call", toolCallId: "call-read", toolName: "shell_command", text: JSON.stringify({ command: "Get-Content src/a.ts" }) },
        { id: "m2", role: "tool", contentType: "tool-result", toolCallId: "call-read", text: raw },
    ];
    const output = await preprocessCoreWorkflow(messages, current, { ...DEFAULT_WORKFLOW_OPTIONS, prunerMinTokens: 10 });
    assert.equal(output[1].text, raw);
    assert.equal(Object.values(current.workflow.operations)[0].type, "READ");
});

test("generic core path archives output pruned by the optional cheap model", async (t) => {
    const dataHome = mkdtempSync(path.join(tmpdir(), "bili-cheap-pruner-"));
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    t.after(() => {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousDataHome;
        rmSync(dataHome, { recursive: true, force: true });
    });
    const current = session();
    const raw = Array.from({ length: 900 }, (_, index) => `generated telemetry ${index}`).join("\n");
    const messages: BiliMessage[] = [
        { id: "m1", role: "assistant", contentType: "tool-call", toolCallId: "call-run", toolName: "shell_command", text: JSON.stringify({ command: "node telemetry.js" }) },
        { id: "m2", role: "tool", contentType: "tool-result", toolCallId: "call-run", text: raw },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
        choices: [{ message: { content: "[RUN OUTPUT PRUNED]\nTelemetry command completed; repetitive generated records omitted." } }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    let output: BiliMessage[];
    try {
        output = await preprocessCoreWorkflow(messages, current, {
            ...DEFAULT_WORKFLOW_OPTIONS,
            prunerMinTokens: 10,
            cheapModel: {
                enabled: true,
                endpoint: "https://cheap.example/v1/chat/completions",
                model: "nano",
                minTokens: 10,
                maxOutputTokens: 500,
                timeoutMs: 5_000,
            },
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.match(output[1].text ?? "", /\[RUN OUTPUT PRUNED\]/);
    assert.match(output[1].text ?? "", /raw_ref: raw_000001/);
    const operation = Object.values(current.workflow.operations)[0];
    assert.equal(retrieveRawOutput(current.id, current.workflow, operation.rawRef ?? ""), raw);
});
