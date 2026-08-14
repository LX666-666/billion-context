import type { BiliMessage } from "../bili-message.js";
import { classifyOperation } from "./operation-classifier.js";
import { observeOperationForSupervisor } from "./execution-supervisor.js";
import { capturePhaseMessage, ensureActivePhase, recomputeWorkflowMetrics } from "./state.js";
import { beforeFallbackOperation } from "./phase-boundary.js";
import { observeRepositoryOperation } from "./repo-bridge.js";
import { validationOutcome } from "./pruner/diagnostics.js";
import type { CodexNestedOperation, OperationRecord, WorkflowOptions, WorkflowState } from "./types.js";

export function trackOperationCall(
    state: WorkflowState,
    callId: string,
    toolName: string,
    argumentsText: string,
): OperationRecord {
    const existingId = state.operationByCallId[callId];
    if (existingId && state.operations[existingId]) return state.operations[existingId];
    const classification = classifyOperation(toolName, argumentsText);
    const initialPhase = ensureActivePhase(state);
    const opId = `op${String(state.nextOperationNumber++).padStart(5, "0")}`;
    const now = Date.now();
    const operation: OperationRecord = {
        opId,
        phaseId: initialPhase.phaseId,
        type: classification.type,
        callRefs: [],
        resultRefs: [],
        toolCallId: callId,
        toolName,
        ...(classification.path ? { path: classification.path } : {}),
        ...(classification.command ? { command: classification.command } : {}),
        ...(classification.workdir ? { workdir: classification.workdir } : {}),
        paths: classification.paths,
        addedPaths: classification.addedPaths,
        ...(classification.codexNested ? { codexNested: classification.codexNested } : {}),
        rawTokens: 0,
        visibleTokens: 0,
        lifecycle: "ACTIVE",
        importance: "NORMAL",
        createdAt: now,
        updatedAt: now,
    };
    const fallbackDecision = beforeFallbackOperation(state, operation);
    const phase = fallbackDecision === "CLOSE_AND_START_NEW_PHASE"
        ? ensureActivePhase(state, classification.type === "PLAN" ? "Planning" : "Unplanned work")
        : initialPhase;
    operation.phaseId = phase.phaseId;
    state.operations[opId] = operation;
    state.operationByCallId[callId] = opId;
    phase.operationIds.push(opId);
    capturePhaseMessage(state, {
        phaseId: phase.phaseId,
        messageRef: `${callId}:call`,
        role: "assistant",
        contentType: "tool-call",
        payload: argumentsText,
        operationId: opId,
    });
    return operation;
}

export function operationForCall(state: WorkflowState, callId: string): OperationRecord | undefined {
    const opId = state.operationByCallId[callId];
    return opId ? state.operations[opId] : undefined;
}

export function updateOperationResult(
    state: WorkflowState,
    operation: OperationRecord,
    rawTokens: number,
    visibleTokens: number,
    resultText?: string,
    outcomeText?: string,
): void {
    operation.rawTokens = Math.max(operation.rawTokens, rawTokens);
    operation.visibleTokens = Math.max(operation.visibleTokens, visibleTokens);
    if (resultText !== undefined) {
        if (operation.lifecycle === "ACTIVE") operation.lifecycle = "DELIVERED";
        capturePhaseMessage(state, {
            phaseId: operation.phaseId,
            messageRef: `${operation.toolCallId ?? operation.opId}:result`,
            role: "tool",
            contentType: "tool-result",
            payload: resultText,
            tokenSize: visibleTokens,
            operationId: operation.opId,
        });
    }
    if (resultText !== undefined) operation.outcome = operationOutcome(operation.type, outcomeText ?? resultText);
    operation.updatedAt = Date.now();
    observeOperationForSupervisor(state, operation);
    recomputeWorkflowMetrics(state);
}

