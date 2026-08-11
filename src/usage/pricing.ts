/**
 * Model pricing and per-request cost calculation (doc §3, §4).
 *
 * Four-way pricing (USD per 1M tokens): input, output, cache read, cache
 * creation. Per-request cost:
 *
 *   inputCost       = freshInput   × input       / 1_000_000
 *   outputCost      = output       × output      / 1_000_000
 *   cacheReadCost   = cacheRead    × cacheRead   / 1_000_000
 *   cacheCreationCost = cacheCreation × cacheCreation / 1_000_000
 *   totalCost       = (sum) × costMultiplier
 *
 * Pricing sources, highest priority first:
 *   1. Local user overrides (usage-pricing.json in the data dir).
 *   2. models.dev pricing (synced from the project's existing registry),
 *      converted from per-token to per-million units.
 *   3. Defaults (zero) — an unpriced model costs nothing rather than erroring.
 *
 * Dollar figures are rounded to 6 decimals to avoid float noise in ledgers
 * (the docs ask for Decimal-like precision; 1e-6 USD is below any display).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../paths.js";
import { pricingFromRegistry } from "../registry.js";
import type { NormalizedUsage, PriceEntry } from "./types.js";

export const PER_MILLION = 1_000_000;

export const ZERO_PRICE: PriceEntry = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
};

/** Round a dollar amount to micro-dollar precision (avoids float noise). */
export function roundUsd(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

/** Cost breakdown for one normalized request under the given price. */
export function costOf(
    usage: NormalizedUsage,
    price: PriceEntry,
    multiplier = 1,
): {
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheCreationCost: number;
    totalCost: number;
} {
    const inputCost = roundUsd((usage.freshInputTokens * price.input) / PER_MILLION);
    const outputCost = roundUsd((usage.outputTokens * price.output) / PER_MILLION);
    const cacheReadCost = roundUsd((usage.cacheReadTokens * price.cacheRead) / PER_MILLION);
    const cacheCreationCost = roundUsd((usage.cacheCreationTokens * price.cacheCreation) / PER_MILLION);
    const totalCost = roundUsd((inputCost + outputCost + cacheReadCost + cacheCreationCost) * multiplier);
    return { inputCost, outputCost, cacheReadCost, cacheCreationCost, totalCost };
}

/**
 * Estimated cost if there were no cache at all (all cacheable input billed as
 * fresh input). Used for the "Cache savings" metric.
 */
export function costWithoutCache(usage: NormalizedUsage, price: PriceEntry, multiplier = 1): number {
    const allFresh = usage.freshInputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
    const inputCost = (allFresh * price.input) / PER_MILLION;
    const outputCost = (usage.outputTokens * price.output) / PER_MILLION;
    return roundUsd((inputCost + outputCost) * multiplier);
}

/* ---------------------------------------------------------------------------
 * Pricing store
 * ------------------------------------------------------------------------- */

/** models.dev prices are USD per token (models.dev models.json layout). */
export type ModelsDevPricing = {
    prompt?: number;
    completion?: number;
    request?: number;
};

/** Convert models.dev per-token prices to the per-million PriceEntry shape.
 *  `request` maps to a flat per-call fee folded into input (approx). */
export function fromModelsDevPricing(p: ModelsDevPricing = {}): PriceEntry {
    return {
        input: (p.prompt ?? 0) * PER_MILLION,
        output: (p.completion ?? 0) * PER_MILLION,
        cacheRead: (p.prompt ?? 0) * PER_MILLION,
        cacheCreation: (p.prompt ?? 0) * PER_MILLION,
    };
}

/** Map of model id → PriceEntry overrides. */
export type PricingMap = Record<string, PriceEntry>;

/** Price overrides file (user-editable JSON in the data dir). */
export function pricingFile(): string {
    const env = process.env.BILI_USAGE_PRICING_FILE;
    if (env && env.length > 0) return path.resolve(env);
    return path.join(dataDir(), "usage-pricing.json");
}

let cachedPricing: PricingMap | undefined;
let pricingSource: "overrides" | "modelsdev" | "default" = "default";

/** Resolve the price for a model. If the model is absent from every source, a
 *  zero price is returned (unpriced models cost nothing). */
export function priceFor(model: string | undefined): PriceEntry {
    if (!model) return { ...ZERO_PRICE };
    const map = cachedPricing ?? {};
    return map[model] ? { ...map[model] } : { ...ZERO_PRICE };
}

/** Per-model cache of prices resolved from models.dev (avoid repeated registry
 *  walks in the request hot path). */
const registryPriceCache = new Map<string, PriceEntry>();

/**
 * Async price resolution for the capture path: local overrides first, then a
 * cached models.dev lookup, then zero. Result is cached per model so only the
 * first request for a model touches the registry (which is itself cached and
 * pre-loaded at server startup).
 */
export async function resolvePrice(model?: string, host?: string): Promise<PriceEntry> {
    if (!model) return { ...ZERO_PRICE };
    const local = (cachedPricing ?? {})[model];
    if (local) return { ...local };
    const cached = registryPriceCache.get(model);
    if (cached) return { ...cached };
    let entry: PriceEntry;
    try {
        const md = await pricingFromRegistry(model, host);
        entry = md ? fromModelsDevPricing(md) : { ...ZERO_PRICE };
    } catch {
        entry = { ...ZERO_PRICE };
    }
    registryPriceCache.set(model, entry);
    return entry;
}

/** Load pricing overrides from disk (called at startup and after writes). */
export async function loadPricing(): Promise<PricingMap> {
    try {
        const raw = await readFile(pricingFile(), "utf-8");
        const parsed = JSON.parse(raw) as PricingMap;
        cachedPricing = parsed;
        pricingSource = "overrides";
        return parsed;
    } catch {
        cachedPricing = {};
        pricingSource = "default";
        return {};
    }
}

/** Persist a single model's price override. Returns the new map. */
export async function setPricing(model: string, price: PriceEntry): Promise<PricingMap> {
    const map = { ...(cachedPricing ?? {}), [model]: price };
    const file = pricingFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(map, null, 2) + "\n", "utf-8");
    cachedPricing = map;
    pricingSource = "overrides";
    return map;
}

/** Reset pricing state (test hook). */
export function _resetPricingForTest(): void {
    cachedPricing = undefined;
    pricingSource = "default";
    registryPriceCache.clear();
}
