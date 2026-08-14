import type { BiliMessage } from "../bili-message.js";
import type { Session } from "../session.js";
import { applyDeferredRollover, beginWorkflowTurn, checkpointRequest, workflowMemory } from "./context-gc.js";
import { attachOperationMessageRefs, observeCodexNestedOperations, operationForCall, trackOperationCall, updateOperationResult } from "./operation-tracker.js";
import { applyPlanUpdate } from "./plan-tracker.js";
import { extractCodexUpdatePlanCalls } from "./codex-code-mode.js";
import { pruneWithCheapModel } from "./pruner/cheap-model.js";
import { commitSemanticPrune, pruneToolOutput } from "./pruner/index.js";
import { hydrateProjectMemory, runCheapHistorian } from "./project-memory.js";
import { syncRequirements } from "./requirements.js";
import { requirementMessageCanDrop } from "./requirements.js";
import { ingestRequirementDocumentForOperation, registerPendingRequirementDocuments } from "./requirement-document.js";
import { capturePhaseMessage } from "./state.js";
import { observePhaseBoundaryFallback } from "./phase-boundary.js";
import type { WorkflowOptions } from "./types.js";
import { observeRepositoryOperation, refreshRepoBridge, repoProjectId, repositoryGuardMessage, workspaceRootFromText } from "./repo-bridge.js";
import { isWorkflowMessage } from "./workflow-item.js";
import { executionSupervisorNudge } from "./execution-supervisor.js";

export async function preprocessCoreWorkflow(
    messages: BiliMessage[],
    session: Session,
    options: WorkflowOptions,
    workspaceSource?: string,
    modelContextLimit = 0,
    model?: string,
): Promise<BiliMessage[]> {
    if (!options.enabled) return messages;
    beginWorkflowTurn(session.workflow);
    const workspace = workspaceRootFromText([
        workspaceSource,
        ...messages.filter((message) => message.role === "system").map((message) => message.text),
    ]);
    refreshRepoBridge(session.workflow, workspace ?? options.repoBridge.workspaceRoot, options.repoBridge);
    session.workflow.projectId ??= options.projectKey?.trim() || repoProjectId(session.workflow.repoBridge);
    if (options.sessionGc) hydrateProjectMemory(session.id, session.workflow, options.memory.maxProjectSessions);
    syncRequirements(session.workflow, messages, session.id);
    registerPendingRequirementDocuments(session.workflow, messages, session.id, workspace ?? options.repoBridge.workspaceRoot);
    observePhaseBoundaryFallback(session.workflow, messages);
    if (options.sessionGc) await runCheapHistorian(session.id, session.workflow, options);
    applyDeferredRollover(session.workflow, options, session.stats.lastInputTokens || session.stats.contextTokens, modelContextLimit, model);
    for (const message of messages) {
        if (message.contentType !== "tool-call" || !message.toolCallId) continue;
        const operation = trackOperationCall(session.workflow, message.toolCallId, message.toolName ?? "unknown", message.text ?? "{}");
        const planCalls = message.toolName === "update_plan"
            ? [{ callId: message.toolCallId, argumentsText: message.text ?? "{}" }]
            : (message.toolName === "exec" || message.toolName === "codex")
              ? extractCodexUpdatePlanCalls(message.toolCallId, message.text ?? "")
              : [];
        for (const planCall of planCalls) applyPlanUpdate(session.workflow, planCall.callId, planCall.argumentsText);
        observeRepositoryOperation(session.workflow, operation, options.repoBridge);
        observeCodexNestedOperations(session.workflow, operation, options.repoBridge);
    }
    for (const message of messages) {
        const operation = message.toolCallId ? operationForCall(session.workflow, message.toolCallId) : undefined;
        const phaseId = operation?.phaseId ?? session.workflow.itemPhaseByKey[message.id] ?? session.workflow.activePhaseId;
        if (!phaseId || isWorkflowMessage(message)) continue;
        session.workflow.itemPhaseByKey[message.id] = phaseId;
        const requirementId = message.role === "user" ? session.workflow.requirementBySourceRef[message.id] : undefined;
        const requirementMessageId = requirementId ? session.workflow.requirements[requirementId]?.messageId : undefined;
        capturePhaseMessage(session.workflow, {
            phaseId,
            messageRef: message.id,
            role: message.role,
            contentType: message.contentType,
            payload: message.text ?? "",
            operationId: operation?.opId,
            ...(requirementMessageId ? { requirementMessageId } : {}),
        });
    }
    const phaseObjective = session.workflow.activePhaseId
        ? session.workflow.phases[session.workflow.activePhaseId]?.objective
        : undefined;
    const requirementHint = Object.values(session.workflow.requirements)
        .filter((requirement) => requirement.status === "ACTIVE" || requirement.status === "ACTIVE_CURRENT" || requirement.status === "ACTIVE_STABLE")
        .map((requirement) => `${requirement.id}: ${requirement.detail}`)
        .join("\n")
        .slice(0, 4_000);
    const transformed: BiliMessage[] = [];
    for (const message of messages) {
        if (message.contentType !== "tool-result" || !message.toolCallId) {
            transformed.push(message);
            continue;
        }
        const operation = operationForCall(session.workflow, message.toolCallId)
            ?? trackOperationCall(session.workflow, message.toolCallId, "unknown", "{}");
        if (operation.lifecycle === "ARCHIVED") {
            transformed.push(message);
            continue;
        }
        const raw = message.text ?? "";
        if (operation.type === "READ") {
            ingestRequirementDocumentForOperation(session.workflow, operation, raw, session.id, workspace ?? options.repoBridge.workspaceRoot);
        }
        let result = pruneToolOutput(operation, raw, options);
        result = await pruneWithCheapModel(operation, result, options, { phaseObjective, requirementHint });
        result = commitSemanticPrune(session.id, session.workflow, operation, raw, result, options.archiveSemanticRaw);
        updateOperationResult(session.workflow, operation, result.rawTokens, result.visibleTokens, result.text, raw);
        transformed.push(result.text === raw ? message : { ...message, text: result.text });
    }
    const filtered = transformed.filter((message) => {
        if (message.toolCallId && (message.contentType === "tool-call" || message.contentType === "tool-result")) {
            if (operationForCall(session.workflow, message.toolCallId)?.lifecycle === "ARCHIVED") return false;
        }
        const phaseId = session.workflow.itemPhaseByKey[message.id];
        if (message.role === "user" && requirementMessageCanDrop(session.workflow, message.id)) return false;
        const phaseMessage = session.workflow.phaseMessages[message.id];
        return !(phaseId
            && session.workflow.phases[phaseId]?.status === "ARCHIVED"
            && phaseMessage?.lifecycle === "ARCHIVED");
    });
    const tails = [
        workflowMemory(session.workflow, options.rereadAfterPhase, options.memory.maxInjectedTokens),
        checkpointRequest(session.workflow, false),
        repositoryGuardMessage(session.workflow),
        executionSupervisorNudge(session.workflow),
    ].filter((value): value is string => Boolean(value));
    for (const [index, tail] of tails.entries()) {
        filtered.push({
            id: `workflow_tail_${Date.now()}_${index}`,
            role: "user",
            contentType: "text",
            text: tail,
        });
    }
    attachOperationMessageRefs(session.workflow, filtered);
    return filtered;
}
