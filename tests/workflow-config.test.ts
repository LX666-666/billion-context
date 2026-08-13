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
    assert.equal(options.workflow?.repoBridge.enabled, true);
    assert.equal(options.workflow?.repoBridge.requireRereadAfterPhase, true);
    assert.equal(options.workflow?.cachePolicy.protectCacheHitRatio, 0.65);
    assert.equal(options.workflow?.cachePolicy.expectedTokensPerStep, 8000);
    assert.equal(options.workflow?.memory.maxInjectedTokens, 12000);
    assert.equal(options.workflow?.historian.enabled, false);
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
        BILI_WORKFLOW_REPO_BRIDGE: "0",
        BILI_WORKFLOW_ENFORCE_REREAD: "0",
        BILI_WORKFLOW_WORKSPACE_ROOT: "H:\\Auto\\repo-main",
        BILI_WORKFLOW_REPO_HASH_MAX_BYTES: "1048576",
        BILI_WORKFLOW_REPO_GIT_TIMEOUT_MS: "5000",
        BILI_WORKFLOW_CACHE_PROTECT_HIT_RATIO: "0.75",
        BILI_WORKFLOW_CACHE_HIGH_GROWTH_RATE: "0.25",
        BILI_WORKFLOW_CACHE_EXPECTED_TOKENS_PER_STEP: "12000",
        BILI_WORKFLOW_CACHE_MAX_EXPECTED_TOKENS: "96000",
        BILI_WORKFLOW_CACHE_DEBUG_WINDOW: "14",
        BILI_WORKFLOW_CACHE_REWRITE_WEIGHT: "1.4",
        BILI_WORKFLOW_MEMORY_MAX_INJECTED_TOKENS: "18000",
        BILI_WORKFLOW_MEMORY_MAX_PROJECT_SESSIONS: "8",
        BILI_WORKFLOW_HISTORIAN_ENABLED: "1",
        BILI_WORKFLOW_HISTORIAN_MODEL: "historian-nano",
        BILI_WORKFLOW_HISTORIAN_MAX_INPUT_TOKENS: "20000",
        BILI_WORKFLOW_HISTORIAN_MAX_OUTPUT_TOKENS: "2500",
        BILI_WORKFLOW_HISTORIAN_TIMEOUT_MS: "35000",
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
        repoBridge: {
            enabled: false,
            requireRereadAfterPhase: false,
            workspaceRoot: "H:\\Auto\\repo-main",
            hashMaxBytes: 1048576,
            gitTimeoutMs: 5000,
        },
        cachePolicy: {
            protectCacheHitRatio: 0.75,
            highGrowthRate: 0.25,
            expectedTokensPerStep: 12000,
            maxExpectedNextWorkTokens: 96000,
            debuggingWindowOperations: 14,
            rewriteCostWeight: 1.4,
        },
        memory: {
            maxInjectedTokens: 18000,
            maxProjectSessions: 8,
        },
        historian: {
            enabled: true,
            endpoint: "http://127.0.0.1:11434/v1/chat/completions",
            model: "historian-nano",
            apiKey: "local-key",
            maxInputTokens: 20000,
            maxOutputTokens: 2500,
            timeoutMs: 35000,
        },
    });
});

test("invalid workflow ratios and token thresholds are rejected", () => {
    assert.throws(() => loadOptions({ ACP_AUTO_UPDATE: "0", BILI_WORKFLOW_TARGET_RATIO: "1.1" }), /targetRatio/);
    assert.throws(() => loadOptions({ ACP_AUTO_UPDATE: "0", BILI_WORKFLOW_PRUNER_MIN_TOKENS: "0" }), /minTokens/);
    assert.throws(() => loadOptions({ ACP_AUTO_UPDATE: "0", BILI_WORKFLOW_CHEAP_MODEL_ENABLED: "1" }), /requires endpoint and model/);
    assert.throws(() => loadOptions({ ACP_AUTO_UPDATE: "0", BILI_WORKFLOW_CHEAP_MODEL_ENDPOINT: "file:\/\/bad" }), /endpoint protocol/);
    assert.throws(() => loadOptions({ ACP_AUTO_UPDATE: "0", BILI_WORKFLOW_CACHE_HIGH_GROWTH_RATE: "0" }), /highGrowthRate/);
    assert.throws(() => loadOptions({ ACP_AUTO_UPDATE: "0", BILI_WORKFLOW_CACHE_REWRITE_WEIGHT: "11" }), /rewriteCostWeight/);
    assert.throws(() => loadOptions({ ACP_AUTO_UPDATE: "0", BILI_WORKFLOW_HISTORIAN_ENABLED: "1" }), /historian requires endpoint and model/);
});
