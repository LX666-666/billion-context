import { defaultConfig, type Config } from "acp-kernel";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFile } from "./paths.js";
import { log as loggerLog } from "./logger.js";
import { validateHttpProxy, type ProxyFallbackOptions } from "./upstream-proxy.js";
import type { WorkflowOptions } from "./workflow/types.js";

export function safeReadJson(path: string): unknown {
    try {
        // Strip a leading UTF-8 BOM: Windows Notepad saves UTF-8 "with BOM",
        // and JSON.parse("\uFEFF...") throws SyntaxError, silently dropping
        // the whole config file.
        const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
        return JSON.parse(raw);
    } catch (e) {
        // Surface config parse failures instead of silently swallowing them;
        // a malformed providers file would otherwise run the proxy with
        // defaults and the user would not know why routing is wrong.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            loggerLog("error", `[acp-config] failed to parse ${path}: ${String(e)}`);
        }
        return undefined;
    }
}

/** Each upstream URL may declare per-model context/output limits, mirroring the
 *  structure agents like opencode carry in their own model registry. This is
 *  the source of truth for the proxy: the LLM `/models` endpoint does NOT
 *  return context windows (verified across OpenAI/Anthropic/zhipu/comfly),
 *  so the proxy cannot discover them at runtime — the user must declare them.
 */
export type ProviderRoute = {
    models?: Record<string, { context?: number; output?: number }>;
    /** Per-URL upstream HTTP proxy. Overrides the global `proxy`. Empty string
     *  means "explicitly direct" (override global with no proxy). Format:
     *  `http://host:port`. SOCKS5 is not supported yet. */
    proxy?: string;
};
export type ProviderRoutes = Record<string, ProviderRoute>; // key = upstream URL prefix (the /bili/<this> string)
export type PromptCacheRouting = "auto" | "enabled" | "disabled";
export type UpstreamProxyMode = "auto" | "manual" | "direct";

/** Built-in context window for common model families, keyed by a lowercase
 *  prefix. This is a FALLBACK used when the per-route model declaration in
 *  providers.json does not cover a model. The per-route declaration (which
 *  the user controls) always wins, because the same model name can have
 *  different windows behind different relays. */
const CONTEXT_LIMIT_TABLE: Array<{ match: RegExp; limit: number }> = [
    { match: /^claude-/i, limit: 200_000 },
    { match: /^gpt-5/i, limit: 400_000 },
    { match: /^gpt-4\.1/i, limit: 1_000_000 },
    { match: /^gpt-4o/i, limit: 128_000 },
    { match: /^gpt-4-turbo/i, limit: 128_000 },
    { match: /^o[13]-/i, limit: 200_000 },
    { match: /^gemini-2\.5/i, limit: 1_000_000 },
    { match: /^gemini-1\.5/i, limit: 1_000_000 },
    { match: /^glm-4\.6/i, limit: 128_000 },
    { match: /^glm-5/i, limit: 1_000_000 },
    { match: /^glm-/i, limit: 128_000 },
    { match: /^deepseek/i, limit: 64_000 },
    { match: /^qwen/i, limit: 128_000 },
    { match: /^kimi/i, limit: 128_000 },
    { match: /^llama-/i, limit: 128_000 },
];

export function lookupContextLimit(model: string | undefined): number | undefined {
    if (!model) return undefined;
    for (const entry of CONTEXT_LIMIT_TABLE) {
        if (entry.match.test(model)) return entry.limit;
    }
    return undefined;
}

/** Resolve the context-window limit for a request. Priority:
 *  1. Per-URL per-model declaration in config (user-controlled, most accurate).
 *     The upstreamUrl is matched against config keys by **longest-prefix wins**
 *     (the key is a string the user wrote, identical to what follows /bili/ in
 *     the zero-config baseURL). A shallow key like "https://open.bigmodel.cn"
 *     matches all paths on that host; a deep key like
 *     "https://open.bigmodel.cn/api/anthropic" matches only that endpoint.
 *  2. Built-in CONTEXT_LIMIT_TABLE (by model name prefix)
 *  Returns undefined if neither matches — caller falls back to the env default. */
