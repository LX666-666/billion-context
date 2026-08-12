const DIAGNOSTIC_PATTERN = /\b(?:error|exception|fail(?:ed|ure)?|assert(?:ion)?|expected|actual|panic|fatal|segmentation|traceback|stack trace|caused by|unhandled|rejection|core dumped|exit code|exit_code|signal)\b|\b(?:ERR_[A-Z0-9_]+|E[A-Z]{2,}[0-9]*)\b|\bat\s+.+:\d+(?::\d+)?|(?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+:\d+(?::\d+)?/i;
const ENVIRONMENT_PATTERN = /\b(?:environment|platform|operating system|\bos\b|architecture|\barch\b|runtime|node(?:\.js)?|npm|pnpm|yarn|bun|python|pip|java|jdk|dotnet|\.net sdk|rustc|cargo|go version|cmake|compiler|kernel|uname|working directory|workdir|\bcwd\b|NODE_ENV|CI)\b\s*(?:[:=]|v?\d)/i;
const SECRET_PATTERN = /\b(?:api[_-]?key|authorization|cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|private[_-]?key)\b\s*[:=]/i;

export function outputField(text: string, pattern: RegExp): string | undefined {
    return pattern.exec(text)?.[1]?.trim();
}

export function exitCode(text: string): string | undefined {
    return outputField(text, /(?:exit code|exit_code|process exited with code)\s*[:=]?\s*(-?\d+)/i);
}

export function duration(text: string): string | undefined {
    return outputField(text, /(?:duration|wall time|elapsed(?: time)?)\s*[:=]\s*([^\r\n]+)/i);
}

export function crashSignal(text: string): string | undefined {
    return outputField(text, /(?:signal|terminated by)\s*[:=]?\s*((?:SIG)?[A-Z][A-Z0-9_]+)/i)
        ?? outputField(text, /\b(SIG(?:ABRT|BUS|FPE|ILL|KILL|QUIT|SEGV|TERM|TRAP))\b/i);
}

export function outputFailed(text: string, code = exitCode(text)): boolean {
    if (code !== undefined && code !== "0") return true;
    return /(?:^|\n)\s*(?:npm ERR!|error:(?!\s*0\b)|fatal:|panic:|FAIL(?:ED)?\b(?!\s*[:=]?\s*0\b)|status\s*[:=]\s*failed\b|[1-9]\d*\s+failed\b|Traceback \(most recent call last\)|Unhandled (?:exception|rejection)|segmentation fault|core dumped)|\bcommand failed\b/i.test(text);
}

export type ValidationOutcome = "PASS" | "FAIL" | "UNKNOWN";

export function validationOutcome(text: string, type: "TEST" | "BUILD" | "RUN"): ValidationOutcome {
    const code = exitCode(text);
    if (outputFailed(text, code)) return "FAIL";
    if (code !== undefined) return code === "0" ? "PASS" : "FAIL";
    if (type === "TEST") {
        const failed = /(?:^|\n)\s*(?:fail|failed|failures?)\s*[:=]?\s*(\d+)/im.exec(text)?.[1]
            ?? /(\d+)\s+failed\b/i.exec(text)?.[1];
        if (failed !== undefined && failed !== "0") return "FAIL";
        if (failed === "0" && /(?:\b(?:pass|passed|tests?|suites?)\b|success)/i.test(text)) return "PASS";
        if (/\b(?:all tests passed|tests? passed|test suite passed|passed)\b/i.test(text)) return "PASS";
    } else if (type === "BUILD") {
        if (/\b(?:build|compile|typecheck)\s+(?:succeeded|successful|passed|complete|completed|ok)\b/i.test(text)) return "PASS";
        if (/\b(?:build|compile|typecheck)\s+passed\b|\bcompiled successfully\b/i.test(text)) return "PASS";
    } else if (/\b(?:command|process|run)\s+(?:succeeded|successful|completed successfully|passed)\b/i.test(text)) {
        return "PASS";
    }
    return "UNKNOWN";
}

function diagnosticContext(line: string): boolean {
    return /^\s+(?:at\s|File\s+"|\^+|~+|Caused by:|\.\.\.|[A-Za-z_][A-Za-z0-9_]*(?:Error|Exception)\b)/.test(line);
}

export function diagnosticLines(text: string, limit = 140): string[] {
    const lines = text.split(/\r?\n/);
    const selected: string[] = [];
    const seen = new Map<string, number>();
    const visited = new Set<number>();
    let omitted = 0;
    const add = (index: number): void => {
        if (visited.has(index)) return;
        visited.add(index);
        const line = lines[index];
        const value = line.replace(/[ \t]+$/g, "");
        if (!value.trim()) return;
        const count = seen.get(value) ?? 0;
        seen.set(value, count + 1);
        if (count > 0) return;
        if (selected.length < limit) selected.push(value);
        else omitted++;
    };
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!DIAGNOSTIC_PATTERN.test(line)) continue;
        const previous = lines[index - 1];
        if (previous && /^\s*(?:FAIL(?:ED)?|✖|×|test|suite)\b/i.test(previous)) add(index - 1);
        add(index);
        let cursor = index + 1;
        while (cursor < lines.length && cursor <= index + 4 && diagnosticContext(lines[cursor])) {
            add(cursor);
            cursor++;
        }
    }
    const grouped = selected.flatMap((line) => {
        const repeats = (seen.get(line) ?? 1) - 1;
        return repeats > 0 ? [line, `[diagnostic repeated ${repeats} more time${repeats === 1 ? "" : "s"}]`] : [line];
    });
    if (omitted > 0) grouped.push(`[${omitted} additional diagnostic line(s) available in raw output]`);
    return grouped;
}

function redactEnvironment(line: string): string {
    return SECRET_PATTERN.test(line) ? "[sensitive environment value redacted]" : line.replace(/[ \t]+$/g, "");
}

export function environmentLines(text: string, limit = 40): string[] {
    const values: string[] = [];
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
        if (!ENVIRONMENT_PATTERN.test(line)) continue;
        const value = redactEnvironment(line);
        if (!value.trim() || seen.has(value)) continue;
        seen.add(value);
        values.push(value);
        if (values.length >= limit) break;
    }
    return values;
}

export function outputExcerpt(text: string, limit = 60): string[] {
    const diagnostic = new Set(diagnosticLines(text).filter((line) => !line.startsWith("[diagnostic repeated")));
    const environment = new Set(environmentLines(text));
    const lines = text.split(/\r?\n/).filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || diagnostic.has(line) || environment.has(line) || SECRET_PATTERN.test(line)) return false;
        return !/^(?:progress|runner detail|machine detail|chunk|record|item|step)\s+#?\d+\b|^\d{1,3}%\s/i.test(trimmed);
    });
    if (lines.length <= limit) return lines;
    const headCount = Math.ceil(limit * 2 / 3);
    return [...lines.slice(0, headCount), `[... ${lines.length - limit} output lines omitted ...]`, ...lines.slice(-(limit - headCount))];
}
