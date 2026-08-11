import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { estimateTokensFast } from "acp-kernel";
import { dataDir } from "../paths.js";
import { log as loggerLog } from "../logger.js";
import type { OperationRecord, RequirementRecord, WorkflowState } from "./types.js";

type RawArchiveRecord = {
    rawRef: string;
    sessionId: string;
    projectId?: string;
    phaseId?: string;
    opId?: string;
    requirementId?: string;
    type: OperationRecord["type"] | "REQUIREMENT";
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

export function archiveOperationOutput(
    sessionId: string,
    state: WorkflowState,
    operation: OperationRecord,
    payload: string,
    tokenCount: number,
): string | undefined {
    const checksum = rawChecksum(payload);
    if (operation.rawRef && operation.rawChecksum === checksum && state.rawArchive[operation.rawRef]) {
        if (existsSync(archiveFile(sessionId, operation.rawRef))) return operation.rawRef;
        delete state.rawArchive[operation.rawRef];
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
        const dir = sessionArchiveDir(sessionId);
        mkdirSync(dir, { recursive: true });
        const destination = archiveFile(sessionId, rawRef);
        const temporary = path.join(dir, `.tmp-${rawRef}-${process.pid}-${Date.now()}.json`);
        writeFileSync(temporary, JSON.stringify(record), "utf8");
        renameSync(temporary, destination);
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
        if (existsSync(archiveFile(sessionId, requirement.rawRef))) return requirement.rawRef;
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
        const dir = sessionArchiveDir(sessionId);
        mkdirSync(dir, { recursive: true });
        const destination = archiveFile(sessionId, rawRef);
        const temporary = path.join(dir, `.tmp-${rawRef}-${process.pid}-${Date.now()}.json`);
        writeFileSync(temporary, JSON.stringify(record), "utf8");
        renameSync(temporary, destination);
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
        return rawRef;
    } catch (error) {
        loggerLog("warn", `[workflow-archive] could not store ${rawRef}: ${String(error)}`);
        return undefined;
    }
}

export function retrieveRawOutput(sessionId: string, state: WorkflowState, rawRef: string): string {
    if (!state.rawArchive[rawRef]) return `[retrieve_raw FAILED: unknown raw_ref ${rawRef}]`;
    try {
        const parsed = JSON.parse(readFileSync(archiveFile(sessionId, rawRef), "utf8")) as RawArchiveRecord;
        if (parsed.rawRef !== rawRef || parsed.sessionId !== sessionId) {
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
