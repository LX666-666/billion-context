/**
 * Aggregation over ledger records (doc §5, §6, §11, §12).
 *
 * All aggregation happens server-side; the Web UI never sees raw request logs
 * in volume. Metrics mirror CC Switch (token/cost/cache-hit-rate, grouped by
 * time / provider / model) plus billion-context-specific ACP savings.
 */

import { cacheableInput } from "./normalizer.js";
import type { PriceEntry, UsageRecord } from "./types.js";
import { ZERO_PRICE, priceFor, roundUsd } from "./pricing.js";

/** Rolled-up summary for a set of records. */
export type UsageSummary = {
    requests: number;
    /** Raw input as reported by the API (includes cache). */
    inputTokens: number;
    /** Fresh (non-cache-read) input, the billable base. */
    freshInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** freshInput + output + cacheRead + cacheCreation. */
    realTotalTokens: number;
    cacheableInput: number;
    /** Token cache hit rate 0..1 (cacheRead / cacheableInput). */
    cacheHitRate: number;
    totalCost: number;
    /** ACP compression, summed across requests. */
    originalContextTokens: number;
    forwardedContextTokens: number;
    acpSavedTokens: number;
};

export function summarize(records: UsageRecord[]): UsageSummary {
    const s: UsageSummary = {
        requests: 0,
        inputTokens: 0,
        freshInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        realTotalTokens: 0,
        cacheableInput: 0,
        cacheHitRate: 0,
        totalCost: 0,
        originalContextTokens: 0,
        forwardedContextTokens: 0,
        acpSavedTokens: 0,
    };
    let totalCacheable = 0;
    for (const r of records) {
        s.requests++;
        s.inputTokens += r.inputTokens;
        s.freshInputTokens += r.freshInputTokens;
        s.outputTokens += r.outputTokens;
        s.cacheReadTokens += r.cacheReadTokens;
        s.cacheCreationTokens += r.cacheCreationTokens;
        s.totalCost += r.totalCost ?? 0;
        s.originalContextTokens += r.originalContextTokens ?? 0;
        s.forwardedContextTokens += r.forwardedContextTokens ?? 0;
        s.acpSavedTokens += r.acpSavedTokens ?? 0;
        totalCacheable += cacheableInput({
            freshInputTokens: r.freshInputTokens,
            outputTokens: r.outputTokens,
            cacheReadTokens: r.cacheReadTokens,
            cacheCreationTokens: r.cacheCreationTokens,
        });
    }
    s.realTotalTokens = s.freshInputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens;
    s.cacheableInput = totalCacheable;
    s.cacheHitRate = totalCacheable > 0 ? s.cacheReadTokens / totalCacheable : 0;
    s.totalCost = roundUsd(s.totalCost);
    return s;
}

/* ---------------------------------------------------------------------------
 * Time trends
 * ------------------------------------------------------------------------- */

export type TrendGranularity = "hour" | "day";

export type TrendPoint = {
    /** Bucket start, ms epoch. */
    start: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    acpSavedTokens: number;
    totalCost: number;
};

function bucketStart(ts: number, granularity: TrendGranularity): number {
    const d = new Date(ts);
    if (granularity === "day") {
        d.setHours(0, 0, 0, 0);
    } else {
        d.setMinutes(0, 0, 0);
    }
    return d.getTime();
}

/** Bucket records into hour/day intervals over [fromMs, toMs]. */
export function trends(
    records: UsageRecord[],
    granularity: TrendGranularity = "hour",
    fromMs?: number,
    toMs?: number,
): TrendPoint[] {
    const map = new Map<number, TrendPoint>();
    for (const r of records) {
        const ts = Date.parse(r.timestamp);
        if (Number.isNaN(ts)) continue;
        if (fromMs !== undefined && ts < fromMs) continue;
        if (toMs !== undefined && ts > toMs) continue;
        const start = bucketStart(ts, granularity);
        let p = map.get(start);
        if (!p) {
            p = { start, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, acpSavedTokens: 0, totalCost: 0 };
            map.set(start, p);
        }
        p.requests++;
        p.inputTokens += r.inputTokens;
        p.outputTokens += r.outputTokens;
        p.cacheReadTokens += r.cacheReadTokens;
        p.cacheCreationTokens += r.cacheCreationTokens;
        p.acpSavedTokens += r.acpSavedTokens ?? 0;
        p.totalCost += r.totalCost ?? 0;
    }
    return [...map.values()].sort((a, b) => a.start - b.start);
}

/* ---------------------------------------------------------------------------
 * Grouped breakdowns
 * ------------------------------------------------------------------------- */

export type GroupedRow = {
    key: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    acpSavedTokens: number;
    totalCost: number;
    cacheHitRate: number;
};

