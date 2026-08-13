import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    applyCodexConfig,
    getCodexConfigStatus,
    patchCodexConfig,
    restoreCodexConfig,
} from "../src/web/codex-config.ts";

test("Codex config patch keeps user settings and only changes top-level provider keys", () => {
    const original = `model = "gpt-5-codex"\nmodel_provider = "custom"\n\n[model_providers.custom]\nname = "Custom"\nbase_url = "https://example.com"\n`;
    const patched = patchCodexConfig(original, "http://127.0.0.1:8787/bili/https://chatgpt.com/backend-api/codex");
    assert.match(patched, /^model_provider = "openai"/m);
    assert.match(patched, /^openai_base_url = "http:\/\/127\.0\.0\.1:8787\/bili\/https:\/\/chatgpt\.com\/backend-api\/codex"/m);
    assert.match(patched, /^model = "gpt-5-codex"/m);
    assert.match(patched, /^\[model_providers\.custom\]$/m);
    assert.match(patched, /^base_url = "https:\/\/example\.com"/m);
});

test("Codex config apply and restore round-trip the original file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-codex-config-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    const config = path.join(root, "config.toml");
    const original = "model = \"gpt-5-codex\"\n\n[features]\nweb_search = true\n";
    writeFileSync(config, original, "utf8");
    try {
        const target = "http://127.0.0.1:8787/bili/https://chatgpt.com/backend-api/codex";
        const applied = applyCodexConfig(target);
        assert.equal(applied.active, true);
        assert.equal(getCodexConfigStatus().active, true);
        assert.match(readFileSync(config, "utf8"), /model_provider = "openai"/);
        assert.equal(existsSync(`${config}.bili-backup`), true);

        const restored = restoreCodexConfig();
        assert.deepEqual(restored, { restored: true, conflict: false, path: config });
        assert.equal(readFileSync(config, "utf8"), original);
        assert.equal(existsSync(`${config}.bili-backup`), false);
        assert.equal(getCodexConfigStatus().active, false);
    } finally {
        if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    }
});

test("Codex config restore refuses to overwrite an external edit", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-codex-conflict-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    const config = path.join(root, "config.toml");
    writeFileSync(config, "model = \"gpt-5-codex\"\n", "utf8");
    try {
        applyCodexConfig("http://127.0.0.1:8787/bili/https://chatgpt.com/backend-api/codex");
        writeFileSync(config, `${readFileSync(config, "utf8")}user_modified = true\n`, "utf8");
        assert.deepEqual(restoreCodexConfig(), { restored: false, conflict: true, path: config });
        assert.match(readFileSync(config, "utf8"), /user_modified = true/);
        assert.equal(existsSync(`${config}.bili-backup`), true);
    } finally {
        if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    }
});
