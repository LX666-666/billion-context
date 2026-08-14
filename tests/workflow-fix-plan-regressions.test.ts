import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createInitialState } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import type { ResponsesRequestBody, ResponseInputItem } from "../src/responses.ts";
import type { Session } from "../src/session.ts";
import type { ParsedRange } from "../src/compress-tool.ts";
import { archiveRequirementMessage } from "../src/workflow/archive.ts";
import { recordWorkflowCheckpoint } from "../src/workflow/context-gc.ts";
import { arbitrateAcpRanges } from "../src/workflow/acp-arbitration.ts";
import { classifyOperation, protectsCodeContent } from "../src/workflow/operation-classifier.ts";
import { extractCodexUpdatePlanCalls } from "../src/workflow/codex-code-mode.ts";
import {
    ingestRequirementDocumentForOperation,
    registerPendingRequirementDocuments,
    syncRequirementDocument,
} from "../src/workflow/requirement-document.ts";
import {
    executionSupervisorNudge,
    observeOperationForSupervisor,
    redundantReadNudgeForOperation,
} from "../src/workflow/execution-supervisor.ts";
import { applyPlanUpdate } from "../src/workflow/plan-tracker.ts";
import { refreshRequirementHistory } from "../src/workflow/requirements.ts";
import { preprocessResponsesWorkflow } from "../src/workflow/responses-preprocessor.ts";
import { createInitialWorkflowState, ensureActivePhase, recomputeWorkflowMetrics } from "../src/workflow/state.ts";
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

function tempDataHome(t: TestContext): string {
    const dataHome = mkdtempSync(path.join(tmpdir(), "bili-fix-plan-regression-"));
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    t.after(() => {
        if (previous === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previous;
        rmSync(dataHome, { recursive: true, force: true });
    });
    return dataHome;
}

function planJson(items: Array<[string, "pending" | "in_progress" | "completed"]>): string {
    return JSON.stringify({ plan: items.map(([step, status]) => ({ step, status })) });
}

function checkpointArgs(phaseId: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        phaseId,
        completedWork: "Phase completed",
        currentState: "Ready for the next phase",
        changedFiles: [],
        requirementUpdates: [],
        decisions: [],
        rejectedApproaches: [],
        failedAttempts: [],
        validation: [],
        blockers: [],
        unresolvedIssues: [],
        criticalRefs: [],
        keepRefs: [],
        ...overrides,
    };
}

function pendingTestPhase(state: WorkflowState, callPrefix: string): string {
    const phase = ensureActivePhase(state, "Test phase");
    const operation = trackOperationCall(
        state,
        `${callPrefix}-1`,
        "shell_command",
        JSON.stringify({ command: "npm test" }),
    );
    updateOperationResult(state, operation, 20, 10, "[TEST PASS]\nexit_code: 0");
    phase.status = "CHECKPOINT_PENDING";
    phase.completedAt = Date.now();
    state.activePhaseId = undefined;
    state.checkpointQueue.push(phase.phaseId);
    return phase.phaseId;
}

// ---------------------------------------------------------------------------
// P0-1: mixed Codex exec must not be wholly classified as PLAN
// ---------------------------------------------------------------------------

test("mixed exec with update_plan and shell_command READ is classified as READ, not PLAN", () => {
    const source = [
        "const p = await tools.update_plan({ plan: [{ step: 'Inspect', status: 'in_progress' }] });",
        "const r = await tools.shell_command({ command: 'Get-Content src/a.ts' });",
        "return r;",
    ].join("\n");
    const classification = classifyOperation("exec", source);
    assert.equal(classification.type, "READ");
    assert.ok(classification.paths.some((value) => value.endsWith("src/a.ts") || value.endsWith("a.ts")));
    assert.ok(classification.codexNested && classification.codexNested.length > 0);
    assert.ok(protectsCodeContent(classification.type));
    const plans = extractCodexUpdatePlanCalls("exec-mixed", source);
    assert.equal(plans.length, 1, "update_plan must still be extracted as a side-channel");
});

