import path from "node:path";
import { estimateTokensFast } from "acp-kernel";
import type { BiliMessage } from "../bili-message.js";
import { archiveRequirementMessage } from "./archive.js";
import { assignRequirementToTask } from "./project-memory.js";
import { atomicRequirementDetails, requirementImportance } from "./requirements.js";
import type {
    OperationRecord,
    RequirementDocumentPointer,
    RequirementMessageRecord,
    RequirementRecord,
    WorkflowState,
} from "./types.js";

const GOAL_READ_PATTERN = /(?:^|\s)\/goal\b[^\n]*?\b(?:read|cat|get-content|type)\s+("(?:[^"]+)"|'([^']+)'|([^\s;,\n]+))/i;

export function isRequirementDocumentPath(value: string): boolean {
    return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

export function normalizeRequirementDocumentPath(value: string | undefined, workspaceRoot?: string): string | undefined {
    if (!value) return undefined;
    const cleaned = value.trim().replace(/^['"]|['"]$/g, "");
    if (!cleaned) return undefined;
    const resolved = path.isAbsolute(cleaned)
        ? path.resolve(cleaned)
        : workspaceRoot
            ? path.resolve(workspaceRoot, cleaned)
            : path.resolve(cleaned);
    return resolved.replace(/\\/g, "/").toLowerCase();
}

function extractGoalDocumentPath(text: string): string | undefined {
    const match = GOAL_READ_PATTERN.exec(text);
    if (!match) return undefined;
    const raw = match[1] ?? match[2] ?? match[3];
    if (!raw || !isRequirementDocumentPath(raw.replace(/^['"]|['"]$/g, ""))) return undefined;
    return raw.replace(/^['"]|['"]$/g, "");
}

function createRequirementMessage(
    state: WorkflowState,
    sessionId: string | undefined,
    sourceRefs: string[],
    detailText: string,
    provenance: RequirementRecord["provenance"],
    details: string[],
): { messageId: string; requirementIds: string[] } {
    const messageId = `REQMSG-${String(state.nextRequirementMessageNumber++).padStart(5, "0")}`;
    const requirementIds: string[] = [];
    const messageRecord: RequirementMessageRecord = {
        messageId,
        sourceRefs: [...sourceRefs],
        detail: detailText,
        requirementIds,
        tokenSize: estimateTokensFast(detailText),
        lifecycle: "ACTIVE",
        createdAt: Date.now(),
    };
    state.requirementMessages[messageId] = messageRecord;
    for (const detail of details) {
        const id = `REQ-${String(state.nextRequirementNumber++).padStart(5, "0")}`;
        const requirement: RequirementRecord = {
            id,
            sourceRefs: [...sourceRefs],
            messageId,
            parentMessageId: messageId,
            detail,
            status: details.length > 1 ? "ACTIVE_CURRENT" : "ACTIVE",
            importance: requirementImportance(detail),
            provenance,
            preserveRaw: true,
            createdAt: Date.now(),
        };
        state.requirements[id] = requirement;
        requirementIds.push(id);
        assignRequirementToTask(state, requirement, sessionId);
        state.requirementLedgerVersion++;
    }
    if (sessionId && requirementIds.length > 0) {
        const first = state.requirements[requirementIds[0]];
        if (first) {
            const rawRef = archiveRequirementMessage(sessionId, state, first, detailText);
            if (rawRef) {
                messageRecord.rawRef = rawRef;
                for (const id of requirementIds) state.requirements[id].rawRef = rawRef;
            }
        }
    }
    return { messageId, requirementIds };
}

export function registerPendingRequirementDocuments(
    state: WorkflowState,
    messages: BiliMessage[],
    sessionId: string | undefined,
    workspaceRoot?: string,
): void {
    for (const message of messages) {
        if (message.role !== "user" || message.contentType !== "text" || !message.text?.trim()) continue;
        const candidate = extractGoalDocumentPath(message.text);
        if (!candidate) continue;
        const normalized = normalizeRequirementDocumentPath(candidate, workspaceRoot);
        if (!normalized) continue;
        if (state.requirementDocumentByPath[normalized]) continue;
        const pointer = createRequirementMessage(
            state,
            sessionId,
            [message.id],
            message.text.trim(),
            "USER_REQUIREMENT_POINTER",
            [message.text.trim()],
        );
        state.requirementBySourceRef[message.id] ??= pointer.requirementIds[0];
        const record: RequirementDocumentPointer = {
            path: normalized,
            sourceRef: message.id,
            pointerRequirementId: pointer.requirementIds[0],
            requirementMessageId: pointer.messageId,
            ingested: false,
            createdAt: Date.now(),
        };
        state.requirementDocumentByPath[normalized] = record;
        state.pendingRequirementDocuments.push(normalized);
    }
}

function operationDocumentMatch(state: WorkflowState, operation: OperationRecord, workspaceRoot?: string): string | undefined {
    if (operation.type !== "READ") return undefined;
    const candidates = [...(operation.path ? [operation.path] : []), ...operation.paths];
    for (const candidate of candidates) {
        const normalized = normalizeRequirementDocumentPath(candidate, workspaceRoot);
        if (!normalized) continue;
        const pointer = state.requirementDocumentByPath[normalized];
        if (pointer && !pointer.ingested) return normalized;
    }
    return undefined;
}

export function pendingRequirementDocumentForOperation(
    state: WorkflowState,
    operation: OperationRecord,
    workspaceRoot?: string,
): RequirementDocumentPointer | undefined {
    const normalized = operationDocumentMatch(state, operation, workspaceRoot);
    return normalized ? state.requirementDocumentByPath[normalized] : undefined;
}

function markRequirementDocumentSnapshot(state: WorkflowState, normalizedPath: string): void {
    const fileKey = Object.keys(state.repoBridge.files).find((key) => key.toLowerCase() === normalizedPath);
    const snapshot = fileKey ? state.repoBridge.files[fileKey] : undefined;
    if (snapshot) {
        snapshot.requirementDocument = true;
        snapshot.stale = false;
        snapshot.staleReason = undefined;
        snapshot.staleGeneration = undefined;
    }
}

export function syncRequirementDocument(
    state: WorkflowState,
    sessionId: string | undefined,
    normalizedPath: string,
    content: string,
): RequirementRecord[] | undefined {
    const pointer = state.requirementDocumentByPath[normalizedPath];
    if (!pointer || pointer.ingested) return undefined;
    const detailText = content.trim();
    if (!detailText) return undefined;
    const details = atomicRequirementDetails(detailText);
    if (details.length === 0) return undefined;
    const { messageId, requirementIds } = createRequirementMessage(
        state,
        sessionId,
        [pointer.sourceRef],
        detailText,
        "USER_REQUIREMENT_DOCUMENT",
        details,
    );
    pointer.ingested = true;
    pointer.ingestedAt = Date.now();
    pointer.requirementMessageId = messageId;
    state.pendingRequirementDocuments = state.pendingRequirementDocuments.filter((value) => value !== normalizedPath);
    markRequirementDocumentSnapshot(state, normalizedPath);
    return requirementIds.map((id) => state.requirements[id]).filter((requirement): requirement is RequirementRecord => Boolean(requirement));
}

export function ingestRequirementDocumentForOperation(
    state: WorkflowState,
    operation: OperationRecord,
    content: string,
    sessionId: string | undefined,
    workspaceRoot?: string,
): RequirementRecord[] | undefined {
    const normalized = operationDocumentMatch(state, operation, workspaceRoot);
    if (!normalized) return undefined;
    return syncRequirementDocument(state, sessionId, normalized, content);
}
