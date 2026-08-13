import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { configFile } from "../paths.js";
import {
    loadRoutes,
    loadOptions,
    normalizeUrlKey,
    parseRouteEntry,
    parseUpstreamProxyMode,
    safeReadJson,
    type ProviderRoute,
    type ProviderRoutes,
    type UpstreamProxyMode,
} from "../config.js";
import { log } from "../logger.js";
import { validateHttpProxy } from "../upstream-proxy.js";
import type { WorkflowOptions } from "../workflow/types.js";
import { applyCodexConfig, getCodexConfigStatus, restoreCodexConfig } from "./codex-config.js";

type ConfigShape = Record<string, unknown> & {
    providers?: Record<string, unknown>;
    upstreamProxy?: string;
    upstreamProxyMode?: string;
    workflow?: Record<string, unknown>;
};

type JsonObject = Record<string, unknown>;

function plainObject(value: unknown, name: string): JsonObject {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
    return value as JsonObject;
}

function allowedKeys(value: JsonObject, name: string, allowed: string[]): void {
    const accepted = new Set(allowed);
    const unknown = Object.keys(value).find((key) => !accepted.has(key));
    if (unknown) throw new Error(`${name}.${unknown} is not supported`);
}

function copyBoolean(source: JsonObject, target: JsonObject, key: string, name: string): void {
    if (!(key in source)) return;
    if (typeof source[key] !== "boolean") throw new Error(`${name}.${key} must be a boolean`);
    target[key] = source[key];
}

function copyString(source: JsonObject, target: JsonObject, key: string, name: string, nullable = false): void {
    if (!(key in source)) return;
    const value = source[key];
    if (nullable && value === null) {
        target[key] = null;
        return;
    }
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name}.${key} must be a non-empty string${nullable ? " or null" : ""}`);
    target[key] = value.trim();
}

function copyNumber(source: JsonObject, target: JsonObject, key: string, name: string, kind: "integer" | "ratio" | "positive"): void {
    if (!(key in source)) return;
    const value = source[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name}.${key} must be a number`);
    if (kind === "integer" && (!Number.isInteger(value) || value <= 0)) throw new Error(`${name}.${key} must be a positive integer`);
    if (kind === "ratio" && (value <= 0 || value > 1)) throw new Error(`${name}.${key} must be > 0 and <= 1`);
    if (kind === "positive" && (value <= 0 || value > 10)) throw new Error(`${name}.${key} must be > 0 and <= 10`);
    target[key] = value;
}

function validateEndpoint(value: unknown, name: string): void {
    if (value === undefined || value === null) return;
    const parsed = new URL(String(value));
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
        throw new Error(`${name} must be an http(s) URL without embedded credentials`);
    }
}

function modelPatch(value: unknown, name: string, includeMinTokens: boolean): JsonObject {
    const source = plainObject(value, name);
    const keys = ["enabled", "endpoint", "model", "apiKey", "maxOutputTokens", "timeoutMs", ...(includeMinTokens ? ["minTokens"] : ["maxInputTokens"])];
    allowedKeys(source, name, keys);
    const target: JsonObject = {};
    copyBoolean(source, target, "enabled", name);
    copyString(source, target, "endpoint", name, true);
    copyString(source, target, "model", name, true);
    copyString(source, target, "apiKey", name, true);
    if (includeMinTokens) copyNumber(source, target, "minTokens", name, "integer");
    else copyNumber(source, target, "maxInputTokens", name, "integer");
    copyNumber(source, target, "maxOutputTokens", name, "integer");
    copyNumber(source, target, "timeoutMs", name, "integer");
    validateEndpoint(target.endpoint, `${name}.endpoint`);
    return target;
}