test("mixed exec with update_plan and apply_patch is classified as PATCH and protects code", () => {
    const source = [
        "await tools.update_plan({ plan: [{ step: 'Patch', status: 'in_progress' }] });",
        "await tools.apply_patch({ patch: '*** Begin Patch\n*** Update File: src/b.ts\n@@\n-old\n+new\n*** End Patch' });",
    ].join("\n");
    const classification = classifyOperation("exec", source);
    assert.equal(classification.type, "PATCH");
    assert.ok(classification.paths.some((value) => value.includes("b.ts")));
    assert.ok(protectsCodeContent(classification.type));
});

test("mixed exec with update_plan and search is classified as SEARCH", () => {
    const source = [
        "await tools.update_plan({ plan: [{ step: 'Search', status: 'in_progress' }] });",
        "await tools.shell_command({ command: 'rg --foo src' });",
    ].join("\n");
    const classification = classifyOperation("exec", source);
    assert.equal(classification.type, "SEARCH");
});

test("pure update_plan exec remains classified as PLAN", () => {
    const source = "const p = await tools.update_plan({ plan: [{ step: 'Plan only', status: 'in_progress' }] }); return p;";
    const classification = classifyOperation("exec", source);
    assert.equal(classification.type, "PLAN");
    assert.equal(protectsCodeContent(classification.type), false);
});

test("mixed exec dominant type follows PATCH > WRITE > DIFF > READ priority", () => {
    const source = [
        "await tools.update_plan({ plan: [{ step: 'Mixed', status: 'in_progress' }] });",
        "await tools.shell_command({ command: 'Get-Content src/readme.md' });",
        "await tools.apply_patch({ patch: '*** Begin Patch\n*** Update File: src/code.ts\n@@\n-x\n+y\n*** End Patch' });",
    ].join("\n");
    const classification = classifyOperation("exec", source);
    assert.equal(classification.type, "PATCH", "PATCH dominates READ when both are present");
});

// ---------------------------------------------------------------------------
// P0-2: /goal requirement documents are ingested into the Requirement Ledger
// ---------------------------------------------------------------------------

test("registerPendingRequirementDocuments captures /goal Read pointers and deduplicates", () => {
    const state = createInitialWorkflowState();
    const workspaceRoot = process.platform === "win32" ? "C:\\workspace\\sample" : "/workspace/sample";
    const messages: BiliMessage[] = [
        { id: "u-1", role: "user", contentType: "text", text: "/goal Read goal-objective.md before continuing." },
    ];
    registerPendingRequirementDocuments(state, messages, undefined, workspaceRoot);
    assert.equal(state.pendingRequirementDocuments.length, 1);
    const pointer = Object.values(state.requirementDocumentByPath)[0];
    assert.ok(pointer);
    assert.equal(pointer.ingested, false);
    assert.ok(pointer.pointerRequirementId);

    registerPendingRequirementDocuments(state, messages, undefined, workspaceRoot);
    assert.equal(state.pendingRequirementDocuments.length, 1, "duplicate /goal must not register twice");
});

test("syncRequirementDocument turns the document body into atomic requirements with USER_REQUIREMENT_DOCUMENT provenance", () => {
    const state = createInitialWorkflowState();
    const workspaceRoot = process.platform === "win32" ? "C:\\workspace\\sample" : "/workspace/sample";
    const messages: BiliMessage[] = [
        { id: "u-goal", role: "user", contentType: "text", text: "/goal Read goal-objective.md before continuing." },
    ];
    registerPendingRequirementDocuments(state, messages, "session-doc", workspaceRoot);
    const pointerPath = Object.keys(state.requirementDocumentByPath)[0];
    assert.ok(pointerPath);

    const body = "1. Must fix feature A\n2. Never change API B\n3. UI must keep card layout";
    const created = syncRequirementDocument(state, "session-doc", pointerPath, body);
    assert.ok(created && created.length === 3, "three atomic requirements are created");
    for (const requirement of created) {
        assert.equal(requirement.provenance, "USER_REQUIREMENT_DOCUMENT");
        assert.equal(requirement.preserveRaw, true);
        assert.ok(requirement.messageId);
    }
    const pointer = state.requirementDocumentByPath[pointerPath];
    assert.equal(pointer.ingested, true);
    assert.equal(state.pendingRequirementDocuments.includes(pointerPath), false);
    assert.ok(state.requirementLedgerVersion > 0, "ledger version increments on document ingestion");
});

