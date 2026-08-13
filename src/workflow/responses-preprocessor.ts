import { createHash } from "node:crypto";
import { responsesToCore, type ResponsesRequestBody, type ResponseInputItem } from "../responses.js";
import type { Session } from "../session.js";
import { applyDeferredRollover, beginWorkflowTurn, checkpointRequest, workflowMemory } from "./context-gc.js";
import { operationForCall, trackOperationCall, updateOperationResult } from "./operation-tracker.js";
import { applyPlanUpdate } from "./plan-tracker.js";
import { extractCodexUpdatePlanCalls } from "./codex-code-mode.js";
import { pruneWithCheapModel } from "./pruner/cheap-model.js";
import { commitSemanticPrune, pruneToolOutput } from "./pruner/index.js";
import { hydrateProjectMemory, runCheapHistorian } from "./project-memory.js";
import { syncRequirements } from "./requirements.js";
import { capturePhaseMessage } from "./state.js";
import { observePhaseBoundaryFallback } from "./phase-boundary.js";
import {
    observeRepositoryOperation,
    refreshRepoBridge,
    repoProjectId,
    repositoryGuardMessage,
    workspaceRootFromText,
} from "./repo-bridge.js";
import type { WorkflowOptions } from "./types.js";
import { isWorkflowItem, isWorkflowResultItem, isWorkflowResultText, isWorkflowText, stripWorkflowMarker } from "./workflow-item.js";
import { classifyRequirementProvenance, isCodexHostContext } from "./provenance.js";

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

const deliveredInternalResults = new WeakMap<Session, Set<string>>();

function internalResultKey(item: ResponseInputItem): string {
    const record = item as Record<string, unknown>;
    if (typeof record.id === "string" && record.id.trim()) return `id:${record.id}`;
    return `body:${createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 24)}`;
}

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

type WorkspaceHints = {
    workspaceRoot?: string;
    repoRoot?: string;
    remoteIdentity?: string;
    head?: string;
    dirty?: boolean;
};

function parseCodexTurnMetadata(body: ResponsesRequestBody): WorkspaceHints {
    const clientMetadata = body.client_metadata ?? body.metadata?.client_metadata;
    if (!clientMetadata || typeof clientMetadata !== "object" || Array.isArray(clientMetadata)) return {};
    const raw = (clientMetadata as Record<string, unknown>)["x-codex-turn-metadata"];
    let value: unknown = raw;
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw);
        } catch {
            return {};
        }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const metadata = value as Record<string, unknown>;
    const workspaces = Array.isArray(metadata.workspaces)
        ? metadata.workspaces
        : metadata.workspaces && typeof metadata.workspaces === "object"
          ? Object.entries(metadata.workspaces as Record<string, unknown>).map(([root, details]) =>
                details && typeof details === "object" && !Array.isArray(details)
                    ? { root, ...(details as Record<string, unknown>) }
                    : root,
            )
          : [];
    const firstWorkspace = workspaces[0];
    const workspaceRoot = typeof firstWorkspace === "string"
        ? firstWorkspace
        : firstWorkspace && typeof firstWorkspace === "object"
          ? ["root", "workspace_root", "path", "cwd"].map((key) => (firstWorkspace as Record<string, unknown>)[key]).find((item): item is string => typeof item === "string" && Boolean(item.trim()))
          : undefined;
    const workspaceDetails = firstWorkspace && typeof firstWorkspace === "object" && !Array.isArray(firstWorkspace)
        ? firstWorkspace as Record<string, unknown>
        : {};
    const repository = metadata.repository && typeof metadata.repository === "object" && !Array.isArray(metadata.repository)
        ? metadata.repository as Record<string, unknown>
        : metadata.repo && typeof metadata.repo === "object" && !Array.isArray(metadata.repo)
          ? metadata.repo as Record<string, unknown>
          : metadata.git && typeof metadata.git === "object" && !Array.isArray(metadata.git)
            ? metadata.git as Record<string, unknown>
          : { ...metadata, ...workspaceDetails };
    const remoteIdentity = ["remote", "remote_url", "remoteUrl", "origin"].map((key) => repository[key]).find((item): item is string => typeof item === "string" && Boolean(item.trim()));
    const head = ["commit", "head", "current_commit", "currentCommit"].map((key) => repository[key]).find((item): item is string => typeof item === "string" && Boolean(item.trim()));
    const dirty = ["has_changes", "hasChanges", "dirty"].map((key) => repository[key]).find((item): item is boolean => typeof item === "boolean");
    return {
        ...(workspaceRoot ? { workspaceRoot: workspaceRoot.trim() } : {}),
        ...(typeof metadata.repo_root === "string" ? { repoRoot: metadata.repo_root } : {}),
        ...(remoteIdentity ? { remoteIdentity } : {}),
        ...(head ? { head } : {}),
        ...(dirty !== undefined ? { dirty } : {}),
    };
}

