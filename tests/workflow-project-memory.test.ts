import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hydrateProjectMemory, saveProjectMemory } from "../src/workflow/project-memory.ts";
import { createInitialWorkflowState } from "../src/workflow/state.ts";

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
});
