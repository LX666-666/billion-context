import assert from "node:assert/strict";
import test from "node:test";
import { classifyOperation } from "../src/workflow/operation-classifier.ts";
import { cleanDeterministic } from "../src/workflow/pruner/deterministic.ts";
import { pruneWithCheapModel } from "../src/workflow/pruner/cheap-model.ts";
import { pruneToolOutput } from "../src/workflow/pruner/index.ts";
import { DEFAULT_WORKFLOW_OPTIONS, type OperationRecord } from "../src/workflow/types.ts";

function operation(type: OperationRecord["type"], overrides: Partial<OperationRecord> = {}): OperationRecord {
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
        ...overrides,
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

test("large failed RUN output preserves crash diagnostics, signal and environment clues", () => {
    const raw = [
        "Exit code: 134",
        "Wall time: 18.2s",
        "Node.js: v22.5.1",
        "Platform: win32 x64",
        "cwd: H:\\work\\repo",
        "API_KEY=must-not-leak",
        ...Array.from({ length: 600 }, (_, index) => `progress ${index}`),
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        "Error: JavaScript heap out of memory",
        "    at src/worker.ts:44:11",
        "signal: SIGABRT",
    ].join("\n");
    const result = pruneToolOutput(operation("RUN", { command: "node dist/worker.js", workdir: "H:\\work\\repo" }), raw, {
        ...DEFAULT_WORKFLOW_OPTIONS,
        prunerMinTokens: 10,
    }, "raw_run_failure");
    assert.equal(result.semanticPruned, true);
    assert.match(result.text, /\[RUN FAILED\]/);
    assert.match(result.text, /exit_code: 134/);
    assert.match(result.text, /signal: SIGABRT/);
    assert.match(result.text, /FATAL ERROR: Reached heap limit/);
    assert.match(result.text, /src\/worker\.ts:44:11/);
    assert.match(result.text, /Node\.js: v22\.5\.1/);
    assert.match(result.text, /Platform: win32 x64/);
    assert.doesNotMatch(result.text, /must-not-leak/);
    assert.ok(result.visibleTokens < result.rawTokens / 4);
});

test("large machine JSON becomes a path-aware redacted structural summary", () => {
    const raw = JSON.stringify({
        status: "failed",
        request_id: "req_exact_123",
        environment: { node_version: "v22.5.1", platform: "win32", api_key: "must-not-leak" },
        errors: [{ code: "E_PARSE", message: "Unexpected token }", file: "src/config.ts", line: 42 }],
        items: Array.from({ length: 1_000 }, (_, index) => ({ id: `item_${index}`, value: index })),
    }, null, 2);
    const result = pruneToolOutput(operation("RUN", { command: "node diagnostics.js --json" }), raw, {
        ...DEFAULT_WORKFLOW_OPTIONS,
        prunerMinTokens: 10,
    }, "raw_json_output");
    assert.equal(result.semanticPruned, true);
    assert.match(result.text, /\[JSON OUTPUT PRUNED\]/);
    assert.match(result.text, /top_level_keys: status, request_id, environment, errors, items/);
    assert.match(result.text, /\$\.errors\[0\]\.code: "E_PARSE"/);
    assert.match(result.text, /\$\.errors\[0\]\.file: "src\/config\.ts"/);
    assert.match(result.text, /raw_ref: raw_json_output/);
    assert.doesNotMatch(result.text, /must-not-leak/);
    assert.ok(result.visibleTokens < result.rawTokens / 10);
});

test("large JSONL diagnostics preserve record count and exact error fields", () => {
    const raw = Array.from({ length: 300 }, (_, index) => JSON.stringify({
        id: `event_${index}`,
        status: index === 299 ? "failed" : "ok",
        ...(index === 299 ? { error_code: "E_LAST", message: "final exact failure", file: "src/end.ts", line: 9 } : {}),
    })).join("\n");
    const result = pruneToolOutput(operation("OTHER"), raw, { ...DEFAULT_WORKFLOW_OPTIONS, prunerMinTokens: 10 }, "raw_jsonl_output");
    assert.match(result.text, /\[JSONL OUTPUT PRUNED\]/);
    assert.match(result.text, /record_count: 300/);
    assert.match(result.text, /E_LAST|raw_ref: raw_jsonl_output/);
    assert.ok(result.visibleTokens < result.rawTokens / 4);
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
    const cheapOperation = operation("OTHER", { command: "node opaque-diagnostic.js" });
    const base = pruneToolOutput(cheapOperation, raw, options);
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
        result = await pruneWithCheapModel(cheapOperation, base, options, {
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
