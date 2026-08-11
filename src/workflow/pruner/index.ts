import { estimateTokensFast } from "acp-kernel";
import { protectsCodeContent } from "../operation-classifier.js";
import type { OperationRecord, WorkflowOptions } from "../types.js";
import { cleanDeterministic } from "./deterministic.js";

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

function field(text: string, pattern: RegExp): string | undefined {
    return pattern.exec(text)?.[1]?.trim();
}

function relevantFailureLines(text: string): string[] {
    const lines = text.split(/\r?\n/);
    const matches = lines.filter((line) =>
        /\b(error|failed|failure|assert|expected|actual|exception|panic|fatal|segmentation|exit code)\b|\bat\s+.+:\d+(?::\d+)?|[A-Za-z0-9_./\\-]+:\d+(?::\d+)?/i.test(line),
    );
    return matches.slice(0, 140);
}

function referenceLine(rawRef: string | undefined): string {
    return rawRef ? `\nraw_ref: ${rawRef}` : "";
}

function testSummary(text: string, operation: OperationRecord, rawRef: string | undefined): string {
    const exitCode = field(text, /(?:exit code|exit_code)\s*[:=]\s*(-?\d+)/i);
    const failed = field(text, /(?:^|\n)\s*(?:fail|failed|failures?)\s*[:=]?\s*(\d+)/im)
        ?? field(text, /(\d+)\s+failed\b/i);
    const passed = field(text, /(?:^|\n)\s*(?:passed|pass)\s*[:=]?\s*(\d+)/im)
        ?? field(text, /(\d+)\s+passed\b/i);
    const skipped = field(text, /(?:^|\n)\s*skipped\s*[:=]?\s*(\d+)/im)
        ?? field(text, /(\d+)\s+skipped\b/i);
    const duration = field(text, /(?:duration|wall time)\s*[:=]\s*([^\r\n]+)/i);
    const isFailure = (exitCode !== undefined && exitCode !== "0") || (failed !== undefined && failed !== "0") || /\b(test|tests?)\s+failed\b/i.test(text);
    const lines = [
        isFailure ? "[TEST FAILED]" : "[TEST PASS]",
        `op_id: ${operation.opId}`,
        operation.command ? `command: ${operation.command}` : undefined,
        exitCode !== undefined ? `exit_code: ${exitCode}` : undefined,
        duration ? `duration: ${duration}` : undefined,
        passed !== undefined ? `passed: ${passed}` : undefined,
        failed !== undefined ? `failed: ${failed}` : undefined,
        skipped !== undefined ? `skipped: ${skipped}` : undefined,
    ].filter((value): value is string => Boolean(value));
    if (isFailure) {
        const relevant = relevantFailureLines(text);
        if (relevant.length > 0) lines.push("", "exact_errors:", ...relevant);
    }
    return `${lines.join("\n")}${referenceLine(rawRef)}`;
}

function buildSummary(text: string, operation: OperationRecord, rawRef: string | undefined): string {
    const exitCode = field(text, /(?:exit code|exit_code)\s*[:=]\s*(-?\d+)/i);
    const duration = field(text, /(?:duration|wall time)\s*[:=]\s*([^\r\n]+)/i);
    const warnings = field(text, /(?:warnings?|warn)\s*[:=]\s*(\d+)/i);
    const errors = field(text, /(?:errors?)\s*[:=]\s*(\d+)/i);
    const isFailure = (exitCode !== undefined && exitCode !== "0") || /\b(build|compile|typecheck)\s+failed\b/i.test(text);
    const lines = [
        isFailure ? "[BUILD FAILED]" : "[BUILD PASS]",
        `op_id: ${operation.opId}`,
        operation.command ? `command: ${operation.command}` : undefined,
        exitCode !== undefined ? `exit_code: ${exitCode}` : undefined,
        duration ? `duration: ${duration}` : undefined,
        errors !== undefined ? `errors: ${errors}` : undefined,
        warnings !== undefined ? `warnings: ${warnings}` : undefined,
    ].filter((value): value is string => Boolean(value));
    if (isFailure) {
        const relevant = relevantFailureLines(text);
        if (relevant.length > 0) lines.push("", "exact_errors:", ...relevant);
    }
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
    if (operation.type === "TEST") text = testSummary(cleaned.text, operation, rawRef);
    else if (operation.type === "BUILD") text = buildSummary(cleaned.text, operation, rawRef);
    else if (operation.type === "SEARCH" || operation.type === "LIST" || operation.type === "INSTALL") {
        text = boundedLines(cleaned.text, operation, rawRef);
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
