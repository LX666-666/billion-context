import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { estimateTokensFast } from "acp-kernel";
import { dataDir } from "../paths.js";
import { log as loggerLog } from "../logger.js";
import type {
    OperationRecord,
    PhaseArchive,
    PhaseArchiveMessageEntry,
    PhaseArchiveOperationEntry,
    PhaseMessageRecord,
    RequirementRecord,
    WorkflowCheckpoint,
    WorkflowState,
} from "./types.js";

type RawArchiveRecord = {
    rawRef: string;
    sessionId: string;
    projectId?: string;
    phaseId?: string;
    opId?: string;
    requirementId?: string;
    type: OperationRecord["type"] | "REQUIREMENT" | "MESSAGE";
    messageRef?: string;
    createdAt: number;
    sourceRefs: string[];
    tokenCount: number;
    checksum: string;
    payload: string;
};

export function rawChecksum(payload: string): string {
    return createHash("sha256").update(payload).digest("hex");
}

function sessionArchiveDir(sessionId: string): string {
    const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    return path.join(dataDir(), "archive", sessionHash);
}

function archiveFile(sessionId: string, rawRef: string): string {
    if (!/^raw_\d{6,}$/.test(rawRef)) throw new Error(`invalid raw ref: ${rawRef}`);
    return path.join(sessionArchiveDir(sessionId), `${rawRef}.json`);
}

function phaseArchiveFile(sessionId: string, phaseId: string): string {
    if (!/^phase\d{5,}$/.test(phaseId)) throw new Error(`invalid phase id: ${phaseId}`);
    return path.join(sessionArchiveDir(sessionId), `${phaseId}.json`);
}

function archivePayloadExists(sessionId: string, state: WorkflowState, rawRef: string): boolean {
    return verifyRawArchiveCommit(sessionId, state, rawRef);
}

function writeRawArchiveRecord(sessionId: string, record: RawArchiveRecord): void {
    const dir = sessionArchiveDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const destination = archiveFile(sessionId, record.rawRef);
    const temporary = path.join(dir, `.tmp-${record.rawRef}-${process.pid}-${Date.now()}.json`);
    try {
        writeFileSync(temporary, JSON.stringify(record), "utf8");
        renameSync(temporary, destination);
        const stored = JSON.parse(readFileSync(destination, "utf8")) as RawArchiveRecord;
        if (stored.rawRef !== record.rawRef
            || stored.sessionId !== sessionId
            || stored.checksum !== record.checksum
            || rawChecksum(stored.payload) !== record.checksum) {
            throw new Error("raw archive checksum verification failed");
        }
    } catch (error) {
        try {
            if (existsSync(temporary)) unlinkSync(temporary);
            if (existsSync(destination)) unlinkSync(destination);
        } catch {
        }
        throw error;
    }
}

export function verifyRawArchiveCommit(sessionId: string, state: WorkflowState, rawRef: string): boolean {
    const index = state.rawArchive[rawRef];
    if (!index) return false;
    try {
        const stored = JSON.parse(readFileSync(archiveFile(sessionId, rawRef), "utf8")) as RawArchiveRecord;
        return stored.rawRef === rawRef
            && stored.sessionId === sessionId
            && stored.type === index.type
            && stored.phaseId === index.phaseId
            && stored.opId === index.opId
            && stored.requirementId === index.requirementId
            && stored.checksum === index.checksum
            && rawChecksum(stored.payload) === stored.checksum;
    } catch {
        return false;
    }
}

export function archiveOperationOutput(
    sessionId: string,
    state: WorkflowState,
    operation: OperationRecord,
    payload: string,
    tokenCount: number,
): string | undefined {
    const checksum = rawChecksum(payload);
    if (operation.rawRef && operation.rawChecksum === checksum && state.rawArchive[operation.rawRef]) {
        if (verifyRawArchiveCommit(sessionId, state, operation.rawRef)) return operation.rawRef;
        delete state.rawArchive[operation.rawRef];
        operation.rawRef = undefined;
        operation.rawChecksum = undefined;
    }
    const rawRef = `raw_${String(state.nextRawNumber++).padStart(6, "0")}`;
    const createdAt = Date.now();
    const record: RawArchiveRecord = {
        rawRef,
        sessionId,
        ...(state.projectId ? { projectId: state.projectId } : {}),
        phaseId: operation.phaseId,
        opId: operation.opId,
        type: operation.type,
        createdAt,
        sourceRefs: operation.resultRefs.length > 0
            ? [...operation.resultRefs]
            : operation.toolCallId ? [operation.toolCallId] : [],
        tokenCount,
        checksum,
        payload,
    };
    try {
        writeRawArchiveRecord(sessionId, record);
        operation.rawRef = rawRef;
        operation.rawChecksum = checksum;
        state.rawArchive[rawRef] = {
            rawRef,
            opId: operation.opId,
            phaseId: operation.phaseId,
            type: operation.type,
            tokenCount,
            checksum,
            createdAt,
        };
        state.archiveSessionId = sessionId;
        return rawRef;
    } catch (error) {
        loggerLog("warn", `[workflow-archive] could not store ${rawRef}: ${String(error)}`);
        return undefined;
    }
}

