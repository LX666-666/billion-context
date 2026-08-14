import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createInitialState } from "acp-kernel";
import type { ResponsesRequestBody, ResponseInputItem } from "../src/responses.ts";
import type { Session } from "../src/session.ts";
import { readPhaseArchive, verifyPhaseArchiveRecoverability } from "../src/workflow/archive.ts";
import { checkpointRequest, recordWorkflowCheckpoint } from "../src/workflow/context-gc.ts";
import { observePhaseBoundaryFallback, closeFallbackPhaseForTest } from "../src/workflow/phase-boundary.ts";
import { applyPlanUpdate } from "../src/workflow/plan-tracker.ts";
import { preprocessResponsesWorkflow } from "../src/workflow/responses-preprocessor.ts";
import { createInitialWorkflowState, ensureActivePhase } from "../src/workflow/state.ts";
import { trackOperationCall, updateOperationResult } from "../src/workflow/operation-tracker.ts";
import { DEFAULT_WORKFLOW_OPTIONS, type WorkflowOptions, type WorkflowState } from "../src/workflow/types.ts";
import type { BiliMessage } from "../src/bili-message.ts";

function options(): WorkflowOptions {
    return {
        ...DEFAULT_WORKFLOW_OPTIONS,
        sessionGc: false,
        repoBridge: { ...DEFAULT_WORKFLOW_OPTIONS.repoBridge, enabled: false },
        rolloverMinTokens: 1_000_000,
    };
}

