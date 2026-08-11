import type { BiliMessage } from "../bili-message.js";
import { archiveRequirementMessage } from "./archive.js";
import type { RequirementRecord, WorkflowState } from "./types.js";

function importance(detail: string): RequirementRecord["importance"] {
    return /(?:\b(?:must|never|critical|forbid)\b|禁止|必须|绝不|优先级)/i.test(detail) ? "CRITICAL" : "NORMAL";
}

export function syncRequirements(state: WorkflowState, messages: BiliMessage[], sessionId?: string): RequirementRecord[] {
    const created: RequirementRecord[] = [];
    for (const message of messages) {
        if (message.role !== "user" || message.contentType !== "text" || !message.text?.trim()) continue;
        const raw = message.rawResponsesItem;
        if (raw && typeof raw === "object" && (raw as Record<string, unknown>).bili_workflow === true) continue;
        if (state.requirementBySourceRef[message.id]) continue;
        const id = `REQ-${String(state.nextRequirementNumber++).padStart(5, "0")}`;
        const requirement: RequirementRecord = {
            id,
            sourceRefs: [message.id],
            detail: message.text,
            status: "ACTIVE",
            importance: importance(message.text),
            preserveRaw: true,
            createdAt: Date.now(),
        };
        state.requirements[id] = requirement;
        state.requirementBySourceRef[message.id] = id;
        if (sessionId && requirement.preserveRaw) archiveRequirementMessage(sessionId, state, requirement, message.text);
        created.push(requirement);
    }
    return created;
}