export function resolveContextLimit(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    model: string | undefined,
): number | undefined {
    return resolveConfiguredContextLimit(routes, upstreamUrl, model) ?? lookupContextLimit(model);
}

export function resolveConfiguredContextLimit(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    model: string | undefined,
): number | undefined {
    if (!model || !upstreamUrl) return undefined;
    // Longest-prefix match: collect all keys that are a prefix of upstreamUrl,
    // pick the longest (most specific). A key matches if upstreamUrl === key
    // OR upstreamUrl starts with key + ("/" or key being the full origin). This
    // avoids "https://x.com" matching "https://x.com.evil" — the boundary check
    // requires the next char after the key to be "/" or end-of-string.
    let bestKey = "";
    for (const key of Object.keys(routes)) {
        if (upstreamUrl === key || upstreamUrl.startsWith(key + "/")) {
            if (key.length > bestKey.length) bestKey = key;
        }
    }
    if (bestKey) {
        const m = routes[bestKey].models?.[model];
        if (m?.context && m.context > 0) return m.context;
    }
    return undefined;
}

export type ProxyOptions = {
    port: number;
    host: string;
    upstream: string;
    routes: ProviderRoutes;
    /** Global default upstream HTTP proxy. Per-URL `proxy` overrides this.
     *  Empty string explicitly disables environment/system proxy fallback. */
    proxy?: string;
    proxyMode?: UpstreamProxyMode;
    proxySource?: "bili-env" | "web-manual" | "config" | "auto" | "direct";
    proxyFallback?: ProxyFallbackOptions;
    modelContextLimit: number;
    kernelConfig: Config;
    compress: {
        injectTool: boolean;
        injectNudge: boolean;
    };
    promptCache: { routing: PromptCacheRouting };
    workflow?: WorkflowOptions;
    sessionHeader: string;
    log: boolean;
    debug: boolean;
    dumpSse?: string;
    passthrough: boolean;
    autoUpdate: boolean;
    logFile?: string;
    /** MITM transparent-proxy mode. When enabled, an HTTP CONNECT handler is
     *  attached so clients that only know how to set HTTP_PROXY (ZCode with a
     *  locked-in endpoint) can route through the proxy. Whitelisted model
     *  hosts are TLS-terminated locally and fed back into the same request
     *  pipeline; all other hosts are blind-tunnelled. */
    mitm: { enabled: boolean; domains: string[] };
};

/** Re-read ONLY the routes from the current config sources, returning a fresh
 *  ProviderRoutes object. Used by the web UI's "Apply" (hot-reload) button so
 *  provider/route changes take effect without restarting bili. Only routes are
 *  re-read — port/host/upstream can't change on a running server (the listen
 *  socket is already bound), so those stay as they were at startup. Mirrors the
 *  exact precedence of loadOptions: external ACP_PROVIDERS path > inline
 *  providers in the config file. */
export function loadRoutes(env: NodeJS.ProcessEnv = process.env): ProviderRoutes {
    const fileConfig = loadConfigFile();
    const routes: ProviderRoutes = {};
    const routesPath = env.ACP_PROVIDERS ?? fileConfig.providersPath ?? "";
    if (routesPath) {
        const parsed = safeReadJson(routesPath);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                rejectLegacyRoute(k, v);
                const route = parseRouteEntry(v);
                if (route) routes[normalizeUrlKey(k)] = route;
            }
        }
    }
    if (fileConfig.providers) {
        for (const [k, v] of Object.entries(fileConfig.providers)) {
            rejectLegacyRoute(k, v);
            const route = parseRouteEntry(v);
            if (route && !routes[normalizeUrlKey(k)]) routes[normalizeUrlKey(k)] = route;
        }
    }
    return routes;
}

