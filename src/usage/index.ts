/**
 * Usage accounting — request ledger, cache normalization, pricing, and stats.
 * See the design doc "Sub2API 风格 「用量统计」Web UI".
 */

export * from "./types.js";
export { normalizeCodexUsage, normalizeOpenaiUsage, normalizeAnthropicUsage, normalizeUsage, cacheableInput, cacheHitRate } from "./normalizer.js";
export * from "./pricing.js";
export { makeUsageRecord, type RecordContext } from "./record.js";
export { appendUsage, loadUsage, queryUsage, usageFile, type UsageQuery } from "./store.js";
export {
    summarize,
    trends,
    groupByModel,
    groupByProvider,
    savingsBreakdown,
    compressionRate,
    type UsageSummary,
    type TrendPoint,
    type GroupedRow,
    type SavingsBreakdown,
    type TrendGranularity,
} from "./stats.js";
