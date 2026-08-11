import { createHash } from "node:crypto";
import type { ResponsesRequestBody, ResponseInputItem } from "../responses.js";
import type { Session } from "../session.js";
import { archiveOperationOutput } from "./archive.js";
import { applyDeferredRollover, checkpointRequest, workflowMemory } from "./context-gc.js";
import { operationForCall, trackOperationCall, updateOperationResult } from "./operation-tracker.js";
import { applyPlanUpdate } from "./plan-tracker.js";
import { pruneWithCheapModel } from "./pruner/cheap-model.js";
import { attachRawReference, pruneToolOutput } from "./pruner/index.js";
import { hydrateProjectMemory } from "./project-memory.js";
import type { WorkflowOptions } from "./types.js";

export type WorkflowPreprocessResult = {
    body: ResponsesRequestBody;
    prunedOperations: number;
    archivedOperations: number;
};

type CallFields = {
    callId: string;
    name: string;
    argumentsText: string;
};

function callFields(item: ResponseInputItem): CallFields | undefined {
    const record = item as Record<string, unknown>;
    if (item.type !== "function_call" && item.type !== "custom_tool_call") return undefined;
    const callId = record.call_id;
    const name = record.name;
    const argumentsValue = item.type === "custom_tool_call" ? record.input ?? record.arguments : record.arguments;
    if (typeof callId !== "string" || typeof name !== "string") return undefined;
    return {
        callId,
        name,
        argumentsText: typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue ?? {}),
    };
}

function outputFields(item: ResponseInputItem): { callId: string; output: string } | undefined {
    if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.call_id !== "string") return undefined;
    return {
        callId: record.call_id,
        output: typeof record.output === "string" ? record.output : JSON.stringify(record.output ?? ""),
    };
}