export function loadOptions(env: NodeJS.ProcessEnv = process.env): ProxyOptions {
    // --- Source 1: JSON config file (~/.config/billion-context/billion-context.json) ---
    // The canonical, user-editable config. Loaded first so env vars below can
    // override it (env wins for environment-specific overrides).
    const fileConfig = loadConfigFile();

    // --- Source 2: env vars (highest priority) ---
    const port = parseInt(env.ACP_PORT ?? env.PORT ?? `${fileConfig.port ?? 8787}`, 10);
    const host = env.ACP_HOST ?? fileConfig.host ?? "127.0.0.1";
    const upstream = (env.ACP_UPSTREAM ?? fileConfig.upstream ?? "https://api.anthropic.com").replace(/\/$/, "");
    let routes: ProviderRoutes = {};
    // Routes: explicit env path > config file providers > none.
    const routesPath = env.ACP_PROVIDERS ?? fileConfig.providersPath ?? "";
    if (routesPath) {
        const parsed = safeReadJson(routesPath);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                rejectLegacyRoute(k, v);
                const route = parseRouteEntry(v);
                if (route) routes[normalizeUrlKey(k)] = route;
            }
        }
    }
    // Also accept providers inline in the config file.
    if (fileConfig.providers) {
        for (const [k, v] of Object.entries(fileConfig.providers)) {
            rejectLegacyRoute(k, v);
            const route = parseRouteEntry(v);
            if (route && !routes[normalizeUrlKey(k)]) routes[normalizeUrlKey(k)] = route;
        }
    }
    const modelContextLimit = parseInt(env.ACP_MODEL_CONTEXT_LIMIT ?? `${fileConfig.modelContextLimit ?? 200000}`, 10);
    const biliProxy = nonEmpty(env.BILI_UPSTREAM_PROXY);
    const webProxy = nonEmpty(fileConfig.upstreamProxy);
    const configProxy = nonEmpty(fileConfig.proxy);
    const proxyMode = parseUpstreamProxyMode(
        env.BILI_UPSTREAM_PROXY_MODE ?? fileConfig.upstreamProxyMode ?? (webProxy ? "manual" : undefined),
    );
    const proxy = biliProxy ?? (proxyMode === "direct" ? "" : proxyMode === "manual" ? webProxy ?? configProxy : configProxy);
    const proxySource: ProxyOptions["proxySource"] = biliProxy
        ? "bili-env"
        : proxyMode === "direct"
          ? "direct"
          : proxyMode === "manual" && webProxy
            ? "web-manual"
            : configProxy
              ? "config"
              : "auto";
    const httpProxy = nonEmpty(env.HTTP_PROXY ?? env.http_proxy);
    const httpsProxy = nonEmpty(env.HTTPS_PROXY ?? env.https_proxy);
    const allProxy = nonEmpty(env.ALL_PROXY ?? env.all_proxy);
    const noProxy = nonEmpty(env.NO_PROXY ?? env.no_proxy);
    const proxyFallback: ProxyFallbackOptions = {
        ...(httpProxy ? { httpProxy } : {}),
        ...(httpsProxy ? { httpsProxy } : {}),
        ...(allProxy ? { allProxy } : {}),
        ...(noProxy ? { noProxy } : {}),
        biliPort: Number.isFinite(port) ? port : 8787,
        globalSource: proxySource,
    };
    validateHttpProxy(proxy, proxyFallback.biliPort);
    for (const [url, route] of Object.entries(routes)) {
        try {
            validateHttpProxy(route.proxy, proxyFallback.biliPort);
        } catch (error) {
            throw new Error(`[acp-config] invalid upstream proxy for ${url}: ${String(error)}`);
        }
    }
    const cheapModelEnabled = (env.BILI_WORKFLOW_CHEAP_MODEL_ENABLED ?? (fileConfig.workflow?.pruner?.cheapModel?.enabled ? "1" : "0")) === "1";
    const cheapModelEndpoint = nonEmpty(env.BILI_WORKFLOW_CHEAP_MODEL_ENDPOINT) ?? nonEmpty(fileConfig.workflow?.pruner?.cheapModel?.endpoint);
    const cheapModelName = nonEmpty(env.BILI_WORKFLOW_CHEAP_MODEL_NAME) ?? nonEmpty(fileConfig.workflow?.pruner?.cheapModel?.model);
    const cheapModelApiKey = nonEmpty(env.BILI_WORKFLOW_CHEAP_MODEL_API_KEY) ?? nonEmpty(fileConfig.workflow?.pruner?.cheapModel?.apiKey);
    if (cheapModelEnabled && (!cheapModelEndpoint || !cheapModelName)) {
        throw new Error("[acp-config] workflow.pruner.cheapModel requires endpoint and model when enabled");
    }
    if (cheapModelEndpoint) {
        let parsedCheapEndpoint: URL;
        try {
            parsedCheapEndpoint = new URL(cheapModelEndpoint);
        } catch {
            throw new Error(`[acp-config] invalid workflow.pruner.cheapModel.endpoint: ${JSON.stringify(cheapModelEndpoint)}`);
        }
        if (parsedCheapEndpoint.protocol !== "http:" && parsedCheapEndpoint.protocol !== "https:") {
            throw new Error(`[acp-config] invalid workflow.pruner.cheapModel.endpoint protocol: ${parsedCheapEndpoint.protocol}`);
        }
    }
    const historianEnabled = (env.BILI_WORKFLOW_HISTORIAN_ENABLED ?? (fileConfig.workflow?.historian?.enabled ? "1" : "0")) === "1";
    const historianEndpoint = nonEmpty(env.BILI_WORKFLOW_HISTORIAN_ENDPOINT)
        ?? nonEmpty(fileConfig.workflow?.historian?.endpoint)
        ?? cheapModelEndpoint;
    const historianModel = nonEmpty(env.BILI_WORKFLOW_HISTORIAN_MODEL)
        ?? nonEmpty(fileConfig.workflow?.historian?.model)
        ?? cheapModelName;
    const historianApiKey = nonEmpty(env.BILI_WORKFLOW_HISTORIAN_API_KEY)
        ?? nonEmpty(fileConfig.workflow?.historian?.apiKey)
        ?? cheapModelApiKey;
    if (historianEnabled && (!historianEndpoint || !historianModel)) {
        throw new Error("[acp-config] workflow.historian requires endpoint and model when enabled");
    }
    if (historianEndpoint) {
        let parsedHistorianEndpoint: URL;
        try {
            parsedHistorianEndpoint = new URL(historianEndpoint);
        } catch {
            throw new Error(`[acp-config] invalid workflow.historian.endpoint: ${JSON.stringify(historianEndpoint)}`);
        }
        if (parsedHistorianEndpoint.protocol !== "http:" && parsedHistorianEndpoint.protocol !== "https:") {
            throw new Error(`[acp-config] invalid workflow.historian.endpoint protocol: ${parsedHistorianEndpoint.protocol}`);
        }
    }
    const workflowModels = parseWorkflowModels(fileConfig.workflow?.models);
    const workflow: WorkflowOptions = {
        enabled: (env.BILI_WORKFLOW_ENABLED ?? (fileConfig.workflow?.enabled === false ? "0" : "1")) !== "0",
        targetContextRatio: parseWorkflowRatio(
            env.BILI_WORKFLOW_TARGET_RATIO ?? fileConfig.workflow?.context?.targetRatio ?? fileConfig.workflow?.context?.defaultTargetRatio,
            "workflow.context.targetRatio",
            0.2,
        ),
        ...(workflowModels ? { models: workflowModels } : {}),
        phaseGc: (env.BILI_WORKFLOW_PHASE_GC ?? (fileConfig.workflow?.context?.phaseGc === false ? "0" : "1")) !== "0",
        sessionGc: (env.BILI_WORKFLOW_SESSION_GC ?? (fileConfig.workflow?.context?.sessionGc === false ? "0" : "1")) !== "0",
        rereadAfterPhase: (env.BILI_WORKFLOW_REREAD_AFTER_PHASE ?? (fileConfig.workflow?.code?.rereadAfterPhase === false ? "0" : "1")) !== "0",
        deterministicPruner: (env.BILI_WORKFLOW_PRUNER ?? (fileConfig.workflow?.pruner?.enabled === false ? "0" : "1")) !== "0",
        prunerMinTokens: parseWorkflowInteger(
            env.BILI_WORKFLOW_PRUNER_MIN_TOKENS ?? fileConfig.workflow?.pruner?.minTokens,
            "workflow.pruner.minTokens",
            2_000,
        ),
        cheapModel: {
            enabled: cheapModelEnabled,
            ...(cheapModelEndpoint ? { endpoint: cheapModelEndpoint } : {}),
            ...(cheapModelName ? { model: cheapModelName } : {}),
            ...(cheapModelApiKey ? { apiKey: cheapModelApiKey } : {}),
            minTokens: parseWorkflowInteger(
                env.BILI_WORKFLOW_CHEAP_MODEL_MIN_TOKENS ?? fileConfig.workflow?.pruner?.cheapModel?.minTokens,
                "workflow.pruner.cheapModel.minTokens",
                8_000,
            ),
            maxOutputTokens: parseWorkflowInteger(
                env.BILI_WORKFLOW_CHEAP_MODEL_MAX_OUTPUT_TOKENS ?? fileConfig.workflow?.pruner?.cheapModel?.maxOutputTokens,
                "workflow.pruner.cheapModel.maxOutputTokens",
                2_000,
            ),
            timeoutMs: parseWorkflowInteger(
                env.BILI_WORKFLOW_CHEAP_MODEL_TIMEOUT_MS ?? fileConfig.workflow?.pruner?.cheapModel?.timeoutMs,
                "workflow.pruner.cheapModel.timeoutMs",
                30_000,
            ),
        },
        rolloverMinTokens: parseWorkflowInteger(
            env.BILI_WORKFLOW_ROLLOVER_MIN_TOKENS ?? fileConfig.workflow?.context?.rolloverMinTokens,
            "workflow.context.rolloverMinTokens",
            12_000,
        ),
        archiveSemanticRaw: (env.BILI_WORKFLOW_ARCHIVE_RAW ?? (fileConfig.workflow?.archive?.semanticRaw === false ? "0" : "1")) !== "0",
        projectKey: nonEmpty(env.BILI_WORKFLOW_PROJECT_KEY) ?? nonEmpty(fileConfig.workflow?.projectKey),
        repoBridge: {
            enabled: (env.BILI_WORKFLOW_REPO_BRIDGE ?? (fileConfig.workflow?.repoBridge?.enabled === false ? "0" : "1")) !== "0",
            enforceReread: (env.BILI_WORKFLOW_ENFORCE_REREAD ?? (fileConfig.workflow?.repoBridge?.enforceReread === false ? "0" : "1")) !== "0",
            workspaceRoot: nonEmpty(env.BILI_WORKFLOW_WORKSPACE_ROOT) ?? nonEmpty(fileConfig.workflow?.repoBridge?.workspaceRoot),
            hashMaxBytes: parseWorkflowInteger(
                env.BILI_WORKFLOW_REPO_HASH_MAX_BYTES ?? fileConfig.workflow?.repoBridge?.hashMaxBytes,
                "workflow.repoBridge.hashMaxBytes",
                4 * 1024 * 1024,
            ),
            gitTimeoutMs: parseWorkflowInteger(
                env.BILI_WORKFLOW_REPO_GIT_TIMEOUT_MS ?? fileConfig.workflow?.repoBridge?.gitTimeoutMs,
                "workflow.repoBridge.gitTimeoutMs",
                2_000,
            ),
        },
        cachePolicy: {
            protectCacheHitRatio: parseWorkflowRatio(
                env.BILI_WORKFLOW_CACHE_PROTECT_HIT_RATIO ?? fileConfig.workflow?.cache?.protectCacheHitRatio,
                "workflow.cache.protectCacheHitRatio",
                0.65,
            ),
            highGrowthRate: parseWorkflowRatio(
                env.BILI_WORKFLOW_CACHE_HIGH_GROWTH_RATE ?? fileConfig.workflow?.cache?.highGrowthRate,
                "workflow.cache.highGrowthRate",
                0.18,
            ),
            expectedTokensPerStep: parseWorkflowInteger(
                env.BILI_WORKFLOW_CACHE_EXPECTED_TOKENS_PER_STEP ?? fileConfig.workflow?.cache?.expectedTokensPerStep,
                "workflow.cache.expectedTokensPerStep",
                8_000,
            ),
            maxExpectedNextWorkTokens: parseWorkflowInteger(
                env.BILI_WORKFLOW_CACHE_MAX_EXPECTED_TOKENS ?? fileConfig.workflow?.cache?.maxExpectedNextWorkTokens,
                "workflow.cache.maxExpectedNextWorkTokens",
                64_000,
            ),
            debuggingWindowOperations: parseWorkflowInteger(
                env.BILI_WORKFLOW_CACHE_DEBUG_WINDOW ?? fileConfig.workflow?.cache?.debuggingWindowOperations,
                "workflow.cache.debuggingWindowOperations",
                10,
            ),
            rewriteCostWeight: parseWorkflowPositive(
                env.BILI_WORKFLOW_CACHE_REWRITE_WEIGHT ?? fileConfig.workflow?.cache?.rewriteCostWeight,
                "workflow.cache.rewriteCostWeight",
                1.1,
            ),
        },
        memory: {
            maxInjectedTokens: parseWorkflowInteger(
                env.BILI_WORKFLOW_MEMORY_MAX_INJECTED_TOKENS ?? fileConfig.workflow?.memory?.maxInjectedTokens,
                "workflow.memory.maxInjectedTokens",
                12_000,
            ),
            maxProjectSessions: parseWorkflowInteger(
                env.BILI_WORKFLOW_MEMORY_MAX_PROJECT_SESSIONS ?? fileConfig.workflow?.memory?.maxProjectSessions,
                "workflow.memory.maxProjectSessions",
                6,
            ),
        },
        historian: {
            enabled: historianEnabled,
            ...(historianEndpoint ? { endpoint: historianEndpoint } : {}),
            ...(historianModel ? { model: historianModel } : {}),
            ...(historianApiKey ? { apiKey: historianApiKey } : {}),
            maxInputTokens: parseWorkflowInteger(
                env.BILI_WORKFLOW_HISTORIAN_MAX_INPUT_TOKENS ?? fileConfig.workflow?.historian?.maxInputTokens,
                "workflow.historian.maxInputTokens",
                16_000,
            ),
            maxOutputTokens: parseWorkflowInteger(
                env.BILI_WORKFLOW_HISTORIAN_MAX_OUTPUT_TOKENS ?? fileConfig.workflow?.historian?.maxOutputTokens,
                "workflow.historian.maxOutputTokens",
                2_000,
            ),
            timeoutMs: parseWorkflowInteger(
                env.BILI_WORKFLOW_HISTORIAN_TIMEOUT_MS ?? fileConfig.workflow?.historian?.timeoutMs,
                "workflow.historian.timeoutMs",
                30_000,
            ),
        },
    };
    return {
        port: Number.isFinite(port) ? port : 8787,
        host,
        upstream,
        routes,
        proxy,
        proxyMode,
        proxySource,
        proxyFallback,
        modelContextLimit,
        kernelConfig: defaultConfig(modelContextLimit),
        compress: {
            injectTool: (env.ACP_COMPRESS_TOOL ?? (fileConfig.compress?.injectTool === false ? "0" : "1")) !== "0",
            injectNudge: (env.ACP_COMPRESS_NUDGE ?? (fileConfig.compress?.injectNudge === false ? "0" : "1")) !== "0",
        },
        promptCache: {
            routing: parsePromptCacheRouting(env.ACP_PROMPT_CACHE_ROUTING ?? fileConfig.promptCache?.routing),
        },
        workflow,
        sessionHeader: env.ACP_SESSION_HEADER ?? fileConfig.sessionHeader ?? "x-acp-session",
        log: env.ACP_LOG !== "0" && fileConfig.log !== false,
        debug: (env.ACP_DEBUG ?? (fileConfig.debug ? "1" : "0")) === "1",
        dumpSse: env.ACP_DUMP_SSE || fileConfig.dumpSse || undefined,
        passthrough: (env.ACP_PASSTHROUGH ?? (fileConfig.passthrough ? "1" : "0")) === "1",
        autoUpdate: (env.ACP_AUTO_UPDATE ?? (fileConfig.autoUpdate === false ? "0" : "1")) !== "0",
        logFile: env.ACP_LOG_FILE !== undefined ? (env.ACP_LOG_FILE || undefined) : fileConfig.logFile,
        mitm: {
            enabled: (env.BILI_MITM ?? (fileConfig.mitm?.enabled === false ? "0" : "1")) !== "0",
            domains: fileConfig.mitm?.domains ?? [],
        },
    };
}

