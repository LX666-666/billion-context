import type { OperationRecord } from "../types.js";
import { crashSignal, diagnosticLines, duration, environmentLines, exitCode, outputExcerpt, outputFailed, validationOutcome } from "./diagnostics.js";

function reference(rawRef: string | undefined): string[] {
    return rawRef ? ["", `raw_ref: ${rawRef}`] : [];
}

export function summarizeRun(text: string, operation: OperationRecord, rawRef: string | undefined): string {
    const code = exitCode(text);
    const signal = crashSignal(text);
    const failed = outputFailed(text, code) || Boolean(signal);
    const outcome = validationOutcome(text, "RUN");
    const elapsed = duration(text);
    const diagnostics = diagnosticLines(text);
    const environment = environmentLines(text);
    const excerpt = outputExcerpt(text);
    return [
        failed ? "[RUN FAILED]" : outcome === "PASS" ? "[RUN PASS]" : outcome === "UNKNOWN" ? "[RUN UNKNOWN]\n[RUN OUTPUT PRUNED]" : "[RUN OUTPUT PRUNED]",
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
