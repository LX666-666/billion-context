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
): void {
    operation.rawTokens = Math.max(operation.rawTokens, rawTokens);
    operation.visibleTokens = Math.max(operation.visibleTokens, visibleTokens);
    if (operation.lifecycle === "ACTIVE") operation.lifecycle = "CONSUMED";
    operation.updatedAt = Date.now();
    recomputeWorkflowMetrics(state);
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
