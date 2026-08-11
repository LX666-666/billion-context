import type { OperationType } from "./types.js";

export type OperationClassification = {
    type: OperationType;
    command?: string;
    path?: string;
    workdir?: string;
    paths: string[];
    addedPaths: string[];
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

function stringArrayField(value: Record<string, unknown>, ...keys: string[]): string[] {
    for (const key of keys) {
        const field = value[key];
        if (Array.isArray(field)) return field.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    }
    return [];
}

function booleanField(value: Record<string, unknown>, ...keys: string[]): boolean {
    return keys.some((key) => value[key] === true);
}

function embeddedStringField(text: string, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const pattern = new RegExp(`(?:["']?${key}["']?)\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, "i");
        const match = pattern.exec(text)?.[1];
        if (!match) continue;
        if (match.startsWith('"')) {
            try {
                const value = JSON.parse(match) as unknown;
                if (typeof value === "string" && value.trim()) return value;
            } catch {
                continue;
            }
        }
        const value = match.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        if (value.trim()) return value;
    }
    return undefined;
}

function unique(values: Array<string | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))];
}

function patchPaths(text: string): { paths: string[]; addedPaths: string[] } {
    const paths: string[] = [];
    const addedPaths: string[] = [];
    for (const match of text.matchAll(/^\*\*\*\s+(Add|Update|Delete)\s+File:\s*(.+?)\s*$/gim)) {
        const value = match[2]?.trim();
        if (!value) continue;
        paths.push(value);
        if (match[1]?.toLowerCase() === "add") addedPaths.push(value);
    }
    for (const match of text.matchAll(/^(?:\+\+\+|---)\s+(?:[ab]\/)?([^\t\r\n]+)$/gm)) {
        const value = match[1]?.trim();
        if (value && value !== "/dev/null") paths.push(value);
    }
    return { paths: unique(paths), addedPaths: unique(addedPaths) };
}

function commandPaths(command: string): string[] {
    const paths: string[] = [];
    const token = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s;|]+))`;
    const parameter = new RegExp(String.raw`-(?:LiteralPath|Path)\s+${token}`, "gi");
    for (const match of command.matchAll(parameter)) paths.push(match[1] ?? match[2] ?? match[3] ?? "");
    const direct = new RegExp(String.raw`\b(?:Get-Content|Set-Content|Add-Content|Out-File|cat|type|head|tail)\s+${token}`, "gi");
    for (const match of command.matchAll(direct)) paths.push(match[1] ?? match[2] ?? match[3] ?? "");
    const gitDiff = new RegExp(String.raw`\bgit\s+diff(?:\s+[^\s;|]+)*\s+--\s+${token}`, "gi");
    for (const match of command.matchAll(gitDiff)) paths.push(match[1] ?? match[2] ?? match[3] ?? "");
    return unique(paths.filter((value) => value && !value.startsWith("-")));
}

function classification(
    type: OperationType,
    command: string | undefined,
    path: string | undefined,
    workdir: string | undefined,
    argumentsText: string,
    explicitPaths: string[] = [],
    explicitAddedPaths: string[] = [],
): OperationClassification {
    const patch = type === "PATCH" ? patchPaths(`${command ?? ""}\n${argumentsText}`) : { paths: [], addedPaths: [] };
    const paths = unique([path, ...explicitPaths, ...commandPaths(command ?? ""), ...patch.paths]);
    return {
        type,
        ...(command ? { command } : {}),
        ...(path ? { path } : {}),
        ...(workdir ? { workdir } : {}),
        paths,
        addedPaths: unique([...explicitAddedPaths, ...patch.addedPaths]),
    };
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
    if (/tools\.(?:view_image|read_[a-z0-9_]+)/.test(text)) return "READ";
    if (/\b(set-content|add-content|out-file|new-item|copy-item|move-item)\b|(^|[^>])>{1,2}([^>]|$)/.test(text)) return "WRITE";
    return "RUN";
}

export function classifyOperation(toolName: string, argumentsText: string): OperationClassification {
    const lower = toolName.toLowerCase();
    const args = parseArguments(argumentsText);
    const embeddedCommand = embeddedStringField(argumentsText, "command", "cmd", "script");
    const command = stringField(args, "command", "cmd", "script", "input") ?? embeddedCommand ?? (Object.keys(args).length === 0 ? argumentsText : undefined);
    const path = stringField(args, "path", "file_path", "file") ?? embeddedStringField(argumentsText, "path", "file_path", "file");
    const workdir = stringField(args, "workdir", "cwd") ?? embeddedStringField(argumentsText, "workdir", "cwd");
    const explicitPaths = stringArrayField(args, "paths", "files");
    const patchPayload = stringField(args, "patch", "diff") ?? embeddedStringField(argumentsText, "patch", "diff");
    const createsPath = booleanField(args, "create", "create_new", "new_file")
        || Boolean(command && /\b(?:new-item|touch)\b/i.test(command));
    const addedPaths = createsPath ? unique([path, ...commandPaths(command ?? "")]) : [];
    const source = patchPayload ? `${argumentsText}\n${patchPayload}` : argumentsText;
    if (lower === "update_plan") return classification("PLAN", undefined, undefined, workdir, source, explicitPaths, addedPaths);
    if (lower.includes("apply_patch") || lower === "patch") return classification("PATCH", command, path, workdir, source, explicitPaths, addedPaths);
    if (lower.includes("read") || lower === "view_image") return classification("READ", command, path, workdir, source, explicitPaths, addedPaths);
    if (lower.includes("search") || lower.includes("grep")) return classification("SEARCH", command, path, workdir, source, explicitPaths, addedPaths);
    if (lower.includes("list")) return classification("LIST", command, path, workdir, source, explicitPaths, addedPaths);
    if (lower.includes("write") || lower.includes("edit")) return classification("WRITE", command, path, workdir, source, explicitPaths, addedPaths);
    if (lower.includes("test")) return classification("TEST", command, path, workdir, source, explicitPaths, addedPaths);
    if (lower.includes("build")) return classification("BUILD", command, path, workdir, source, explicitPaths, addedPaths);
    if (lower.includes("install")) return classification("INSTALL", command, path, workdir, source, explicitPaths, addedPaths);
    if (lower.includes("diff")) return classification("DIFF", command, path, workdir, source, explicitPaths, addedPaths);
    if (lower.includes("shell") || lower.includes("exec") || lower === "computer") {
        return classification(command ? classifyCommand(command) : "RUN", command, path, workdir, source, explicitPaths, addedPaths);
    }
    if (lower === "codex" && command) return classification(classifyCommand(command), command, path, workdir, source, explicitPaths, addedPaths);
    return classification("OTHER", command, path, workdir, source, explicitPaths, addedPaths);
}

export function protectsCodeContent(type: OperationType): boolean {
    return type === "READ" || type === "PATCH" || type === "WRITE" || type === "DIFF";
}