/** Shape of the optional JSON config file. All fields optional — the file is a
 *  pure override layer; anything unset falls through to defaults. */
type FileConfig = {
    port?: number;
    host?: string;
    upstream?: string;
    /** Path to a legacy providers.json (backward compat). */
    providersPath?: string;
    /** Inline providers, same shape as providers.json. */
    providers?: Record<string, unknown>;
    /** Global default upstream HTTP proxy (applied to all providers unless a
     *  per-URL `proxy` overrides it). `http://host:port`. */
    proxy?: string;
    modelContextLimit?: number;
    sessionHeader?: string;
    log?: boolean;
    debug?: boolean;
    dumpSse?: string;
    passthrough?: boolean;
    autoUpdate?: boolean;
    upstreamProxy?: string;
    upstreamProxyMode?: string;
    logFile?: string;
    compress?: { injectTool?: boolean; injectNudge?: boolean };
    promptCache?: { routing?: string };
    workflow?: {
        enabled?: boolean;
        projectKey?: string;
        context?: { targetRatio?: number; defaultTargetRatio?: number; phaseGc?: boolean; sessionGc?: boolean; rolloverMinTokens?: number };
        models?: Record<string, { targetRatio?: number; targetContextRatio?: number }>;
        code?: { rereadAfterPhase?: boolean };
        pruner?: {
            enabled?: boolean;
            minTokens?: number;
            cheapModel?: {
                enabled?: boolean;
                endpoint?: string;
                model?: string;
                apiKey?: string;
                minTokens?: number;
                maxOutputTokens?: number;
                timeoutMs?: number;
            };
        };
        archive?: { semanticRaw?: boolean };
        repoBridge?: {
            enabled?: boolean;
            enforceReread?: boolean;
            workspaceRoot?: string;
            hashMaxBytes?: number;
            gitTimeoutMs?: number;
        };
        cache?: {
            protectCacheHitRatio?: number;
            highGrowthRate?: number;
            expectedTokensPerStep?: number;
            maxExpectedNextWorkTokens?: number;
            debuggingWindowOperations?: number;
            rewriteCostWeight?: number;
        };
        memory?: {
            maxInjectedTokens?: number;
            maxProjectSessions?: number;
        };
        historian?: {
            enabled?: boolean;
            endpoint?: string;
            model?: string;
            apiKey?: string;
            maxInputTokens?: number;
            maxOutputTokens?: number;
            timeoutMs?: number;
        };
    };
    mitm?: { enabled?: boolean; domains?: string[] };
};

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function parseWorkflowRatio(value: unknown, name: string, fallback: number): number {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
        throw new Error(`[acp-config] invalid ${name}: ${JSON.stringify(value)} — must be > 0 and <= 1`);
    }
    return parsed;
}

