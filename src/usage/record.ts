/**
 * Assemble a priced UsageRecord from a normalized usage + context.
 * This is the single place the capture integration points call.
 */

import { randomUUID } from "node:crypto";
import { costOf, costWithoutCache, priceFor } from "./pricing.js";
import type { AcpUsage, NormalizedUsage, PriceEntry, Protocol, UsageRecord } from "./types.js";

export type RecordContext = {
    sessionId?: string;
    protocol: Protocol;
    provider?: string;
    model?: string;
    statusCode?: number;
    streaming?: boolean;
    latencyMs?: number;
    ttftMs?: number;
};

/**
 * Build a full ledger record. `inputTokens` (the raw number the API reported)
 * is reconstructed per protocol semantics: Codex/OpenAI include cache reads in
 * input, Anthropic reports them separately.
 */
export function makeUsageRecord(
    usage: NormalizedUsage,
    acp: AcpUsage | undefined,
    ctx: RecordContext,
    price?: PriceEntry,
): UsageRecord {
    const p = price ?? priceFor(ctx.model);
    const costs = costOf(usage, p);
    const rawInput = ctx.protocol === "anthropic"
        ? usage.freshInputTokens
        : usage.freshInputTokens + usage.cacheReadTokens;
    return {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: ctx.sessionId,
        protocol: ctx.protocol,
        provider: ctx.provider,
        model: ctx.model,
        inputTokens: rawInput,
        freshInputTokens: usage.freshInputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        ...(acp
            ? {
                  originalContextTokens: acp.originalContextTokens,
                  forwardedContextTokens: acp.forwardedContextTokens,
                  acpSavedTokens: acp.acpSavedTokens,
              }
            : {}),
        ...costs,
        estimatedWithoutCacheCost: costWithoutCache(usage, p),
        statusCode: ctx.statusCode,
        streaming: ctx.streaming,
        latencyMs: ctx.latencyMs,
        ttftMs: ctx.ttftMs,
    };
}
