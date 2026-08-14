import type { CoreMessage } from "acp-kernel";
import type { ParsedRange } from "../compress-tool.js";
import type { OperationRecord, WorkflowState } from "./types.js";

const PENDING_DROP_TOKEN_THRESHOLD = 4_000;

function operationIsProtected(lifecycle: OperationRecord["lifecycle"]): boolean {
    return lifecycle === "KEEP" || lifecycle === "CRITICAL";
}

function messageIndex(messages: CoreMessage[], ref: string): number {
    return messages.findIndex((message) => message.id === ref);
}

function protectedMessageRefs(state: WorkflowState): Set<string> {
    const refs = new Set<string>();
    for (const [messageRef, message] of Object.entries(state.phaseMessages)) {
        const phase = state.phases[message.phaseId];
        if (!phase) continue;
        if (phase.status === "ACTIVE" || phase.status === "CHECKPOINT_PENDING" || phase.status === "PENDING_ROLLOVER") {
            refs.add(messageRef);
        }
        if (message.lifecycle === "ACTIVE" && phase.status !== "ARCHIVED") {
            refs.add(messageRef);
        }
    }
    for (const operation of Object.values(state.operations)) {
        if (operationIsProtected(operation.lifecycle) || operation.importance === "CRITICAL") {
            for (const ref of [...operation.callRefs, ...operation.resultRefs]) refs.add(ref);
            if (operation.toolCallId) {
                refs.add(`${operation.toolCallId}:call`);
                refs.add(`${operation.toolCallId}:result`);
            }
        }
    }
    for (const message of Object.values(state.requirementMessages)) {
        if (message.lifecycle === "ACTIVE") {
            for (const ref of message.sourceRefs) refs.add(ref);
        }
    }
    return refs;
}

function rangeCoversProtected(
    range: ParsedRange,
    messages: CoreMessage[],
    protectedRefs: Set<string>,
): boolean {
    const startIndex = messageIndex(messages, range.startRef);
    const endIndex = messageIndex(messages, range.endRef);
    if (startIndex === -1 || endIndex === -1) {
        return protectedRefs.has(range.startRef) || protectedRefs.has(range.endRef);
    }
    const lower = Math.min(startIndex, endIndex);
    const upper = Math.max(startIndex, endIndex);
    for (let index = lower; index <= upper; index++) {
        const message = messages[index];
        if (message && protectedRefs.has(message.id)) return true;
    }
    return false;
}

function workflowHasSignificantPendingDrop(state: WorkflowState): boolean {
    return state.metrics.pendingDropTotalTokens >= PENDING_DROP_TOKEN_THRESHOLD;
}

export type AcpArbitrationResult = {
    ranges: ParsedRange[];
    rejected: ParsedRange[];
    reason: string;
};

export function arbitrateAcpRanges(
    state: WorkflowState,
    ranges: ParsedRange[],
    messages: CoreMessage[],
): AcpArbitrationResult {
    if (ranges.length === 0) {
        return { ranges, rejected: [], reason: "no ranges" };
    }
    if (workflowHasSignificantPendingDrop(state)) {
        return {
            ranges: [],
            rejected: ranges,
            reason: "workflow has pending rollover content; prefer workflow rollover over ACP compression",
        };
    }
    const protectedRefs = protectedMessageRefs(state);
    if (protectedRefs.size === 0) {
        return { ranges, rejected: [], reason: "no protected workflow content" };
    }
    const accepted: ParsedRange[] = [];
    const rejected: ParsedRange[] = [];
    for (const range of ranges) {
        if (rangeCoversProtected(range, messages, protectedRefs)) {
            rejected.push(range);
        } else {
            accepted.push(range);
        }
    }
    return {
        ranges: accepted,
        rejected,
        reason: rejected.length > 0 ? "range covers protected workflow content" : "all ranges eligible",
    };
}
