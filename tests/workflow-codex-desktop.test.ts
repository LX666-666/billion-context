import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createInitialState } from "acp-kernel";
import type { ResponsesRequestBody, ResponseInputItem } from "../src/responses.ts";
import type { Session } from "../src/session.ts";
import { recordWorkflowCheckpoint } from "../src/workflow/context-gc.ts";
import { extractCodexUpdatePlanCalls } from "../src/workflow/codex-code-mode.ts";
import { classifyOperation } from "../src/workflow/operation-classifier.ts";
import { preprocessResponsesWorkflow } from "../src/workflow/responses-preprocessor.ts";
import { createInitialWorkflowState } from "../src/workflow/state.ts";
import { DEFAULT_WORKFLOW_OPTIONS } from "../src/workflow/types.ts";

type Fixture = {
    client_metadata: Record<string, string>;
    host_context: string;
    goal: string;
    plans: Array<Array<{ step: string; status: "pending" | "in_progress" | "completed" }>>;
};

const fixture = JSON.parse(readFileSync(new URL("./fixtures/codex-desktop-workflow.json", import.meta.url), "utf8")) as Fixture;

function session(id: string): Session {
    return {
        id,
        meta: { protocol: "responses" },
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

function execSource(plan: Fixture["plans"][number]): string {
    const entries = plan.map((item) => `{step:${JSON.stringify(item.step)},status:${JSON.stringify(item.status)}}`).join(",");
    return `const p = await tools.update_plan({ plan: [${entries}] }); return p;`;
}

function bodyItems(plan: Fixture["plans"][number], index: number): ResponseInputItem[] {
    return [
        { type: "message", role: "user", content: fixture.host_context },
        { type: "message", role: "user", content: fixture.goal },
        { type: "custom_tool_call", call_id: `exec-${index}`, name: "exec", input: execSource(plan) },
        { type: "custom_tool_call_output", call_id: `exec-${index}`, output: "Plan updated" },
    ];
}

function desktopBody(items: ResponseInputItem[], workspaceRoot: string): ResponsesRequestBody {
    const metadata = JSON.parse(fixture.client_metadata["x-codex-turn-metadata"] ?? "{}") as { workspaces?: unknown[] };
    const firstWorkspace = metadata.workspaces?.[0];
    metadata.workspaces = [
        firstWorkspace && typeof firstWorkspace === "object" && !Array.isArray(firstWorkspace)
            ? { ...(firstWorkspace as Record<string, unknown>), root: workspaceRoot }
            : workspaceRoot,
    ];
    return {
        model: "gpt-5-codex",
        client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
        input: items,
    };
}

test("Codex code-mode adapter safely extracts update_plan and keeps a stable nested call id", () => {
    const source = "const p = await tools.update_plan({ plan: [{ step: 'Inspect', status: 'in_progress' }] });";
    const calls = extractCodexUpdatePlanCalls("exec-outer", source);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].callId, "exec-outer:update_plan:0");
    assert.deepEqual(JSON.parse(calls[0].argumentsText), { plan: [{ step: "Inspect", status: "in_progress" }] });
    assert.equal(classifyOperation("exec", source).type, "PLAN");
    assert.deepEqual(extractCodexUpdatePlanCalls("exec-outer", "const text = 'tools.update_plan({plan: []})';"), []);
    assert.deepEqual(extractCodexUpdatePlanCalls("exec-outer", "await tools.update_plan({ plan: getPlan() });"), []);
});

test("realistic Codex Desktop wire fixture tracks every plan phase and ignores host instructions as requirements", async (t) => {
    const dataHome = mkdtempSync(path.join(tmpdir(), "bili-codex-desktop-"));
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    t.after(() => {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousDataHome;
        rmSync(dataHome, { recursive: true, force: true });
    });
    const current = session("codex-desktop-fixture");
    const options = {
        ...DEFAULT_WORKFLOW_OPTIONS,
        sessionGc: false,
        rolloverMinTokens: 1_000_000,
    };
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "bili-codex-workspace-"));
    t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    let items: ResponseInputItem[] = bodyItems(fixture.plans[0], 1).slice(0, 2);
    const phaseIds: string[] = [];
    for (let index = 0; index < fixture.plans.length; index++) {
        items = [...items, ...bodyItems(fixture.plans[index], index + 1).slice(2)];
        await preprocessResponsesWorkflow(desktopBody(items, workspaceRoot), current, options, 400_000, true);
        const plan = current.workflow.activePlan;
        assert.ok(plan);
        assert.equal(plan.items[0]?.status, fixture.plans[index][0]?.status);
        assert.equal(plan.items[1]?.status, fixture.plans[index][1]?.status);
        assert.equal(plan.items[2]?.status, fixture.plans[index][2]?.status);
        if (index > 0) {
            const pending = current.workflow.checkpointQueue.at(-1);
            assert.ok(pending);
            phaseIds.push(pending);
            const checkpoint = recordWorkflowCheckpoint(current.workflow, {
                phaseId: pending,
                completedWork: `Completed phase ${index + 1}`,
                currentState: "The phase result is recorded and ready for the next phase.",
                changedFiles: [],
                validation: [],
                requirementUpdates: [],
                decisions: [],
                rejectedApproaches: [],
                failedAttempts: [],
                blockers: [],
                unresolvedIssues: [],
                criticalRefs: [],
                keepRefs: [],
            }, options, 0, 400_000, current.id);
            assert.match(checkpoint, /workflow_checkpoint OK/);
        }
    }
    assert.equal(phaseIds.length, 3);
    assert.equal(new Set(phaseIds).size, 3);
    assert.equal(Object.values(current.workflow.phases).filter((phase) => phase.status === "ARCHIVED" || phase.status === "PENDING_ROLLOVER").length, 3);
    assert.equal(current.workflow.activePlan?.items.every((item) => item.status === "completed"), true);
    assert.equal(current.workflow.sessionStatus, "COMPLETE_CANDIDATE");
    assert.equal(Object.keys(current.workflow.requirements).length, 1);
    assert.equal(Object.values(current.workflow.requirements)[0]?.detail, fixture.goal);
    assert.ok(current.workflow.repoBridge.workspaceRoot);
    assert.ok(current.workflow.repoBridge.repoRoot);
    assert.equal(current.workflow.repoBridge.head, "deadbeef");
    assert.equal(current.workflow.repoBridge.remoteIdentity, "https://example.invalid/acme/sample");
    assert.match(current.workflow.projectId ?? "", /^project-/);
});

