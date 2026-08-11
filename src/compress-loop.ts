import {
    buildStatusReport,
    collectBlockContent,
    deactivateBlock,
    estimateTokensFast,
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { markDirty, type Session } from "./session.js";
import {
    MUTATING_PROXY_TOOLS,
    parseCompressInput,
    PROXY_TOOL_NAMES,
    READONLY_PROXY_TOOLS,
} from "./compress-tool.js";
import { applyRanges } from "./stream.js";
import { resolveDecompress } from "./decompress-shared.js";
import { fetchWithTimeout } from "./fetch-util.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { normalizeSseLineEndings } from "./sse-util.js";
import { log as loggerLog } from "./logger.js";
import { captureUsage, type UsageCaptureCtx } from "./usage/capture.js";
import { expandOperation, retrieveRawOutput } from "./workflow/archive.js";
import { recordWorkflowUsage } from "./workflow/cache-policy.js";

interface CompressLoopCtx {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    /** Resolved upstream proxy URL (http://host:port) or undefined for direct.
     *  Pre-resolved by the caller (server.ts) via resolveProxy(). */
    proxyUrl?: string;
    /** Usage-ledger capture context (model/provider). Omitted = no ledger. */
    usage?: UsageCaptureCtx;
}

interface RequestOptions {
    url: string;
    headers: Record<string, string>;
}

interface ToolCallAccumulator {
    index: number;
    id: string;
    name: string;
    arguments: string;
}

function executeProxyTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: CompressLoopCtx,
): string {
    if (toolName === "compress") {
        return applyRanges(parseCompressInput(args), ctx);
    }
    if (toolName === "decompress") {
        return resolveDecompress(args, ctx);
    }
    if (toolName === "search_context") {
        const query = typeof args.query === "string" ? args.query : "";
        if (query.length === 0) return "[search_context FAILED: query is required]";
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
        const blocks = ctx.core.search(query, ctx.session.state).slice(0, limit);
        if (blocks.length === 0) return `[No blocks matched "${query}"]`;
        const lines = blocks.map((b) => {
            const topic = b.topic ?? "(no topic)";
            const preview = b.summary.length > 200 ? b.summary.slice(0, 200) + "..." : b.summary;
            return `${b.blockId} (T${b.tier}) "${topic}"\n  ${preview}`;
        });
        return `Found ${blocks.length} block(s) for "${query}":\n\n${lines.join("\n\n")}`;
    }
    if (toolName === "acp_status") {
        return buildStatusReport(ctx.session.state, ctx.messages, estimateTokensFast);
    }
    if (toolName === "retrieve_raw") {
        const rawRef = typeof args.rawRef === "string" ? args.rawRef : "";
        if (!rawRef) return "[retrieve_raw FAILED: rawRef is required]";
        const result = retrieveRawOutput(ctx.session.id, ctx.session.workflow, rawRef);
        markDirty(ctx.session);
        return result;
    }
    if (toolName === "expand_operation") {
        const opId = typeof args.opId === "string" ? args.opId : "";
        return opId ? expandOperation(ctx.session.workflow, opId) : "[expand_operation FAILED: opId is required]";
    }
    return `[Unknown proxy tool: ${toolName}]`;
}

interface EventDisposition {
    yieldChunk?: Buffer;
    contentDelta?: string;
    finishReason?: string;
    usage?: Record<string, unknown> | null;
    done?: boolean;
    toolCalls?: ToolCallAccumulator[];
}

function classifySseEvent(eventStr: string): EventDisposition {
    const dataLine = eventStr.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return {};
    const jsonStr = dataLine.slice(5).trim();
    if (jsonStr === "[DONE]") return { done: true };
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(jsonStr);
    } catch {
        return {};
    }
    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) return {};
    const delta = choice.delta as Record<string, unknown> | undefined;
    const finishReason = choice.finish_reason as string | null;
    const out: EventDisposition = {};
    if (finishReason) {
        out.finishReason = finishReason;
        out.usage = (parsed.usage ?? null) as Record<string, unknown> | null;
    }
    if (!delta) return out;
    if (delta.tool_calls) {
        const tcs = delta.tool_calls as Array<Record<string, unknown>>;
        const toolCalls: ToolCallAccumulator[] = [];
        for (const tc of tcs) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const fn = tc.function as Record<string, unknown> | undefined;
            const name = typeof fn?.name === "string" ? fn.name : "";
            const id = typeof tc.id === "string" ? tc.id : "";
            const args = typeof fn?.arguments === "string" ? fn.arguments : "";
            toolCalls.push({ index: idx, id, name, arguments: args });
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
            out.contentDelta = delta.content;
        }
        out.toolCalls = toolCalls;
        return out;
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
        out.contentDelta = delta.content;
        out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
        return out;
    }
    if (delta.role || (Object.keys(delta).length === 0 && !finishReason)) {
        out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
    }
    return out;
}

