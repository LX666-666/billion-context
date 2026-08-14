import type { PlanStepStatus } from "./types.js";

type RestrictedObject = Record<string, unknown>;

export type CodexUpdatePlanCall = {
    callId: string;
    argumentsText: string;
    index: number;
};

export type CodexNestedCall = {
    callId: string;
    name: string;
    argumentsText: string;
    index: number;
};

function isPlanStatus(value: unknown): value is PlanStepStatus {
    return value === "pending" || value === "in_progress" || value === "completed";
}

function isIdentifierStart(value: string | undefined): boolean {
    return Boolean(value && /[A-Za-z_$]/.test(value));
}

function isIdentifierPart(value: string | undefined): boolean {
    return Boolean(value && /[A-Za-z0-9_$]/.test(value));
}

class RestrictedValueParser {
    private index = 0;

    constructor(private readonly source: string) {}

    parse(): unknown {
        const value = this.value();
        this.space();
        if (this.index !== this.source.length) throw new Error("trailing input");
        return value;
    }

    private current(): string | undefined {
        return this.source[this.index];
    }

    private space(): void {
        while (this.index < this.source.length && /\s/.test(this.source[this.index] ?? "")) this.index++;
    }

    private value(): unknown {
        this.space();
        const current = this.current();
        if (current === "{") return this.object();
        if (current === "[") return this.array();
        if (current === "\"" || current === "'") return this.string(current);
        if (current && /[-0-9]/.test(current)) return this.number();
        return this.keyword();
    }

    private object(): RestrictedObject {
        this.index++;
        const result: RestrictedObject = {};
        this.space();
        if (this.current() === "}") {
            this.index++;
            return result;
        }
        while (this.index < this.source.length) {
            this.space();
            const key = this.current() === "\"" || this.current() === "'"
                ? this.string(this.current() as "\"" | "'")
                : this.identifier();
            if (typeof key !== "string") throw new Error("object key is not a string");
            this.space();
            if (this.current() !== ":") throw new Error("object key must be followed by a colon");
            this.index++;
            result[key] = this.value();
            this.space();
            if (this.current() === "}") {
                this.index++;
                return result;
            }
            if (this.current() !== ",") throw new Error("object entries must be comma separated");
            this.index++;
        }
        throw new Error("unterminated object");
    }

    private array(): unknown[] {
        this.index++;
        const result: unknown[] = [];
        this.space();
        if (this.current() === "]") {
            this.index++;
            return result;
        }
        while (this.index < this.source.length) {
            result.push(this.value());
            this.space();
            if (this.current() === "]") {
                this.index++;
                return result;
            }
            if (this.current() !== ",") throw new Error("array entries must be comma separated");
            this.index++;
            this.space();
        }
        throw new Error("unterminated array");
    }

    private identifier(): string {
        if (!isIdentifierStart(this.current())) throw new Error("invalid identifier");
        const start = this.index++;
        while (isIdentifierPart(this.current())) this.index++;
        return this.source.slice(start, this.index);
    }

    private keyword(): unknown {
        const word = this.identifier();
        if (word === "true") return true;
        if (word === "false") return false;
        if (word === "null") return null;
        throw new Error(`unsupported literal ${word}`);
    }

    private number(): number {
        const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.index));
        if (!match) throw new Error("invalid number");
        this.index += match[0].length;
        const value = Number(match[0]);
        if (!Number.isFinite(value)) throw new Error("non-finite number");
        return value;
    }

    private string(quote: "\"" | "'"): string {
        if (this.current() !== quote) throw new Error("invalid string");
        this.index++;
        let result = "";
        while (this.index < this.source.length) {
            const current = this.source[this.index++];
            if (current === quote) return result;
            if (current !== "\\") {
                result += current;
                continue;
            }
            const escaped = this.source[this.index++];
            if (escaped === undefined) throw new Error("unterminated escape");
            const escapes: Record<string, string> = {
                "0": "\0",
                b: "\b",
                f: "\f",
                n: "\n",
                r: "\r",
                t: "\t",
                v: "\v",
                "\\": "\\",
                "\"": "\"",
                "'": "'",
            };
            if (escaped === "u") {
                const hex = this.source.slice(this.index, this.index + 4);
                if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error("invalid unicode escape");
                result += String.fromCharCode(Number.parseInt(hex, 16));
                this.index += 4;
                continue;
            }
            if (escaped === "x") {
                const hex = this.source.slice(this.index, this.index + 2);
                if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error("invalid hex escape");
                result += String.fromCharCode(Number.parseInt(hex, 16));
                this.index += 2;
                continue;
            }
            result += escapes[escaped] ?? escaped;
        }
        throw new Error("unterminated string");
    }
}

