import type {
    CheckpointValidationResult,
    OperationRecord,
    PhaseRecord,
    WorkflowCheckpoint,
    WorkflowState,
} from "./types.js";

function normalized(value: string): string {
    return value
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.?\//, "")
        .replace(/^(?:a|b)\//, "")
        .toLowerCase();
}

function pathCovered(changedFiles: string[], target: string): boolean {
    const expected = normalized(target);
    if (!expected) return false;
    return changedFiles.some((file) => {
        const actual = normalized(file);
        return actual === expected || actual.endsWith(`/${expected}`) || expected.endsWith(`/${actual}`);
    });
}

function includesReference(values: string[], operation: OperationRecord): boolean {
    const haystack = values.join("\n").toLowerCase();
    const refs = [operation.opId, operation.toolCallId, operation.command].filter(
        (value): value is string => Boolean(value),
    );
    return refs.some((ref) => haystack.includes(ref.toLowerCase()));
}

function validationReferencesOperation(
    values: string[],
    operation: OperationRecord,
    outcome: "PASS" | "FAIL",
    validationOperations: OperationRecord[],
): boolean {
    if (includesReference(values, operation)) return true;
    const haystack = values.join("\n");
    const sameTypeCount = validationOperations.filter((candidate) => candidate.type === operation.type).length;
    if (sameTypeCount !== 1) return false;
    if (outcome === "PASS" && operation.type === "TEST") return /\b(?:test|tests|passed|pass)\b.*\b(?:pass|passed|green|success)/is.test(haystack);
    if (outcome === "PASS" && operation.type === "BUILD") return /\b(?:build|compile|typecheck)\b.*\b(?:pass|passed|green|success|ok)/is.test(haystack);
    if (outcome === "PASS" && operation.type === "RUN") return /\b(?:run|command|process)\b.*\b(?:pass|passed|success|ok|exit[_ ]?code\s*[:=]?\s*0)/is.test(haystack);
    if (outcome === "FAIL" && operation.type === "TEST") return /\b(?:test|tests?)\b.*\b(?:fail|failed|failure)/is.test(haystack);
    if (outcome === "FAIL" && operation.type === "BUILD") return /\b(?:build|compile|typecheck)\b.*\b(?:fail|failed|failure|error)/is.test(haystack);
    if (outcome === "FAIL" && operation.type === "RUN") return /\b(?:run|command|process)\b.*\b(?:fail|failed|failure|error|nonzero|exit[_ ]?code\s*[:=]?\s*[1-9])/is.test(haystack);
    return false;
}

function laterSuccessfulValidation(
    operation: OperationRecord,
    operations: OperationRecord[],
    validation: string[],
): boolean {
    const index = operations.findIndex((candidate) => candidate.opId === operation.opId);
    return operations.slice(index + 1).some((candidate) => {
        if (candidate.outcome !== "PASS" || candidate.type !== operation.type) return false;
        if (operation.command && candidate.command && operation.command !== candidate.command) return false;
        return validationReferencesOperation(validation, candidate, "PASS", operations);
    });
}

function claimsCompletion(checkpoint: WorkflowCheckpoint): boolean {
    return /\b(?:complete|completed|fixed|done|validated|finished|pass(?:ed)?|green)\b|已完成|修复|完成|通过|验证/i.test(
        `${checkpoint.completedWork}\n${checkpoint.currentState}`,
    );
}

export function validateCheckpointAgainstPhase(
    checkpoint: WorkflowCheckpoint,
    phase: PhaseRecord,
    operations: OperationRecord[],
    state: WorkflowState,
): CheckpointValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const changedFiles = checkpoint.changedFiles.map(normalized).filter(Boolean);
    const mutations = operations.filter((operation) => operation.type === "PATCH" || operation.type === "WRITE");
    if (mutations.length > 0 && changedFiles.length === 0) {
        errors.push("changedFiles is required when the phase contains PATCH or WRITE operations");
    }
    for (const operation of mutations) {
        if (operation.paths.length === 0 && operation.addedPaths.length === 0) {
            errors.push(`${operation.opId} mutation has no verifiable repository path`);
        }
        for (const target of [...operation.paths, ...operation.addedPaths]) {
            if (!pathCovered(changedFiles, target)) errors.push(`${operation.opId} changed path is missing from changedFiles: ${target}`);
        }
    }

    const validationOperations = operations.filter((operation) => operation.type === "TEST" || operation.type === "BUILD" || operation.type === "RUN");
    const failed = validationOperations.filter((operation) => operation.outcome === "FAIL");
    const unknown = validationOperations.filter((operation) => operation.outcome === "UNKNOWN");
    const passed = validationOperations.filter((operation) => operation.outcome === "PASS");
    for (const operation of passed) {
        if (!validationReferencesOperation(checkpoint.validation, operation, "PASS", validationOperations)) {
            errors.push(`${operation.opId} PASS has no matching checkpoint validation evidence`);
        }
    }
    if (claimsCompletion(checkpoint)) {
        for (const operation of unknown) errors.push(`${operation.opId} validation outcome is UNKNOWN; it cannot prove completion`);
    } else if (unknown.length > 0) {
        warnings.push(`${unknown.map((operation) => operation.opId).join(", ")} validation outcome is UNKNOWN`);
    }
    for (const operation of failed) {
        const explained = validationReferencesOperation(checkpoint.failedAttempts, operation, "FAIL", validationOperations)
            || validationReferencesOperation(checkpoint.blockers, operation, "FAIL", validationOperations)
            || validationReferencesOperation(checkpoint.unresolvedIssues, operation, "FAIL", validationOperations)
            || laterSuccessfulValidation(operation, validationOperations, checkpoint.validation);
        if (!explained) errors.push(`${operation.opId} failed validation has no failedAttempts, resolution, or blocker evidence`);
    }

    const referenced = new Set([...checkpoint.criticalRefs, ...checkpoint.keepRefs]);
    for (const operation of operations) {
        if (operation.type === "PLAN") continue;
        if ((operation.importance === "CRITICAL" || operation.lifecycle === "CRITICAL")
            && !referenced.has(operation.opId)
            && !operation.callRefs.some((ref) => referenced.has(ref))
            && !operation.resultRefs.some((ref) => referenced.has(ref))) {
            errors.push(`${operation.opId} is CRITICAL but is absent from criticalRefs/keepRefs`);
        }
    }
    const stale = Object.values(state.repoBridge.files).filter((file) =>
        file.stale
        && (file.lastReadPhaseId === phase.phaseId || file.lastMutationPhaseId === phase.phaseId)
        && file.staleReason !== "PHASE_BOUNDARY",
    );
    for (const file of stale) errors.push(`${file.relativePath} is stale and must be re-read before checkpoint`);
    const violations = state.repoBridge.violations.filter((violation) =>
        violation.phaseId === phase.phaseId && violation.resolvedAt === undefined,
    );
    for (const violation of violations) errors.push(`${violation.violationId} repository guard is unresolved`);

    if (operations.length === 0) warnings.push("phase has no tracked operations");
    return { valid: errors.length === 0, errors, warnings };
}