function workflowPatch(value: unknown): JsonObject {
    const source = plainObject(value, "workflow");
    allowedKeys(source, "workflow", ["enabled", "projectKey", "context", "models", "code", "pruner", "archive", "repoBridge", "cache", "memory", "historian"]);
    const target: JsonObject = {};
    copyBoolean(source, target, "enabled", "workflow");
    copyString(source, target, "projectKey", "workflow", true);
    if (source.context !== undefined) {
        const input = plainObject(source.context, "workflow.context");
        allowedKeys(input, "workflow.context", ["targetRatio", "defaultTargetRatio", "phaseGc", "sessionGc", "rolloverMinTokens"]);
        const output: JsonObject = {};
        copyNumber(input, output, "targetRatio", "workflow.context", "ratio");
        copyNumber(input, output, "defaultTargetRatio", "workflow.context", "ratio");
        copyBoolean(input, output, "phaseGc", "workflow.context");
        copyBoolean(input, output, "sessionGc", "workflow.context");
        copyNumber(input, output, "rolloverMinTokens", "workflow.context", "integer");
        target.context = output;
    }
    if (source.models !== undefined) {
        const input = plainObject(source.models, "workflow.models");
        const output: JsonObject = {};
        for (const [pattern, value] of Object.entries(input)) {
            const profile = plainObject(value, `workflow.models.${pattern}`);
            allowedKeys(profile, `workflow.models.${pattern}`, ["targetRatio", "targetContextRatio"]);
            const profileOutput: JsonObject = {};
            copyNumber(profile, profileOutput, "targetRatio", `workflow.models.${pattern}`, "ratio");
            copyNumber(profile, profileOutput, "targetContextRatio", `workflow.models.${pattern}`, "ratio");
            output[pattern] = profileOutput;
        }
        target.models = output;
    }
    if (source.code !== undefined) {
        const input = plainObject(source.code, "workflow.code");
        allowedKeys(input, "workflow.code", ["rereadAfterPhase"]);
        const output: JsonObject = {};
        copyBoolean(input, output, "rereadAfterPhase", "workflow.code");
        target.code = output;
    }
    if (source.pruner !== undefined) {
        const input = plainObject(source.pruner, "workflow.pruner");
        allowedKeys(input, "workflow.pruner", ["enabled", "minTokens", "cheapModel"]);
        const output: JsonObject = {};
        copyBoolean(input, output, "enabled", "workflow.pruner");
        copyNumber(input, output, "minTokens", "workflow.pruner", "integer");
        if (input.cheapModel !== undefined) output.cheapModel = modelPatch(input.cheapModel, "workflow.pruner.cheapModel", true);
        target.pruner = output;
    }
    if (source.archive !== undefined) {
        const input = plainObject(source.archive, "workflow.archive");
        allowedKeys(input, "workflow.archive", ["semanticRaw"]);
        const output: JsonObject = {};
        copyBoolean(input, output, "semanticRaw", "workflow.archive");
        target.archive = output;
    }
    if (source.repoBridge !== undefined) {
        const input = plainObject(source.repoBridge, "workflow.repoBridge");
        allowedKeys(input, "workflow.repoBridge", ["enabled", "requireRereadAfterPhase", "enforceReread", "workspaceRoot", "hashMaxBytes", "gitTimeoutMs"]);
        const output: JsonObject = {};
        copyBoolean(input, output, "enabled", "workflow.repoBridge");
        if ("requireRereadAfterPhase" in input) {
            copyBoolean(input, output, "requireRereadAfterPhase", "workflow.repoBridge");
        } else {
            copyBoolean(input, output, "enforceReread", "workflow.repoBridge");
            if ("enforceReread" in output) output.requireRereadAfterPhase = output.enforceReread;
            delete output.enforceReread;
        }
        copyString(input, output, "workspaceRoot", "workflow.repoBridge", true);
        copyNumber(input, output, "hashMaxBytes", "workflow.repoBridge", "integer");
        copyNumber(input, output, "gitTimeoutMs", "workflow.repoBridge", "integer");
        target.repoBridge = output;
    }
    if (source.cache !== undefined) {
        const input = plainObject(source.cache, "workflow.cache");
        allowedKeys(input, "workflow.cache", ["protectCacheHitRatio", "highGrowthRate", "expectedTokensPerStep", "maxExpectedNextWorkTokens", "debuggingWindowOperations", "rewriteCostWeight"]);
        const output: JsonObject = {};
        copyNumber(input, output, "protectCacheHitRatio", "workflow.cache", "ratio");
        copyNumber(input, output, "highGrowthRate", "workflow.cache", "ratio");
        copyNumber(input, output, "expectedTokensPerStep", "workflow.cache", "integer");
        copyNumber(input, output, "maxExpectedNextWorkTokens", "workflow.cache", "integer");
        copyNumber(input, output, "debuggingWindowOperations", "workflow.cache", "integer");
        copyNumber(input, output, "rewriteCostWeight", "workflow.cache", "positive");
        target.cache = output;
    }
    if (source.memory !== undefined) {
        const input = plainObject(source.memory, "workflow.memory");
        allowedKeys(input, "workflow.memory", ["maxInjectedTokens", "maxProjectSessions"]);
        const output: JsonObject = {};
        copyNumber(input, output, "maxInjectedTokens", "workflow.memory", "integer");
        copyNumber(input, output, "maxProjectSessions", "workflow.memory", "integer");
        target.memory = output;
    }
    if (source.historian !== undefined) target.historian = modelPatch(source.historian, "workflow.historian", false);
    return target;
}