test("ingestRequirementDocumentForOperation skips non-READ operations and already-ingested pointers", () => {
    const state = createInitialWorkflowState();
    const workspaceRoot = process.platform === "win32" ? "C:\\workspace\\sample" : "/workspace/sample";
    const messages: BiliMessage[] = [
        { id: "u-goal-2", role: "user", contentType: "text", text: "/goal Read goal-objective.md before continuing." },
    ];
    registerPendingRequirementDocuments(state, messages, "session-op", workspaceRoot);
    const pointerPath = Object.keys(state.requirementDocumentByPath)[0];

    const patch = trackOperationCall(
        state,
        "patch-1",
        "apply_patch",
        JSON.stringify({ patch: "*** Begin Patch\n*** Update File: goal-objective.md\n@@\n-x\n+y\n*** End Patch" }),
    );
    const before = Object.keys(state.requirements).length;
    const rejected = ingestRequirementDocumentForOperation(state, patch, "body", "session-op", workspaceRoot);
    assert.equal(rejected, undefined);
    assert.equal(Object.keys(state.requirements).length, before);

    const readOp = trackOperationCall(
        state,
        "read-1",
        "read",
        JSON.stringify({ path: "goal-objective.md" }),
    );
    const created = ingestRequirementDocumentForOperation(state, readOp, "1. Must fix A\n2. Never change B", "session-op", workspaceRoot);
    assert.ok(created && created.length === 2);

    const secondPass = ingestRequirementDocumentForOperation(state, readOp, "1. Must fix A\n2. Never change B", "session-op", workspaceRoot);
    assert.equal(secondPass, undefined, "already-ingested pointer must not re-ingest");
    void pointerPath;
});

// ---------------------------------------------------------------------------
// P0-3: Plan Sync Nudge does not auto-complete the plan step
// ---------------------------------------------------------------------------

test("plan sync nudge fires once per plan item+revision on completion evidence but leaves the plan untouched", () => {
    const state = createInitialWorkflowState();
    applyPlanUpdate(state, "plan-sync-1", planJson([
        ["Implement feature", "in_progress"],
        ["Verify", "pending"],
    ]));
    const phaseId = state.activePhaseId;
    assert.ok(phaseId);

    const patch = trackOperationCall(
        state,
        "sync-patch",
        "apply_patch",
        JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/feat.ts\n@@\n-old\n+new\n*** End Patch" }),
    );
    updateOperationResult(state, patch, 10, 5, "patched");
    const test = trackOperationCall(state, "sync-test", "shell_command", JSON.stringify({ command: "npm test" }));
    updateOperationResult(state, test, 20, 10, "[TEST PASS]\nexit_code: 0");

    const first = executionSupervisorNudge(state);
    assert.match(first ?? "", /workflow-plan-sync/);
    assert.equal(state.activePlan?.items[0]?.status, "in_progress", "nudge must not auto-complete the step");

    const second = executionSupervisorNudge(state);
    assert.equal(second, undefined, "plan sync nudge must fire at most once per plan item+revision");
});

test("plan sync nudge is suppressed when there is no active plan", () => {
    const state = createInitialWorkflowState();
    ensureActivePhase(state, "Planless work");
    const patch = trackOperationCall(
        state,
        "noplan-patch",
        "apply_patch",
        JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** End Patch" }),
    );
    updateOperationResult(state, patch, 10, 5, "patched");
    const test = trackOperationCall(state, "noplan-test", "shell_command", JSON.stringify({ command: "npm test" }));
    updateOperationResult(state, test, 20, 10, "[TEST PASS]\nexit_code: 0");
    assert.equal(executionSupervisorNudge(state), undefined);
});

test("read-only stall nudge fires once per phase after threshold and resets on mutation", () => {
    const state = createInitialWorkflowState();
    const phaseId = ensureActivePhase(state, "Stall phase").phaseId;
    for (let index = 0; index < 8; index++) {
        const read = trackOperationCall(state, `read-${index}`, "read", JSON.stringify({ path: `src/file${index}.ts` }));
        updateOperationResult(state, read, 100, 50, "content");
    }
    const stalled = executionSupervisorNudge(state);
    assert.match(stalled ?? "", /workflow-read-only-stall/);
    const second = executionSupervisorNudge(state);
    assert.equal(second, undefined, "stall nudge must not repeat in the same phase");

    const patch = trackOperationCall(
        state,
        "stall-patch",
        "apply_patch",
        JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/file0.ts\n@@\n-x\n+y\n*** End Patch" }),
    );
    updateOperationResult(state, patch, 10, 5, "patched");
    assert.equal(state.supervisor.mutationSeen, true);
    void phaseId;
});

