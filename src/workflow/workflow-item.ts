import type { BiliMessage } from "../bili-message.js";
import type { ResponseInputItem } from "../responses.js";

const WORKFLOW_ENVELOPE_PATTERN = /^\s*<(workflow-checkpoint-request|workflow-memory|workflow-repository-guard)>[\s\S]*<\/\1>\s*$/;
const WORKFLOW_RESULT_PATTERN = /^\s*<workflow-internal-result>[\s\S]*<\/workflow-internal-result>\s*$/;

function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => {
        if (!part || typeof part !== "object") return "";
        const text = (part as Record<string, unknown>).text;
        return typeof text === "string" ? text : "";
    }).join("\n");
}

export function isWorkflowText(text: string | undefined): boolean {
    return Boolean(text && WORKFLOW_ENVELOPE_PATTERN.test(text));
}

export function isWorkflowResultText(text: string | undefined): boolean {
    return Boolean(text && WORKFLOW_RESULT_PATTERN.test(text));
}

export function buildWorkflowResultText(toolName: string, result: string): string {
    return `<workflow-internal-result>${JSON.stringify({ toolName, result })}</workflow-internal-result>`;
}

export function isWorkflowInstructionItem(item: ResponseInputItem): boolean {
    if ((item as Record<string, unknown>).bili_workflow === true) return true;
    if (item.type !== "message") return false;
    const record = item as Record<string, unknown>;
    return record.role === "user" && isWorkflowText(contentText(record.content));
}

export function isWorkflowResultItem(item: ResponseInputItem): boolean {
    if (item.type !== "message") return false;
    const record = item as Record<string, unknown>;
    return (record.role === "user" || record.role === "assistant") && isWorkflowResultText(contentText(record.content));
}

export function isWorkflowItem(item: ResponseInputItem): boolean {
    return isWorkflowInstructionItem(item) || isWorkflowResultItem(item);
}

export function isWorkflowMessage(message: BiliMessage): boolean {
    if (message.contentType !== "text") return false;
    if (isWorkflowResultText(message.text)) return true;
    if (message.role !== "user") return false;
    if (isWorkflowText(message.text)) return true;
    const raw = message.rawResponsesItem;
    return Boolean(raw && typeof raw === "object" && (raw as Record<string, unknown>).bili_workflow === true);
}

export function stripWorkflowMarker(item: ResponseInputItem): ResponseInputItem {
    if (!("bili_workflow" in item)) return item;
    const { bili_workflow: _biliWorkflow, ...clean } = item;
    return clean as ResponseInputItem;
}