function mergeObject(base: JsonObject, patch: JsonObject): JsonObject {
    const merged: JsonObject = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete merged[key];
        } else if (value && typeof value === "object" && !Array.isArray(value)) {
            const current = merged[key];
            const currentObject = current && typeof current === "object" && !Array.isArray(current) ? current as JsonObject : {};
            merged[key] = mergeObject(currentObject, value as JsonObject);
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

function requireEnabledModels(workflow: JsonObject): void {
    const pruner = workflow.pruner && typeof workflow.pruner === "object" && !Array.isArray(workflow.pruner) ? workflow.pruner as JsonObject : {};
    const cheap = pruner.cheapModel && typeof pruner.cheapModel === "object" && !Array.isArray(pruner.cheapModel) ? pruner.cheapModel as JsonObject : {};
    const historian = workflow.historian && typeof workflow.historian === "object" && !Array.isArray(workflow.historian) ? workflow.historian as JsonObject : {};
    if (cheap.enabled === true && (typeof cheap.endpoint !== "string" || typeof cheap.model !== "string")) {
        throw new Error("workflow.pruner.cheapModel requires endpoint and model when enabled");
    }
    if (historian.enabled === true && (typeof historian.endpoint !== "string" || typeof historian.model !== "string")) {
        throw new Error("workflow.historian requires endpoint and model when enabled");
    }
}

export function publicWorkflowOptions(options: WorkflowOptions): JsonObject {
    const cheapModel: JsonObject = { ...options.cheapModel };
    const historian: JsonObject = { ...options.historian };
    const cheapKeyConfigured = Boolean(cheapModel.apiKey);
    const historianKeyConfigured = Boolean(historian.apiKey);
    delete cheapModel.apiKey;
    delete historian.apiKey;
    for (const model of [cheapModel, historian]) {
        if (typeof model.endpoint !== "string") continue;
        try {
            const endpoint = new URL(model.endpoint);
            endpoint.username = "";
            endpoint.password = "";
            model.endpoint = endpoint.toString();
        } catch {
            delete model.endpoint;
        }
    }
    cheapModel.apiKeyConfigured = cheapKeyConfigured;
    historian.apiKeyConfigured = historianKeyConfigured;
    return { ...options, cheapModel, historian };
}

function readConfig(): ConfigShape {
    const parsed = safeReadJson(configFile());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ConfigShape : {};
}

export function readProviders(): ProviderRoutes {
    return loadRoutes();
}

export function readUpstreamSettings(): { mode: UpstreamProxyMode; proxy?: string } {
    const config = readConfig();
    const proxy = typeof config.upstreamProxy === "string" && config.upstreamProxy.trim()
        ? config.upstreamProxy.trim()
        : undefined;
    return {
        mode: parseUpstreamProxyMode(config.upstreamProxyMode ?? (proxy ? "manual" : undefined)),
        ...(proxy ? { proxy } : {}),
    };
}

export async function handleCodexConfig(
    req: IncomingMessage,
    res: ServerResponse,
    defaultTargetBaseUrl: string,
): Promise<void> {
    try {
        if (req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(getCodexConfigStatus()));
            return;
        }
        const raw = await readJsonBody(req);
        const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        const action = body.action;
        if (action === "apply") {
            const target = typeof body.targetBaseUrl === "string" && body.targetBaseUrl.trim()
                ? body.targetBaseUrl.trim()
                : defaultTargetBaseUrl;
            const status = applyCodexConfig(target);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, ...status }));
            return;
        }
        if (action === "restore") {
            const result = restoreCodexConfig();
            if (result.conflict) {
                return sendError(res, 409, "Codex 配置已被外部修改，未恢复以保护用户改动");
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, ...result, ...getCodexConfigStatus() }));
            return;
        }
        return sendError(res, 400, "action must be apply or restore");
    } catch (error) {
        return sendError(res, 500, String(error instanceof Error ? error.message : error));
    }
}

function atomicWriteConfig(config: ConfigShape): void {
    const filePath = configFile();
    mkdirSync(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
        descriptor = openSync(tempPath, "wx", 0o600);
        writeFileSync(descriptor, JSON.stringify(config, null, 2) + "\n", "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(tempPath, filePath);
    } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        try { unlinkSync(tempPath); } catch { }
        throw error;
    }
}

