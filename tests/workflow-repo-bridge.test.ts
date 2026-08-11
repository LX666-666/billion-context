import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createInitialState } from "acp-kernel";
import type { BiliMessage } from "../src/bili-message.ts";
import type { Session } from "../src/session.ts";
import { preprocessCoreWorkflow } from "../src/workflow/core-preprocessor.ts";
import { classifyOperation } from "../src/workflow/operation-classifier.ts";
import { trackOperationCall } from "../src/workflow/operation-tracker.ts";
import { applyPlanUpdate } from "../src/workflow/plan-tracker.ts";
import { preprocessResponsesWorkflow } from "../src/workflow/responses-preprocessor.ts";
import {
    guardedOperationOutput,
    observeRepositoryOperation,
    refreshRepoBridge,
    repositoryGuardMessage,
} from "../src/workflow/repo-bridge.ts";
import { createInitialWorkflowState, mergeWorkflowState } from "../src/workflow/state.ts";
import { DEFAULT_WORKFLOW_OPTIONS, type OperationRecord } from "../src/workflow/types.ts";

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function repository(t: TestContext): { base: string; root: string } {
    const base = mkdtempSync(path.join(tmpdir(), "bili-repo-bridge-"));
    const root = path.join(base, "repo");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(path.join(root, "src", "b.ts"), "export const b = 1;\n", "utf8");
    git(root, "init");
    git(root, "config", "core.autocrlf", "false");
    git(root, "config", "user.email", "repo-bridge@example.invalid");
    git(root, "config", "user.name", "Repo Bridge Test");
    git(root, "add", "src/a.ts", "src/b.ts");
    git(root, "commit", "-m", "initial");
    git(root, "remote", "add", "origin", "https://token:secret@example.com/acme/repo.git?auth=hidden");
    t.after(() => rmSync(base, { recursive: true, force: true }));
    return { base, root };
}