function hostContextSources(body: ResponsesRequestBody): string[] {
    const sources: string[] = [];
    if (!Array.isArray(body.input)) return sources;
    for (const item of body.input) {
        if (item.type !== "message") continue;
        const record = item as Record<string, unknown>;
        const content = record.content;
        const text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text as string : "").join("\n")
              : "";
        if ((record.role === "system" || record.role === "developer" || record.role === "user") && isCodexHostContext(text)) sources.push(text);
    }
    return sources;
}

function workspaceRoot(body: ResponsesRequestBody): { root?: string; hints: WorkspaceHints } {
    const metadata = body.metadata;
    const codexMetadata = parseCodexTurnMetadata(body);
    let candidate = codexMetadata.workspaceRoot ?? metadata?.project_root ?? metadata?.workspace_root ?? metadata?.cwd;
    if (typeof candidate !== "string" || !candidate.trim()) {
        const sources = [body.instructions, ...hostContextSources(body)];
        if (Array.isArray(body.input)) {
            for (const item of body.input) {
                if (item.type !== "message") continue;
                const record = item as Record<string, unknown>;
                if (record.role !== "system" && record.role !== "developer" && record.role !== "user") continue;
                const content = record.content;
                if (typeof content === "string") {
                    sources.push(content);
                } else if (Array.isArray(content)) {
                    sources.push(content.map((part) => {
                        if (!part || typeof part !== "object") return "";
                        const text = (part as Record<string, unknown>).text;
                        return typeof text === "string" ? text : "";
                    }).join("\n"));
                }
            }
        }
        candidate = workspaceRootFromText(sources);
    }
    return {
        ...(typeof candidate === "string" && candidate.trim() ? { root: candidate.trim() } : {}),
        hints: codexMetadata,
    };
}

