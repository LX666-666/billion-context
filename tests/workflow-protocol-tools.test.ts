import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { compressLoopAnthropicJson, compressLoopAnthropicStream } from "../src/compress-loop-anthropic.ts";
import { compressLoopResponsesJson } from "../src/compress-loop-responses.ts";
import { compressLoopJson, compressLoopStream } from "../src/compress-loop.ts";
import { ACP_TOOLS_ANTHROPIC, ACP_TOOLS_OPENAI } from "../src/compress-tool.ts";
import { _setStoreForTest, SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { archiveOperationOutput, retrieveRawOutput } from "../src/workflow/archive.ts";
import { trackOperationCall } from "../src/workflow/operation-tracker.ts";
import { syncRequirements } from "../src/workflow/requirements.ts";
import { createInitialWorkflowState } from "../src/workflow/state.ts";

function streamOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}

function makeSession(id: string, protocol: "openai" | "anthropic" | "responses"): Session {
    return {
        id,
        meta: { protocol },
        stats: {
            requests: 0,
            tokensSaved: 0,
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            cacheSamples: 0,
            lastInputTokens: 0,
            contextTokens: 0,
        },
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

function archiveRaw(session: Session, raw: string): string {
    const operation = trackOperationCall(
        session.workflow,
        `${session.id}-call`,
        "shell_command",
        JSON.stringify({ command: "npm test" }),
    );
    const rawRef = archiveOperationOutput(session.id, session.workflow, operation, raw, Math.ceil(raw.length / 4));
    assert.ok(rawRef);
    return rawRef;
}

function openaiEvent(value: Record<string, unknown>): string {
    return `data: ${JSON.stringify(value)}\n\n`;
}

function anthropicEvent(type: string, value: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

test("Anthropic and OpenAI inject the six universal context tools", () => {
    const names = ["compress", "decompress", "search_context", "acp_status", "workflow_checkpoint", "workflow_mark", "retrieve_raw", "expand_operation"];
    assert.deepEqual(ACP_TOOLS_ANTHROPIC.map((tool) => tool.name), names);
    assert.deepEqual(ACP_TOOLS_OPENAI.map((tool) => tool.function.name), names);
});

test("streaming and JSON proxy loops restore raw output exactly without leaking proxy calls", async (t) => {
    const dataHome = mkdtempSync(path.join(tmpdir(), "bili-protocol-tools-"));
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    _setStoreForTest(new SessionStore({ enabled: false }));
    t.after(() => {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousDataHome;
        rmSync(dataHome, { recursive: true, force: true });
    });

    const raw = "Exact diagnostic line 1\nAssertionError: expected 41, received 42\nsrc/value.ts:17:9";
    const core = createCore();
    const config = defaultConfig(200_000);
    const originalFetch = globalThis.fetch;

    const openaiSession = makeSession("openai-retrieve-test", "openai");
    const openaiRef = archiveRaw(openaiSession, raw);
    const openaiInitial = [
        openaiEvent({ id: "chat-1", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
        openaiEvent({ id: "chat-1", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "proxy-1", type: "function", function: { name: "retrieve_raw", arguments: JSON.stringify({ rawRef: openaiRef }) } }] }, finish_reason: null }] }),
        openaiEvent({ id: "chat-1", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 2 } }),
        "data: [DONE]\n\n",
    ].join("");
    const openaiFinal = [
        openaiEvent({ id: "chat-2", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: { content: "continued" }, finish_reason: null }] }),
        openaiEvent({ id: "chat-2", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 24, completion_tokens: 1 } }),
        "data: [DONE]\n\n",
    ].join("");
    let forwardedOpenai: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        forwardedOpenai = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(openaiFinal, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let openaiOutput = "";
    try {
        for await (const chunk of compressLoopStream(
            streamOf(openaiInitial),
            { core, config, messages: [], session: openaiSession, log: () => {} },
            { model: "test", messages: [] },
            { url: "https://example.invalid/openai", headers: { "content-type": "application/json" } },
        )) {
            openaiOutput += chunk.toString("utf8");
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.ok(forwardedOpenai);
    const openaiMessages = forwardedOpenai.messages as Array<Record<string, unknown>>;
    const openaiToolResult = openaiMessages.find((message) => message.role === "tool");
    assert.equal(openaiToolResult?.content, raw);
    assert.doesNotMatch(openaiOutput, /"name":"retrieve_raw"/);
    assert.match(openaiOutput, /continued/);
    assert.equal(openaiSession.workflow.metrics.rawRetrievals, 1);
    const requirementText = "Keep every exact number and never discard this requirement: 41 → 42.";
    const requirements = syncRequirements(openaiSession.workflow, [{
        id: "m-user-1",
        role: "user",
        contentType: "text",
        text: requirementText,
    }], openaiSession.id);
    assert.ok(requirements[0].rawRef);
    assert.equal(retrieveRawOutput(openaiSession.id, openaiSession.workflow, requirements[0].rawRef), requirementText);

    const openaiJsonSession = makeSession("openai-json-retrieve-test", "openai");
    const openaiJsonRef = archiveRaw(openaiJsonSession, raw);
    const openaiJsonInitial = {
        id: "chat-json-1",
        choices: [{
            message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "proxy-json-1", type: "function", function: { name: "retrieve_raw", arguments: JSON.stringify({ rawRef: openaiJsonRef }) } }],
            },
            finish_reason: "tool_calls",
        }],
    };
    let forwardedOpenaiJson: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        forwardedOpenaiJson = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
            id: "chat-json-2",
            choices: [{ message: { role: "assistant", content: "continued" }, finish_reason: "stop" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    let openaiJsonFinal: Record<string, unknown>;
    try {
        openaiJsonFinal = await compressLoopJson(
            openaiJsonInitial,
            { core, config, messages: [], session: openaiJsonSession, log: () => {} },
            { model: "test", messages: [] },
            { url: "https://example.invalid/openai-json", headers: { "content-type": "application/json" } },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.ok(forwardedOpenaiJson);
    const openaiJsonMessages = forwardedOpenaiJson.messages as Array<Record<string, unknown>>;
    const openaiJsonToolResult = openaiJsonMessages.find((message) => message.role === "tool");
    assert.equal(openaiJsonToolResult?.content, raw);
    assert.match(JSON.stringify(openaiJsonFinal), /continued/);
    assert.doesNotMatch(JSON.stringify(openaiJsonFinal), /retrieve_raw/);

    const anthropicSession = makeSession("anthropic-retrieve-test", "anthropic");
    const anthropicRef = archiveRaw(anthropicSession, raw);
    const anthropicInitial = [
        anthropicEvent("message_start", { type: "message_start", message: { id: "msg-1", type: "message", role: "assistant", content: [], model: "test", usage: { input_tokens: 20, output_tokens: 0 } } }),
        anthropicEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "proxy-2", name: "retrieve_raw", input: {} } }),
        anthropicEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ rawRef: anthropicRef }) } }),
        anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicEvent("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 20, output_tokens: 2 } }),
        anthropicEvent("message_stop", { type: "message_stop" }),
    ].join("");
    const anthropicFinal = [
        anthropicEvent("message_start", { type: "message_start", message: { id: "msg-2", type: "message", role: "assistant", content: [], model: "test", usage: { input_tokens: 24, output_tokens: 0 } } }),
        anthropicEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "continued" } }),
        anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 24, output_tokens: 1 } }),
        anthropicEvent("message_stop", { type: "message_stop" }),
    ].join("");
    let forwardedAnthropic: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        forwardedAnthropic = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(anthropicFinal, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let anthropicOutput = "";
    try {
        for await (const chunk of compressLoopAnthropicStream(
            streamOf(anthropicInitial),
            { core, config, messages: [], session: anthropicSession, log: () => {} },
            { model: "test", messages: [] },
            { url: "https://example.invalid/anthropic", headers: { "content-type": "application/json" } },
        )) {
            anthropicOutput += chunk.toString("utf8");
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.ok(forwardedAnthropic);
    const anthropicMessages = forwardedAnthropic.messages as Array<Record<string, unknown>>;
    const anthropicToolResultMessage = anthropicMessages.find((message) => message.role === "user");
    const anthropicContent = anthropicToolResultMessage?.content as Array<Record<string, unknown>>;
    const anthropicToolResult = anthropicContent.find((block) => block.type === "tool_result");
    assert.equal(anthropicToolResult?.content, raw);
    assert.doesNotMatch(anthropicOutput, /"name":"retrieve_raw"/);
    assert.match(anthropicOutput, /continued/);
    assert.equal(anthropicSession.workflow.metrics.rawRetrievals, 1);

    const anthropicJsonSession = makeSession("anthropic-json-retrieve-test", "anthropic");
    const anthropicJsonRef = archiveRaw(anthropicJsonSession, raw);
    const anthropicJsonInitial = {
        id: "msg-json-1",
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: "proxy-json-2", name: "retrieve_raw", input: { rawRef: anthropicJsonRef } }],
        stop_reason: "tool_use",
    };
    let forwardedAnthropicJson: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        forwardedAnthropicJson = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
            id: "msg-json-2",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "continued" }],
            stop_reason: "end_turn",
        }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    let anthropicJsonFinal: Record<string, unknown>;
    try {
        anthropicJsonFinal = await compressLoopAnthropicJson(
            anthropicJsonInitial,
            { core, config, messages: [], session: anthropicJsonSession, log: () => {} },
            { model: "test", messages: [] },
            { url: "https://example.invalid/anthropic-json", headers: { "content-type": "application/json" } },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.ok(forwardedAnthropicJson);
    const anthropicJsonMessages = forwardedAnthropicJson.messages as Array<Record<string, unknown>>;
    const anthropicJsonToolMessage = anthropicJsonMessages.find((message) => message.role === "user");
    const anthropicJsonResults = anthropicJsonToolMessage?.content as Array<Record<string, unknown>>;
    assert.equal(anthropicJsonResults[0].content, raw);
    assert.match(JSON.stringify(anthropicJsonFinal), /continued/);
    assert.doesNotMatch(JSON.stringify(anthropicJsonFinal), /retrieve_raw/);

    const responsesSession = makeSession("responses-retrieve-test", "responses");
    const responsesRef = archiveRaw(responsesSession, raw);
    const responsesInitial = {
        id: "response-1",
        status: "completed",
        output: [{
            type: "function_call",
            id: "fc-1",
            call_id: "proxy-3",
            name: "retrieve_raw",
            arguments: JSON.stringify({ rawRef: responsesRef }),
        }],
    };
    let forwardedResponses: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        forwardedResponses = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
            id: "response-2",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "continued" }] }],
        }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    let responsesFinal: Record<string, unknown>;
    try {
        responsesFinal = await compressLoopResponsesJson(
            responsesInitial,
            { core, config, messages: [], session: responsesSession, log: () => {}, textProtocol: false },
            { model: "test", input: [] },
            { url: "https://example.invalid/responses", headers: { "content-type": "application/json" } },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.ok(forwardedResponses);
    const responsesInput = forwardedResponses.input as Array<Record<string, unknown>>;
    const responsesToolResult = responsesInput.find((item) => item.type === "function_call_output");
    assert.equal(responsesToolResult?.output, raw);
    assert.ok(responsesInput.some((item) => item.type === "function_call" && item.name === "retrieve_raw"));
    assert.match(JSON.stringify(responsesFinal), /continued/);
    assert.doesNotMatch(JSON.stringify(responsesFinal), /retrieve_raw/);
    assert.equal(responsesSession.workflow.metrics.rawRetrievals, 1);
});
