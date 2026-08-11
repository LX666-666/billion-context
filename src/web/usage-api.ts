/**
 * Usage-stats API handlers (doc §17). All aggregation happens server-side; the
 * Web UI never receives raw request logs in volume.
 *
 *   GET  /__bili/usage/summary        — rolled-up totals for the filter
 *   GET  /__bili/usage/trends         — time-series buckets (hour/day)
 *   GET  /__bili/usage/models         — per-model breakdown
 *   GET  /__bili/usage/providers      — per-provider breakdown
 *   GET  /__bili/usage/requests       — request log (paginated)
 *   GET  /__bili/usage/requests/:id   — single request detail
 *   GET  /__bili/usage/pricing        — local price overrides
 *   PUT  /__bili/usage/pricing/:model — set a price override
 *   POST /__bili/usage/pricing/sync   — pull models.dev prices into overrides
 *
 * Query: from=&to=&protocol=&provider=&model= (all optional), plus
 * granularity=hour|day for trends and limit=/offset= for the request log.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { queryUsage, type UsageQuery } from "../usage/store.js";
import { summarize, trends, groupByModel, groupByProvider, savingsBreakdown, compressionRate } from "../usage/stats.js";
import { loadPricing, setPricing, priceFor, fromModelsDevPricing, pricingFile } from "../usage/pricing.js";
import { pricingFromRegistry } from "../registry.js";
import type { PriceEntry } from "../usage/types.js";

function queryParams(url: string): URLSearchParams {
    const qIndex = url.indexOf("?");
    return new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : "");
}

/** Accept ISO strings or numeric ms epochs. */
function parseMs(value: string | null): number | undefined {
    if (!value) return undefined;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(value);
    return Number.isNaN(d) ? undefined : d;
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
}

function parseQuery(req: IncomingMessage): { query: UsageQuery; granularity: "hour" | "day"; limit: number; offset: number } {
    const p = queryParams(req.url ?? "");
    const protocol = p.get("protocol") as UsageQuery["protocol"] | null;
    return {
        query: {
            from: parseMs(p.get("from")),
            to: parseMs(p.get("to")),
            protocol: protocol && ["codex", "openai", "anthropic"].includes(protocol) ? protocol : undefined,
            provider: p.get("provider") ?? undefined,
            model: p.get("model") ?? undefined,
        },
        granularity: p.get("granularity") === "day" ? "day" : "hour",
        limit: Math.min(Number(p.get("limit")) || 100, 500),
        offset: Number(p.get("offset")) || 0,
    };
}

/** GET /__bili/usage/summary */
export async function handleUsageSummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { query } = parseQuery(req);
    const records = await queryUsage(query);
    sendJson(res, {
        summary: summarize(records),
        savings: savingsBreakdown(records),
        compressionRate: compressionRate(records),
        filters: query,
    });
}

/** GET /__bili/usage/trends */
export async function handleUsageTrends(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { query, granularity } = parseQuery(req);
    const records = await queryUsage(query);
    sendJson(res, { points: trends(records, granularity, query.from, query.to), granularity });
}

/** GET /__bili/usage/models */
export async function handleUsageModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { query } = parseQuery(req);
    const records = await queryUsage(query);
    sendJson(res, { models: groupByModel(records) });
}

/** GET /__bili/usage/providers */
export async function handleUsageProviders(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { query } = parseQuery(req);
    const records = await queryUsage(query);
    sendJson(res, { providers: groupByProvider(records) });
}

/** GET /__bili/usage/requests */
export async function handleUsageRequests(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { query, limit, offset } = parseQuery(req);
    const records = await queryUsage(query);
    // Newest first.
    const sorted = [...records].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    sendJson(res, {
        total: sorted.length,
        limit,
        offset,
        requests: sorted.slice(offset, offset + limit),
    });
}

/** GET /__bili/usage/requests/:id */
export async function handleUsageRequestById(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const records = await queryUsage({});
    const rec = records.find((r) => r.id === id);
    if (!rec) {
        sendJson(res, { error: `no usage record ${id}` }, 404);
        return;
    }
    sendJson(res, { request: rec });
}

/** GET /__bili/usage/pricing — local overrides plus what models.dev would say. */
export async function handleUsagePricingGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const overrides = await loadPricing();
    const { model } = parseQuery(req).query;
    if (model) {
        const remote = await pricingFromRegistry(model);
        sendJson(res, {
            model,
            override: overrides[model] ?? null,
            modelsDev: remote ? fromModelsDevPricing(remote) : null,
            effective: priceFor(model),
        });
        return;
    }
    sendJson(res, { overrides, source: "overrides" });
}

/** PUT /__bili/usage/pricing/:model */
export async function handleUsagePricingPut(req: IncomingMessage, res: ServerResponse, model: string): Promise<void> {
    const body = await readJsonBody(req);
    const price = body as Partial<PriceEntry> | null;
    if (!price || typeof price !== "object") {
        sendJson(res, { error: "body must be a pricing object" }, 400);
        return;
    }
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const entry: PriceEntry = {
        input: num(price.input),
        output: num(price.output),
        cacheRead: num(price.cacheRead),
        cacheCreation: num(price.cacheCreation),
    };
    const map = await setPricing(model, entry);
    sendJson(res, { model, entry, overrides: map });
}

/** POST /__bili/usage/pricing/sync — pull models.dev prices into the local
 *  override store for every model present in the ledger. */
export async function handleUsagePricingSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const records = await queryUsage({});
    const models = [...new Set(records.map((r) => r.model).filter((m): m is string => !!m))];
    let synced = 0;
    let skipped = 0;
    const overrides = await loadPricing();
    for (const model of models) {
        const remote = await pricingFromRegistry(model);
        if (!remote) {
            skipped++;
            continue;
        }
        overrides[model] = fromModelsDevPricing(remote);
        synced++;
    }
    // Persist the merged map (override store write is per-model; write whole map).
    await persistPricingMap(overrides);
    sendJson(res, { synced, skipped, models: Object.keys(overrides).length });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024) {
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

async function persistPricingMap(map: Record<string, PriceEntry>): Promise<void> {
    const file = pricingFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(map, null, 2) + "\n", "utf-8");
}