function session(id: string): Session {
    return {
        id,
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

function plan(items: Array<[string, "pending" | "in_progress" | "completed"]>): string {
    return JSON.stringify({ plan: items.map(([step, status]) => ({ step, status })) });
}

function pendingTestPhase(state: WorkflowState, callPrefix: string, count = 1): string {
    const phase = ensureActivePhase(state, "Validation phase");
    for (let index = 0; index < count; index++) {
        const operation = trackOperationCall(
            state,
            `${callPrefix}-${index + 1}`,
            "shell_command",
            JSON.stringify({ command: index === 0 ? "npm test" : "node --test" }),
        );
        updateOperationResult(state, operation, 20, 10, "[TEST PASS]\nexit_code: 0");
    }
    phase.status = "CHECKPOINT_PENDING";
    phase.completedAt = Date.now();
    state.activePhaseId = undefined;
    state.checkpointQueue.push(phase.phaseId);
    return phase.phaseId;
}

function checkpointArgs(phaseId: string, validation: string[]): Record<string, unknown> {
    return {
        phaseId,
        completedWork: "Validation completed",
        currentState: "The phase is ready to archive",
        validation,
        changedFiles: [],
        requirementUpdates: [],
        decisions: [],
        rejectedApproaches: [],
        failedAttempts: [],
        blockers: [],
        unresolvedIssues: [],
        criticalRefs: [],
        keepRefs: [],
    };
}

function tempDataHome(t: TestContext): void {
    const dataHome = mkdtempSync(path.join(tmpdir(), "bili-workflow-regression-"));
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    t.after(() => {
        if (previous === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previous;
        rmSync(dataHome, { recursive: true, force: true });
    });
}

test("rewording the same in-progress plan item does not cross a phase boundary", () => {
    const state = createInitialWorkflowState();
    applyPlanUpdate(state, "plan-1", plan([
        ["Implement Tool Output Pruner", "in_progress"],
        ["Verify", "pending"],
    ]));
    const phaseId = state.activePhaseId;
    const planItemId = state.activePlan?.items[0]?.planItemId;
    assert.ok(phaseId);
    assert.ok(planItemId);

    applyPlanUpdate(state, "plan-2", plan([
        ["Finish pre-ingest output pruning", "in_progress"],
        ["Verify", "pending"],
    ]));

    assert.equal(state.activePhaseId, phaseId);
    assert.equal(state.activePlan?.items[0]?.planItemId, planItemId);
    assert.equal(state.phases[phaseId].status, "ACTIVE");
    assert.deepEqual(state.checkpointQueue, []);
});

test("Responses requirement lifecycle follows source identity, not duplicate text", async (t) => {
    tempDataHome(t);
    const current = session("duplicate-requirement");
    const workflowOptions = options();
    const oldItem: ResponseInputItem = {
        type: "message",
        id: "user-a",
        role: "user",
        content: "Never change API X.",
    };
    await preprocessResponsesWorkflow({ model: "gpt-5-codex", input: [oldItem] }, current, workflowOptions, 400_000, true);
    const oldRequirement = Object.values(current.workflow.requirements)[0];
    assert.ok(oldRequirement?.messageId);
    current.workflow.requirementMessages[oldRequirement.messageId].lifecycle = "ARCHIVED";
    oldRequirement.status = "HISTORICAL";

    const newItem: ResponseInputItem = {
        type: "message",
        id: "user-b",
        role: "user",
        content: "Never change API X.",
    };
    const result = await preprocessResponsesWorkflow({
        model: "gpt-5-codex",
        input: [oldItem, newItem],
    } satisfies ResponsesRequestBody, current, workflowOptions, 400_000, true);
    const requirements = Object.values(current.workflow.requirements);
    const newRequirement = requirements.find((requirement) => requirement.id !== oldRequirement.id);
    const activeRequirement = requirements.find((requirement) => requirement.status === "ACTIVE");
    const output = result.body.input as ResponseInputItem[];

    assert.equal(requirements.length, 2);
    assert.equal(activeRequirement?.status, "ACTIVE");
    assert.equal(newRequirement?.status, "ACTIVE");
    assert.equal(current.workflow.requirementMessages[newRequirement?.messageId ?? ""]?.lifecycle, "ACTIVE");
    assert.equal(output.some((item) => item.type === "message" && (item as Record<string, unknown>).id === "user-a"), false);
    assert.equal(output.some((item) => item.type === "message" && (item as Record<string, unknown>).id === "user-b"), true);
});

test("assistant workflow result envelopes are excluded from core workflow capture", async () => {
    const current = session("assistant-envelope");
    const { preprocessCoreWorkflow } = await import("../src/workflow/core-preprocessor.ts");
    const messages: BiliMessage[] = [{
        id: "internal-result",
        role: "assistant",
        contentType: "text",
        text: "<workflow-internal-result>{\"toolName\":\"workflow_checkpoint\",\"result\":\"rejected\"}</workflow-internal-result>",
    }];
    await preprocessCoreWorkflow(messages, current, options(), undefined, 400_000);
    assert.equal(Object.keys(current.workflow.phaseMessages).length, 0);
    assert.equal(Object.keys(current.workflow.requirements).length, 0);
});

test("fallback boundary ignores assistant reports and consumes one user signal once", () => {
    const state = createInitialWorkflowState();
    const phase = ensureActivePhase(state, "First objective");
    const assistantReport: BiliMessage = {
        id: "assistant-report",
        role: "assistant",
        contentType: "text",
        text: "This is done; now switch to the next task.",
    };
    observePhaseBoundaryFallback(state, [assistantReport]);
    assert.equal(state.phaseBoundaryCandidate, undefined);

    const descriptiveUser: BiliMessage = {
        id: "descriptive-user",
        role: "user",
        contentType: "text",
        text: "These two implementations have different behavior.",
    };
    observePhaseBoundaryFallback(state, [descriptiveUser]);
    assert.equal(state.phaseBoundaryCandidate, undefined);

    const switchUser: BiliMessage = {
        id: "switch-user",
        role: "user",
        contentType: "text",
        text: "This is done; now switch to the next task.",
    };
    observePhaseBoundaryFallback(state, [switchUser]);
    assert.equal(state.phaseBoundaryCandidate?.sourceMessageRef, "switch-user");
    observePhaseBoundaryFallback(state, [switchUser]);
    assert.deepEqual(state.seenBoundarySignalRefs, ["switch-user"]);

    closeFallbackPhaseForTest(state);
    assert.deepEqual(state.checkpointQueue, [phase.phaseId]);
    ensureActivePhase(state, "Second objective");
    observePhaseBoundaryFallback(state, [switchUser]);
    assert.equal(state.phaseBoundaryCandidate, undefined);
});

test("fallback assigns the first new-target operation to a new phase", () => {
    const state = createInitialWorkflowState();
    const oldPhase = ensureActivePhase(state, "First objective");
    const validation = trackOperationCall(state, "fallback-test", "shell_command", JSON.stringify({ command: "npm test" }));
    updateOperationResult(state, validation, 20, 10, "[TEST PASS]\nexit_code: 0");

    const operation = trackOperationCall(
        state,
        "fallback-patch",
        "apply_patch",
        JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/new.ts\n@@\n-old\n+new\n*** End Patch" }),
    );

    assert.notEqual(operation.phaseId, oldPhase.phaseId);
    assert.equal(oldPhase.status, "CHECKPOINT_PENDING");
    assert.deepEqual(oldPhase.operationIds, [validation.opId]);
    assert.deepEqual(state.phases[operation.phaseId]?.operationIds, [operation.opId]);
    assert.deepEqual(state.checkpointQueue, [oldPhase.phaseId]);
});

test("fallback waits for plan sync instead of closing an active plan phase", () => {
    const state = createInitialWorkflowState();
    applyPlanUpdate(state, "fallback-plan", plan([
        ["Implement the next objective", "in_progress"],
        ["Verify", "pending"],
    ]));
    const phaseId = state.activePhaseId;
    assert.ok(phaseId);
    const validation = trackOperationCall(state, "planned-test", "shell_command", JSON.stringify({ command: "npm test" }));
    updateOperationResult(state, validation, 20, 10, "[TEST PASS]\nexit_code: 0");

    const operation = trackOperationCall(
        state,
        "planned-patch",
        "apply_patch",
        JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/new.ts\n@@\n-old\n+new\n*** End Patch" }),
    );

    assert.equal(operation.phaseId, phaseId);
    assert.equal(state.activePhaseId, phaseId);
    assert.equal(state.phases[phaseId].status, "ACTIVE");
    assert.deepEqual(state.checkpointQueue, []);
});

test("a rejected checkpoint retries once, then leaves the queue pending", () => {
    const state = createInitialWorkflowState();
    const phaseId = pendingTestPhase(state, "retry");
    const invalid = checkpointArgs(phaseId, []);
    const first = recordWorkflowCheckpoint(state, invalid, options(), 0, 400_000, "checkpoint-retry");
    const second = recordWorkflowCheckpoint(state, invalid, options(), 0, 400_000, "checkpoint-retry");
    assert.match(first, /workflow_checkpoint REJECTED/);
    assert.match(second, /workflow_checkpoint REJECTED/);
    assert.equal(state.checkpointRetryCount, 2);
    assert.equal(checkpointRequest(state, true), undefined);
    assert.deepEqual(state.checkpointQueue, [phaseId]);
});

test("generic validation evidence cannot explain multiple test operations", (t) => {
    tempDataHome(t);
    const state = createInitialWorkflowState();
    const phaseId = pendingTestPhase(state, "multi-test", 2);
    const generic = recordWorkflowCheckpoint(
        state,
        checkpointArgs(phaseId, ["tests passed"]),
        options(),
        0,
        400_000,
        "multi-test",
    );
    assert.match(generic, /PASS has no matching checkpoint validation evidence/);

    const operations = Object.values(state.operations);
    const specific = recordWorkflowCheckpoint(
        state,
        checkpointArgs(phaseId, operations.map((operation) => `${operation.opId} tests passed`)),
        options(),
        0,
        400_000,
        "multi-test",
    );
    assert.match(specific, /workflow_checkpoint OK/);
});

test("generic failed-test evidence is only accepted for one test operation", (t) => {
    tempDataHome(t);
    const state = createInitialWorkflowState();
    const phaseId = pendingTestPhase(state, "single-failed");
    const operation = Object.values(state.operations)[0];
    operation.outcome = "FAIL";
    const result = recordWorkflowCheckpoint(
        state,
        {
            ...checkpointArgs(phaseId, []),
            completedWork: "The failed test is documented",
            currentState: "The phase remains blocked",
            failedAttempts: ["tests failed earlier"],
        },
        options(),
        0,
        400_000,
        "single-failed",
    );
    assert.match(result, /workflow_checkpoint OK/);
});

test("phase archives contain a self-contained checkpoint snapshot", (t) => {
    tempDataHome(t);
    const state = createInitialWorkflowState();
    const phaseId = pendingTestPhase(state, "archive");
    const result = recordWorkflowCheckpoint(
        state,
        checkpointArgs(phaseId, ["op00001 tests passed"]),
        options(),
        0,
        400_000,
        "archive-snapshot",
    );
    assert.match(result, /workflow_checkpoint OK/);
    const archive = readPhaseArchive("archive-snapshot", state, phaseId);
    assert.ok(archive?.checkpoint);
    assert.equal(archive.checkpoint?.checkpointId, archive.checkpointRef);
    assert.equal(archive.checkpoint?.phaseId, phaseId);
    assert.equal(verifyPhaseArchiveRecoverability("archive-snapshot", state, phaseId, archive), true);
});
