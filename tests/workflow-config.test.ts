import assert from "node:assert/strict";
import test from "node:test";
import { loadOptions } from "../src/config.ts";

test("workflow defaults are enabled and Codex-ready", () => {
    const options = loadOptions({ ACP_AUTO_UPDATE: "0" });
    assert.equal(options.workflow?.enabled, true);
    assert.equal(options.workflow?.targetContextRatio, 0.2);
    assert.equal(options.workflow?.deterministicPruner, true);
    assert.equal(options.workflow?.cheapModel.enabled, false);
    assert.equal(options.workflow?.rereadAfterPhase, true);
});

test("workflow environment settings override context, pruning, archive and project identity", () => {
    const options = loadOptions({
        ACP_AUTO_UPDATE: "0",
        BILI_WORKFLOW_ENABLED: "0",
        BILI_WORKFLOW_TARGET_RATIO: "0.35",
        BILI_WORKFLOW_PHASE_GC: "0",
        BILI_WORKFLOW_SESSION_GC: "0",
        BILI_WORKFLOW_REREAD_AFTER_PHASE: "0",
        BILI_WORKFLOW_PRUNER: "0",
        BILI_WORKFLOW_PRUNER_MIN_TOKENS: "4096",
        BILI_WORKFLOW_CHEAP_MODEL_ENABLED: "1",
        BILI_WORKFLOW_CHEAP_MODEL_ENDPOINT: "http://127.0.0.1:11434/v1/chat/completions",
        BILI_WORKFLOW_CHEAP_MODEL_NAME: "qwen3:4b",
        BILI_WORKFLOW_CHEAP_MODEL_API_KEY: "local-key",
        BILI_WORKFLOW_CHEAP_MODEL_MIN_TOKENS: "9000",
        BILI_WORKFLOW_CHEAP_MODEL_MAX_OUTPUT_TOKENS: "1500",
        BILI_WORKFLOW_CHEAP_MODEL_TIMEOUT_MS: "45000",
        BILI_WORKFLOW_ROLLOVER_MIN_TOKENS: "24000",
        BILI_WORKFLOW_ARCHIVE_RAW: "0",
        BILI_WORKFLOW_PROJECT_KEY: "repo-main",
    });
    assert.deepEqual(options.workflow, {
        enabled: false,
        targetContextRatio: 0.35,
        phaseGc: false,
        sessionGc: false,
        rereadAfterPhase: false,
        deterministicPruner: false,
        prunerMinTokens: 4096,
        cheapModel: {
            enabled: true,
            endpoint: "http://127.0.0.1:11434/v1/chat/completions",
            model: "qwen3:4b",
            apiKey: "local-key",
            minTokens: 9000,
            maxOutputTokens: 1500,
            timeoutMs: 45000,
        },
        rolloverMinTokens: 24000,
        archiveSemanticRaw: false,
        projectKey: "repo-main",
    });
});

test("invalid workflow ratios and token thresholds are rejected", () => {
    assert.throws(() => loadOptions({ ACP_AUTO_UPDATE: "0", BILI_WORKFLOW_TARGET_RATIO: "1.1" }), /targetRatio/);
    assert.throws(() => loadOptions({ ACP_AUTO_UPDATE: "0", BILI_WORKFLOW_PRUNER_MIN_TOKENS: "0" }), /minTokens/);
    assert.throws(() => loadOptions({ ACP_AUTO_UPDATE: "0", BILI_WORKFLOW_CHEAP_MODEL_ENABLED: "1" }), /requires endpoint and model/);
    assert.throws(() => loadOptions({ ACP_AUTO_UPDATE: "0", BILI_WORKFLOW_CHEAP_MODEL_ENDPOINT: "file:\/\/bad" }), /endpoint protocol/);
});