function balancedCallArguments(source: string, openIndex: number): string | undefined {
    let depth = 0;
    let quote: "\"" | "'" | "`" | undefined;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = openIndex; index < source.length; index++) {
        const current = source[index];
        const next = source[index + 1];
        if (lineComment) {
            if (current === "\n" || current === "\r") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (current === "*" && next === "/") {
                blockComment = false;
                index++;
            }
            continue;
        }
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (current === "\\") {
                escaped = true;
            } else if (current === quote) {
                quote = undefined;
            }
            continue;
        }
        if (current === "/" && next === "/") {
            lineComment = true;
            index++;
            continue;
        }
        if (current === "/" && next === "*") {
            blockComment = true;
            index++;
            continue;
        }
        if (current === "\"" || current === "'" || current === "`") {
            quote = current;
            continue;
        }
        if (current === "(") {
            depth++;
            continue;
        }
        if (current !== ")") continue;
        depth--;
        if (depth === 0) return source.slice(openIndex + 1, index);
    }
    return undefined;
}

function planArguments(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as RestrictedObject;
    if (!Array.isArray(record.plan)) return undefined;
    const plan = record.plan.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const step = (item as RestrictedObject).step;
        const status = (item as RestrictedObject).status;
        if (typeof step !== "string" || !step.trim() || !isPlanStatus(status)) return [];
        return [{ step: step.trim(), status }];
    });
    if (plan.length !== record.plan.length) return undefined;
    return JSON.stringify({
        ...(typeof record.explanation === "string" ? { explanation: record.explanation } : {}),
        plan,
    });
}

function invocationAt(source: string, index: number): { name: string; openIndex: number; endIndex: number } | undefined {
    const match = /^tools\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(source.slice(index));
    if (!match) return undefined;
    const openIndex = index + match[0].length - 1;
    const argumentsText = balancedCallArguments(source, openIndex);
    if (argumentsText === undefined) return undefined;
    return { name: match[1] ?? "", openIndex, endIndex: openIndex + argumentsText.length + 2 };
}

function scanCodexNestedCalls(outerCallId: string, source: string): CodexNestedCall[] {
    const calls: CodexNestedCall[] = [];
    let quote: "\"" | "'" | "`" | undefined;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = 0; index < source.length; index++) {
        const current = source[index];
        const next = source[index + 1];
        if (lineComment) {
            if (current === "\n" || current === "\r") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (current === "*" && next === "/") {
                blockComment = false;
                index++;
            }
            continue;
        }
        if (quote) {
            if (escaped) escaped = false;
            else if (current === "\\") escaped = true;
            else if (current === quote) quote = undefined;
            continue;
        }
        if (current === "/" && next === "/") {
            lineComment = true;
            index++;
            continue;
        }
        if (current === "/" && next === "*") {
            blockComment = true;
            index++;
            continue;
        }
        if (current === "\"" || current === "'" || current === "`") {
            quote = current;
            continue;
        }
        if (current !== "t") continue;
        const invocation = invocationAt(source, index);
        if (!invocation) continue;
        const argumentsText = balancedCallArguments(source, invocation.openIndex);
        if (argumentsText === undefined) continue;
        let normalized = argumentsText.trim();
        try {
            const parsed = new RestrictedValueParser(argumentsText).parse();
            normalized = JSON.stringify(parsed);
        } catch {
        }
        const occurrence = calls.filter((call) => call.name === invocation.name).length;
        calls.push({
            callId: `${outerCallId}:${invocation.name}:${occurrence}`,
            name: invocation.name,
            argumentsText: normalized,
            index: calls.length,
        });
        index = invocation.endIndex - 1;
    }
    return calls;
}

export function extractCodexNestedCalls(outerCallId: string, source: string): CodexNestedCall[] {
    return scanCodexNestedCalls(outerCallId, source);
}

export function extractCodexUpdatePlanCalls(outerCallId: string, source: string): CodexUpdatePlanCall[] {
    return scanCodexNestedCalls(outerCallId, source)
        .filter((call) => call.name === "update_plan")
        .flatMap((call, index) => {
            try {
                const parsed = new RestrictedValueParser(call.argumentsText).parse();
                const normalized = planArguments(parsed);
                return normalized
                    ? [{ callId: `${outerCallId}:update_plan:${index}`, argumentsText: normalized, index }]
                    : [];
            } catch {
                return [];
            }
        });
}

export function containsCodexUpdatePlan(source: string): boolean {
    return extractCodexUpdatePlanCalls("probe", source).length > 0;
}
