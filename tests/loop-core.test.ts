import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter, type LoopCtx } from "../src/loop/index.ts";
import {
    buildCompressSystemPrompt,
    EXPAND_OPERATION_TEXT_CLOSE,
    EXPAND_OPERATION_TEXT_OPEN,
    RETRIEVE_RAW_TEXT_CLOSE,
    RETRIEVE_RAW_TEXT_OPEN,
    WORKFLOW_TEXT_CLOSE,
    WORKFLOW_TEXT_OPEN,
} from "../src/compress-tool.ts";
import { createInitialWorkflowState } from "../src/workflow/state.ts";
import { DEFAULT_WORKFLOW_OPTIONS } from "../src/workflow/types.ts";

function makeCtx(messages: CoreMessage[] = []): LoopCtx {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages,
        session: {
            id: "loop-core-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
            metadata: {},
            workflow: createInitialWorkflowState(),
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: () => {},
    };
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function drain(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    requestBody: Record<string, unknown>,
    requestOptions: { url: string; headers: Record<string, string> },
    systemPrompt = buildCompressSystemPrompt(),
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, requestBody, requestOptions, createResponsesAdapter(), systemPrompt)) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

const COMPLETED = sse("response.completed", { response: { id: "resp_done", status: "completed", output: [] } });

test("loop #1: acp_status-only round → marker surfaced + re-request (avoids tool_calls-no-body hang)", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_status", "acp_status", "{}"),
        COMPLETED,
    ].join("");
    const round2 = COMPLETED;
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round2, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("[ACP]"), "acp_status visibility marker surfaced to client");
        assert.ok(/response\.completed/.test(out), "graceful completion present (no 炸锅)");
        assert.equal(fetchCalls, 1, "re-request after acp_status so model can continue (not finish_reason=tool_calls with no body)");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #2: search_context-only round → marker surfaced + re-request", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_search", "search_context", JSON.stringify({ query: "auth", limit: 3 })),
        COMPLETED,
    ].join("");
    const round2 = COMPLETED;
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round2, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("[ACP]"), "search_context marker surfaced");
        assert.ok(/response\.completed/.test(out), "graceful completion present");
        assert.equal(fetchCalls, 1, "re-request after search_context so model can use results");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #8: real-tool passthrough → emitted to client, loop ends (no re-request)", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_bash", "bash", JSON.stringify({ command: "ls" })),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round1, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("\"name\":\"bash\""), "real tool call emitted to client");
        assert.ok(/response\.completed/.test(out), "completion present (loop ended)");
        assert.equal(fetchCalls, 0, "NO re-request: real tool ends the loop");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #9: mixed compress + real tool → forwarded (no re-request), compress executed, marker shown", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_compress", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] })),
        fcEvents(1, "call_bash", "bash", JSON.stringify({ command: "echo hi" })),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round1, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("[ACP]"), "compress marker shown");
        assert.ok(out.includes("\"name\":\"bash\""), "real tool forwarded to client");
        assert.equal(fetchCalls, 0, "NO re-request: real tool present alongside mutating proxy tool");
        assert.ok(/response\.completed/.test(out), "completion present");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #5: limit-hit graceful — 10 mutating rounds never degenerate empty, no crash", async () => {
    const mutatingRound = [
        sse("response.created", { response: { id: "resp_m", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] })),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(mutatingRound, { status: 200 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(mutatingRound, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(/response\.completed/.test(out), "graceful completion at limit (NOT degenerate empty)");
        assert.ok(!/^data: \[\]\n\n$/.test(out), "no degenerate empty payload");
        const completedCount = (out.match(/event: response\.completed/g) || []).length;
        assert.equal(completedCount, 1, "exactly one completion event (one SSE event line)");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #11: workflow checkpoint executes, refreshes the request and re-requests", async () => {
    const ctx = makeCtx();
    ctx.workflowOptions = DEFAULT_WORKFLOW_OPTIONS;
    ctx.session.workflow.phases.phase00001 = {
        phaseId: "phase00001",
        objective: "finish integration",
        status: "CHECKPOINT_PENDING",
        operationIds: [],
        itemKeys: [],
        startedAt: Date.now(),
    };
    ctx.session.workflow.activePhaseId = "phase00001";
    ctx.session.workflow.checkpointQueue.push("phase00001");
    let refreshes = 0;
    ctx.refreshWorkflowRequest = async (requestBody) => {
        refreshes++;
        return { requestBody, messages: [] };
    };
    const args = {
        phaseId: "phase00001",
        completedWork: "Integrated the V2 loop.",
        currentState: "The proxy continues after checkpointing.",
    };
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_checkpoint", "workflow_checkpoint", JSON.stringify(args)),
        COMPLETED,
    ].join("");
    const orig = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(COMPLETED, { status: 200 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-5", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, 1);
        assert.equal(refreshes, 1);
        assert.equal(Object.keys(ctx.session.workflow.checkpoints).length, 1);
        assert.match(out, /workflow_checkpoint OK/);
    } finally {
        globalThis.fetch = orig;
    }
});

test("responses V2 text protocol recognizes workflow retrieval markers", () => {
    const adapter = createResponsesAdapter(true);
    const text = [
        `${WORKFLOW_TEXT_OPEN}{"phaseId":"phase00001"}${WORKFLOW_TEXT_CLOSE}`,
        `${RETRIEVE_RAW_TEXT_OPEN}{"rawRef":"raw_000001"}${RETRIEVE_RAW_TEXT_CLOSE}`,
        `${EXPAND_OPERATION_TEXT_OPEN}{"opId":"op00001"}${EXPAND_OPERATION_TEXT_CLOSE}`,
    ].join("\n");
    const extracted = adapter.extractTextTriggers?.(text);
    assert.deepEqual(extracted?.calls.map((call) => call.name), [
        "workflow_checkpoint",
        "retrieve_raw",
        "expand_operation",
    ]);
    assert.equal(extracted?.clean.trim(), "");
});
