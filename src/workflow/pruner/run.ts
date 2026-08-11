import type { OperationRecord } from "../types.js";
import { crashSignal, diagnosticLines, duration, environmentLines, exitCode, outputExcerpt, outputFailed } from "./diagnostics.js";

function reference(rawRef: string | undefined): string[] {
    return rawRef ? ["", `raw_ref: ${rawRef}`] : [];
}

export function summarizeRun(text: string, operation: OperationRecord, rawRef: string | undefined): string {
    const code = exitCode(text);
    const signal = crashSignal(text);
    const failed = outputFailed(text, code) || Boolean(signal);
    const passed = !failed && code === "0";
    const elapsed = duration(text);
    const diagnostics = diagnosticLines(text);
    const environment = environmentLines(text);
    const excerpt = outputExcerpt(text);
    return [
        failed ? "[RUN FAILED]" : passed ? "[RUN PASS]" : "[RUN OUTPUT PRUNED]",
        `op_id: ${operation.opId}`,
        operation.command ? `command: ${operation.command}` : undefined,
        operation.workdir ? `workdir: ${operation.workdir}` : undefined,
        code !== undefined ? `exit_code: ${code}` : undefined,
        elapsed ? `duration: ${elapsed}` : undefined,
        signal ? `signal: ${signal}` : undefined,
        ...(diagnostics.length > 0 ? ["", "diagnostics:", ...diagnostics] : []),
        ...(environment.length > 0 ? ["", "environment:", ...environment] : []),
        ...(excerpt.length > 0 ? ["", "output_excerpt:", ...excerpt] : []),
        ...reference(rawRef),
    ].filter((value): value is string => value !== undefined).join("\n");
}
