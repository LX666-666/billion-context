import { estimateTokensFast } from "acp-kernel";
import { protectsCodeContent } from "../operation-classifier.js";
import type { OperationRecord, WorkflowOptions } from "../types.js";
import { cleanDeterministic } from "./deterministic.js";
import { guardedOperationOutput } from "../repo-bridge.js";
import { diagnosticLines, duration, environmentLines, exitCode, outputFailed } from "./diagnostics.js";
import { summarizeMachineJson } from "./json.js";
import { summarizeRun } from "./run.js";

export type PrunedToolOutput = {
    text: string;
    rawTokens: number;
    visibleTokens: number;
    semanticPruned: boolean;
    noiseRemoved: boolean;
};

export function attachRawReference(result: PrunedToolOutput, rawRef: string): PrunedToolOutput {
    if (!result.semanticPruned || result.text.includes(`raw_ref: ${rawRef}`)) return result;
    const text = `${result.text}\nraw_ref: ${rawRef}`;
    return { ...result, text, visibleTokens: estimateTokensFast(text) };
}

function referenceLine(rawRef: string | undefined): string {
    return rawRef ? `\nraw_ref: ${rawRef}` : "";
}

function testSummary(text: string, operation: OperationRecord, rawRef: string | undefined): string {
    const code = exitCode(text);
    const failed = /(?:^|\n)\s*(?:fail|failed|failures?)\s*[:=]?\s*(\d+)/im.exec(text)?.[1]?.trim()
        ?? /(\d+)\s+failed\b/i.exec(text)?.[1]?.trim();
    const passed = /(?:^|\n)\s*(?:passed|pass)\s*[:=]?\s*(\d+)/im.exec(text)?.[1]?.trim()
        ?? /(\d+)\s+passed\b/i.exec(text)?.[1]?.trim();
    const skipped = /(?:^|\n)\s*skipped\s*[:=]?\s*(\d+)/im.exec(text)?.[1]?.trim()
        ?? /(\d+)\s+skipped\b/i.exec(text)?.[1]?.trim();
    const elapsed = duration(text);
    const isFailure = outputFailed(text, code) || (failed !== undefined && failed !== "0") || /\b(test|tests?)\s+failed\b/i.test(text);
    const lines = [
        isFailure ? "[TEST FAILED]" : "[TEST PASS]",
        `op_id: ${operation.opId}`,
        operation.command ? `command: ${operation.command}` : undefined,
        code !== undefined ? `exit_code: ${code}` : undefined,
        elapsed ? `duration: ${elapsed}` : undefined,
        passed !== undefined ? `passed: ${passed}` : undefined,
        failed !== undefined ? `failed: ${failed}` : undefined,
        skipped !== undefined ? `skipped: ${skipped}` : undefined,
    ].filter((value): value is string => Boolean(value));
    if (isFailure) {
        const relevant = diagnosticLines(text);
        if (relevant.length > 0) lines.push("", "exact_errors:", ...relevant);
    }
    const environment = environmentLines(text);
    if (environment.length > 0) lines.push("", "environment:", ...environment);
    return `${lines.join("\n")}${referenceLine(rawRef)}`;
}

function buildSummary(text: string, operation: OperationRecord, rawRef: string | undefined): string {
    const code = exitCode(text);
    const elapsed = duration(text);
    const warnings = /(?:warnings?|warn)\s*[:=]\s*(\d+)/i.exec(text)?.[1]?.trim();
    const errors = /(?:errors?)\s*[:=]\s*(\d+)/i.exec(text)?.[1]?.trim();
    const isFailure = outputFailed(text, code) || (errors !== undefined && errors !== "0") || /\b(build|compile|typecheck)\s+failed\b/i.test(text);
    const lines = [
        isFailure ? "[BUILD FAILED]" : "[BUILD PASS]",
        `op_id: ${operation.opId}`,
        operation.command ? `command: ${operation.command}` : undefined,
        code !== undefined ? `exit_code: ${code}` : undefined,
        elapsed ? `duration: ${elapsed}` : undefined,
        errors !== undefined ? `errors: ${errors}` : undefined,
        warnings !== undefined ? `warnings: ${warnings}` : undefined,
    ].filter((value): value is string => Boolean(value));
    if (isFailure) {
        const relevant = diagnosticLines(text);
        if (relevant.length > 0) lines.push("", "exact_errors:", ...relevant);
    }
    const environment = environmentLines(text);
    if (environment.length > 0) lines.push("", "environment:", ...environment);
    return `${lines.join("\n")}${referenceLine(rawRef)}`;
}