function buildToolCallSse(
    base: Record<string, unknown>,
    tc: ToolCallAccumulator,
): string {
    return `data: ${JSON.stringify({
        ...base,
        choices: [{
            index: 0,
            delta: {
                tool_calls: [{
                    index: tc.index,
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: tc.arguments },
                }],
            },
            finish_reason: null,
        }],
    })}\n\n`;
}

function buildFinishSse(
    base: Record<string, unknown>,
    finishReason: string,
    usage: Record<string, unknown> | null,
): string {
    return `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
    })}\n\n`;
}

function buildContentSse(
    id: string,
    model: string,
    content: string,
): string {
    return `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Date.now(),
        model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`;
}

export function buildVisibilityMarker(toolName: string, result: string): string {
    const lines = result.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const failed = lines.some((l) =>
        l.includes("FAILED")
        || l.includes("not found")
        || l.includes("is required")
        || l.includes("No blocks matched")
    );
    const icons: Record<string, string> = {
        compress: "📦",
        decompress: "📤",
        search_context: "🔍",
        acp_status: "📊",
    };
    const icon = failed ? "❌" : (icons[toolName] ?? "📦");

    if (toolName === "acp_status" && lines.length >= 2) {
        const dataLine = lines.slice(0, 3).join(" | ").replace(/\s+/g, " ");
        return `\n${icon} [ACP] ${dataLine}\n`;
    }

    const inner = (lines[0] ?? "").replace(/^\[/, "").replace(/\]$/, "").trim();
    return `\n${icon} [ACP] ${inner}\n`;
}

function openaiJsonToolCalls(response: Record<string, unknown>): { content: unknown; calls: ToolCallAccumulator[] } {
    const choices = response.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const rawCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    const calls = (rawCalls ?? []).flatMap((raw, index) => {
        const fn = raw.function as Record<string, unknown> | undefined;
        const name = typeof fn?.name === "string" ? fn.name : "";
        if (!name) return [];
        return [{
            index,
            id: typeof raw.id === "string" ? raw.id : `call_${index}`,
            name,
            arguments: typeof fn?.arguments === "string" ? fn.arguments : "{}",
        }];
    });
    return { content: message?.content ?? null, calls };
}

function openaiJsonLoopError(current: Record<string, unknown>, detail: string): Record<string, unknown> {
    const choices = current.choices as Array<Record<string, unknown>> | undefined;
    if (!choices?.[0]) return current;
    choices[0].message = { role: "assistant", content: `[acp-proxy: ${detail}]` };
    choices[0].finish_reason = "stop";
    return current;
}