export function archiveRequirementMessage(
    sessionId: string,
    state: WorkflowState,
    requirement: RequirementRecord,
    payload: string,
): string | undefined {
    const checksum = rawChecksum(payload);
    if (requirement.rawRef && state.rawArchive[requirement.rawRef]?.checksum === checksum) {
        if (verifyRawArchiveCommit(sessionId, state, requirement.rawRef)) return requirement.rawRef;
        delete state.rawArchive[requirement.rawRef];
    }
    const rawRef = `raw_${String(state.nextRawNumber++).padStart(6, "0")}`;
    const createdAt = Date.now();
    const tokenCount = estimateTokensFast(payload);
    const record: RawArchiveRecord = {
        rawRef,
        sessionId,
        ...(state.projectId ? { projectId: state.projectId } : {}),
        ...(state.activePhaseId ? { phaseId: state.activePhaseId } : {}),
        requirementId: requirement.id,
        type: "REQUIREMENT",
        createdAt,
        sourceRefs: [...requirement.sourceRefs],
        tokenCount,
        checksum,
        payload,
    };
    try {
        writeRawArchiveRecord(sessionId, record);
        requirement.rawRef = rawRef;
        state.rawArchive[rawRef] = {
            rawRef,
            requirementId: requirement.id,
            ...(state.activePhaseId ? { phaseId: state.activePhaseId } : {}),
            type: "REQUIREMENT",
            tokenCount,
            checksum,
            createdAt,
        };
        state.archiveSessionId = sessionId;
        return rawRef;
    } catch (error) {
        loggerLog("warn", `[workflow-archive] could not store ${rawRef}: ${String(error)}`);
        return undefined;
    }
}

export function archiveMessagePayload(
    sessionId: string,
    state: WorkflowState,
    phaseId: string,
    messageRef: string,
    payload: string,
): string | undefined {
    const checksum = rawChecksum(payload);
    const existing = Object.values(state.rawArchive).find((record) =>
        record.type === "MESSAGE" && record.phaseId === phaseId && record.checksum === checksum,
    );
    if (existing && verifyRawArchiveCommit(sessionId, state, existing.rawRef)) return existing.rawRef;
    const rawRef = `raw_${String(state.nextRawNumber++).padStart(6, "0")}`;
    const createdAt = Date.now();
    const record: RawArchiveRecord = {
        rawRef,
        sessionId,
        ...(state.projectId ? { projectId: state.projectId } : {}),
        phaseId,
        type: "MESSAGE",
        messageRef,
        createdAt,
        sourceRefs: [messageRef],
        tokenCount: estimateTokensFast(payload),
        checksum,
        payload,
    };
    try {
        writeRawArchiveRecord(sessionId, record);
        state.rawArchive[rawRef] = {
            rawRef,
            phaseId,
            type: "MESSAGE",
            tokenCount: record.tokenCount,
            checksum,
            createdAt,
        };
        state.archiveSessionId = sessionId;
        return rawRef;
    } catch (error) {
        loggerLog("warn", `[workflow-archive] could not store message ${messageRef}: ${String(error)}`);
        return undefined;
    }
}

