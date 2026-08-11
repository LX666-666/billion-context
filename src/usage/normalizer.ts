/**
 * Protocol-specific usage normalization (doc §16).
 *
 * Different providers report cache semantics differently:
 *  - Codex / OpenAI: `input_tokens` (or `prompt_tokens`) usually INCLUDES the
 *    cached portion; the cached part is reported separately under
 *    `input_tokens_details.cached_tokens` (or `prompt_tokens_details`).
 *  - Anthropic: `input_tokens` is fresh input; cache reads are reported
 *    separately as `cache_read_input_tokens`.
 *
 * Every normalizer maps to the same `NormalizedUsage` so that cache-hit-rate
 * and cost math below never double-counts a cached token as fresh input.
 */

import type { NormalizedUsage, Protocol } from "./types.js";

/** Field aliases CC Switch tolerates for the cache-write portion. */
function firstDefined(...values: Array<unknown>): number | undefined {
    for (const v of values) {
        if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
}

export type RawCodexUsage = {
    input_tokens?: number;
    prompt_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: {
        cached_tokens?: number;
        cache_write_tokens?: number;
    };
    prompt_tokens_details?: {
        cached_tokens?: number;
        cache_write_tokens?: number;
    };
    cache_creation_input_tokens?: number;
};

/** Codex / OpenAI Responses `response.usage`. `input_tokens` includes cache;
 *  fresh input = input - cached. */
export function normalizeCodexUsage(usage: RawCodexUsage): NormalizedUsage {
    const input = firstDefined(usage.input_tokens, usage.prompt_tokens) ?? 0;
    const cached =
        firstDefined(
            usage.input_tokens_details?.cached_tokens,
            usage.prompt_tokens_details?.cached_tokens,
        ) ?? 0;
    const cacheCreation =
        firstDefined(
            usage.input_tokens_details?.cache_write_tokens,
            usage.prompt_tokens_details?.cache_write_tokens,
            usage.cache_creation_input_tokens,
        ) ?? 0;
    return {
        freshInputTokens: Math.max(0, input - cached),
        outputTokens: firstDefined(usage.output_tokens) ?? 0,
        cacheReadTokens: cached,
        cacheCreationTokens: cacheCreation,
    };
}

export type RawOpenaiUsage = {
    prompt_tokens?: number;
    input_tokens?: number;
    completion_tokens?: number;
    output_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        cache_write_tokens?: number;
    };
    input_tokens_details?: {
        cached_tokens?: number;
        cache_write_tokens?: number;
    };
    prompt_cache_hit_tokens?: number;
    cache_creation_input_tokens?: number;
};

/** OpenAI Chat Completions `usage` (and older /v1/chat/completions style).
 *  Same semantics as Codex: input includes cached. */
export function normalizeOpenaiUsage(usage: RawOpenaiUsage): NormalizedUsage {
    const input = firstDefined(usage.prompt_tokens, usage.input_tokens) ?? 0;
    const cached =
        firstDefined(
            usage.prompt_tokens_details?.cached_tokens,
            usage.input_tokens_details?.cached_tokens,
            usage.prompt_cache_hit_tokens,
        ) ?? 0;
    const cacheCreation =
        firstDefined(
            usage.prompt_tokens_details?.cache_write_tokens,
            usage.input_tokens_details?.cache_write_tokens,
            usage.cache_creation_input_tokens,
        ) ?? 0;
    return {
        freshInputTokens: Math.max(0, input - cached),
        outputTokens: firstDefined(usage.completion_tokens, usage.output_tokens) ?? 0,
        cacheReadTokens: cached,
        cacheCreationTokens: cacheCreation,
    };
}

export type RawAnthropicUsage = {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
};

/** Anthropic Messages `usage`. `input_tokens` is fresh input; cache reads are
 *  reported separately. */
export function normalizeAnthropicUsage(usage: RawAnthropicUsage): NormalizedUsage {
    return {
        freshInputTokens: firstDefined(usage.input_tokens) ?? 0,
        outputTokens: firstDefined(usage.output_tokens) ?? 0,
        cacheReadTokens: firstDefined(usage.cache_read_input_tokens) ?? 0,
        cacheCreationTokens: firstDefined(usage.cache_creation_input_tokens) ?? 0,
    };
}

/** Dispatch by protocol. Falls back to a zeroed record for unknown protocols. */
export function normalizeUsage(protocol: Protocol, usage: unknown): NormalizedUsage {
    switch (protocol) {
        case "codex":
            return normalizeCodexUsage(usage as RawCodexUsage);
        case "openai":
            return normalizeOpenaiUsage(usage as RawOpenaiUsage);
        case "anthropic":
            return normalizeAnthropicUsage(usage as RawAnthropicUsage);
        default:
            return { freshInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    }
}

/** Total input that could have been served from cache (doc §16). */
export function cacheableInput(u: NormalizedUsage): number {
    return u.freshInputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/** Token cache hit rate (doc §2): cacheRead / cacheable input, NOT request
 *  hit ratio. Returns 0 when there is no cacheable input. */
export function cacheHitRate(u: NormalizedUsage): number {
    const total = cacheableInput(u);
    return total > 0 ? u.cacheReadTokens / total : 0;
}