function parseWorkflowInteger(value: unknown, name: string, fallback: number): number {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        throw new Error(`[acp-config] invalid ${name}: ${JSON.stringify(value)} — must be a positive integer`);
    }
    return parsed;
}

function parseWorkflowModels(value: unknown): Record<string, { targetRatio?: number; targetContextRatio?: number }> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("[acp-config] invalid workflow.models: must be an object");
    const result: Record<string, { targetRatio?: number; targetContextRatio?: number }> = {};
    for (const [pattern, raw] of Object.entries(value as Record<string, unknown>)) {
        if (!pattern.trim() || !raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error(`[acp-config] invalid workflow.models.${pattern}`);
        }
        const record = raw as Record<string, unknown>;
        const targetRatio = record.targetRatio === undefined
            ? undefined
            : parseWorkflowRatio(record.targetRatio, `workflow.models.${pattern}.targetRatio`, 0.2);
        const targetContextRatio = record.targetContextRatio === undefined
            ? undefined
            : parseWorkflowRatio(record.targetContextRatio, `workflow.models.${pattern}.targetContextRatio`, 0.2);
        if (targetRatio === undefined && targetContextRatio === undefined) {
            throw new Error(`[acp-config] invalid workflow.models.${pattern}: targetRatio is required`);
        }
        result[pattern] = {
            ...(targetRatio !== undefined ? { targetRatio } : {}),
            ...(targetContextRatio !== undefined ? { targetContextRatio } : {}),
        };
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function parseWorkflowPositive(value: unknown, name: string, fallback: number): number {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10) {
        throw new Error(`[acp-config] invalid ${name}: ${JSON.stringify(value)} — must be > 0 and <= 10`);
    }
    return parsed;
}
function loadConfigFile(): FileConfig {
    const parsed = safeReadJson(configFile());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as FileConfig;
    }
    return {};
}