function projectIdentity(body: ResponsesRequestBody, configured?: string): string | undefined {
    if (configured?.trim()) return configured.trim();
    const metadata = body.metadata;
    let candidate = metadata?.projectKey ?? metadata?.project_root ?? metadata?.workspace_root ?? metadata?.cwd;
    if (typeof candidate !== "string" || !candidate.trim()) {
        const sources = [body.instructions];
        if (Array.isArray(body.input)) {
            for (const item of body.input) {
                if (item.type !== "message") continue;
                const content = (item as Record<string, unknown>).content;
                if (typeof content === "string") sources.push(content);
            }
        }
        for (const source of sources) {
            if (typeof source !== "string") continue;
            const match = /\x3ccwd\x3e([^<]+)\x3c\/cwd\x3e/i.exec(source);
            if (match?.[1]?.trim()) {
                candidate = match[1];
                break;
            }
        }
    }
    if (typeof candidate !== "string" || !candidate.trim()) return undefined;
    const normalized = candidate.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return `project-${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
}

function workflowItem(content: string): ResponseInputItem {
    return { type: "message", role: "user", content, bili_workflow: true };
}

function messageIdentity(item: ResponseInputItem): string | undefined {
    if (item.type !== "message") return undefined;
    const record = item as Record<string, unknown>;
    const content = record.content;
    const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => {
                if (!part || typeof part !== "object") return "";
                const value = (part as Record<string, unknown>).text;
                return typeof value === "string" ? value : "";
            }).join("\n")
          : "";
    const normalized = text.replace(/^\s*\x3cacp\b[^>]*\x3e[^<]+\x3c\/acp\x3e\s*/i, "");
    return `${String(record.role ?? "unknown")}:${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
}

function responseItemKeys(items: ResponseInputItem[]): string[] {
    const counts = new Map<string, number>();
    return items.map((item) => {
        const record = item as Record<string, unknown>;
        const message = messageIdentity(item);
        const identity = typeof record.id === "string"
            ? `${item.type}:id:${record.id}`
            : typeof record.call_id === "string"
              ? `${item.type}:call:${record.call_id}`
              : message
                ? `${item.type}:message:${message}`
              : `${item.type}:hash:${createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 20)}`;
        const count = (counts.get(identity) ?? 0) + 1;
        counts.set(identity, count);
        return `${identity}:${count}`;
    });
}

function assignItemPhase(session: Session, itemKey: string, phaseId: string | undefined): void {
    if (!phaseId || session.workflow.itemPhaseByKey[itemKey]) return;
    const phase = session.workflow.phases[phaseId];
    if (!phase) return;
    session.workflow.itemPhaseByKey[itemKey] = phaseId;
    if (!phase.itemKeys.includes(itemKey)) phase.itemKeys.push(itemKey);
}

function phaseItemCanDrop(item: ResponseInputItem): boolean {
    if (item.type === "message") return (item as Record<string, unknown>).role === "assistant";
    if (item.type === "function_call" || item.type === "function_call_output") return false;
    if (item.type === "custom_tool_call" || item.type === "custom_tool_call_output") return false;
    return item.type !== "additional_tools" && item.type !== "mcp_list_tools";
}

function operationArchived(session: Session, callId: string): boolean {
    return operationForCall(session.workflow, callId)?.lifecycle === "ARCHIVED";
}

export async function preprocessResponsesWorkflow(
    body: ResponsesRequestBody,
    session: Session,
    options: WorkflowOptions,
    modelContextLimit: number,
    textProtocol: boolean,
): Promise<WorkflowPreprocessResult> {
    if (!options.enabled || !Array.isArray(body.input)) {
        return { body, prunedOperations: 0, archivedOperations: 0 };
    }
    const state = session.workflow;
    state.projectId ??= projectIdentity(body, options.projectKey);
    if (options.sessionGc) hydrateProjectMemory(session.id, state);
    applyDeferredRollover(state, options, session.stats.contextTokens, modelContextLimit);
    const sourceInput = body.input.filter((item) => {
        return !((item as Record<string, unknown>).bili_workflow === true);
    });
    const itemKeys = responseItemKeys(sourceInput);
    let prunedOperations = 0;
    for (let index = 0; index < sourceInput.length; index++) {
        const item = sourceInput[index];
        const call = callFields(item);
        if (call) {
            const operation = trackOperationCall(state, call.callId, call.name, call.argumentsText);
            assignItemPhase(session, itemKeys[index], operation.phaseId);
            if (call.name === "update_plan") applyPlanUpdate(state, call.callId, call.argumentsText);
            continue;
        }
        const output = outputFields(item);
        if (output) {
            const operation = operationForCall(state, output.callId)
                ?? trackOperationCall(state, output.callId, "unknown", "{}");
            assignItemPhase(session, itemKeys[index], operation.phaseId);
            continue;
        }
        assignItemPhase(session, itemKeys[index], state.activePhaseId);
    }
    const phaseObjective = state.activePhaseId ? state.phases[state.activePhaseId]?.objective : undefined;
    const requirementHint = Object.values(state.requirements)
        .filter((requirement) => requirement.status === "ACTIVE")
        .map((requirement) => `${requirement.id}: ${requirement.detail}`)
        .join("\n")
        .slice(0, 4_000);
    const transformed: ResponseInputItem[] = [];
    for (const item of sourceInput) {
        const output = outputFields(item);
        if (!output) {
            transformed.push(item);
            continue;
        }
        const operation = operationForCall(state, output.callId)
            ?? trackOperationCall(state, output.callId, "unknown", "{}");
        if (operation.lifecycle === "ARCHIVED") {
            transformed.push(item);
            continue;
        }
        let result = pruneToolOutput(operation, output.output, options);
        result = await pruneWithCheapModel(operation, result, options, { phaseObjective, requirementHint });
        if (result.semanticPruned && options.archiveSemanticRaw) {
            const rawRef = archiveOperationOutput(session.id, state, operation, output.output, result.rawTokens);
            if (rawRef) result = attachRawReference(result, rawRef);
        }
        updateOperationResult(state, operation, result.rawTokens, result.visibleTokens);
        if (result.semanticPruned) prunedOperations++;
        transformed.push(result.text === output.output ? item : { ...item, output: result.text });
    }
    const filtered = transformed.filter((item, index) => {
        const call = callFields(item);
        if (call && operationArchived(session, call.callId)) return false;
        const output = outputFields(item);
        if (output && operationArchived(session, output.callId)) return false;
        const phaseId = state.itemPhaseByKey[itemKeys[index]];
        return !(phaseId && state.phases[phaseId]?.status === "ARCHIVED" && phaseItemCanDrop(item));
    });
    const memory = workflowMemory(state, options.rereadAfterPhase);
    if (memory) filtered.push(workflowItem(memory));
    const request = checkpointRequest(state, textProtocol);
    if (request) filtered.push(workflowItem(request));
    return {
        body: { ...body, input: filtered },
        prunedOperations,
        archivedOperations: Object.values(state.operations).filter((operation) => operation.lifecycle === "ARCHIVED").length,
    };
}