test("redundant read nudge fires for unchanged file in the same phase but does not block", () => {
    const state = createInitialWorkflowState();
    const phaseId = ensureActivePhase(state, "Redundant read phase").phaseId;
    state.repoBridge.repoRoot = process.platform === "win32" ? "C:\\repo" : "/repo";
    state.repoBridge.workspaceRoot = state.repoBridge.repoRoot;
    const relativePath = "src/unchanged.ts";
    const absolute = path.join(state.repoBridge.repoRoot, relativePath);
    state.repoBridge.files[absolute] = {
        path: absolute,
        relativePath,
        exists: true,
        tracked: true,
        size: 10,
        mtimeMs: 0,
        signature: "abc",
        lastReadPhaseId: phaseId,
        stale: false,
        observedAt: Date.now(),
    };
    const read = trackOperationCall(state, "reread-1", "read", JSON.stringify({ path: relativePath }));
    updateOperationResult(state, read, 100, 50, "content");
    const nudge = redundantReadNudgeForOperation(state, read);
    assert.match(nudge ?? "", /workflow-redundant-read/);
    const again = redundantReadNudgeForOperation(state, read);
    assert.equal(again, undefined, "redundant-read nudge throttles within the cooldown window");
});

// ---------------------------------------------------------------------------
// P1-2: ACP / Workflow GC arbitration
// ---------------------------------------------------------------------------

function parsedRange(start: string, end: string, summary = "summary"): ParsedRange {
    return { startRef: start, endRef: end, summary };
}

