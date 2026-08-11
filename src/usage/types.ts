/**
 * Usage-accounting types for the request ledger.
 *
 * The design borrows CC Switch's usage model: every proxied request is
 * normalized to a protocol-agnostic shape, priced with per-model four-way
 * pricing, and appended to a request log that the Web UI aggregates.
 * See the design doc "Sub2API 风格 「用量统计」Web UI".
 */

/** Protocol we know how to parse usage from. */
export type Protocol = "codex" | "openai" | "anthropic" | "unknown";

/**
 * Origin of a ledger record. `proxy` is the real-time capture path; the
 * `*_session` values come from offline client-log importers that backfill
 * usage when CC Switch wasn't running. The field drives the cross-source
 * dedup layer and the Dashboard "数据来源" tab.
 */
export type DataSource =
    | "proxy"
    | "claude_session"
    | "codex_session"
    | "gemini_session"
    | "opencode_session"
    | "grok_session";

/**
 * Normalized, protocol-agnostic usage for a single request (doc §16).
 *
 * The cache semantics differ per protocol:
 *  - Codex/OpenAI: `input_tokens` usually *includes* cached tokens, so
 *    fresh input = input_tokens - cached_tokens.
 *  - Anthropic: `input_tokens` is fresh input, cache reads are reported
 *    separately.
 * The normalizers in normalizer.ts reconcile this so downstream math never
 * double-counts cached tokens.
 */
export type NormalizedUsage = {
    /** Input tokens that were NOT cache-read (i.e. billable fresh input). */
    freshInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
};

/** ACP compression result for one request (billion-context specific). */
export type AcpUsage = {
    /** Context size before ACP compression (what the upstream would have seen
     *  without billion-context). */
    originalContextTokens: number;
    /** Actual context forwarded upstream after compression. */
    forwardedContextTokens: number;
    /** original - forwarded. */
    acpSavedTokens: number;
};

/**
 * One request-level ledger entry (doc §14 schema, adapted for JSONL).
 * `timestamp` is ISO 8601 so records stay lexicographically sortable.
 */
export type UsageRecord = {
    id: string;
    timestamp: string;
    sessionId?: string;
    protocol: Protocol;
    /** Origin of the record — real-time proxy or an offline client importer. */
    dataSource?: DataSource;
    /**
     * Stable identifier from the source protocol (Claude `message.id`,
     * Codex thread id, Grok `prompt_id`, etc.). Used as the primary
     * cross-source dedup key when present.
     */
    sourceRequestId?: string;
    /** Upstream host / provider identifier (e.g. "chatgpt.com"). */
    provider?: string;
    model?: string;
    /** Raw input reported by the API (pre-normalization, includes cache). */
    inputTokens: number;
    freshInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** ACP compression (doc §11) — only set on compressed requests. */
    originalContextTokens?: number;
    forwardedContextTokens?: number;
    acpSavedTokens?: number;
    /** Costs in USD (priced at request time). */
    inputCost?: number;
    outputCost?: number;
    cacheReadCost?: number;
    cacheCreationCost?: number;
    totalCost?: number;
    /** Estimated total cost had the cache not existed (all fresh input). */
    estimatedWithoutCacheCost?: number;
    /** Estimated total cost had ACP compression not run. */
    estimatedWithoutAcpCost?: number;
    statusCode?: number;
    streaming?: boolean;
    latencyMs?: number;
    ttftMs?: number;
};

/**
 * Four-way pricing for a model, USD per 1M tokens (doc §3). All fields default
 * to 0 so an unpriced model still produces deterministic (zero) cost.
 */
export type PriceEntry = {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
};