function operationEntry(state: WorkflowState, operation: OperationRecord, messages: PhaseMessageRecord[]): PhaseArchiveOperationEntry {
    const callMessage = messages.find((message) => message.operationId === operation.opId
        && (message.contentType === "tool-call" || message.contentType.endsWith("_call")));
    const resultMessage = messages.find((message) => message.operationId === operation.opId
        && (message.contentType === "tool-result" || message.contentType.endsWith("_output")));
    return {
        opId: operation.opId,
        type: operation.type,
        lifecycle: operation.lifecycle,
        callRefs: [...operation.callRefs],
        resultRefs: [...operation.resultRefs],
        ...(operation.toolCallId ? { toolCallId: operation.toolCallId } : {}),
        ...(operation.command ? { command: operation.command } : {}),
        ...(operation.workdir ? { workdir: operation.workdir } : {}),
        ...(operation.path ? { path: operation.path } : {}),
        paths: [...operation.paths],
        addedPaths: [...operation.addedPaths],
        ...(operation.rawRef ? { rawRef: operation.rawRef } : {}),
        ...(callMessage?.payloadRef ? { callPayloadRef: callMessage.payloadRef } : {}),
        ...(resultMessage?.payloadRef ? { resultPayloadRef: resultMessage.payloadRef } : {}),
        ...(operation.outcome ? { outcome: operation.outcome } : {}),
    };
}

function archiveMessageEntry(
    sessionId: string,
    state: WorkflowState,
    message: PhaseMessageRecord,
    operations: OperationRecord[],
): PhaseArchiveMessageEntry | undefined {
    const operation = message.operationId ? state.operations[message.operationId] : undefined;
    if (message.payloadRef && archivePayloadExists(sessionId, state, message.payloadRef)) {
        return {
            messageRef: message.messageRef,
            role: message.role,
            contentType: message.contentType,
            tokenSize: message.tokenSize,
            ...(message.operationId ? { operationId: message.operationId } : {}),
            ...(message.requirementMessageId ? { requirementMessageId: message.requirementMessageId } : {}),
            payloadRef: message.payloadRef,
        };
    }
    if ((message.contentType === "tool-result" || message.contentType.endsWith("_output")) && operation?.rawRef) {
        if (!archivePayloadExists(sessionId, state, operation.rawRef)) return undefined;
        return {
            messageRef: message.messageRef,
            role: message.role,
            contentType: message.contentType,
            tokenSize: message.tokenSize,
            ...(message.operationId ? { operationId: message.operationId } : {}),
            ...(message.requirementMessageId ? { requirementMessageId: message.requirementMessageId } : {}),
            payloadRef: operation.rawRef,
        };
    }
    const requirement = message.requirementMessageId
        ? state.requirementMessages[message.requirementMessageId]
        : undefined;
    if (requirement?.rawRef && archivePayloadExists(sessionId, state, requirement.rawRef)) {
        return {
            messageRef: message.messageRef,
            role: message.role,
            contentType: message.contentType,
            tokenSize: message.tokenSize,
            ...(message.operationId ? { operationId: message.operationId } : {}),
            requirementMessageId: message.requirementMessageId,
            payloadRef: requirement.rawRef,
        };
    }
    if (message.payload === undefined) {
        if (operation && operation.type !== "PLAN") return undefined;
        return {
            messageRef: message.messageRef,
            role: message.role,
            contentType: message.contentType,
            tokenSize: message.tokenSize,
            ...(message.operationId ? { operationId: message.operationId } : {}),
            ...(message.requirementMessageId ? { requirementMessageId: message.requirementMessageId } : {}),
        };
    }
    return {
        messageRef: message.messageRef,
        role: message.role,
        contentType: message.contentType,
        tokenSize: message.tokenSize,
        ...(message.operationId ? { operationId: message.operationId } : {}),
        ...(message.requirementMessageId ? { requirementMessageId: message.requirementMessageId } : {}),
        payload: message.payload,
    };
}