function projectIdentity(candidate: string | undefined): string | undefined {
    if (!candidate) return undefined;
    const normalized = candidate.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return `project-${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
}

function workflowItem(content: string): ResponseInputItem {
    return { type: "message", role: "user", content };
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
    const tagReference = /^\s*\x3cacp\b[^>]*\x3e([^<]+)\x3c\/acp\x3e\s*/i.exec(text)?.[1]?.trim();
    const normalized = text.replace(/^\s*\x3cacp\b[^>]*\x3e[^<]+\x3c\/acp\x3e\s*/i, "");
    return `${String(record.role ?? "unknown")}:${tagReference ?? createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
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

function responseItemRole(item: ResponseInputItem): string {
    if (item.type === "message") return String((item as Record<string, unknown>).role ?? "unknown");
    if (item.type === "function_call" || item.type === "custom_tool_call") return "assistant";
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") return "tool";
    return "assistant";
}

function responseItemText(item: ResponseInputItem): string {
    if (item.type === "message") {
        const content = (item as Record<string, unknown>).content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content.map((part) => {
                if (!part || typeof part !== "object") return "";
                const text = (part as Record<string, unknown>).text;
                return typeof text === "string" ? text : "";
            }).join("\n");
        }
    }
    const record = item as Record<string, unknown>;
    return typeof record.arguments === "string"
        ? record.arguments
        : typeof record.input === "string"
          ? record.input
          : typeof record.output === "string"
            ? record.output
            : JSON.stringify(item);
}

function requirementMessageForResponseItem(
    state: Session["workflow"],
    item: ResponseInputItem,
    itemKey: string | undefined,
    sourceRefsByItemKey: Map<string, string>,
): string | undefined {
    if (item.type !== "message" || (item as Record<string, unknown>).role !== "user") return undefined;
    const record = item as Record<string, unknown>;
    const sourceRef = (itemKey ? sourceRefsByItemKey.get(itemKey) : undefined)
        ?? (typeof record.id === "string" ? record.id : undefined);
    if (!sourceRef) return undefined;
    const requirementId = state.requirementBySourceRef[sourceRef];
    return requirementId ? state.requirements[requirementId]?.messageId : undefined;
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
    internalRefresh = false,
): Promise<WorkflowPreprocessResult> {
    if (!Array.isArray(body.input)) {
        return { body, prunedOperations: 0, archivedOperations: 0 };
    }
    const state = session.workflow;
    let internalResults: ResponseInputItem[] = [];
    if (internalRefresh) {
        const seen = deliveredInternalResults.get(session) ?? new Set<string>();
        deliveredInternalResults.set(session, seen);
        internalResults = body.input
            .filter((item) => isWorkflowResultItem(item))
            .filter((item) => {
                const key = internalResultKey(item);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .map(stripWorkflowMarker);
    }
    const clientInput = body.input
        .filter((item) => !isWorkflowItem(item) || (item.type === "message" && (item as Record<string, unknown>).role === "user" && (item as Record<string, unknown>).bili_workflow === true && !isWorkflowText(responseItemText(item)) && !isWorkflowResultText(responseItemText(item))))
        .map(stripWorkflowMarker);
    const cleanBody = { ...body, input: clientInput };
    if (!internalRefresh) {
        beginWorkflowTurn(session.workflow);
        deliveredInternalResults.delete(session);
    }
    if (!options.enabled) {
        return { body: cleanBody, prunedOperations: 0, archivedOperations: 0 };
    }
    const workspaceInfo = workspaceRoot(cleanBody);
    const workspace = workspaceInfo.root ?? options.repoBridge.workspaceRoot;
    refreshRepoBridge(state, workspace, options.repoBridge, workspaceInfo.hints);
    const metadataProjectKey = typeof body.metadata?.projectKey === "string" ? body.metadata.projectKey : undefined;
    state.projectId ??= options.projectKey?.trim()
        || projectIdentity(metadataProjectKey)
        || repoProjectId(state.repoBridge)
        || projectIdentity(workspace);
    if (options.sessionGc) hydrateProjectMemory(session.id, state, options.memory.maxProjectSessions);
    const workflowProjection = responsesToCore(cleanBody);
    syncRequirements(state, workflowProjection.msgs, session.id);
    observePhaseBoundaryFallback(state, workflowProjection.msgs);
    if (options.sessionGc) await runCheapHistorian(session.id, state, options);
    applyDeferredRollover(state, options, session.stats.lastInputTokens || session.stats.contextTokens, modelContextLimit, body.model);
    const sourceInput = clientInput;
    const itemKeys = responseItemKeys(sourceInput);
    const sourceRefsByItemKey = new Map<string, string>();
    const sourceIndexesByItem = new Map<ResponseInputItem, number[]>();
    sourceInput.forEach((item, index) => {
        const indexes = sourceIndexesByItem.get(item) ?? [];
        indexes.push(index);
        sourceIndexesByItem.set(item, indexes);
    });
    workflowProjection.layout.forEach((slot, index) => {
        const sourceIndexes = sourceIndexesByItem.get(slot.original);
        const sourceIndex = sourceIndexes?.shift();
        if (slot.coreId && sourceIndex !== undefined && itemKeys[sourceIndex]) {
            sourceRefsByItemKey.set(itemKeys[sourceIndex], slot.coreId);
        }
    });
    let prunedOperations = 0;
    for (let index = 0; index < sourceInput.length; index++) {
        const item = sourceInput[index];
        const call = callFields(item);
        if (call) {
            const operation = trackOperationCall(state, call.callId, call.name, call.argumentsText);
            assignItemPhase(session, itemKeys[index], operation.phaseId);
            const planCalls = call.name === "update_plan"
                ? [{ callId: call.callId, argumentsText: call.argumentsText }]
                : (call.name === "exec" || call.name === "codex")
                  ? extractCodexUpdatePlanCalls(call.callId, call.argumentsText)
                  : [];
            for (const planCall of planCalls) applyPlanUpdate(state, planCall.callId, planCall.argumentsText);
            observeRepositoryOperation(state, operation, options.repoBridge);
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
    for (let index = 0; index < sourceInput.length; index++) {
        const item = sourceInput[index];
        const itemKey = itemKeys[index];
        const phaseId = state.itemPhaseByKey[itemKey] ?? state.activePhaseId;
        if (!phaseId) continue;
        const call = callFields(item);
        const output = outputFields(item);
        const operation = call
            ? operationForCall(state, call.callId)
            : output
              ? operationForCall(state, output.callId)
              : undefined;
        const requirementMessageId = requirementMessageForResponseItem(state, item, itemKey, sourceRefsByItemKey);
        capturePhaseMessage(state, {
            phaseId,
            messageRef: itemKey,
            role: responseItemRole(item),
            contentType: item.type === "message" ? "text" : item.type,
            payload: JSON.stringify(item),
            operationId: operation?.opId,
            ...(requirementMessageId ? { requirementMessageId } : {}),
        });
        if (operation) {
            const refs = output ? operation.resultRefs : call ? operation.callRefs : undefined;
            if (refs && !refs.includes(itemKey)) refs.push(itemKey);
        }
    }
    const phaseObjective = state.activePhaseId ? state.phases[state.activePhaseId]?.objective : undefined;
    const requirementHint = Object.values(state.requirements)
        .filter((requirement) => requirement.status === "ACTIVE" || requirement.status === "ACTIVE_CURRENT" || requirement.status === "ACTIVE_STABLE")
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
        result = commitSemanticPrune(session.id, state, operation, output.output, result, options.archiveSemanticRaw);
        updateOperationResult(state, operation, result.rawTokens, result.visibleTokens, result.text, output.output);
        if (result.semanticPruned) prunedOperations++;
        transformed.push(result.text === output.output ? item : { ...item, output: result.text });
    }
    const filtered = transformed.filter((item, index) => {
        const call = callFields(item);
        if (call && operationArchived(session, call.callId)) return false;
        const output = outputFields(item);
        if (output && operationArchived(session, output.callId)) return false;
        const requirementMessageId = requirementMessageForResponseItem(state, item, itemKeys[index], sourceRefsByItemKey);
        if (requirementMessageId && state.requirementMessages[requirementMessageId]?.lifecycle === "ARCHIVED") return false;
        const phaseId = state.itemPhaseByKey[itemKeys[index]];
        const phaseMessage = state.phaseMessages[itemKeys[index]];
        return !(phaseId
            && state.phases[phaseId]?.status === "ARCHIVED"
            && phaseMessage?.lifecycle === "ARCHIVED"
            && phaseItemCanDrop(item));
    });
    const memory = workflowMemory(state, options.rereadAfterPhase, options.memory.maxInjectedTokens);
    filtered.push(...internalResults);
    if (memory) filtered.push(workflowItem(memory));
    const request = checkpointRequest(state, textProtocol);
    if (request) filtered.push(workflowItem(request));
    const guard = repositoryGuardMessage(state);
    if (guard) filtered.push(workflowItem(guard));
    return {
        body: { ...cleanBody, input: filtered.map(stripWorkflowMarker) },
        prunedOperations,
        archivedOperations: Object.values(state.operations).filter((operation) => operation.lifecycle === "ARCHIVED").length,
    };
}
