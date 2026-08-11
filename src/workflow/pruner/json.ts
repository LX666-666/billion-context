import type { OperationRecord } from "../types.js";

type ParsedMachineOutput = {
    kind: "JSON" | "JSONL";
    value: unknown;
    recordCount?: number;
};

const IMPORTANT_KEY = /(?:^|_)(?:error|errors|message|code|status|fail(?:ed|ure)?|warning|path|file|line|column|expected|actual|reason|cause|name|version|platform|arch|os|cwd|command|duration|count|passed|skipped|id)(?:$|_)/i;
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|private[_-]?key)/i;

function parseMachineOutput(text: string): ParsedMachineOutput | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    try {
        const value = JSON.parse(trimmed) as unknown;
        if (value && typeof value === "object") return { kind: "JSON", value };
    } catch {
    }
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 3) return undefined;
    const values: unknown[] = [];
    for (const line of lines) {
        try {
            values.push(JSON.parse(line) as unknown);
        } catch {
            return undefined;
        }
    }
    return { kind: "JSONL", value: values, recordCount: values.length };
}

function scalar(value: string | number | boolean | null, sensitive: boolean): string {
    if (sensitive) return '"[REDACTED]"';
    if (typeof value !== "string") return JSON.stringify(value);
    const bounded = value.length > 800 ? `${value.slice(0, 800)}…` : value;
    return JSON.stringify(bounded);
}

function collectFacts(value: unknown, path: string, key: string, output: string[], depth = 0): void {
    if (output.length >= 80 || depth > 10) return;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        if (IMPORTANT_KEY.test(key)) output.push(`${path}: ${scalar(value, SENSITIVE_KEY.test(key))}`);
        return;
    }
    if (Array.isArray(value)) {
        const importantArray = /(?:error|fail|warning|diagnostic|issue)/i.test(key);
        const headCount = importantArray ? 38 : 12;
        const sample = value.length <= headCount + 2 ? value.map((item, index) => [item, index] as const) : [
            ...value.slice(0, headCount).map((item, index) => [item, index] as const),
            ...value.slice(-2).map((item, index) => [item, value.length - 2 + index] as const),
        ];
        for (const [item, index] of sample) collectFacts(item, `${path}[${index}]`, key, output, depth + 1);
        return;
    }
    if (typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${childKey}` : childKey;
        collectFacts(child, childPath, childKey, output, depth + 1);
        if (output.length >= 80) return;
    }
}

function shape(value: unknown): string[] {
    if (Array.isArray(value)) return [`top_level_type: array`, `item_count: ${value.length}`];
    if (!value || typeof value !== "object") return [`top_level_type: ${typeof value}`];
    const keys = Object.keys(value);
    return [
        "top_level_type: object",
        `top_level_keys: ${keys.slice(0, 40).join(", ")}`,
        ...(keys.length > 40 ? [`omitted_top_level_keys: ${keys.length - 40}`] : []),
    ];
}

export function summarizeMachineJson(text: string, operation: OperationRecord, rawRef: string | undefined): string | undefined {
    const parsed = parseMachineOutput(text);
    if (!parsed) return undefined;
    const facts: string[] = [];
    collectFacts(parsed.value, "$", "", facts);
    return [
        `[${parsed.kind} OUTPUT PRUNED]`,
        `op_id: ${operation.opId}`,
        operation.command ? `command: ${operation.command}` : undefined,
        operation.workdir ? `workdir: ${operation.workdir}` : undefined,
        ...(parsed.recordCount !== undefined ? [`record_count: ${parsed.recordCount}`] : []),
        ...shape(parsed.value),
        ...(facts.length > 0 ? ["", "selected_fields:", ...facts] : []),
        ...(rawRef ? ["", `raw_ref: ${rawRef}`] : []),
    ].filter((value): value is string => value !== undefined).join("\n");
}