export function archivePhase(
    sessionId: string | undefined,
    state: WorkflowState,
    phaseId: string,
    checkpoint?: WorkflowCheckpoint,
): { committed: boolean; archive?: PhaseArchive; error?: string } {
    const phase = state.phases[phaseId];
    if (!phase) return { committed: false, error: `unknown phase ${phaseId}` };
    const effectiveSessionId = sessionId ?? state.archiveSessionId ?? "workflow-state";
    if (phase.archiveStatus === "COMMITTED" && phase.archiveChecksum && verifyArchiveCommit(effectiveSessionId, phaseId, phase.archiveChecksum, state)) {
        const existing = readPhaseArchive(effectiveSessionId, state, phaseId);
        return existing ? { committed: true, archive: existing } : { committed: false, error: "archive commit could not be read back" };
    }
    const messages = Object.values(state.phaseMessages).filter((message) => message.phaseId === phaseId);
    const operations = phase.operationIds
        .map((opId) => state.operations[opId])
        .filter((operation): operation is OperationRecord => Boolean(operation));
    const messageEntries: PhaseArchiveMessageEntry[] = [];
    for (const message of messages) {
        const entry = archiveMessageEntry(effectiveSessionId, state, message, operations);
        if (!entry) {
            phase.archiveStatus = "FAILED";
            phase.archiveError = `message ${message.messageRef} has no recoverable payload`;
            return { committed: false, error: phase.archiveError };
        }
        messageEntries.push(entry);
    }
    for (const operation of operations) {
        if (operation.rawRef && !archivePayloadExists(effectiveSessionId, state, operation.rawRef)) {
            phase.archiveStatus = "FAILED";
            phase.archiveError = `operation ${operation.opId} references missing ${operation.rawRef}`;
            return { committed: false, error: phase.archiveError };
        }
    }
    const effectiveCheckpoint = checkpoint ?? (phase.checkpointId ? state.checkpoints[phase.checkpointId] : undefined);
    if (phase.checkpointId && !effectiveCheckpoint) {
        phase.archiveStatus = "FAILED";
        phase.archiveError = `checkpoint snapshot is missing for ${phase.checkpointId}`;
        return { committed: false, error: phase.archiveError };
    }
    const base = {
        phaseId,
        ...(phase.taskId ? { taskId: phase.taskId } : {}),
        objective: phase.objective,
        createdAt: phase.startedAt,
        ...(phase.completedAt ? { completedAt: phase.completedAt } : {}),
        ...(checkpoint?.checkpointId ? { checkpointId: checkpoint.checkpointId } : phase.checkpointId ? { checkpointId: phase.checkpointId } : {}),
        messageEntries,
        operations: operations.map((operation) => operationEntry(state, operation, messages)),
        changedFiles: effectiveCheckpoint?.changedFiles ?? [],
        ...(effectiveCheckpoint?.checkpointId ? { checkpointRef: effectiveCheckpoint.checkpointId } : phase.checkpointId ? { checkpointRef: phase.checkpointId } : {}),
        ...(effectiveCheckpoint ? { checkpoint: structuredClone(effectiveCheckpoint) } : {}),
    };
    const checksum = rawChecksum(JSON.stringify(base));
    const archive: PhaseArchive = { ...base, checksum };
    let temporary: string | undefined;
    let backup: string | undefined;
    let committedDestination = false;
    try {
        const dir = sessionArchiveDir(effectiveSessionId);
        mkdirSync(dir, { recursive: true });
        const destination = phaseArchiveFile(effectiveSessionId, phaseId);
        temporary = path.join(dir, `.tmp-${phaseId}-${process.pid}-${Date.now()}.json`);
        writeFileSync(temporary, JSON.stringify(archive), "utf8");
        if (existsSync(destination)) {
            backup = path.join(dir, `.bak-${phaseId}-${process.pid}-${Date.now()}.json`);
            renameSync(destination, backup);
        }
        renameSync(temporary, destination);
        committedDestination = true;
        if (!verifyArchiveCommit(effectiveSessionId, phaseId, checksum, state)) throw new Error("archive checksum verification failed");
        if (backup && existsSync(backup)) unlinkSync(backup);
        phase.archiveStatus = "COMMITTED";
        phase.archiveRef = phaseId;
        phase.archiveChecksum = checksum;
        phase.archiveError = undefined;
        state.archiveSessionId = effectiveSessionId;
        for (const message of messages) {
            if (message.lifecycle === "PENDING_DROP") message.payload = undefined;
            message.updatedAt = Date.now();
        }
        return { committed: true, archive };
    } catch (error) {
        phase.archiveStatus = "FAILED";
        phase.archiveError = String(error);
        try {
            if (temporary && existsSync(temporary)) unlinkSync(temporary);
            if (committedDestination) {
                const destination = phaseArchiveFile(effectiveSessionId, phaseId);
                if (existsSync(destination)) unlinkSync(destination);
            }
            if (backup && existsSync(backup)) {
                renameSync(backup, phaseArchiveFile(effectiveSessionId, phaseId));
            }
        } catch {
        }
        loggerLog("warn", `[workflow-archive] could not commit phase ${phaseId}: ${String(error)}`);
        return { committed: false, error: phase.archiveError };
    }
}

function archiveReferenceIsValid(sessionId: string, state: WorkflowState, rawRef: string | undefined): boolean {
    return rawRef !== undefined && verifyRawArchiveCommit(sessionId, state, rawRef);
}