/** Template written on first run so the user has a file to edit instead
 *  of having to invent the path/schema. Left empty on purpose: the proxy
 *  can't guess your provider, so we don't put a fake one. Fill it in per
 *  the README Quickstart, then restart `bili`. */
const TEMPLATE_CONFIG = `{
  "providers": {
  }
}`;

/** On first run, seed a template config file next to where loadOptions reads.
 *  Idempotent: never overwrites an existing file. Returns true if it created
 *  one. Non-fatal: if the dir isn't writable, we fall through to defaults and
 *  the proxy still runs. */
export function ensureConfigTemplate(): boolean {
    const p = configFile();
    if (existsSync(p)) return false;
    try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, TEMPLATE_CONFIG + "\n", "utf8");
        loggerLog("info", `[acp-config] created empty config at ${p} — add your providers (see README Quickstart), then restart`);
        return true;
    } catch {
        return false;
    }
}

export function normalizeUrlKey(key: string): string {
    // Keys are upstream URLs matched by longest-prefix against the request's
    // embedded URL. A trailing slash breaks that match (the embedded URL never
    // has one), so strip trailing slashes. Manual edits and web-UI saves both
    // flow through here so the behavior is consistent.
    return key.replace(/\/+$/, "");
}

export function parseRouteEntry(v: unknown): ProviderRoute | undefined {
    // The value describes per-model context overrides. The upstream URL itself
    // is the KEY in the providers map (identical to the /bili/<url> string),
    // so it is NOT repeated inside the value.
    if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as { models?: Record<string, { context?: number; output?: number }>; proxy?: string };
        const route: ProviderRoute = { models: obj.models };
        if (typeof obj.proxy === "string") route.proxy = obj.proxy;
        return route;
    }
    // A bare value (e.g. null) means "this upstream exists, no overrides".
    if (v === null) return {};
    return undefined;
}

export function parsePromptCacheRouting(value: string | undefined): PromptCacheRouting {
    return value === "enabled" || value === "disabled" ? value : "auto";
}

export function parseUpstreamProxyMode(value: string | undefined): UpstreamProxyMode {
    return value === "manual" || value === "auto" ? value : "direct";
}

function rejectLegacyRoute(key: string, value: unknown): void {
    if (typeof value !== "string") return;
    throw new Error(
        `[acp-config] legacy provider route \"${key}\": \"${value}\" is no longer valid; ` +
        `use the upstream URL as the key, for example { \"${value.replace(/\/+$/, "")}\": {} }`,
    );
}