export async function handleConfigGet(res: ServerResponse): Promise<void> {
    const upstream = readUpstreamSettings();
    const workflow = loadOptions().workflow;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        path: configFile(),
        providers: readProviders(),
        upstreamProxy: upstream.proxy ?? null,
        upstreamProxyMode: upstream.mode,
        workflow: workflow ? publicWorkflowOptions(workflow) : null,
    }, null, 2));
}

export async function handleConfigPut(
    req: IncomingMessage,
    res: ServerResponse,
    onChanged?: () => void,
    biliPort: number = 8787,
): Promise<void> {
    const raw = await readJsonBody(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return sendError(res, 400, "expected JSON object");
    const body = raw as Record<string, unknown>;
    const hasProviders = Object.prototype.hasOwnProperty.call(body, "providers");
    const hasProxy = Object.prototype.hasOwnProperty.call(body, "upstreamProxy");
    const hasMode = Object.prototype.hasOwnProperty.call(body, "upstreamProxyMode");
    const hasWorkflow = Object.prototype.hasOwnProperty.call(body, "workflow");
    if (!hasProviders && !hasProxy && !hasMode && !hasWorkflow) return sendError(res, 400, "expected providers, workflow, or upstream proxy settings");

    const routes: Record<string, ProviderRoute> = {};
    if (hasProviders) {
        if (!body.providers || typeof body.providers !== "object" || Array.isArray(body.providers)) {
            return sendError(res, 400, "providers must be an object");
        }
        for (const [url, value] of Object.entries(body.providers as Record<string, unknown>)) {
            const route = parseRouteEntry(value);
            if (!url || !route) return sendError(res, 400, `invalid provider entry: ${url || "(empty)"}`);
            try { validateHttpProxy(route.proxy, biliPort); } catch (error) {
                return sendError(res, 400, `invalid provider proxy for ${url}: ${String(error)}`);
            }
            routes[normalizeUrlKey(url)] = route;
        }
    }

    let proxy: string | undefined;
    if (hasProxy) {
        if (body.upstreamProxy !== null && typeof body.upstreamProxy !== "string") {
            return sendError(res, 400, "upstreamProxy must be a string or null");
        }
        proxy = typeof body.upstreamProxy === "string" ? body.upstreamProxy.trim() || undefined : undefined;
        try { validateHttpProxy(proxy, biliPort); } catch (error) {
            return sendError(res, 400, String(error));
        }
    }
    let mode: UpstreamProxyMode | undefined;
    if (hasMode) {
        if (typeof body.upstreamProxyMode !== "string" || !["auto", "manual", "direct"].includes(body.upstreamProxyMode)) {
            return sendError(res, 400, "upstreamProxyMode must be auto, manual, or direct");
        }
        mode = parseUpstreamProxyMode(body.upstreamProxyMode);
    }
    if (mode === "manual" && !proxy && !readUpstreamSettings().proxy) {
        return sendError(res, 400, "manual mode requires an upstream proxy URL");
    }

    const config = readConfig();
    if (hasProviders) config.providers = routes;
    if (hasProxy) {
        if (proxy) config.upstreamProxy = proxy;
        else delete config.upstreamProxy;
    }
    if (hasMode && mode) config.upstreamProxyMode = mode;
    if (hasWorkflow) {
        try {
            const patch = workflowPatch(body.workflow);
            const existing = config.workflow && typeof config.workflow === "object" && !Array.isArray(config.workflow) ? config.workflow : {};
            config.workflow = mergeObject(existing, patch);
            requireEnabledModels(config.workflow);
        } catch (error) {
            return sendError(res, 400, String(error instanceof Error ? error.message : error));
        }
    }
    try {
        atomicWriteConfig(config);
        onChanged?.();
    } catch (error) {
        return sendError(res, 500, `failed to apply config: ${String(error)}`);
    }
    const scope = [hasProviders ? `${Object.keys(routes).length} routes` : undefined, hasWorkflow ? "workflow" : undefined, hasProxy || hasMode ? "network" : undefined].filter(Boolean).join(", ");
    log("info", `[acp-web] configuration updated (${scope})`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, providers: hasProviders ? Object.keys(routes).length : undefined }));
}

function sendError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: message }));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 256 * 1024) {
                req.destroy();
                resolve(undefined);
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(undefined); }
        });
        req.on("error", () => resolve(undefined));
    });
}