function boundedLines(text: string, operation: OperationRecord, rawRef: string | undefined): string {
    const lines = text.split(/\r?\n/);
    const head = lines.slice(0, 100);
    const tail = lines.length > 130 ? lines.slice(-30) : [];
    const omitted = Math.max(0, lines.length - head.length - tail.length);
    const label = operation.type === "SEARCH" ? "SEARCH" : operation.type === "LIST" ? "LIST" : operation.type;
    return [
        `[${label} OUTPUT PRUNED]`,
        `op_id: ${operation.opId}`,
        operation.command ? `command: ${operation.command}` : undefined,
        `total_lines: ${lines.length}`,
        omitted > 0 ? `omitted_lines: ${omitted}` : undefined,
        "",
        ...head,
        ...(tail.length > 0 ? ["", `[... ${omitted} lines omitted ...]`, "", ...tail] : []),
        ...(rawRef ? ["", `raw_ref: ${rawRef}`] : []),
    ].filter((value): value is string => value !== undefined).join("\n");
}

export function pruneToolOutput(
    operation: OperationRecord,
    raw: string,
    options: WorkflowOptions,
    rawRef?: string,
): PrunedToolOutput {
    const rawTokens = estimateTokensFast(raw);
    const guarded = guardedOperationOutput(operation);
    if (guarded) {
        return {
            text: guarded,
            rawTokens,
            visibleTokens: estimateTokensFast(guarded),
            semanticPruned: true,
            noiseRemoved: false,
        };
    }
    if (protectsCodeContent(operation.type) || !options.deterministicPruner) {
        return { text: raw, rawTokens, visibleTokens: rawTokens, semanticPruned: false, noiseRemoved: false };
    }
    const cleaned = cleanDeterministic(raw);
    const cleanedTokens = estimateTokensFast(cleaned.text);
    if (cleanedTokens < options.prunerMinTokens) {
        return {
            text: cleaned.text,
            rawTokens,
            visibleTokens: cleanedTokens,
            semanticPruned: false,
            noiseRemoved: cleaned.changed,
        };
    }
    let text: string | undefined;
    if (operation.type === "RUN" || operation.type === "OTHER" || operation.type === "SEARCH" || operation.type === "LIST") {
        text = summarizeMachineJson(cleaned.text, operation, rawRef);
    }
    if (!text) {
        if (operation.type === "TEST") text = testSummary(cleaned.text, operation, rawRef);
        else if (operation.type === "BUILD") text = buildSummary(cleaned.text, operation, rawRef);
        else if (operation.type === "RUN") text = summarizeRun(cleaned.text, operation, rawRef);
        else if (operation.type === "SEARCH" || operation.type === "LIST" || operation.type === "INSTALL") {
            text = boundedLines(cleaned.text, operation, rawRef);
        }
    }
    if (!text) {
        return {
            text: cleaned.text,
            rawTokens,
            visibleTokens: cleanedTokens,
            semanticPruned: false,
            noiseRemoved: cleaned.changed,
        };
    }
    return {
        text,
        rawTokens,
        visibleTokens: estimateTokensFast(text),
        semanticPruned: true,
        noiseRemoved: cleaned.changed,
    };
}
