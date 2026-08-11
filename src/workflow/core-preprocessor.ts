import type { BiliMessage } from "../bili-message.js";
import type { Session } from "../session.js";
import { archiveOperationOutput } from "./archive.js";
import { applyDeferredRollover, checkpointRequest, workflowMemory } from "./context-gc.js";
import { attachOperationMessageRefs, operationForCall, trackOperationCall, updateOperationResult } from "./operation-tracker.js";
import { applyPlanUpdate } from "./plan-tracker.js";
import { hydrateProjectMemory } from "./project-memory.js";
import { pruneWithCheapModel } from "./pruner/cheap-model.js";
import { attachRawReference, pruneToolOutput } from "./pruner/index.js";
import { syncRequirements } from "./requirements.js";
import type { WorkflowOptions } from "./types.js";
import { observeRepositoryOperation, refreshRepoBridge, repoProjectId, repositoryGuardMessage, workspaceRootFromText } from "./repo-bridge.js";

export async function preprocessCoreWorkflow(
    messages: BiliMessage[],
    session: Session,
    options: WorkflowOptions,
    workspaceSource?: string,
    modelContextLimit = 0,
): Promise<BiliMessage[]> {
    if (!options.enabled) return messages;
    const workspace = workspaceRootFromText([
        workspaceSource,
        ...messages.filter((message) => message.role === "system").map((message) => message.text),
    ]);
    refreshRepoBridge(session.workflow, workspace ?? options.repoBridge.workspaceRoot, options.repoBridge);
    session.workflow.projectId ??= options.projectKey?.trim() || repoProjectId(session.workflow.repoBridge);
    if (options.sessionGc) hydrateProjectMemory(session.id, session.workflow);
    applyDeferredRollover(session.workflow, options, session.stats.contextTokens, modelContextLimit);
    for (const message of messages) {
        if (message.contentType !== "tool-call" || !message.toolCallId) continue;
        const operation = trackOperationCall(session.workflow, message.toolCallId, message.toolName ?? "unknown", message.text ?? "{}");
        if (message.toolName === "update_plan") applyPlanUpdate(session.workflow, message.toolCallId, message.text ?? "{}");
        observeRepositoryOperation(session.workflow, operation, options.repoBridge);
    }
    const phaseObjective = session.workflow.activePhaseId
        ? session.workflow.phases[session.workflow.activePhaseId]?.objective
        : undefined;
    const requirementHint = Object.values(session.workflow.requirements)
        .filter((requirement) => requirement.status === "ACTIVE")
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
        let result = pruneToolOutput(operation, raw, options);
        result = await pruneWithCheapModel(operation, result, options, { phaseObjective, requirementHint });
        if (result.semanticPruned && options.archiveSemanticRaw) {
            const rawRef = archiveOperationOutput(session.id, session.workflow, operation, raw, result.rawTokens);
            if (rawRef) result = attachRawReference(result, rawRef);
        }
        updateOperationResult(session.workflow, operation, result.rawTokens, result.visibleTokens);
        transformed.push(result.text === raw ? message : { ...message, text: result.text });
    }
    const filtered = transformed.filter((message) => {
        if (!message.toolCallId || (message.contentType !== "tool-call" && message.contentType !== "tool-result")) return true;
        return operationForCall(session.workflow, message.toolCallId)?.lifecycle !== "ARCHIVED";
    });
    const tails = [
        workflowMemory(session.workflow, options.rereadAfterPhase),
        checkpointRequest(session.workflow, false),
        repositoryGuardMessage(session.workflow),
    ].filter((value): value is string => Boolean(value));
    for (const [index, tail] of tails.entries()) {
        filtered.push({
            id: `workflow_tail_${Date.now()}_${index}`,
            role: "user",
            contentType: "text",
            text: tail,
            rawResponsesItem: { bili_workflow: true },
        });
    }
    attachOperationMessageRefs(session.workflow, filtered);
    syncRequirements(session.workflow, filtered, session.id);
    return filtered;
}