test("ACP arbitration rejects ranges covering an ACTIVE phase message", () => {
    const state = createInitialWorkflowState();
    const phase = ensureActivePhase(state, "Active phase");
    state.phaseMessages["m-active"] = {
        messageRef: "m-active",
        phaseId: phase.phaseId,
        role: "user",
        contentType: "text",
        tokenSize: 10,
        lifecycle: "ACTIVE",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    const messages: CoreMessage[] = [
        { id: "m-old", role: "user", content: "old" },
        { id: "m-active", role: "user", content: "active" },
        { id: "m-newer", role: "user", content: "newer" },
    ];
    const result = arbitrateAcpRanges(state, [parsedRange("m-old", "m-active")], messages);
    assert.equal(result.ranges.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.match(result.reason, /protected workflow content/);
});

test("ACP arbitration accepts ranges that do not touch protected workflow content", () => {
    const state = createInitialWorkflowState();
    const messages: CoreMessage[] = [
        { id: "m-old-1", role: "user", content: "old 1" },
        { id: "m-old-2", role: "user", content: "old 2" },
        { id: "m-old-3", role: "user", content: "old 3" },
    ];
    const result = arbitrateAcpRanges(state, [parsedRange("m-old-1", "m-old-3")], messages);
    assert.equal(result.ranges.length, 1);
    assert.equal(result.rejected.length, 0);
});

test("ACP arbitration prefers workflow rollover when pending drop tokens are significant", () => {
    const state = createInitialWorkflowState();
    state.metrics.pendingDropTotalTokens = 8_000;
    const messages: CoreMessage[] = [
        { id: "m-old-1", role: "user", content: "old 1" },
        { id: "m-old-2", role: "user", content: "old 2" },
    ];
    const result = arbitrateAcpRanges(state, [parsedRange("m-old-1", "m-old-2")], messages);
    assert.equal(result.ranges.length, 0, "ACP must defer when workflow has pending rollover content");
    assert.equal(result.rejected.length, 1);
    assert.match(result.reason, /pending rollover/);
});

// ---------------------------------------------------------------------------
// P1-3: Requirement Ledger version/snapshot atomicization
// ---------------------------------------------------------------------------

test("checkpoint requirementSnapshot reflects post-update status and version bumps atomically", (t) => {
    tempDataHome(t);
    const state = createInitialWorkflowState();
    state.archiveSessionId = "ledger-atomic";
    const phase = ensureActivePhase(state, "Atomic ledger phase");
    const requirementId = `REQ-${String(state.nextRequirementNumber++).padStart(5, "0")}`;
    state.requirements[requirementId] = {
        id: requirementId,
        sourceRefs: ["u-req"],
        messageId: "REQMSG-00001",
        parentMessageId: "REQMSG-00001",
        detail: "Must preserve API surface",
        status: "ACTIVE",
        importance: "NORMAL",
        provenance: "REAL_USER_REQUIREMENT",
        preserveRaw: true,
        createdAt: Date.now(),
    };
    state.requirementMessages["REQMSG-00001"] = {
        messageId: "REQMSG-00001",
        sourceRefs: ["u-req"],
        detail: "Must preserve API surface",
        requirementIds: [requirementId],
        tokenSize: 10,
        lifecycle: "ACTIVE",
        createdAt: Date.now(),
    };
    state.requirementBySourceRef["u-req"] = requirementId;
    phase.taskId = "task-atomic";
    state.requirements[requirementId].taskId = "task-atomic";
    state.tasks["task-atomic"] = {
        taskId: "task-atomic",
        objective: "Atomic ledger task",
        status: "ACTIVE",
        requirementIds: [requirementId],
        phaseIds: [phase.phaseId],
        checkpointIds: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
    };
    state.activeTaskId = "task-atomic";

    const op = trackOperationCall(state, "ledger-test", "shell_command", JSON.stringify({ command: "npm test" }));
    updateOperationResult(state, op, 20, 10, "[TEST PASS]\nexit_code: 0");
    phase.status = "CHECKPOINT_PENDING";
    phase.completedAt = Date.now();
    state.activePhaseId = undefined;
    state.checkpointQueue.push(phase.phaseId);

    const versionBefore = state.requirementLedgerVersion;
    const result = recordWorkflowCheckpoint(state, checkpointArgs(phase.phaseId, {
        requirementUpdates: [{ id: requirementId, status: "SATISFIED" }],
        validation: ["op00001 tests passed"],
    }), options(), 0, 400_000, "ledger-atomic");
    assert.match(result, /workflow_checkpoint OK/);

    const checkpoint = Object.values(state.checkpoints).at(-1);
    assert.ok(checkpoint);
    assert.equal(checkpoint.requirementLedgerVersion, versionBefore + 1, "version in checkpoint is post-update");
    const snapshot = checkpoint.requirementSnapshot?.find((entry) => entry.id === requirementId);
    assert.ok(snapshot);
    assert.equal(snapshot.status, "SATISFIED", "snapshot reflects the post-update status");
    assert.equal(state.requirements[requirementId].status, "SATISFIED");
    assert.equal(state.requirementLedgerVersion, versionBefore + 1, "state version is committed atomically");
});

test("checkpoint version and snapshot are unchanged when requirementUpdates are no-ops", (t) => {
    tempDataHome(t);
    const state = createInitialWorkflowState();
    state.archiveSessionId = "ledger-noop";
    const phase = ensureActivePhase(state, "Noop ledger phase");
    const requirementId = `REQ-${String(state.nextRequirementNumber++).padStart(5, "0")}`;
    state.requirements[requirementId] = {
        id: requirementId,
        sourceRefs: ["u-req-noop"],
        messageId: "REQMSG-00002",
        parentMessageId: "REQMSG-00002",
        detail: "Must keep behavior",
        status: "ACTIVE",
        importance: "NORMAL",
        provenance: "REAL_USER_REQUIREMENT",
        preserveRaw: true,
        createdAt: Date.now(),
    };
    state.requirementMessages["REQMSG-00002"] = {
        messageId: "REQMSG-00002",
        sourceRefs: ["u-req-noop"],
        detail: "Must keep behavior",
        requirementIds: [requirementId],
        tokenSize: 10,
        lifecycle: "ACTIVE",
        createdAt: Date.now(),
    };
    state.requirementBySourceRef["u-req-noop"] = requirementId;
    phase.taskId = "task-noop";
    state.requirements[requirementId].taskId = "task-noop";
    state.tasks["task-noop"] = {
        taskId: "task-noop",
        objective: "Noop ledger task",
        status: "ACTIVE",
        requirementIds: [requirementId],
        phaseIds: [phase.phaseId],
        checkpointIds: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
    };
    state.activeTaskId = "task-noop";

    const op = trackOperationCall(state, "noop-test", "shell_command", JSON.stringify({ command: "npm test" }));
    updateOperationResult(state, op, 20, 10, "[TEST PASS]\nexit_code: 0");
    phase.status = "CHECKPOINT_PENDING";
    phase.completedAt = Date.now();
    state.activePhaseId = undefined;
    state.checkpointQueue.push(phase.phaseId);

    const versionBefore = state.requirementLedgerVersion;
    const result = recordWorkflowCheckpoint(state, checkpointArgs(phase.phaseId, {
        requirementUpdates: [{ id: requirementId, status: "ACTIVE" }],
        validation: ["op00001 tests passed"],
    }), options(), 0, 400_000, "ledger-noop");
    assert.match(result, /workflow_checkpoint OK/);
    assert.equal(state.requirementLedgerVersion, versionBefore, "no-op updates must not bump the ledger version");
    const checkpoint = Object.values(state.checkpoints).at(-1);
    assert.equal(checkpoint?.requirementLedgerVersion, versionBefore);
});

test("archive failure leaves requirement status and ledger version untouched", (t) => {
    tempDataHome(t);
    const state = createInitialWorkflowState();
    state.archiveSessionId = "ledger-fail";
    const phase = pendingTestPhase(state, "ledger-fail");
    const versionBefore = state.requirementLedgerVersion;
    const result = recordWorkflowCheckpoint(state, checkpointArgs(phase, {
        validation: [],
    }), options(), 0, 400_000, "ledger-fail");
    assert.match(result, /workflow_checkpoint REJECTED/);
    assert.equal(state.requirementLedgerVersion, versionBefore, "failed archive must not bump the ledger version");
});

test("refreshRequirementHistory bumps ledger version on transition to HISTORICAL", (t) => {
    tempDataHome(t);
    const state = createInitialWorkflowState();
    state.archiveSessionId = "ledger-history";
    const phase = ensureActivePhase(state, "History phase");
    const requirementId = `REQ-${String(state.nextRequirementNumber++).padStart(5, "0")}`;
    const messageId = "REQMSG-00003";
    const requirement = {
        id: requirementId,
        sourceRefs: ["u-req-hist"],
        messageId,
        parentMessageId: messageId,
        detail: "Must satisfy",
        status: "SATISFIED" as const,
        importance: "NORMAL" as const,
        provenance: "REAL_USER_REQUIREMENT" as const,
        preserveRaw: true,
        createdAt: Date.now(),
    };
    state.requirements[requirementId] = requirement;
    const messageRecord = {
        messageId,
        sourceRefs: ["u-req-hist"],
        detail: "Must satisfy",
        requirementIds: [requirementId],
        tokenSize: 10,
        lifecycle: "ACTIVE" as const,
        createdAt: Date.now(),
    };
    state.requirementMessages[messageId] = messageRecord;
    state.requirementBySourceRef["u-req-hist"] = requirementId;
    const rawRef = archiveRequirementMessage("ledger-history", state, requirement, "Must satisfy");
    assert.ok(rawRef);
    messageRecord.rawRef = rawRef;
    phase.taskId = "task-hist";
    state.requirements[requirementId].taskId = "task-hist";
    state.tasks["task-hist"] = {
        taskId: "task-hist",
        objective: "History task",
        status: "ACTIVE",
        requirementIds: [requirementId],
        phaseIds: [phase.phaseId],
        checkpointIds: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
    };
    state.activeTaskId = "task-hist";

    const op = trackOperationCall(state, "hist-test", "shell_command", JSON.stringify({ command: "npm test" }));
    updateOperationResult(state, op, 20, 10, "[TEST PASS]\nexit_code: 0");
    phase.status = "CHECKPOINT_PENDING";
    phase.completedAt = Date.now();
    state.activePhaseId = undefined;
    state.checkpointQueue.push(phase.phaseId);

    const versionBeforeCheckpoint = state.requirementLedgerVersion;
    const checkpointResult = recordWorkflowCheckpoint(state, checkpointArgs(phase.phaseId, {
        validation: ["op00001 tests passed"],
    }), options(), 0, 400_000, "ledger-history");
    assert.match(checkpointResult, /workflow_checkpoint OK/);
    assert.equal(state.requirements[requirementId].status, "HISTORICAL", "checkpoint refresh transitions terminal requirements to HISTORICAL");
    assert.ok(state.requirementLedgerVersion > versionBeforeCheckpoint, "ledger version bumps on HISTORICAL transition");

    const versionAfterCheckpoint = state.requirementLedgerVersion;
    const changed = refreshRequirementHistory(state);
    assert.equal(changed, 0, "a second refresh has nothing to transition");
    assert.equal(state.requirementLedgerVersion, versionAfterCheckpoint, "no further version bump when nothing transitions");
});

// ---------------------------------------------------------------------------
// P0-2 end-to-end: /goal document survives phase rollover via the preprocessor
// ---------------------------------------------------------------------------

test("/goal requirement document is ingested through the Responses preprocessor and survives rollover", async (t) => {
    const dataHome = tempDataHome(t);
    const current = session("goal-doc-rollover");
    const workflowOptions = options();
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "bili-goal-doc-"));
    t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    const docPath = path.join(workspaceRoot, "goal-objective.md");
    writeFileSync(docPath, "1. Must fix feature A\n2. Never change API B\n", "utf8");

    const goalItem: ResponseInputItem = {
        type: "message",
        id: "user-goal",
        role: "user",
        content: `/goal Read ${docPath} before continuing.`,
    };
    const readCallId = "goal-read-exec";
    const readBody = "1. Must fix feature A\n2. Never change API B\n";
    const readItems: ResponseInputItem[] = [
        { type: "custom_tool_call", call_id: readCallId, name: "exec", input: `await tools.read({ path: ${JSON.stringify(docPath)} });` },
        { type: "custom_tool_call_output", call_id: readCallId, output: readBody },
    ];
    await preprocessResponsesWorkflow(
        { model: "gpt-5-codex", input: [goalItem, ...readItems] } satisfies ResponsesRequestBody,
        current,
        { ...workflowOptions, repoBridge: { ...workflowOptions.repoBridge, enabled: true, workspaceRoot } },
        400_000,
        true,
    );
    const documentRequirements = Object.values(current.workflow.requirements).filter(
        (requirement) => requirement.provenance === "USER_REQUIREMENT_DOCUMENT",
    );
    assert.ok(documentRequirements.length >= 2, "document body must be ingested as atomic requirements");
    const pointerRequirements = Object.values(current.workflow.requirements).filter(
        (requirement) => requirement.provenance === "USER_REQUIREMENT_POINTER",
    );
    assert.ok(pointerRequirements.length >= 1, "pointer must remain tracked");
    assert.equal(current.workflow.pendingRequirementDocuments.length, 0, "document is no longer pending after ingestion");
    void dataHome;
});

