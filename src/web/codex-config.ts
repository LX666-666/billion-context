import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";

type CodexConfigBackup = {
    version: 1;
    configPath: string;
    existed: boolean;
    originalContent: string;
    originalHash: string;
    originalMode?: number;
    appliedHash: string;
    targetBaseUrl: string;
};

export type CodexConfigStatus = {
    active: boolean;
    conflict: boolean;
    path: string;
    targetBaseUrl?: string;
};

const BACKUP_VERSION = 1;

function configPath(): string {
    const configuredHome = process.env.CODEX_HOME?.trim();
    const codexHome = configuredHome ? resolve(configuredHome) : join(homedir(), ".codex");
    return join(codexHome, "config.toml");
}

function backupPath(path: string): string {
    return `${path}.bili-backup`;
}

function hash(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
}

function readSnapshot(path: string): { exists: boolean; content: string } {
    if (!existsSync(path)) return { exists: false, content: "" };
    return { exists: true, content: readFileSync(path, "utf8") };
}

function atomicWrite(path: string, content: string, mode?: number): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, content, { encoding: "utf8", mode: mode ?? 0o600 });
        renameSync(temporary, path);
    } finally {
        try { unlinkSync(temporary); } catch { }
    }
}

function parseBackup(path: string): CodexConfigBackup | undefined {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Codex 配置备份格式无效");
    const value = parsed as Record<string, unknown>;
    if (
        value.version !== BACKUP_VERSION ||
        typeof value.configPath !== "string" ||
        typeof value.existed !== "boolean" ||
        typeof value.originalContent !== "string" ||
        typeof value.originalHash !== "string" ||
        typeof value.appliedHash !== "string" ||
        typeof value.targetBaseUrl !== "string"
    ) throw new Error("Codex 配置备份格式无效");
    return {
        version: BACKUP_VERSION,
        configPath: value.configPath,
        existed: value.existed,
        originalContent: value.originalContent,
        originalHash: value.originalHash,
        ...(typeof value.originalMode === "number" ? { originalMode: value.originalMode } : {}),
        appliedHash: value.appliedHash,
        targetBaseUrl: value.targetBaseUrl,
    };
}

function sameSnapshot(snapshot: { exists: boolean; content: string }, existed: boolean, contentHash: string): boolean {
    return snapshot.exists === existed && hash(snapshot.content) === contentHash;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setTopLevelKey(content: string, key: string, value: string): string {
    const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = bom ? content.slice(1) : content;
    const newline = body.includes("\r\n") ? "\r\n" : "\n";
    const lines = body.split(/\r?\n/);
    const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
    const limit = firstTable < 0 ? lines.length : firstTable;
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    for (let index = 0; index < limit; index++) {
        if (pattern.test(lines[index] ?? "")) {
            lines[index] = `${key} = ${JSON.stringify(value)}`;
            return bom + lines.join(newline);
        }
    }
    lines.splice(firstTable < 0 ? 0 : firstTable, 0, `${key} = ${JSON.stringify(value)}`);
    return bom + lines.join(newline);
}

export function patchCodexConfig(content: string, targetBaseUrl: string): string {
    return setTopLevelKey(setTopLevelKey(content, "model_provider", "openai"), "openai_base_url", targetBaseUrl);
}

export function getCodexConfigStatus(): CodexConfigStatus {
    const path = configPath();
    const backup = parseBackup(backupPath(path));
    if (!backup) return { active: false, conflict: false, path };
    const current = readSnapshot(path);
    if (sameSnapshot(current, true, backup.appliedHash)) {
        return { active: true, conflict: false, path, targetBaseUrl: backup.targetBaseUrl };
    }
    if (sameSnapshot(current, backup.existed, backup.originalHash)) {
        return { active: false, conflict: false, path, targetBaseUrl: backup.targetBaseUrl };
    }
    return { active: false, conflict: true, path, targetBaseUrl: backup.targetBaseUrl };
}

export function applyCodexConfig(targetBaseUrl: string): CodexConfigStatus {
    const path = configPath();
    const sidecar = backupPath(path);
    const existingBackup = parseBackup(sidecar);
    if (existingBackup) {
        const status = getCodexConfigStatus();
        if (status.conflict) throw new Error("Codex 配置已被外部修改，未覆盖用户改动；请先手动处理 .bili-backup 备份");
        if (status.active) return status;
    }
    const current = existingBackup
        ? { exists: existingBackup.existed, content: existingBackup.originalContent }
        : readSnapshot(path);
    const originalMode = current.exists ? statSync(path).mode & 0o777 : undefined;
    const patched = patchCodexConfig(current.content, targetBaseUrl);
    const backup: CodexConfigBackup = {
        version: BACKUP_VERSION,
        configPath: path,
        existed: current.exists,
        originalContent: current.content,
        originalHash: hash(current.content),
        ...(originalMode !== undefined ? { originalMode } : {}),
        appliedHash: hash(patched),
        targetBaseUrl,
    };
    atomicWrite(sidecar, JSON.stringify(backup) + "\n");
    try {
        atomicWrite(path, patched, originalMode);
    } catch (error) {
        try { unlinkSync(sidecar); } catch { }
        throw error;
    }
    return { active: true, conflict: false, path, targetBaseUrl };
}

export function restoreCodexConfig(): { restored: boolean; conflict: boolean; path: string } {
    const path = configPath();
    const sidecar = backupPath(path);
    const backup = parseBackup(sidecar);
    if (!backup) return { restored: false, conflict: false, path };
    const current = readSnapshot(path);
    if (!sameSnapshot(current, true, backup.appliedHash) && !sameSnapshot(current, backup.existed, backup.originalHash)) {
        return { restored: false, conflict: true, path };
    }
    if (backup.existed) atomicWrite(path, backup.originalContent, backup.originalMode);
    else if (existsSync(path)) unlinkSync(path);
    unlinkSync(sidecar);
    return { restored: true, conflict: false, path };
}