export async function compressLoopJson(
    initialResponse: Record<string, unknown>,
    ctx: CompressLoopCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
): Promise<Record<string, unknown>> {
    let current = initialResponse;
    for (let loopCount = 1; loopCount <= 5; loopCount++) {
        const output = openaiJsonToolCalls(current);
        const proxyCalls = output.calls.filter((call) => PROXY_TOOL_NAMES.has(call.name));
        const realCalls = output.calls.filter((call) => !PROXY_TOOL_NAMES.has(call.name));
        if (proxyCalls.length === 0 || realCalls.length > 0) return current;
        const messages = Array.isArray(requestBody.messages) ? [...requestBody.messages as unknown[]] : [];
        messages.push({
            role: "assistant",
            content: output.content,
            tool_calls: proxyCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
            })),
        });
        for (const call of proxyCalls) {
            let args: Record<string, unknown> = {};
            try {
                const parsed = JSON.parse(call.arguments) as unknown;
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
            } catch {
            }
            const result = executeProxyTool(call.name, args, ctx);
            ctx.log(`[acp-proxy: OpenAI JSON ${call.name} → ${result.slice(0, 120).replace(/\n/g, " ")}]`);
            messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        requestBody.messages = messages;
        try {
            const { response, clearTimer } = await fetchWithTimeout(requestOptions.url, {
                method: "POST",
                headers: requestOptions.headers,
                body: JSON.stringify(requestBody),
                ...(ctx.proxyUrl ? { dispatcher: proxyDispatcher(ctx.proxyUrl) } : {}),
            });
            try {
                if (!response.ok) {
                    const detail = await response.text().catch(() => "upstream error");
                    return openaiJsonLoopError(current, `upstream error ${response.status}: ${detail.slice(0, 200)}`);
                }
                current = await response.json() as Record<string, unknown>;
            } finally {
                clearTimer();
            }
        } catch (error) {
            return openaiJsonLoopError(current, String(error));
        }
    }
    return openaiJsonLoopError(current, "JSON proxy loop limit reached");
}