test("observeOperationForSupervisor only tracks operations in the active phase", () => {
    const state = createInitialWorkflowState();
    const phaseA = ensureActivePhase(state, "Phase A");
    const phaseBId = "phase99999";
    state.phases[phaseBId] = {
        phaseId: phaseBId,
        objective: "Phase B",
        status: "ACTIVE",
        operationIds: [],
        itemKeys: [],
        startedAt: Date.now(),
    };
    state.activePhaseId = phaseA.phaseId;
    const operationInA: typeof state.operations[string] = {
        opId: "op-in-a",
        phaseId: phaseA.phaseId,
        type: "READ",
        callRefs: [],
        resultRefs: [],
        paths: [],
        addedPaths: [],
        rawTokens: 0,
        visibleTokens: 100,
        lifecycle: "ACTIVE",
        importance: "NORMAL",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    const operationInB: typeof state.operations[string] = {
        ...operationInA,
        opId: "op-in-b",
        phaseId: phaseBId,
    };
    observeOperationForSupervisor(state, operationInA);
    assert.equal(state.supervisor.observationCount, 1);
    observeOperationForSupervisor(state, operationInB);
    assert.equal(state.supervisor.observationCount, 1, "operations outside the active phase must not feed the supervisor");
    recomputeWorkflowMetrics(state);
});
