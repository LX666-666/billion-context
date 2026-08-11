const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const SPINNER_PATTERN = /^\s*(?:[|/\\-]|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s*(?:loading|downloading|installing|building|waiting)?\s*\.{0,3}\s*$/i;

export type DeterministicCleanResult = {
    text: string;
    changed: boolean;
};

export function cleanDeterministic(raw: string): DeterministicCleanResult {
    const normalized = raw.replace(ANSI_PATTERN, "").replace(/\r(?!\n)/g, "\n");
    const input = normalized.split(/\r?\n/);
    const output: string[] = [];
    let previous = "";
    let repeats = 0;
    let blankRun = 0;
    const flushRepeats = (): void => {
        if (repeats > 0) output.push(`[previous line repeated ${repeats} more time${repeats === 1 ? "" : "s"}]`);
        repeats = 0;
    };
    for (const line of input) {
        const trimmed = line.trim();
        if (SPINNER_PATTERN.test(trimmed)) continue;
        if (!trimmed) {
            flushRepeats();
            blankRun++;
            if (blankRun <= 2) output.push("");
            previous = "";
            continue;
        }
        blankRun = 0;
        if (line === previous) {
            repeats++;
            continue;
        }
        flushRepeats();
        output.push(line.replace(/[ \t]+$/g, ""));
        previous = line;
    }
    flushRepeats();
    const text = output.join("\n").trim();
    return { text, changed: text !== raw.trim() };
}
