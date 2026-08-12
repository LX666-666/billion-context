import assert from "node:assert/strict";
import test from "node:test";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { compressLoopResponsesJson, extractTextTriggers } from "../src/compress-loop-responses.ts";
import {
    ACP_CONTEXT_TOOLS_RESPONSES,
    ACP_TOOLS_RESPONSES,
    WORKFLOW_TOOLS_RESPONSES,
} from "../src/compress-tool.ts";
import type { Session } from "../src/session.ts";
import { trackOperationCall, updateOperationResult } from "../src/workflow/operation-tracker.ts";
import { createInitialWorkflowState } from "../src/workflow/state.ts";
import { DEFAULT_WORKFLOW_OPTIONS } from "../src/workflow/types.ts";
import { preprocessResponsesWorkflow } from "../src/workflow/responses-preprocessor.ts";
import type { ResponsesRequestBody, ResponseInputItem } from "../src/responses.ts";

test("Responses tool groups keep compression and workflow injection independently selectable", () => {
    assert.deepEqual(ACP_CONTEXT_TOOLS_RESPONSES.map((tool) => tool.name), ["compress", "decompress", "search_context", "acp_status"]);
    assert.deepEqual(WORKFLOW_TOOLS_RESPONSES.map((tool) => tool.name), ["workflow_checkpoint", "workflow_mark", "retrieve_raw", "expand_operation"]);
    assert.equal(ACP_TOOLS_RESPONSES.length, 8);
});

test("Codex text protocol extracts checkpoint and retrieval markers without exposing them", () => {
    const text = [
        "before",
        '<workflow_checkpoint>{"phaseId":"phase00001","completedWork":"done","currentState":"pass"}</workflow_checkpoint>',
        '<retrieve_raw>{"rawRef":"raw_000001"}</retrieve_raw>',
        '<expand_operation>{"opId":"op00001"}</expand_operation>',
        "after",
    ].join("\n");
    const extracted = extractTextTriggers(text);
    assert.deepEqual(extracted.calls.map((call) => call.name), ["workflow_checkpoint", "retrieve_raw", "expand_operation"]);
    assert.doesNotMatch(extracted.clean, /workflow_checkpoint|retrieve_raw|expand_operation/);
    assert.match(extracted.clean, /before[\s\S]*after/);
});

test("Codex checkpoint refreshes the same internal sampling request after phase rollover", async () => {
    const workflow = createInitialWorkflowState();
    const operation = trackOperationCall(workflow, "work-call", "shell_command", JSON.stringify({ command: "npm test" }));
    updateOperationResult(workflow, operation, 20_000, 1_000);
    const phase = workflow.phases[operation.phaseId];
    const session: Session = {
        id: "checkpoint-refresh",
        meta: { protocol: "responses" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        workflow,
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
    const initial = {
        id: "response-checkpoint",
        status: "completed",
        output: [{
            type: "message",
            role: "assistant",
            content: [{
                type: "output_text",
                text: `<workflow_checkpoint>{"phaseId":"${phase.phaseId}","completedWork":"Implemented pruning","currentState":"Tests pass","validation":["npm test PASS op00001"]}</workflow_checkpoint>`,
            }],
        }],
    };
    const rawRequest: ResponsesRequestBody = {
        model: "gpt-5-codex",
        input: [
            { type: "function_call", call_id: "work-call", name: "shell_command", arguments: JSON.stringify({ command: "npm test" }) },
            { type: "function_call_output", call_id: "work-call", output: "Exit code: 0\npass 1\nfail 0" },
            { type: "message", role: "assistant", content: "Internal phase reasoning" },
        ],
    };
    const request = (await preprocessResponsesWorkflow(rawRequest, session, DEFAULT_WORKFLOW_OPTIONS, 200_000, true)).body as Record<string, unknown>;
    const requestItems = request.input as ResponseInputItem[];
    const assistant = requestItems.find((item) => item.type === "message" && item.role === "assistant") as { content: string };
    assistant.content = '\x3cacp tokens="4" type="text"\x3em00001\x3c/acp\x3eInternal phase reasoning';
    requestItems.push({ type: "message", role: "user", content: "<workflow-checkpoint-request>stale</workflow-checkpoint-request>", bili_workflow: true });
    phase.status = "CHECKPOINT_PENDING";
    phase.completedAt = Date.now();
    workflow.activePhaseId = undefined;
    workflow.checkpointQueue.push(phase.phaseId);
    workflow.sessionStatus = "COMPLETE_CANDIDATE";
    const previousFetch = globalThis.fetch;
    let forwarded: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
            id: "response-final",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
        }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
        await compressLoopResponsesJson(initial, {
            core: createCore(),
            config: defaultConfig(200_000),
            messages: [],
            session,
            log: () => {},
            textProtocol: true,
            workflowOptions: DEFAULT_WORKFLOW_OPTIONS,
        }, request, { url: "https://unused.example/responses", headers: {} });
    } finally {
        globalThis.fetch = previousFetch;
    }
    assert.ok(forwarded);
    const forwardedText = JSON.stringify(forwarded.input);
    assert.doesNotMatch(forwardedText, /work-call|workflow-checkpoint-request|Internal phase reasoning/);
    assert.match(forwardedText, /workflow-memory/);
    assert.equal(operation.lifecycle, "ARCHIVED");
});
