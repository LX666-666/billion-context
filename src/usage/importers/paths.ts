/**
 * Per-client log root resolution for offline usage importers.
 *
 * Each AI coding CLI writes session transcripts to a well-known directory.
 * Importers honor environment overrides first (matching each CLI's own
 * config semantics), then fall back to the conventional per-OS location.
 */

import { homedir } from "node:os";
import path from "node:path";

function envDir(varName: string): string | undefined {
    const v = process.env[varName];
    return v && v.length > 0 ? path.resolve(v) : undefined;
}

/** Claude Code session transcripts root: `~/.claude`. */
export function claudeHome(): string {
    return envDir("CLAUDE_CONFIG_DIR") ?? path.join(homedir(), ".claude");
}

/** Claude Code projects dir, scanned by the importer. */
export function claudeProjectsDir(): string {
    return envDir("BILI_CLAUDE_PROJECTS_DIR") ?? path.join(claudeHome(), "projects");
}

/** Codex CLI config home: `~/.codex` or `$CODEX_HOME`. */
export function codexHome(): string {
    return envDir("CODEX_HOME") ?? path.join(homedir(), ".codex");
}

/** Codex live session rollouts. */
export function codexSessionsDir(): string {
    return path.join(codexHome(), "sessions");
}

/** Codex archived rollouts. */
export function codexArchivedSessionsDir(): string {
    return path.join(codexHome(), "archived_sessions");
}

/** Gemini CLI transcripts root. */
export function geminiHome(): string {
    return envDir("GEMINI_HOME") ?? path.join(homedir(), ".gemini");
}

/** OpenCode SQLite db path. */
export function opencodeDbPath(): string {
    return envDir("OPENCODE_DB") ?? path.join(homedir(), ".local", "share", "opencode", "opencode.db");
}

/** Grok Build session roots (mirrors cc-switch session_roots()). */
export function grokbuildRoots(): string[] {
    const explicit = process.env.BILI_GROK_ROOTS;
    if (explicit && explicit.length > 0) {
        return explicit.split(path.delimiter).filter((p) => p.length > 0).map((p) => path.resolve(p));
    }
    return [
        path.join(homedir(), ".grok", "sessions"),
        path.join(homedir(), ".local", "share", "grok", "sessions"),
    ];
}
