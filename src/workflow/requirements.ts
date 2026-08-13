import type { BiliMessage } from "../bili-message.js";
import { archiveRequirementMessage, verifyRawArchiveCommit } from "./archive.js";
import { assignRequirementToTask } from "./project-memory.js";
import type { RequirementMessageRecord, RequirementRecord, RequirementStatus, WorkflowState } from "./types.js";
import { estimateTokensFast } from "acp-kernel";
import { isWorkflowMessage } from "./workflow-item.js";

function importance(detail: string): RequirementRecord["importance"] {
    return /(?:\b(?:must|never|critical|forbid|required|do not)\b|禁止|必须|绝不|不能|不得|优先级)/i.test(detail)
        ? "CRITICAL"
        : "NORMAL";
}

function atomicDetails(detail: string): string[] {
    const lines = detail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const marked = lines.some((line) => /^\s*(?:[-*•]|\d+[.)]|[A-Z][.)])\s+/.test(line));
    if (!marked) return [detail.trim()];
    const result: string[] = [];
    for (const line of lines) {
        const value = line.replace(/^\s*(?:[-*•]|\d+[.)]|[A-Z][.)])\s+/, "").trim();
        if (!value) continue;
        if (result.length > 0 && !/^\s*(?:[-*•]|\d+[.)]|[A-Z][.)])\s+/.test(line)) {
            result[result.length - 1] = `${result[result.length - 1]} ${value}`;
        } else {
            result.push(value);
        }
    }
    return result.length > 0 ? result : [detail.trim()];
}

function terminal(status: RequirementStatus): boolean {
    return status === "SATISFIED" || status === "SUPERSEDED" || status === "CANCELLED" || status === "HISTORICAL";
}

export function requirementMessageForSource(state: WorkflowState, sourceRef: string): RequirementMessageRecord | undefined {
    const requirementId = state.requirementBySourceRef[sourceRef];
    const requirement = requirementId ? state.requirements[requirementId] : undefined;
    return requirement?.messageId ? state.requirementMessages[requirement.messageId] : undefined;
}

export function syncRequirements(state: WorkflowState, messages: BiliMessage[], sessionId?: string): RequirementRecord[] {
    const created: RequirementRecord[] = [];
    for (const message of messages) {
        if (message.role !== "user" || message.contentType !== "text" || !message.text?.trim() || isWorkflowMessage(message)) continue;
        if (state.requirementBySourceRef[message.id]) continue;
        const messageId = `REQMSG-${String(state.nextRequirementMessageNumber++).padStart(5, "0")}`;
        const details = atomicDetails(message.text);
        const requirementIds: string[] = [];
        const messageRecord: RequirementMessageRecord = {
            messageId,
            sourceRefs: [message.id],
            detail: message.text,
            requirementIds,
            tokenSize: estimateTokensFast(message.text),
            lifecycle: "ACTIVE",
            createdAt: Date.now(),
        };
        state.requirementMessages[messageId] = messageRecord;
        for (const detail of details) {
            const id = `REQ-${String(state.nextRequirementNumber++).padStart(5, "0")}`;
            const requirement: RequirementRecord = {
                id,
                sourceRefs: [message.id],
                messageId,
                parentMessageId: messageId,
                detail,
                status: details.length > 1 ? "ACTIVE_CURRENT" : "ACTIVE",
                importance: importance(detail),
                preserveRaw: true,
                createdAt: Date.now(),
            };
            state.requirements[id] = requirement;
            requirementIds.push(id);
            state.requirementBySourceRef[message.id] ??= id;
            assignRequirementToTask(state, requirement, sessionId);
            created.push(requirement);
        }
        if (sessionId && requirementIds.length > 0) {
            const first = state.requirements[requirementIds[0]];
            if (first) {
                const rawRef = archiveRequirementMessage(sessionId, state, first, message.text);
                if (rawRef) {
                    messageRecord.rawRef = rawRef;
                    for (const id of requirementIds) state.requirements[id].rawRef = rawRef;
                }
            }
        }
    }
    return created;
}

export function refreshRequirementHistory(state: WorkflowState): number {
    let changed = 0;
    for (const message of Object.values(state.requirementMessages)) {
        const requirements = message.requirementIds.map((id) => state.requirements[id]).filter((value): value is RequirementRecord => Boolean(value));
        if (requirements.length === 0 || message.lifecycle !== "ACTIVE") continue;
        if (!message.rawRef
            || !state.archiveSessionId
            || !verifyRawArchiveCommit(state.archiveSessionId, state, message.rawRef)
            || !requirements.every((requirement) => terminal(requirement.status))) continue;
        for (const requirement of requirements) {
            requirement.historicalDetail = requirement.detail;
            if (requirement.status !== "HISTORICAL") {
                requirement.resolvedStatus = requirement.status;
                requirement.status = "HISTORICAL";
            }
        }
        message.lifecycle = "PENDING_DROP";
        message.historicalAt = Date.now();
        changed++;
    }
    return changed;
}

export function archiveHistoricalRequirements(state: WorkflowState): number {
    let archived = 0;
    for (const message of Object.values(state.requirementMessages)) {
        if (message.lifecycle !== "PENDING_DROP"
            || !message.rawRef
            || !state.archiveSessionId
            || !verifyRawArchiveCommit(state.archiveSessionId, state, message.rawRef)) continue;
        message.lifecycle = "ARCHIVED";
        archived++;
    }
    return archived;
}

export function requirementMessageCanDrop(state: WorkflowState, sourceRef: string): boolean {
    return requirementMessageForSource(state, sourceRef)?.lifecycle === "ARCHIVED";
}
