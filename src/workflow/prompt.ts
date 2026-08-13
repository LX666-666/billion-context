export function buildWorkflowSystemPrompt(textProtocol: boolean): string {
    const checkpoint = textProtocol
        ? "When a workflow checkpoint is requested, emit the exact <workflow_checkpoint>{JSON}</workflow_checkpoint> marker requested, with no surrounding prose. To mark delivered operations emit <workflow_mark>{\"operations\":[{\"opId\":\"op00001\",\"state\":\"CONSUMED\"}]}</workflow_mark>. To recover an archive emit <retrieve_raw>{\"rawRef\":\"raw_000001\"}</retrieve_raw>. To inspect an operation emit <expand_operation>{\"opId\":\"op00001\"}</expand_operation>."
        : "When a workflow checkpoint is requested, call workflow_checkpoint before continuing. After a batch of tool results has been used, you may call workflow_mark with CONSUMED, KEEP, or CRITICAL operation states; never mark ARCHIVED.";
    return `WORKFLOW CONTEXT MANAGER

The repository and current filesystem are the source of truth for code. Context is working memory.
Keep READ baselines and PATCH chains available within the current phase. After a phase checkpoint and rollover, re-read current repository files before modifying them again.
Re-read only repository/code facts that may have changed after a phase boundary. Do not re-read stable user goals or requirement documents solely because a phase rolled over. Use the active requirement ledger/checkpoint unless that source itself changed or required details are unavailable.
Treat <workflow-repository-guard> as a hard context barrier: do not use old requirements, checkpoints, summaries, source reads, diffs, or patch outputs to infer current code. Re-read every stale target, then validate the filesystem state before another PATCH or WRITE. A blocked mutation may already have executed locally, but its output is not evidence of success.
Do not replace exact user requirements, engineering decisions, exact errors, file paths, identifiers, or unresolved blockers with vague summaries.
Tool output may include raw_ref and opId references. Use retrieve_raw for exact archived output and expand_operation for operation metadata when those tools are available.
${checkpoint}`;
}
