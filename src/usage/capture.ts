/**
 * Capture hook used by the proxy forward path. Builds a priced UsageRecord from
 * the raw API usage object and appends it to the request ledger.
 *
 * The compress loops / non-streaming branch call this once per upstream
 * response that carries usage. Records with zero tokens are skipped (a stream
 * round with an empty `usage` object is not a billable event).
 */

import { normalizeUsage } from "./normalizer.js";
import { appendUsage } from "./store.js";
import { makeUsageRecord } from "./record.js";
import { resolvePrice } from "./pricing.js";
import type { AcpUsage, Protocol, UsageRecord } from "./types.js";

/** Minimal per-request context threaded into the capture point. */
export type UsageCaptureCtx = {
    model?: string;
    /** Upstream host / provider id (e.g. "chatgpt.com"). */
    provider?: string;
};

export type CaptureOptions = {
    protocol: Protocol;
    usage: unknown;
    sessionId: string;
    ctx: UsageCaptureCtx;
    /** ACP compression outcome for this request (best-effort estimate). */
    acp?: AcpUsage;
    statusCode?: number;
    streaming?: boolean;
    latencyMs?: number;
    ttftMs?: number;
};

/** Append one ledger record if the response reported any tokens. */
export async function captureUsage(opts: CaptureOptions): Promise<UsageRecord | undefined> {
    const normalized = normalizeUsage(opts.protocol, opts.usage);
    const total = normalized.freshInputTokens + normalized.outputTokens
        + normalized.cacheReadTokens + normalized.cacheCreationTokens;
    if (total <= 0) return undefined;
    const price = await resolvePrice(opts.ctx.model, opts.ctx.provider);
    const rec = makeUsageRecord(normalized, opts.acp, {
        sessionId: opts.sessionId,
        protocol: opts.protocol,
        provider: opts.ctx.provider,
        model: opts.ctx.model,
        statusCode: opts.statusCode,
        streaming: opts.streaming,
        latencyMs: opts.latencyMs,
        ttftMs: opts.ttftMs,
    }, price);
    await appendUsage(rec);
    return rec;
}