function operationOutcome(type: OperationRecord["type"], text: string): OperationRecord["outcome"] {
    if (type !== "TEST" && type !== "BUILD" && type !== "RUN" && type !== "INSTALL") return undefined;
    if (type === "INSTALL") {
        const exitCode = /(?:exit code|exit_code)\s*[:=]\s*(-?\d+)/i.exec(text)?.[1];
        if (exitCode !== undefined) return exitCode === "0" ? "PASS" : "FAIL";
        if (/\b(?:install(?:ed)?|added)\b.*\b(?:success|complete|package)/i.test(text)) return "PASS";
        return /\b(?:failed|failure|fatal|panic|uncaught exception)\b/i.test(text) ? "FAIL" : "UNKNOWN";
    }
    return validationOutcome(text, type);
}

export function markWorkflowOperations(state: WorkflowState, args: Record<string, unknown>): string {
    if (!Array.isArray(args.operations) || args.operations.length === 0) {
        return "[workflow_mark FAILED: operations must be a non-empty array]";
    }
    const errors: string[] = [];
    let marked = 0;
    for (const item of args.operations) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            errors.push("each operation mark must be an object");
            continue;
        }
        const record = item as Record<string, unknown>;
        const opId = typeof record.opId === "string" ? record.opId : "";
        const stateValue = record.state;
        if (!opId || (stateValue !== "CONSUMED" && stateValue !== "KEEP" && stateValue !== "CRITICAL")) {
            errors.push(`invalid mark for ${opId || "unknown operation"}`);
            continue;
        }
        const operation = state.operations[opId];
        if (!operation) {
            errors.push(`unknown operation ${opId}`);
            continue;
        }
        if (operation.lifecycle === "ACTIVE") {
            errors.push(`${opId} has not been delivered to the main agent`);
            continue;
        }
        if (operation.lifecycle === "ARCHIVED" || operation.lifecycle === "PENDING_DROP") {
            errors.push(`${opId} is no longer markable (${operation.lifecycle})`);
            continue;
        }
        if (operation.lifecycle !== "DELIVERED" && operation.lifecycle !== stateValue) {
            errors.push(`${opId} cannot transition from ${operation.lifecycle} to ${stateValue}`);
            continue;
        }
        operation.lifecycle = stateValue;
        if (stateValue === "CRITICAL") operation.importance = "CRITICAL";
        operation.updatedAt = Date.now();
        marked++;
    }
    recomputeWorkflowMetrics(state);
    if (errors.length > 0) return `[workflow_mark REJECTED: ${errors.join("; ")}]`;
    return `[workflow_mark OK: ${marked} operation(s) marked]`;
}

export function attachOperationMessageRefs(state: WorkflowState, messages: BiliMessage[]): void {
    for (const message of messages) {
        if (!message.toolCallId) continue;
        const operation = operationForCall(state, message.toolCallId);
        if (!operation) continue;
        const refs = message.role === "tool" ? operation.resultRefs : operation.callRefs;
        if (!refs.includes(message.id)) refs.push(message.id);
    }
}

export function observeCodexNestedOperations(
    state: WorkflowState,
    operation: OperationRecord,
    repoOptions: WorkflowOptions["repoBridge"],
): void {
    if (!operation.codexNested || operation.codexNested.length === 0) return;
    for (const nested of operation.codexNested) {
        if (nested.paths.length === 0 && nested.addedPaths.length === 0) continue;
        const synthetic: OperationRecord = {
            opId: `${operation.opId}#${nested.type}`,
            phaseId: operation.phaseId,
            type: nested.type,
            callRefs: [],
            resultRefs: [],
            ...(operation.toolCallId ? { toolCallId: operation.toolCallId } : {}),
            ...(nested.command ? { command: nested.command } : {}),
            ...(operation.workdir ? { workdir: operation.workdir } : {}),
            paths: nested.paths,
            addedPaths: nested.addedPaths,
            rawTokens: 0,
            visibleTokens: 0,
            lifecycle: "ACTIVE",
            importance: "NORMAL",
            createdAt: operation.createdAt,
            updatedAt: operation.updatedAt,
        };
        observeRepositoryOperation(state, synthetic, repoOptions);
    }
}
