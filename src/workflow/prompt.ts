export function buildWorkflowSystemPrompt(textProtocol: boolean): string {
    const checkpoint = textProtocol
        ? "When a workflow checkpoint is requested, emit the exact <workflow_checkpoint>{JSON}</workflow_checkpoint> marker requested, with no surrounding prose. To recover an archive emit <retrieve_raw>{\"rawRef\":\"raw_000001\"}</retrieve_raw>. To inspect an operation emit <expand_operation>{\"opId\":\"op00001\"}</expand_operation>."
        : "When a workflow checkpoint is requested, call workflow_checkpoint before continuing.";
    return `WORKFLOW CONTEXT MANAGER

The repository and current filesystem are the source of truth for code. Context is working memory.
Keep READ baselines and PATCH chains available within the current phase. After a phase checkpoint and rollover, re-read current repository files before modifying them again.
Do not replace exact user requirements, engineering decisions, exact errors, file paths, identifiers, or unresolved blockers with vague summaries.
Tool output may include raw_ref and opId references. Use retrieve_raw for exact archived output and expand_operation for operation metadata when those tools are available.
${checkpoint}`;
}