export function verifyPhaseArchiveRecoverability(
    sessionId: string,
    state: WorkflowState,
    phaseId: string,
    archive?: PhaseArchive,
): boolean {
    let parsed = archive;
    if (!parsed) {
        try {
            parsed = JSON.parse(readFileSync(phaseArchiveFile(sessionId, phaseId), "utf8")) as PhaseArchive;
        } catch {
            return false;
        }
    }
    if (parsed.phaseId !== phaseId || !Array.isArray(parsed.messageEntries) || !Array.isArray(parsed.operations)) return false;
    if (parsed.checkpointId !== undefined || parsed.checkpointRef !== undefined || parsed.checkpoint !== undefined) {
        if (!parsed.checkpoint
            || parsed.checkpointId !== parsed.checkpointRef
            || parsed.checkpoint.checkpointId !== parsed.checkpointRef
            || parsed.checkpoint.phaseId !== phaseId) return false;
    }
    for (const message of parsed.messageEntries) {
        if (message.payload === undefined && !message.payloadRef) {
            const operation = message.operationId ? state.operations[message.operationId] : undefined;
            if (!operation || operation.type !== "PLAN") return false;
        }
        if (message.payload === undefined && !archiveReferenceIsValid(sessionId, state, message.payloadRef)) return false;
    }
    for (const operation of parsed.operations) {
        if ((operation.rawRef !== undefined && !archiveReferenceIsValid(sessionId, state, operation.rawRef))
            || (operation.callPayloadRef !== undefined && !archiveReferenceIsValid(sessionId, state, operation.callPayloadRef))
            || (operation.resultPayloadRef !== undefined && !archiveReferenceIsValid(sessionId, state, operation.resultPayloadRef))) return false;
    }
    return true;
}

export function verifyArchiveCommit(
    sessionId: string,
    phaseId: string,
    checksum?: string,
    state?: WorkflowState,
): boolean {
    try {
        const parsed = JSON.parse(readFileSync(phaseArchiveFile(sessionId, phaseId), "utf8")) as PhaseArchive;
        const storedChecksum = parsed.checksum;
        const { checksum: _ignored, ...base } = parsed;
        if (!storedChecksum
            || (checksum !== undefined && storedChecksum !== checksum)
            || rawChecksum(JSON.stringify(base)) !== storedChecksum) return false;
        return state ? verifyPhaseArchiveRecoverability(sessionId, state, phaseId, parsed) : true;
    } catch {
        return false;
    }
}

export function readPhaseArchive(sessionId: string, state: WorkflowState, phaseId: string): PhaseArchive | undefined {
    const phase = state.phases[phaseId];
    if (!phase?.archiveChecksum || !verifyArchiveCommit(sessionId, phaseId, phase.archiveChecksum, state)) return undefined;
    try {
        return JSON.parse(readFileSync(phaseArchiveFile(sessionId, phaseId), "utf8")) as PhaseArchive;
    } catch {
        return undefined;
    }
}


export function retrieveRawOutput(sessionId: string, state: WorkflowState, rawRef: string): string {
    const index = state.rawArchive[rawRef];
    if (!index) return `[retrieve_raw FAILED: unknown raw_ref ${rawRef}]`;
    if (!verifyRawArchiveCommit(sessionId, state, rawRef)) {
        return `[retrieve_raw FAILED: archive verification failed for ${rawRef}]`;
    }
    try {
        const parsed = JSON.parse(readFileSync(archiveFile(sessionId, rawRef), "utf8")) as RawArchiveRecord;
        if (parsed.rawRef !== rawRef
            || parsed.sessionId !== sessionId
            || parsed.type !== index.type
            || parsed.phaseId !== index.phaseId
            || parsed.opId !== index.opId
            || parsed.requirementId !== index.requirementId
            || parsed.checksum !== index.checksum) {
            return `[retrieve_raw FAILED: archive identity mismatch for ${rawRef}]`;
        }
        if (rawChecksum(parsed.payload) !== parsed.checksum) {
            return `[retrieve_raw FAILED: checksum mismatch for ${rawRef}]`;
        }
        state.metrics.rawRetrievals++;
        return parsed.payload;
    } catch (error) {
        return `[retrieve_raw FAILED: ${String(error)}]`;
    }
}

export function expandOperation(state: WorkflowState, opId: string): string {
    const operation = state.operations[opId];
    if (!operation) return `[expand_operation FAILED: unknown operation ${opId}]`;
    return JSON.stringify(operation, null, 2);
}
