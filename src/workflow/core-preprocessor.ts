import type { BiliMessage } from "../bili-message.js";
import type { Session } from "../session.js";
import { archiveOperationOutput } from "./archive.js";
import { attachOperationMessageRefs, operationForCall, trackOperationCall, updateOperationResult } from "./operation-tracker.js";
import { pruneWithCheapModel } from "./pruner/cheap-model.js";
import { attachRawReference, pruneToolOutput } from "./pruner/index.js";
import { syncRequirements } from "./requirements.js";
import type { WorkflowOptions } from "./types.js";

export async function preprocessCoreWorkflow(
    messages: BiliMessage[],
    session: Session,
    options: WorkflowOptions,
): Promise<BiliMessage[]> {
    if (!options.enabled) return messages;
    session.workflow.projectId ??= options.projectKey;
    for (const message of messages) {
        if (message.contentType !== "tool-call" || !message.toolCallId) continue;
        trackOperationCall(session.workflow, message.toolCallId, message.toolName ?? "unknown", message.text ?? "{}");
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
    attachOperationMessageRefs(session.workflow, filtered);
    syncRequirements(session.workflow, filtered, session.id);
    return filtered;
}
