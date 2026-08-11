import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createInitialState } from "acp-kernel";
import type { ResponsesRequestBody, ResponseInputItem } from "../src/responses.ts";
import type { Session } from "../src/session.ts";
import { retrieveRawOutput } from "../src/workflow/archive.ts";
import { recordWorkflowCheckpoint } from "../src/workflow/context-gc.ts";
import { preprocessResponsesWorkflow } from "../src/workflow/responses-preprocessor.ts";
import { syncRequirements } from "../src/workflow/requirements.ts";
import { createInitialWorkflowState } from "../src/workflow/state.ts";
import { DEFAULT_WORKFLOW_OPTIONS } from "../src/workflow/types.ts";

function makeSession(): Session {
    return {
        id: "workflow-test-session",
        meta: { protocol: "responses" },
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

function planCall(callId: string, statuses: Array<[string, "pending" | "in_progress" | "completed"]>): ResponseInputItem {
    return {
        type: "function_call",
        call_id: callId,
        name: "update_plan",
        arguments: JSON.stringify({ plan: statuses.map(([step, status]) => ({ step, status })) }),
    };
}

test("Responses workflow prunes before ingest, archives raw output, checkpoints and rolls phases", async (t) => {
    const dataHome = mkdtempSync(path.join(tmpdir(), "bili-workflow-"));
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    t.after(() => {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousDataHome;
        rmSync(dataHome, { recursive: true, force: true });
    });
    const session = makeSession();
    const options = { ...DEFAULT_WORKFLOW_OPTIONS, prunerMinTokens: 10, rolloverMinTokens: 1_000_000 };
    const rawLog = [
        "Exit code: 0",
        ...Array.from({ length: 800 }, (_, index) => `test runner line ${index}`),
        "pass 183",
        "fail 0",
    ].join("\n");
    const initialInput: ResponseInputItem[] = [
        { type: "message", role: "user", content: "Implement the context manager without losing exact requirements." },
        planCall("plan-1", [["Implement pruning", "in_progress"], ["Verify", "pending"]]),
        { type: "function_call_output", call_id: "plan-1", output: "Plan updated" },
        { type: "function_call", call_id: "test-1", name: "shell_command", arguments: JSON.stringify({ command: "npm test" }) },
        { type: "function_call_output", call_id: "test-1", output: rawLog },
        { type: "message", role: "assistant", content: "Internal phase reasoning that should leave the active context." },
    ];
    const firstBody: ResponsesRequestBody = { model: "gpt-5-codex", input: initialInput };
    const first = await preprocessResponsesWorkflow(firstBody, session, options, 400_000, true);
    const pruned = (first.body.input as ResponseInputItem[]).find((item) => item.type === "function_call_output" && item.call_id === "test-1");
    assert.ok(pruned && "output" in pruned);
    assert.match(String(pruned.output), /\[TEST PASS\]/);
    assert.match(String(pruned.output), /raw_ref: raw_\d{6}/);
    const originalOutput = initialInput.find((item) => item.type === "function_call_output" && item.call_id === "test-1");
    assert.equal((originalOutput as { output: string }).output, rawLog);
    const testOperation = Object.values(session.workflow.operations).find((operation) => operation.toolCallId === "test-1");
    assert.equal(testOperation?.type, "TEST");
    assert.ok(testOperation?.rawRef);
    assert.equal(retrieveRawOutput(session.id, session.workflow, testOperation.rawRef), rawLog);

    const completedInput = [
        ...initialInput,
        planCall("plan-2", [["Implement pruning", "completed"], ["Verify", "completed"]]),
        { type: "function_call_output", call_id: "plan-2", output: "Plan updated" } as ResponseInputItem,
    ];
    const second = await preprocessResponsesWorkflow({ model: "gpt-5-codex", input: completedInput }, session, options, 400_000, true);
    assert.equal(Object.values(session.workflow.rawArchive).filter((record) => record.type === "TEST").length, 1);
    assert.equal(session.workflow.checkpointQueue.length, 1);
    assert.match(JSON.stringify(second.body.input), /workflow-checkpoint-request/);
    session.workflow.requirements["REQ-00001"] = {
        id: "REQ-00001",
        sourceRefs: ["m00001"],
        detail: "Implement deterministic pruning.",
        status: "ACTIVE",
        importance: "CRITICAL",
        preserveRaw: true,
        createdAt: Date.now(),
    };
    const phaseId = session.workflow.checkpointQueue[0];
    const checkpointResult = recordWorkflowCheckpoint(session.workflow, {
        phaseId,
        completedWork: "Implemented deterministic pruning.",
        currentState: "Tests pass and raw output is recoverable.",
        changedFiles: ["src/workflow/pruner/index.ts"],
        validation: ["183 tests passed"],
        requirementUpdates: [{ id: "REQ-00001", status: "SATISFIED" }],
    }, options, 0, 400_000);
    assert.match(checkpointResult, /workflow_checkpoint OK/);
    assert.equal(session.workflow.operations[testOperation.opId].lifecycle, "ARCHIVED");
    assert.equal(session.workflow.requirements["REQ-00001"].status, "SATISFIED");

    const third = await preprocessResponsesWorkflow({ model: "gpt-5-codex", input: completedInput }, session, options, 400_000, true);
    const thirdText = JSON.stringify(third.body.input);
    assert.doesNotMatch(thirdText, /test-1/);
    assert.doesNotMatch(thirdText, /Internal phase reasoning/);
    assert.match(thirdText, /workflow-memory/);
    assert.match(thirdText, /re-read the repository/);
});

test("Codex source reads stay intact and workflow tail messages never enter the requirement ledger", async () => {
    const session = makeSession();
    const rawSource = Array.from({ length: 600 }, () => "export const value = 1;").join("\n");
    const body: ResponsesRequestBody = {
        model: "gpt-5-codex",
        input: [
            { type: "custom_tool_call", call_id: "read-1", name: "codex", input: "await tools.shell_command({command: \"Get-Content src/a.ts\"})" },
            { type: "custom_tool_call_output", call_id: "read-1", output: rawSource },
        ],
    };
    const result = await preprocessResponsesWorkflow(body, session, { ...DEFAULT_WORKFLOW_OPTIONS, prunerMinTokens: 10 }, 400_000, true);
    const output = (result.body.input as ResponseInputItem[]).find((item) => item.type === "custom_tool_call_output");
    assert.equal((output as { output: string }).output, rawSource);
    const operation = Object.values(session.workflow.operations).find((candidate) => candidate.toolCallId === "read-1");
    assert.equal(operation?.type, "READ");
    assert.equal(operation?.rawRef, undefined);

    syncRequirements(session.workflow, [
        { id: "m00001", role: "user", contentType: "text", text: "Never discard my exact constraints." },
        { id: "m00002", role: "user", contentType: "text", text: "internal", rawResponsesItem: { bili_workflow: true } },
    ]);
    assert.equal(Object.keys(session.workflow.requirements).length, 1);
    assert.equal(Object.values(session.workflow.requirements)[0].importance, "CRITICAL");
});

test("Codex cwd metadata derives the same project identity across path separator and case changes", async () => {
    const first = makeSession();
    const second = makeSession();
    await preprocessResponsesWorkflow({
        model: "gpt-5-codex",
        instructions: "<environment_context><cwd>H:\\Auto\\Example</cwd></environment_context>",
        input: [{ type: "message", role: "user", content: "first" }],
    }, first, DEFAULT_WORKFLOW_OPTIONS, 400_000, true);
    await preprocessResponsesWorkflow({
        model: "gpt-5-codex",
        instructions: "<environment_context><cwd>h:/auto/example/</cwd></environment_context>",
        input: [{ type: "message", role: "user", content: "second" }],
    }, second, DEFAULT_WORKFLOW_OPTIONS, 400_000, true);
    assert.match(first.workflow.projectId ?? "", /^project-/);
    assert.equal(first.workflow.projectId, second.workflow.projectId);
});
