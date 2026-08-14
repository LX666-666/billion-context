export function buildVisibilityMarker(toolName: string, result: string): string {
    if (toolName === "workflow_checkpoint" && result.includes("workflow_checkpoint REJECTED")) {
        return "\n❌ [ACP] workflow_checkpoint rejected; evidence is incomplete. Retry once with the missing evidence, then continue in a later turn.\n";
    }
    const lines = result.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const failed = lines.some((l) =>
        l.includes("FAILED")
        || l.includes("not found")
        || l.includes("is required")
        || l.includes("No blocks matched")
    );
    const icons: Record<string, string> = {
        compress: "📦",
        decompress: "📤",
        search_context: "🔍",
        acp_status: "📊",
    };
    const icon = failed ? "❌" : (icons[toolName] ?? "📦");

    if (toolName === "acp_status") {
        return `\n${icon} [ACP] acp_status result:\n${result.trim()}\n`;
    }

    const inner = (lines[0] ?? "").replace(/^\[/, "").replace(/\]$/, "").trim();
    return `\n${icon} [ACP] ${inner}\n`;
}
