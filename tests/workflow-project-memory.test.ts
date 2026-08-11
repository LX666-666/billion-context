import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { estimateTokensFast } from "acp-kernel";
import type { BiliMessage } from "../src/bili-message.ts";
import { recordWorkflowCheckpoint, workflowMemory } from "../src/workflow/context-gc.ts";
import {
    buildSessionCheckpoint,
    hydrateProjectMemory,
    loadProjectMemory,
    markActiveTaskCompleteCandidate,
    runCheapHistorian,
    saveProjectMemory,
} from "../src/workflow/project-memory.ts";
import { syncRequirements } from "../src/workflow/requirements.ts";
import { createInitialWorkflowState, ensureActivePhase, mergeWorkflowState } from "../src/workflow/state.ts";
import { DEFAULT_WORKFLOW_OPTIONS, type WorkflowState } from "../src/workflow/types.ts";

function user(id: string, text: string): BiliMessage {
    return { id, role: "user", contentType: "text", text };
}

function checkpointPhase(state: ReturnType<typeof createInitialWorkflowState>, completedWork: string): string {
    const phase = ensureActivePhase(state, completedWork);
    phase.status = "CHECKPOINT_PENDING";
    phase.completedAt = Date.now();
    state.activePhaseId = undefined;
    state.checkpointQueue.push(phase.phaseId);
    return recordWorkflowCheckpoint(state, {
        phaseId: phase.phaseId,
        completedWork,
        changedFiles: ["src/exact-path.ts"],
        currentState: `${completedWork} current state`,
        decisions: [{ decision: "Keep exact identifiers", reason: "API symbol ExactName must remain stable", refs: ["raw_000777"] }],
        failedAttempts: ["ExactError E_TEST at src/exact-path.ts:42"],
        validation: ["304 tests passed"],
        blockers: ["BLOCKER-7 remains"],
        unresolvedIssues: ["Retry Windows diagnostic"],
        nextAction: "Read the current repository",
        criticalRefs: ["raw_000777"],
    }, { ...DEFAULT_WORKFLOW_OPTIONS, rolloverMinTokens: 1_000_000 }, 0, 200_000);
}

test("project memory carries requirements and checkpoints into a new Codex session", (t) => {
    const dataHome = mkdtempSync(path.join(tmpdir(), "bili-project-memory-"));
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    t.after(() => {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousDataHome;
        rmSync(dataHome, { recursive: true, force: true });
    });
    const first = createInitialWorkflowState();
    first.projectId = "project-codex";
    first.requirements["REQ-00001"] = {
        id: "REQ-00001",
        sourceRefs: ["m00001"],
        detail: "Codex adaptation is the first priority.",
        status: "ACTIVE",
        importance: "CRITICAL",
        preserveRaw: true,
        createdAt: 1,
    };
    first.checkpoints.checkpoint00001 = {
        checkpointId: "checkpoint00001",
        phaseId: "phase00001",
        objective: "Implement Codex adapter",
        requirementUpdates: [],
        completedWork: "Added Responses operation tracking.",
        changedFiles: ["src/workflow/responses-preprocessor.ts"],
        currentState: "The adapter tracks call_id values.",
        decisions: [],
        rejectedApproaches: [],
        failedAttempts: [],
        validation: ["Tests passed"],
        blockers: [],
        unresolvedIssues: [],
        criticalRefs: [],
        keepRefs: [],
        createdAt: 2,
    };
    assert.equal(saveProjectMemory("session-one", first), true);

    const second = createInitialWorkflowState();
    second.projectId = "project-codex";
    hydrateProjectMemory("session-two", second);
    assert.equal(second.projectHistory?.sessions.length, 1);
    assert.equal(second.projectHistory?.sessions[0].requirements[0].detail, "Codex adaptation is the first priority.");
    assert.equal(second.projectHistory?.sessions[0].checkpoint.currentState, "The adapter tracks call_id values.");
    assert.deepEqual(second.projectHistory?.sessions[0].checkpoint.changedFiles, ["src/workflow/responses-preprocessor.ts"]);
    assert.equal(second.projectHistory?.projectCheckpoint?.level, "PROJECT");
});

