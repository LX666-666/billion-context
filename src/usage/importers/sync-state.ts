/**
 * Per-file sync cursor: tracks (mtime, line-offset, imported-count) so each
 * importer run only re-parses files that actually changed.
 *
 * The cursor lives in a single JSON file next to the usage ledger. A JSON
 * map is plenty for the volumes involved (one entry per scanned log file).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../../paths.js";

export type SyncCursor = {
    /** File mtime in ms epoch (caches "did the file change since last run"). */
    lastModified: number;
    /** Last parsed line offset (1-based, matches cc-switch semantics). */
    lastLineOffset: number;
    /** Records imported so far from this file (used for status display). */
    importedCount: number;
    /** Last sync epoch ms. */
    lastSyncedAt: number;
};

export type SyncCursorMap = Record<string, SyncCursor>;

function cursorFile(): string {
    const env = process.env.BILI_IMPORT_CURSOR_FILE;
    return env && env.length > 0 ? path.resolve(env) : path.join(dataDir(), "import-cursors.json");
}

let cache: SyncCursorMap | undefined;
let loaded = false;

async function loadCursors(): Promise<SyncCursorMap> {
    if (loaded && cache) return cache;
    try {
        const raw = await readFile(cursorFile(), "utf-8");
        cache = JSON.parse(raw) as SyncCursorMap;
    } catch {
        cache = {};
    }
    loaded = true;
    return cache!;
}

async function persistCursors(map: SyncCursorMap): Promise<void> {
    const file = cursorFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(map, null, 2) + "\n", "utf-8");
    cache = map;
}

export async function getCursor(filePath: string): Promise<SyncCursor | undefined> {
    const map = await loadCursors();
    return map[filePath];
}

export async function setCursor(
    filePath: string,
    cursor: SyncCursor,
): Promise<void> {
    const map = await loadCursors();
    map[filePath] = cursor;
    await persistCursors(map);
}

/** Reset all cursors (test hook). */
export async function resetCursors(): Promise<void> {
    cache = {};
    loaded = true;
    try {
        await writeFile(cursorFile(), "{}\n", "utf-8");
    } catch {
        // best effort
    }
}