test("Codex Desktop metadata yields to local Git repository identity", async (t) => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "bili-codex-git-workspace-"));
    t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    const git = (args: string[]) => execFileSync("git", ["-C", workspaceRoot, ...args], { encoding: "utf8", windowsHide: true }).trim();
    git(["init"]);
    git(["config", "user.email", "codex-desktop@example.invalid"]);
    git(["config", "user.name", "Codex Desktop Test"]);
    const marker = path.join(workspaceRoot, "marker.txt");
    writeFileSync(marker, "fixture\n", "utf8");
    git(["add", "marker.txt"]);
    git(["commit", "-m", "fixture"]);
    git(["remote", "add", "origin", "https://local.invalid/acme/local.git"]);

    const current = session("codex-desktop-git-priority");
    const options = { ...DEFAULT_WORKFLOW_OPTIONS, sessionGc: false, rolloverMinTokens: 1_000_000 };
    await preprocessResponsesWorkflow(desktopBody([], workspaceRoot), current, options, 400_000, true);

    assert.equal(current.workflow.repoBridge.head, git(["rev-parse", "HEAD"]));
    assert.equal(current.workflow.repoBridge.remoteIdentity, "https://local.invalid/acme/local");
});

test("Codex Desktop metadata fallback drives remoteIdentity, head and project identity when local Git is unavailable", async (t) => {
    const dataHome = mkdtempSync(path.join(tmpdir(), "bili-codex-metadata-fallback-"));
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    t.after(() => {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousDataHome;
        rmSync(dataHome, { recursive: true, force: true });
    });
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "bili-codex-no-git-"));
    t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    const current = session("codex-desktop-metadata-fallback");
    const options = { ...DEFAULT_WORKFLOW_OPTIONS, sessionGc: false, rolloverMinTokens: 1_000_000 };
    await preprocessResponsesWorkflow(desktopBody([], workspaceRoot), current, options, 400_000, true);
    assert.equal(current.workflow.repoBridge.head, "deadbeef");
    assert.equal(current.workflow.repoBridge.remoteIdentity, "https://example.invalid/acme/sample");
    assert.match(current.workflow.projectId ?? "", /^project-/);
    assert.equal(current.workflow.repoBridge.dirty, true);
});

test("Responses Requirement identity uses ACP references when user items have no message.id", async (t) => {
    const dataHome = mkdtempSync(path.join(tmpdir(), "bili-codex-requirement-id-"));
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    t.after(() => {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousDataHome;
        rmSync(dataHome, { recursive: true, force: true });
    });
    const current = session("codex-no-message-id");
    const options = { ...DEFAULT_WORKFLOW_OPTIONS, sessionGc: false, repoBridge: { ...DEFAULT_WORKFLOW_OPTIONS.repoBridge, enabled: false } };
    const oldText = "<acp tokens=\"20\" type=\"text\">m00001</acp>\nNever change API X.";
    const newText = "<acp tokens=\"20\" type=\"text\">m00002</acp>\nNever change API X.";
    await preprocessResponsesWorkflow({ model: "gpt-5-codex", input: [{ type: "message", role: "user", content: oldText }] }, current, options, 400_000, true);
    const oldRequirement = Object.values(current.workflow.requirements)[0];
    assert.ok(oldRequirement?.messageId);
    current.workflow.requirementMessages[oldRequirement.messageId].lifecycle = "ARCHIVED";
    oldRequirement.status = "HISTORICAL";
    const result = await preprocessResponsesWorkflow({
        model: "gpt-5-codex",
        input: [
            { type: "message", role: "user", content: oldText },
            { type: "message", role: "user", content: newText },
        ],
    }, current, options, 400_000, true);
    const requirements = Object.values(current.workflow.requirements);
    assert.equal(requirements.length, 2);
    assert.equal(requirements.filter((item) => item.status === "HISTORICAL").length, 1);
    assert.equal(requirements.filter((item) => item.status === "ACTIVE").length, 1);
    const messages = (result.body.input as ResponseInputItem[]).filter((item) => item.type === "message") as Array<{ content?: unknown }>;
    assert.equal(messages.length, 1);
    assert.match(String(messages[0].content), /m00002/);
    assert.doesNotMatch(String(messages[0].content), /m00001/);
});
