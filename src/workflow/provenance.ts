import type { RequirementProvenance } from "./types.js";

export type { RequirementProvenance } from "./types.js";

function textValue(value: string): string {
    return value.replace(/^\s*\x3cacp\b[^>]*\x3e[^<]*\x3c\/acp\x3e\s*/i, "").trim();
}

export function classifyRequirementProvenance(text: string, internal = false): RequirementProvenance {
    if (internal || /\x3cworkflow-(?:checkpoint-request|memory|repository-guard|internal-result)\x3e/i.test(text)) {
        return "INTERNAL_WORKFLOW";
    }
    const value = textValue(text);
    if (/\x3cenvironment_context\x3e|\x3chost_context\x3e|\x3ccwd\x3e/i.test(value)) {
        return "ENVIRONMENT_CONTEXT";
    }
    if (/#\s*AGENTS\.md\s+instructions?|\bPROJECT_INSTRUCTIONS\b|<project_instructions>/i.test(value)) {
        return "PROJECT_INSTRUCTIONS";
    }
    if (/<recommended_plugins>|<available_plugins>|<system_instructions>|<host_context>/i.test(value)) {
        return "HOST_CONTEXT";
    }
    return "REAL_USER_REQUIREMENT";
}

export function isRealUserRequirement(provenance: RequirementProvenance | undefined): boolean {
    return provenance === undefined || provenance === "REAL_USER_REQUIREMENT";
}

export function isCodexHostContext(text: string): boolean {
    const value = textValue(text);
    return /\x3cenvironment_context\x3e|\x3chost_context\x3e|\x3crecommended_plugins\x3e|#\s*AGENTS\.md\s+instructions?/i.test(value);
}