function session(): Session {
    return {
        id: "repo-bridge-session",
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

function plan(items: Array<[string, "pending" | "in_progress" | "completed"]>): string {
    return JSON.stringify({ plan: items.map(([step, status]) => ({ step, status })) });
}

test("Repo Bridge records sanitized repository identity, HEAD, dirty state and rejects outside reads", (t) => {
    const { base, root } = repository(t);
    const state = createInitialWorkflowState();
    const repo = refreshRepoBridge(state, root, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(repo.repoRoot, realpathSync(root));
    assert.equal(repo.workspaceRoot, realpathSync(root));
    assert.equal(repo.head, git(root, "rev-parse", "HEAD"));
    assert.equal(repo.dirty, false);
    assert.equal(repo.remoteIdentity, "https://example.com/acme/repo");
    assert.doesNotMatch(repo.remoteIdentity ?? "", /token|secret|hidden/);

    const outside = path.join(base, "outside.txt");
    writeFileSync(outside, "private", "utf8");
    const read = trackOperationCall(state, "outside-read", "shell_command", JSON.stringify({ command: `Get-Content -LiteralPath '${outside}'`, workdir: root }));
    observeRepositoryOperation(state, read, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(Object.keys(state.repoBridge.files).length, 0);

    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
    refreshRepoBridge(state, root, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(state.repoBridge.dirty, true);
});

test("Repo Bridge enforces multi-file re-read after a phase and permanently withholds blocked mutation output", (t) => {
    const { base, root } = repository(t);
    const state = createInitialWorkflowState();
    refreshRepoBridge(state, root, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    applyPlanUpdate(state, "plan-1", plan([["implement", "in_progress"], ["verify", "pending"]]));

    for (const name of ["a.ts", "b.ts"]) {
        const read = trackOperationCall(state, `read-${name}`, "shell_command", JSON.stringify({ command: `Get-Content -LiteralPath 'src/${name}'`, workdir: root }));
        observeRepositoryOperation(state, read, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    }
    const firstPatch = trackOperationCall(state, "patch-1", "apply_patch", JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch" }));
    observeRepositoryOperation(state, firstPatch, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(firstPatch.repositoryGuard, undefined);

    applyPlanUpdate(state, "plan-2", plan([["implement", "completed"], ["verify", "in_progress"]]));
    const blocked = trackOperationCall(state, "patch-2", "apply_patch", JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+A\n*** Update File: src/b.ts\n@@\n-b\n+B\n*** End Patch" }));
    observeRepositoryOperation(state, blocked, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(blocked.repositoryGuard?.status, "BLOCKED_REREAD");
    assert.deepEqual(blocked.repositoryGuard?.paths.sort(), ["src/a.ts", "src/b.ts"]);
    assert.match(guardedOperationOutput(blocked) ?? "", /REPOSITORY REREAD REQUIRED/);

    const rereadA = trackOperationCall(state, "reread-a", "shell_command", JSON.stringify({ command: "Get-Content -LiteralPath 'src/a.ts'", workdir: root }));
    observeRepositoryOperation(state, rereadA, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(blocked.repositoryGuard?.status, "BLOCKED_REREAD");
    const rereadB = trackOperationCall(state, "reread-b", "shell_command", JSON.stringify({ command: "Get-Content -LiteralPath 'src/b.ts'", workdir: root }));
    observeRepositoryOperation(state, rereadB, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(blocked.repositoryGuard?.status, "SATISFIED");
    assert.equal(repositoryGuardMessage(state), undefined);
    assert.match(guardedOperationOutput(blocked) ?? "", /REPOSITORY SNAPSHOT REFRESHED/);

    const allowed = trackOperationCall(state, "patch-3", "apply_patch", JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+A\n*** End Patch" }));
    observeRepositoryOperation(state, allowed, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(allowed.repositoryGuard, undefined);

    const added = trackOperationCall(state, "patch-add", "apply_patch", JSON.stringify({ patch: "*** Begin Patch\n*** Add File: src/new.ts\n+export {};\n*** End Patch" }));
    observeRepositoryOperation(state, added, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(added.repositoryGuard, undefined);

    const outside = trackOperationCall(state, "outside-write", "write_file", JSON.stringify({ path: path.join(base, "outside.ts"), content: "unsafe" }));
    observeRepositoryOperation(state, outside, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(outside.repositoryGuard?.status, "BLOCKED_REREAD");
});

test("Repo Bridge marks external file and HEAD changes stale and blocks a later same-phase mutation", (t) => {
    const { root } = repository(t);
    const state = createInitialWorkflowState();
    refreshRepoBridge(state, root, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    const read = trackOperationCall(state, "read-a", "shell_command", JSON.stringify({ command: "Get-Content -LiteralPath 'src/a.ts'", workdir: root }));
    observeRepositoryOperation(state, read, DEFAULT_WORKFLOW_OPTIONS.repoBridge);

    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 3;\n", "utf8");
    refreshRepoBridge(state, root, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.match(repositoryGuardMessage(state) ?? "", /FILE_CHANGED/);
    refreshRepoBridge(state, root, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    const patch = trackOperationCall(state, "patch-after-external", "apply_patch", JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+A\n*** End Patch" }));
    observeRepositoryOperation(state, patch, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(patch.repositoryGuard?.status, "BLOCKED_REREAD");

    const reread = trackOperationCall(state, "reread-after-external", "shell_command", JSON.stringify({ command: "Get-Content -LiteralPath 'src/a.ts'", workdir: root }));
    observeRepositoryOperation(state, reread, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 4;\n", "utf8");
    git(root, "add", "src/a.ts");
    git(root, "commit", "-m", "external head");
    refreshRepoBridge(state, root, DEFAULT_WORKFLOW_OPTIONS.repoBridge);
    assert.equal(Object.values(state.repoBridge.files)[0]?.staleReason, "HEAD_CHANGED");
});

test("Codex wrappers expose paths and generic workflow tails do not become requirements", async (t) => {
    const { root } = repository(t);
    const forwardRoot = root.replace(/\\/g, "/");
    const classification = classifyOperation("codex", `await tools.shell_command({command: "Get-Content -LiteralPath 'src/a.ts'", workdir: "${forwardRoot}"})`);
    assert.equal(classification.type, "READ");
    assert.deepEqual(classification.paths, ["src/a.ts"]);
    assert.equal(classification.workdir, forwardRoot);

    const current = session();
    const first: BiliMessage[] = [
        { id: "m1", role: "user", contentType: "text", text: "Keep this exact user requirement." },
        { id: "m2", role: "assistant", contentType: "tool-call", toolCallId: "plan-1", toolName: "update_plan", text: plan([["read", "in_progress"], ["change", "pending"]]) },
        { id: "m3", role: "assistant", contentType: "tool-call", toolCallId: "read-1", toolName: "shell_command", text: JSON.stringify({ command: "Get-Content -LiteralPath 'src/a.ts'", workdir: root }) },
        { id: "m4", role: "tool", contentType: "tool-result", toolCallId: "read-1", text: "export const a = 1;" },
    ];
    await preprocessCoreWorkflow(first, current, DEFAULT_WORKFLOW_OPTIONS, `<environment_context><cwd>${root}</cwd></environment_context>`, 400_000);
    const second: BiliMessage[] = [
        ...first,
        { id: "m5", role: "assistant", contentType: "tool-call", toolCallId: "plan-2", toolName: "update_plan", text: plan([["read", "completed"], ["change", "in_progress"]]) },
    ];
    const output = await preprocessCoreWorkflow(second, current, DEFAULT_WORKFLOW_OPTIONS, `<environment_context><cwd>${root}</cwd></environment_context>`, 400_000);
    assert.match(output.map((message) => message.text).join("\n"), /workflow-repository-guard/);
    assert.match(output.map((message) => message.text).join("\n"), /workflow-checkpoint-request/);
    assert.equal(Object.keys(current.workflow.requirements).length, 1);
    assert.equal(Object.values(current.workflow.requirements)[0]?.detail, "Keep this exact user requirement.");
});

test("Responses content arrays discover Codex cwd and persisted legacy operations gain path defaults", async (t) => {
    const { root } = repository(t);
    const current = session();
    await preprocessResponsesWorkflow({
        model: "gpt-5-codex",
        input: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: `<environment_context><cwd>${root}</cwd></environment_context>` }] },
            { type: "custom_tool_call", call_id: "codex-read", name: "codex", input: `await tools.shell_command({command: "Get-Content -LiteralPath 'src/a.ts'", workdir: "${root.replace(/\\/g, "/")}"})` },
            { type: "custom_tool_call_output", call_id: "codex-read", output: "export const a = 1;" },
        ],
    }, current, DEFAULT_WORKFLOW_OPTIONS, 400_000, true);
    assert.equal(current.workflow.repoBridge.repoRoot, realpathSync(root));
    assert.equal(Object.values(current.workflow.operations).find((operation) => operation.toolCallId === "codex-read")?.type, "READ");

    const operation = Object.values(current.workflow.operations)[0];
    const legacy = operation as Partial<OperationRecord>;
    delete legacy.paths;
    delete legacy.addedPaths;
    const merged = mergeWorkflowState(current.workflow);
    assert.deepEqual(merged.operations[operation.opId]?.paths, []);
    assert.deepEqual(merged.operations[operation.opId]?.addedPaths, []);
});