test("task boundary detection keeps continuations together and checkpoints unrelated work", () => {
    const state = createInitialWorkflowState();
    syncRequirements(state, [user("m1", "Implement cache-aware scheduling in src/cache.ts")]);
    const firstTaskId = state.activeTaskId;
    assert.ok(firstTaskId);
    checkpointPhase(state, "Implemented scheduler");
    state.sessionStatus = "COMPLETE_CANDIDATE";
    markActiveTaskCompleteCandidate(state);

    syncRequirements(state, [user("m1", "Implement cache-aware scheduling in src/cache.ts"), user("m2", "继续上面的任务，再验证 src/cache.ts")]);
    assert.equal(state.activeTaskId, firstTaskId);
    assert.equal(state.tasks[firstTaskId].status, "ACTIVE");

    state.sessionStatus = "COMPLETE_CANDIDATE";
    markActiveTaskCompleteCandidate(state);
    syncRequirements(state, [
        user("m1", "Implement cache-aware scheduling in src/cache.ts"),
        user("m2", "继续上面的任务，再验证 src/cache.ts"),
        user("m3", "New task: build an unrelated PDF export service"),
    ]);
    assert.notEqual(state.activeTaskId, firstTaskId);
    assert.equal(state.tasks[firstTaskId].status, "COMPLETE");
    assert.equal(state.tasks[firstTaskId].sessionCheckpoint?.level, "SESSION");
    assert.deepEqual(state.tasks[firstTaskId].sessionCheckpoint?.changedFiles, ["src/exact-path.ts"]);
    assert.equal(state.metrics.taskBoundaries, 1);
    assert.deepEqual(state.historian.pendingTaskIds, [firstTaskId]);
});

test("session checkpoints merge phase history without rewriting exact facts", () => {
    const state = createInitialWorkflowState();
    syncRequirements(state, [user("m1", "Never rename ExactName and preserve raw errors")]);
    const taskId = state.activeTaskId;
    assert.ok(taskId);
    state.requirements["REQ-00001"].rawRef = "raw_000123";
    checkpointPhase(state, "First phase");
    checkpointPhase(state, "Second phase");
    const checkpoint = buildSessionCheckpoint(state, taskId);
    assert.deepEqual(checkpoint.completedWork, ["First phase", "Second phase"]);
    assert.equal(checkpoint.decisions[0]?.reason, "API symbol ExactName must remain stable");
    assert.ok(checkpoint.failedAttempts.includes("ExactError E_TEST at src/exact-path.ts:42"));
    assert.ok(checkpoint.changedFiles.includes("src/exact-path.ts"));
    assert.equal(checkpoint.requirements?.[0]?.detail, "Never rename ExactName and preserve raw errors");
    assert.equal(checkpoint.requirements?.[0]?.rawRef, "raw_000123");
    assert.ok(checkpoint.criticalRefs?.includes("raw_000777"));
});

test("legacy workflow state migrates exact history into an initial task", () => {
    const legacy = createInitialWorkflowState();
    legacy.requirements["REQ-00001"] = {
        id: "REQ-00001",
        sourceRefs: ["m1"],
        detail: "Preserve the legacy requirement exactly",
        status: "ACTIVE",
        importance: "CRITICAL",
        preserveRaw: true,
        createdAt: 10,
    };
    legacy.checkpoints.checkpoint00001 = {
        checkpointId: "checkpoint00001",
        phaseId: "phase00001",
        objective: "Legacy phase",
        requirementUpdates: [],
        completedWork: "Legacy exact work",
        changedFiles: ["src/legacy.ts"],
        currentState: "Legacy exact state",
        decisions: [],
        rejectedApproaches: [],
        failedAttempts: [],
        validation: [],
        blockers: [],
        unresolvedIssues: [],
        criticalRefs: [],
        keepRefs: [],
        createdAt: 20,
    };
    delete (legacy as Partial<WorkflowState>).tasks;
    delete (legacy as Partial<WorkflowState>).historian;
    delete (legacy as Partial<WorkflowState>).nextTaskNumber;
    delete (legacy as Partial<WorkflowState>).activeTaskId;
    const migrated = mergeWorkflowState(legacy);
    const taskId = migrated.activeTaskId;
    assert.ok(taskId);
    assert.deepEqual(migrated.tasks[taskId].requirementIds, ["REQ-00001"]);
    assert.deepEqual(migrated.tasks[taskId].checkpointIds, ["checkpoint00001"]);
    assert.equal(migrated.requirements["REQ-00001"].taskId, taskId);
    assert.equal(buildSessionCheckpoint(migrated, taskId).currentState, "Legacy exact state");
});

