import type { OperationType } from "./types.js";

export type OperationClassification = {
    type: OperationType;
    command?: string;
    path?: string;
};

function parseArguments(argumentsText: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(argumentsText) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const field = value[key];
        if (typeof field === "string" && field.trim()) return field;
    }
    return undefined;
}

function classifyCommand(command: string): OperationType {
    const text = command.toLowerCase();
    if (/\b(apply_patch|patch)\b|git\s+apply/.test(text)) return "PATCH";
    if (/\b(git\s+diff|diff\s+--|compare-object)\b/.test(text)) return "DIFF";
    if (/\b(npm|pnpm|yarn|bun)\s+(ci|install|add)\b|\b(pip|uv)\s+install\b|\bcargo\s+install\b|\bdotnet\s+(add|restore)\b/.test(text)) return "INSTALL";
    if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(pytest|cargo\s+test|dotnet\s+test|go\s+test|node\s+--test)\b/.test(text)) return "TEST";
    if (/\b(npm|pnpm|yarn|bun)\s+run\s+(build|typecheck)\b|\b(tsc|cargo\s+build|dotnet\s+build|go\s+build|cmake\s+--build|make)(\s|$)/.test(text)) return "BUILD";
    if (/\b(rg|grep|findstr|select-string)\b/.test(text)) return "SEARCH";
    if (/\b(get-childitem|ls|dir|find)\b/.test(text)) return "LIST";
    if (/\b(get-content|type|cat|sed|head|tail)\b/.test(text)) return "READ";
    if (/\b(set-content|add-content|out-file|new-item|copy-item|move-item)\b|(^|[^>])>{1,2}([^>]|$)/.test(text)) return "WRITE";
    return "RUN";
}

export function classifyOperation(toolName: string, argumentsText: string): OperationClassification {
    const lower = toolName.toLowerCase();
    const args = parseArguments(argumentsText);
    const command = stringField(args, "command", "cmd", "script", "input") ?? (Object.keys(args).length === 0 ? argumentsText : undefined);
    const path = stringField(args, "path", "file_path", "file", "workdir", "cwd");
    if (lower === "update_plan") return { type: "PLAN" };
    if (lower.includes("apply_patch") || lower === "patch") return { type: "PATCH", path };
    if (lower.includes("read") || lower === "view_image") return { type: "READ", path };
    if (lower.includes("search") || lower.includes("grep")) return { type: "SEARCH", path };
    if (lower.includes("list")) return { type: "LIST", path };
    if (lower.includes("write") || lower.includes("edit")) return { type: "WRITE", path };
    if (lower.includes("test")) return { type: "TEST", command, path };
    if (lower.includes("build")) return { type: "BUILD", command, path };
    if (lower.includes("install")) return { type: "INSTALL", command, path };
    if (lower.includes("diff")) return { type: "DIFF", command, path };
    if (lower.includes("shell") || lower.includes("exec") || lower === "computer") {
        return { type: command ? classifyCommand(command) : "RUN", command, path };
    }
    if (lower === "codex" && command) return { type: classifyCommand(command), command, path };
    return { type: "OTHER", command, path };
}

export function protectsCodeContent(type: OperationType): boolean {
    return type === "READ" || type === "PATCH" || type === "WRITE" || type === "DIFF";
}
