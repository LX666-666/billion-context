import type { BiliMessage } from "../bili-message.js";
import { classifyOperation } from "./operation-classifier.js";
import { ensureActivePhase, recomputeWorkflowMetrics } from "./state.js";
import type { OperationRecord, WorkflowState } from "./types.js";

export function trackOperationCall(
    state: WorkflowState,
    callId: string,
    toolName: string,
    argumentsText: string,
): OperationRecord {
    const existingId = state.operationByCallId[callId];
    if (existingId && state.operations[existingId]) return state.operations[existingId];
    const classification = classifyOperation(toolName, argumentsText);
    const phase = ensureActivePhase(state);
    const opId = `op${String(state.nextOperationNumber++).padStart(5, "0")}`;
    const now = Date.now();
    const operation: OperationRecord = {
        opId,
        phaseId: phase.phaseId,
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
        rawTokens: 0,
        visibleTokens: 0,
        lifecycle: "ACTIVE",
        importance: classification.type === "PLAN" ? "CRITICAL" : "NORMAL",
        createdAt: now,
        updatedAt: now,
    };
    state.operations[opId] = operation;
    state.operationByCallId[callId] = opId;
    phase.operationIds.push(opId);
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
): void {
    operation.rawTokens = Math.max(operation.rawTokens, rawTokens);
    operation.visibleTokens = Math.max(operation.visibleTokens, visibleTokens);
    if (operation.lifecycle === "ACTIVE") operation.lifecycle = "CONSUMED";
    if (resultText !== undefined) operation.outcome = operationOutcome(operation.type, resultText);
    operation.updatedAt = Date.now();
    recomputeWorkflowMetrics(state);
}

function operationOutcome(type: OperationRecord["type"], text: string): OperationRecord["outcome"] {
    if (type !== "TEST" && type !== "BUILD" && type !== "RUN" && type !== "INSTALL") return undefined;
    if (/\[(?:TEST|BUILD) FAILED\]/i.test(text)) return "FAIL";
    if (/\[(?:TEST|BUILD) PASS\]/i.test(text)) return "PASS";
    const exitCode = /(?:exit code|exit_code)\s*[:=]\s*(-?\d+)/i.exec(text)?.[1];
    if (exitCode !== undefined) return exitCode === "0" ? "PASS" : "FAIL";
    if (/\b(?:failed|failure|fatal|panic|uncaught exception)\b/i.test(text)) return "FAIL";
    if (/\b(?:passed|success(?:ful)?|completed)\b/i.test(text)) return "PASS";
    return "UNKNOWN";
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
