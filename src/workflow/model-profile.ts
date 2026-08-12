import type { WorkflowOptions } from "./types.js";

function globMatches(pattern: string, model: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(model);
}

export function resolveTargetContextRatio(options: WorkflowOptions, model?: string): number {
    if (!model || !options.models) return options.targetContextRatio;
    const exact = Object.entries(options.models).find(([name]) => name.toLowerCase() === model.toLowerCase());
    if (exact) return exact[1].targetRatio ?? exact[1].targetContextRatio ?? options.targetContextRatio;
    const glob = Object.entries(options.models)
        .filter(([pattern]) =>
            (pattern.includes("*") && globMatches(pattern, model))
            || (!pattern.includes("*") && model.toLowerCase().startsWith(pattern.toLowerCase())),
        )
        .sort(([left], [right]) => right.replace(/\*/g, "").length - left.replace(/\*/g, "").length)[0];
    return glob?.[1].targetRatio ?? glob?.[1].targetContextRatio ?? options.targetContextRatio;
}