function groupBy<T>(records: UsageRecord[], keyOf: (r: UsageRecord) => string | undefined): GroupedRow[] {
    const map = new Map<string, GroupedRow>();
    for (const r of records) {
        const key = keyOf(r) ?? "unknown";
        let row = map.get(key);
        if (!row) {
            row = { key, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, acpSavedTokens: 0, totalCost: 0, cacheHitRate: 0 };
            map.set(key, row);
        }
        row.requests++;
        row.inputTokens += r.inputTokens;
        row.outputTokens += r.outputTokens;
        row.cacheReadTokens += r.cacheReadTokens;
        row.cacheCreationTokens += r.cacheCreationTokens;
        row.acpSavedTokens += r.acpSavedTokens ?? 0;
        row.totalCost += r.totalCost ?? 0;
    }
    const rows = [...map.values()].sort((a, b) => b.totalCost - a.totalCost);
    for (const row of rows) {
        // fresh = input - cacheRead, so cacheable = fresh + cacheRead + cacheCreation
        // = input + cacheCreation.
        const total = row.inputTokens + row.cacheCreationTokens;
        row.cacheHitRate = total > 0 ? row.cacheReadTokens / total : 0;
        row.totalCost = roundUsd(row.totalCost);
    }
    return rows;
}

/** Breakdown by model. */
export function groupByModel(records: UsageRecord[]): GroupedRow[] {
    return groupBy(records, (r) => r.model);
}

/** Breakdown by provider (upstream host). */
export function groupByProvider(records: UsageRecord[]): GroupedRow[] {
    return groupBy(records, (r) => r.provider);
}

/* ---------------------------------------------------------------------------
 * Savings estimates (doc §11, §12)
 * ------------------------------------------------------------------------- */

export type SavingsBreakdown = {
    /** Cost with NO optimization: all context billed fresh at input price
     *  (original ACP context when present, else actual fresh input). */
    costNoOptimization: number;
    /** Cost WITH prompt cache but WITHOUT ACP compression. */
    costCacheOnly: number;
    /** Actual cost (cache + ACP). */
    costActual: number;
    cacheSavings: number;
    acpSavings: number;
    totalSavings: number;
    savingsRate: number; // 0..1 vs no-optimization
};

export function savingsBreakdown(
    records: UsageRecord[],
    prices: Record<string, PriceEntry> = {},
): SavingsBreakdown {
    let costNoOptimization = 0;
    let costCacheOnly = 0;
    let costActual = 0;
    let baseline = 0;
    for (const r of records) {
        const price = prices[r.model ?? ""] ?? priceFor(r.model);
        const inputPrice = price?.input ?? ZERO_PRICE.input;
        const fresh = r.freshInputTokens;
        const output = r.outputTokens;
        const cacheRead = r.cacheReadTokens;
        const cacheCreation = r.cacheCreationTokens;
        const orig = r.originalContextTokens ?? 0;

        // No optimization: everything fresh at input price (use the context the
        // upstream would have seen — original when ACP ran, else actual input).
        const noOptInput = orig > 0 ? orig : fresh + cacheRead + cacheCreation;
        costNoOptimization += (noOptInput * inputPrice + output * (price?.output ?? 0)) / 1_000_000;

        // Cache only (no ACP): actual fresh input but billed as if ACP never
        // compressed — i.e. cache applies to the un-compressed context.
        const cacheOnlyInput = orig > 0 ? orig - cacheRead - cacheCreation : fresh;
        costCacheOnly +=
            (Math.max(0, cacheOnlyInput) * inputPrice +
                cacheRead * (price?.cacheRead ?? inputPrice) +
                cacheCreation * (price?.cacheCreation ?? inputPrice) +
                output * (price?.output ?? 0)) / 1_000_000;

        costActual += r.totalCost ?? 0;
        baseline += fresh + cacheRead + cacheCreation;
    }
    costNoOptimization = roundUsd(costNoOptimization);
    costCacheOnly = roundUsd(costCacheOnly);
    costActual = roundUsd(costActual);
    const cacheSavings = roundUsd(costNoOptimization - costCacheOnly);
    const acpSavings = roundUsd(costCacheOnly - costActual);
    const totalSavings = roundUsd(costNoOptimization - costActual);
    const savingsRate = costNoOptimization > 0 ? totalSavings / costNoOptimization : 0;
    return { costNoOptimization, costCacheOnly, costActual, cacheSavings, acpSavings, totalSavings, savingsRate };
}

/** ACP compression rate 0..1 over the recorded original contexts. */
export function compressionRate(records: UsageRecord[]): number {
    let orig = 0;
    let saved = 0;
    for (const r of records) {
        orig += r.originalContextTokens ?? 0;
        saved += r.acpSavedTokens ?? 0;
    }
    return orig > 0 ? saved / orig : 0;
}
