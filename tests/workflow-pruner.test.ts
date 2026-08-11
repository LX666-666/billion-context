import assert from "node:assert/strict";
import test from "node:test";
import { classifyOperation } from "../src/workflow/operation-classifier.ts";
import { cleanDeterministic } from "../src/workflow/pruner/deterministic.ts";
import { pruneWithCheapModel } from "../src/workflow/pruner/cheap-model.ts";
import { pruneToolOutput } from "../src/workflow/pruner/index.ts";
import { DEFAULT_WORKFLOW_OPTIONS, type OperationRecord } from "../src/workflow/types.ts";

function operation(type: OperationRecord["type"]): OperationRecord {
    return {
        opId: "op00001",
        phaseId: "phase00001",
        type,
        callRefs: [],
        resultRefs: [],
        command: type === "TEST" ? "npm test" : "npm run build",
        rawTokens: 0,
        visibleTokens: 0,
        lifecycle: "ACTIVE",
        importance: "NORMAL",
        createdAt: 1,
        updatedAt: 1,
    };
}

test("Codex custom tool input classifies code reads as protected READ operations", () => {
    const classified = classifyOperation("codex", "await tools.shell_command({command: \"Get-Content src/foo.ts\"})");
    assert.equal(classified.type, "READ");
});

test("deterministic cleaner removes ANSI, spinner noise and duplicate redraws", () => {
    const raw = "\u001b[32mok\u001b[0m\n| loading\nwarning x\nwarning x\nwarning x\n\n\n\nend";
    const cleaned = cleanDeterministic(raw);
    assert.equal(cleaned.changed, true);
    assert.match(cleaned.text, /^ok/m);
    assert.doesNotMatch(cleaned.text, /loading|\u001b/);
    assert.match(cleaned.text, /previous line repeated 2 more times/);
});

test("source reads remain byte-for-byte intact even above pruning threshold", () => {
    const raw = Array.from({ length: 500 }, () => "const value = 1;").join("\n");
    const result = pruneToolOutput(operation("READ"), raw, { ...DEFAULT_WORKFLOW_OPTIONS, prunerMinTokens: 10 }, "raw_000001");
    assert.equal(result.text, raw);
    assert.equal(result.semanticPruned, false);
});

test("large passing test logs become structured results with a raw ref", () => {
    const raw = [
        "Exit code: 0",
        "Wall time: 21.4s",
        ...Array.from({ length: 600 }, (_, index) => `progress ${index}`),
        "tests 185",
        "pass 183",
        "fail 0",
        "skipped 2",
    ].join("\n");
    const result = pruneToolOutput(operation("TEST"), raw, { ...DEFAULT_WORKFLOW_OPTIONS, prunerMinTokens: 10 }, "raw_000001");
    assert.equal(result.semanticPruned, true);
    assert.match(result.text, /\[TEST PASS\]/);
    assert.match(result.text, /op_id: op00001/);
    assert.match(result.text, /passed: 183/);
    assert.match(result.text, /failed: 0/);
    assert.match(result.text, /raw_ref: raw_000001/);
    assert.ok(result.visibleTokens < result.rawTokens / 5);
});

test("failed test pruning keeps exact assertion, location and exit code", () => {
    const raw = [
        "Exit code: 1",
        ...Array.from({ length: 600 }, (_, index) => `runner detail ${index}`),
        "FAIL FooServiceTests.ShouldReturnNull",
        "AssertionError: expected null but actual 42",
        "at tests/FooService.test.ts:91:7",
        "fail 1",
    ].join("\n");
    const result = pruneToolOutput(operation("TEST"), raw, { ...DEFAULT_WORKFLOW_OPTIONS, prunerMinTokens: 10 }, "raw_000002");
    assert.match(result.text, /\[TEST FAILED\]/);
    assert.match(result.text, /exit_code: 1/);
    assert.match(result.text, /AssertionError: expected null but actual 42/);
    assert.match(result.text, /tests\/FooService\.test\.ts:91:7/);
});

test("optional cheap pruner receives only bounded workflow hints and preserves exact diagnostics", async () => {
    const raw = [
        "Exit code: 1",
        "AssertionError: expected 41 but actual 42",
        "at src/value.ts:17:9",
        ...Array.from({ length: 600 }, (_, index) => `machine detail ${index}`),
    ].join("\n");
    const options = {
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
    };
    const base = pruneToolOutput(operation("RUN"), raw, options);
    assert.equal(base.semanticPruned, false);
    const originalFetch = globalThis.fetch;
    let request: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
            choices: [{ message: { content: "[RUN FAILED]\nExit code: 1\nAssertionError: expected 41 but actual 42\nat src/value.ts:17:9" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    let result: Awaited<ReturnType<typeof pruneWithCheapModel>>;
    try {
        result = await pruneWithCheapModel(operation("RUN"), base, options, {
            phaseObjective: "Diagnose the failing command",
            requirementHint: "REQ-00001: Preserve exact errors",
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.ok(request);
    const messages = request.messages as Array<Record<string, unknown>>;
    const payload = JSON.parse(String(messages[1].content)) as Record<string, unknown>;
    assert.equal(payload.phaseObjective, "Diagnose the failing command");
    assert.equal(payload.requirementHint, "REQ-00001: Preserve exact errors");
    assert.equal(payload.toolOutput, base.text);
    assert.equal(result.semanticPruned, true);
    assert.match(result.text, /AssertionError: expected 41 but actual 42/);
    assert.match(result.text, /src\/value\.ts:17:9/);
    assert.ok(result.visibleTokens < base.visibleTokens);
});

test("cheap pruner never sends protected source reads", async () => {
    const raw = Array.from({ length: 600 }, () => "export const exact = 42;").join("\n");
    const options = {
        ...DEFAULT_WORKFLOW_OPTIONS,
        cheapModel: {
            enabled: true,
            endpoint: "https://cheap.example/v1/chat/completions",
            model: "nano",
            minTokens: 10,
            maxOutputTokens: 500,
            timeoutMs: 5_000,
        },
    };
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        calls++;
        return new Response("{}");
    }) as typeof fetch;
    try {
        const base = pruneToolOutput(operation("READ"), raw, options);
        const result = await pruneWithCheapModel(operation("READ"), base, options, {});
        assert.equal(result.text, raw);
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(calls, 0);
});