export async function* compressLoopStream(
    initialUpstream: ReadableStream<Uint8Array>,
    ctx: CompressLoopCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
): AsyncGenerator<Buffer> {
    let upstream = initialUpstream;
    let activeClearTimer: (() => void) | null = null;
    try {
    const model = (requestBody.model as string) ?? "unknown";
    const fallbackResponseId = `chatcmpl-proxy-${Date.now()}`;
    let responseId: string | undefined;
    const clientResponseId = (): string => responseId ?? fallbackResponseId;
    const makeBase = () => ({
        id: clientResponseId(),
        object: "chat.completion.chunk" as const,
        created: Date.now(),
        model,
    });
    let loopCount = 0;

    for (;;) {
        loopCount++;
        if (loopCount > 10) {
            ctx.log("[acp-proxy: compress loop limit (10) reached, forwarding as-is]");
            yield Buffer.from(buildFinishSse(makeBase(), "stop", null), "utf8");
            yield Buffer.from("data: [DONE]\n\n", "utf8");
            return;
        }

        const toolCallByIndex = new Map<number, ToolCallAccumulator>();
        let contentText = "";
        let finishReason: string | null = null;
        let usage: Record<string, unknown> | null = null;
        let roundResponseId: string | undefined;
        const isFirstRound = loopCount === 1;
        const readResponseId = (eventStr: string): void => {
            if (roundResponseId) return;
            const dataLine = eventStr.split("\n").find((line) => line.startsWith("data:"));
            if (!dataLine) return;
            try {
                const payload = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
                if (typeof payload.id === "string") {
                    roundResponseId = payload.id;
                    responseId ??= payload.id;
                }
            } catch {
                return;
            }
        };

        const reader = upstream.getReader();
        const decoder = new TextDecoder("utf-8");
        let sseBuffer = "";
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });
                sseBuffer = normalizeSseLineEndings(sseBuffer);
                let sep: number;
                while ((sep = sseBuffer.indexOf("\n\n")) >= 0) {
                    const eventStr = sseBuffer.slice(0, sep);
                    sseBuffer = sseBuffer.slice(sep + 2);
                    if (!eventStr.trim()) continue;
                    readResponseId(eventStr);
                    const d = classifySseEvent(eventStr);
                    if (d.done) {
                        continue;
                    }
                    if (isFirstRound) {
                        if (d.yieldChunk) {
                            yield d.yieldChunk;
                        }
                    } else {
                        if (d.contentDelta) {
                            yield Buffer.from(buildContentSse(clientResponseId(), model, d.contentDelta), "utf8");
                        }
                    }
                    if (d.contentDelta) contentText += d.contentDelta;
                    if (d.finishReason) finishReason = d.finishReason;
                    if (d.usage !== undefined) usage = d.usage;
                    if (d.toolCalls) {
                        for (const tc of d.toolCalls) {
                            const existing = toolCallByIndex.get(tc.index);
                            if (existing) {
                                if (tc.name) existing.name = tc.name;
                                if (tc.id) existing.id = tc.id;
                                existing.arguments += tc.arguments;
                            } else {
                                toolCallByIndex.set(tc.index, tc);
                            }
                        }
                    }
                }
            }
            sseBuffer += decoder.decode();
            sseBuffer = normalizeSseLineEndings(sseBuffer);
            // Drain any events still in the residual buffer (a well-formed
            // stream ends with \n\n, but some upstreams omit the final
            // blank line; processing the tail avoids losing the last event).
            let resSep: number;
            while ((resSep = sseBuffer.indexOf("\n\n")) >= 0) {
                const eventStr = sseBuffer.slice(0, resSep);
                sseBuffer = sseBuffer.slice(resSep + 2);
                if (!eventStr.trim()) continue;
                readResponseId(eventStr);
                const d = classifySseEvent(eventStr);
                if (d.done) continue;
                if (isFirstRound) {
                    if (d.yieldChunk) yield d.yieldChunk;
                } else {
                    if (d.contentDelta) yield Buffer.from(buildContentSse(clientResponseId(), model, d.contentDelta), "utf8");
                }
                if (d.contentDelta) contentText += d.contentDelta;
                if (d.finishReason) finishReason = d.finishReason;
                if (d.usage !== undefined) usage = d.usage;
                if (d.toolCalls) {
                    for (const tc of d.toolCalls) {
                        const existing = toolCallByIndex.get(tc.index);
                        if (existing) {
                            if (tc.name) existing.name = tc.name;
                            if (tc.id) existing.id = tc.id;
                            existing.arguments += tc.arguments;
                        } else {
                            toolCallByIndex.set(tc.index, tc);
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        const sortedIndices = [...toolCallByIndex.keys()].sort((a, b) => a - b);
        const toolCalls: ToolCallAccumulator[] = sortedIndices
            .map((i) => {
                const tc = toolCallByIndex.get(i)!;
                return { ...tc, id: tc.id || `call_${tc.index}` };
            })
            .filter((tc) => tc.name.length > 0);

        const proxyCalls = toolCalls.filter((tc) => PROXY_TOOL_NAMES.has(tc.name));
        const realCalls = toolCalls.filter((tc) => !PROXY_TOOL_NAMES.has(tc.name));
        const mutatingProxy = proxyCalls.filter((tc) => MUTATING_PROXY_TOOLS.has(tc.name));
        const readonlyProxy = proxyCalls.filter((tc) => READONLY_PROXY_TOOLS.has(tc.name));
        const hasMutatingOnly = mutatingProxy.length > 0 && realCalls.length === 0;

        // Log cache-hit stats from the upstream usage object so we can measure
        // prefix-cache health on the OpenAI chat-completions path (GLM/zhipu).
        if (usage) {
            const prompt = (usage.prompt_tokens ?? usage.input_tokens) as number | undefined;
            const det = (usage.prompt_tokens_details ?? usage.prompt_cache_hit_tokens) as Record<string, unknown> | undefined;
            const cached = det?.cached_tokens ?? usage.prompt_cache_hit_tokens;
            const out = usage.completion_tokens ?? usage.output_tokens;
            if (typeof prompt === "number") {
                const ch = typeof cached === "number" ? cached : 0;
                loggerLog("info", `[acp-usage] round ${loopCount} input=${prompt} cached=${typeof cached === "number" ? cached : "?"} output=${out ?? "?"}${ch > 0 ? ` (cache hit ${Math.round(ch / prompt * 100)}%)` : ""}`);
                // Record into the session for the web UI / stats: cumulative
                // tokens + cache-hit ratio across all rounds seen so far.
                ctx.session.stats.inputTokens += prompt;
                ctx.session.stats.lastInputTokens = prompt;
                recordWorkflowUsage(ctx.session.workflow, prompt, typeof cached === "number" ? cached : undefined);
                if (typeof cached === "number") ctx.session.stats.cachedTokens += cached;
                if (typeof out === "number") ctx.session.stats.outputTokens += out;
                ctx.session.stats.cacheSamples += 1;
                // Request ledger: normalize + price this round's usage.
                if (ctx.usage) {
                    void captureUsage({
                        protocol: "openai",
                        usage,
                        sessionId: ctx.session.id,
                        ctx: ctx.usage,
                        sourceRequestId: roundResponseId,
                        streaming: true,
                    });
                }
            }
        }

        if (!hasMutatingOnly) {
            for (const tc of readonlyProxy) {
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(tc.arguments) as Record<string, unknown>;
                } catch {
                    args = {};
                }
                let result: string;
                try {
                    result = executeProxyTool(tc.name, args, ctx);
                } catch (e) {
                    result = `[${tc.name} FAILED: ${e instanceof Error ? e.message : String(e)}]`;
                }
                const preview = result.length > 120 ? result.slice(0, 120) + "..." : result;
                ctx.log(`[acp-proxy: ${tc.name} (${tc.id}) → ${preview.replace(/\n/g, " ")}]`);
                yield Buffer.from(
                    buildContentSse(clientResponseId(), model, buildVisibilityMarker(tc.name, result)),
                    "utf8",
                );
            }
            for (const tc of realCalls) {
                yield Buffer.from(buildToolCallSse(makeBase(), tc), "utf8");
            }
            const fr = realCalls.length > 0 ? "tool_calls" : (finishReason ?? "stop");
            yield Buffer.from(buildFinishSse(makeBase(), fr, usage), "utf8");
            yield Buffer.from("data: [DONE]\n\n", "utf8");
            return;
        }

        const names = proxyCalls.map((c) => c.name).join(", ");
        ctx.log(`[acp-proxy: round ${loopCount} — ${proxyCalls.length} proxy call(s): ${names}]`);

        const messages = (requestBody.messages as Array<Record<string, unknown>>) ?? [];

        messages.push({
            role: "assistant",
            content: contentText || null,
            tool_calls: proxyCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.arguments },
            })),
        });

        for (const tc of proxyCalls) {
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(tc.arguments) as Record<string, unknown>;
            } catch {
                args = {};
            }
            const result = executeProxyTool(tc.name, args, ctx);
            const preview = result.length > 120 ? result.slice(0, 120) + "..." : result;
            ctx.log(`[acp-proxy: ${tc.name} (${tc.id}) → ${preview.replace(/\n/g, " ")}]`);
            yield Buffer.from(
                buildContentSse(clientResponseId(), model, buildVisibilityMarker(tc.name, result)),
                "utf8",
            );
            messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: result,
            });
        }

        requestBody.messages = messages;

        const { response: resp, clearTimer } = await fetchWithTimeout(requestOptions.url, {
            method: "POST",
            headers: requestOptions.headers,
            body: JSON.stringify(requestBody),
            ...(ctx.proxyUrl ? { dispatcher: proxyDispatcher(ctx.proxyUrl) } : {}),
        });

        if (!resp.ok || !resp.body) {
            const errText = await resp.text().catch(() => "upstream error");
            ctx.log(`[acp-proxy: compress loop upstream error ${resp.status}: ${errText.slice(0, 200)}]`);
            yield Buffer.from(
                `data: ${JSON.stringify({
                    ...makeBase(),
                    choices: [{
                        index: 0,
                        delta: { content: `\n[acp-proxy: upstream error ${resp.status}: ${errText.slice(0, 200)}]\n` },
                        finish_reason: null,
                    }],
                })}\n\n`,
                "utf8",
            );
            yield Buffer.from(buildFinishSse(makeBase(), "stop", null), "utf8");
            yield Buffer.from("data: [DONE]\n\n", "utf8");
            return;
        }

        upstream = resp.body as ReadableStream<Uint8Array>;
        // Clear the PREVIOUS round's timer before overwriting — otherwise the
        // fetch-timeout timer from rounds 1..N-1 leaks (each would self-fire
        // harmlessly after 10min, but the handles accumulate in the event loop
        // over a long session). Only the final round's timer is cleared by the
        // outer finally.
        if (activeClearTimer) activeClearTimer();
        activeClearTimer = clearTimer;
    }
    } finally {
        // Clear the fetch timeout timer on any exit (return / throw / normal
        // completion) so it cannot leak across rounds or keep the event loop
        // alive. Mirrors the responses-loop variant.
        if (activeClearTimer) {
            activeClearTimer();
            activeClearTimer = null;
        }
    }
}