test("Cheap Historian adds a bounded narrative without replacing structured history", async (t) => {
    const dataHome = mkdtempSync(path.join(tmpdir(), "bili-historian-"));
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    t.after(() => {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousDataHome;
        rmSync(dataHome, { recursive: true, force: true });
    });
    const state = createInitialWorkflowState();
    state.projectId = "project-historian";
    syncRequirements(state, [user("m1", "Preserve ExactName and ExactError E_TEST")]);
    const taskId = state.activeTaskId;
    assert.ok(taskId);
    checkpointPhase(state, "Historian source phase");
    state.sessionStatus = "COMPLETE_CANDIDATE";
    markActiveTaskCompleteCandidate(state);
    state.tasks[taskId].sessionCheckpoint = buildSessionCheckpoint(state, taskId);
    state.historian.pendingTaskIds.push(taskId);
    const exactBefore = JSON.stringify({
        decisions: state.tasks[taskId].sessionCheckpoint?.decisions,
        errors: state.tasks[taskId].sessionCheckpoint?.importantErrors,
        requirements: state.tasks[taskId].sessionCheckpoint?.requirements,
    });
    const previousFetch = globalThis.fetch;
    let supplied = "";
    let fetchCalls = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        fetchCalls++;
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        supplied = body.messages[1]?.content ?? "";
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ narrative: "ExactName remains stable; E_TEST is unresolved." }) } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;
    try {
        const ran = await runCheapHistorian("historian-session", state, {
            ...DEFAULT_WORKFLOW_OPTIONS,
            historian: {
                enabled: true,
                endpoint: "https://historian.example/v1/chat/completions",
                model: "nano-history",
                maxInputTokens: 2_000,
                maxOutputTokens: 500,
                timeoutMs: 5_000,
            },
        });
        assert.equal(ran, true);
        state.historian.pendingTaskIds.push(taskId);
        state.historian.lastRunAt = undefined;
        assert.equal(await runCheapHistorian("historian-session", state, {
            ...DEFAULT_WORKFLOW_OPTIONS,
            historian: {
                enabled: true,
                endpoint: "https://historian.example/v1/chat/completions",
                model: "nano-history",
                maxInputTokens: 2_000,
                maxOutputTokens: 500,
                timeoutMs: 5_000,
            },
        }), false);
    } finally {
        globalThis.fetch = previousFetch;
    }
    assert.ok(supplied.length > 0);
    assert.ok(supplied.length < 20_000);
    assert.equal(JSON.stringify({
        decisions: state.tasks[taskId].sessionCheckpoint?.decisions,
        errors: state.tasks[taskId].sessionCheckpoint?.importantErrors,
        requirements: state.tasks[taskId].sessionCheckpoint?.requirements,
    }), exactBefore);
    assert.equal(state.tasks[taskId].sessionCheckpoint?.historian?.narrative, "ExactName remains stable; E_TEST is unresolved.");
    assert.equal(state.metrics.historianRuns, 1);
    assert.equal(fetchCalls, 1);
    assert.equal(loadProjectMemory("project-historian")?.sessions[0]?.checkpoint.historian?.model, "nano-history");
});

test("workflow memory keeps active requirements exact and injects layered checkpoints within budget", () => {
    const state = createInitialWorkflowState();
    syncRequirements(state, [user("m1", "CRITICAL exact active requirement: keep ExactName")]);
    const taskId = state.activeTaskId;
    assert.ok(taskId);
    checkpointPhase(state, "Layered phase");
    state.metrics.rollovers = 1;
    state.tasks[taskId].sessionCheckpoint = buildSessionCheckpoint(state, taskId);
    const memory = workflowMemory(state, true, 2_000);
    assert.match(memory ?? "", /CRITICAL exact active requirement: keep ExactName/);
    assert.match(memory ?? "", /Session checkpoint/);
    assert.match(memory ?? "", /historical memory is not authoritative for code facts/);
    assert.doesNotMatch(memory ?? "", /old patch chain/);
    assert.ok(estimateTokensFast(memory ?? "") <= 2_000);
});

test("workflow memory omits oversized requirements by raw reference without exceeding budget", () => {
    const state = createInitialWorkflowState();
    syncRequirements(state, [user("m1", `Preserve ${"ExactRequirement ".repeat(2_000)}`)]);
    const requirement = state.requirements["REQ-00001"];
    requirement.rawRef = "raw_oversized_requirement";
    state.metrics.rollovers = 1;
    const memory = workflowMemory(state, true, 180);
    assert.ok(memory);
    assert.ok(estimateTokensFast(memory) <= 180);
    assert.match(memory, /raw_oversized_requirement/);
    assert.doesNotMatch(memory, /ExactRequirement ExactRequirement ExactRequirement/);
});
