import {
    buildStatusReport,
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
import { buildVisibilityMarker } from "./compress-loop.js";
import { fetchWithTimeout } from "./fetch-util.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { normalizeSseLineEndings } from "./sse-util.js";
import { captureUsage, type UsageCaptureCtx } from "./usage/capture.js";
import { expandOperation, retrieveRawOutput } from "./workflow/archive.js";
import { recordWorkflowUsage } from "./workflow/cache-policy.js";

/** Anthropic SSE multi-round compress loop.
 *
 *  WHY THIS EXISTS: the Anthropic path previously used `rewriteSseStream` — a
 *  single-pass rewriter that intercepts proxy tool_use blocks and emits their
 *  result as a text delta TO THE CLIENT. That result never went back to the
 *  upstream LLM, so query-type tools (acp_status, search_context) broke the
 *  model's reasoning chain: the model called acp_status, proxy ran it, but
 *  the model never SAW the result → couldn't decide to compress next → the
 *  client hung ("Turn execution failed").
 *
 *  This loop mirrors compress-loop.ts (OpenAI chat) and
 *  compress-loop-responses.ts: intercept proxy tool_use → execute → push
 *  assistant(tool_use) + user(tool_result) back into the request → re-request
 *  upstream → loop until the model stops calling proxy tools. The tool RESULT
 *  reaches the model, so acp_status→compress flows work. */

interface CompressLoopAnthropicCtx {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    /** Resolved upstream proxy URL (http://host:port) or undefined for direct. */
    proxyUrl?: string;
    /** Usage-ledger capture context (model/provider). Omitted = no ledger. */
    usage?: UsageCaptureCtx;
}

interface RequestOptions {
    url: string;
    headers: Record<string, string>;
}

interface ToolUseBlock {
    id: string;
    name: string;
    json: string;
}

function executeProxyTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: CompressLoopAnthropicCtx,
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

function anthropicJsonLoopError(current: Record<string, unknown>, detail: string): Record<string, unknown> {
    current.content = [{ type: "text", text: `[acp-proxy: ${detail}]` }];
    current.stop_reason = "end_turn";
    return current;
}

export async function compressLoopAnthropicJson(
    initialResponse: Record<string, unknown>,
    ctx: CompressLoopAnthropicCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
): Promise<Record<string, unknown>> {
    let current = initialResponse;
    for (let loopCount = 1; loopCount <= 5; loopCount++) {
        const content = Array.isArray(current.content) ? current.content as Array<Record<string, unknown>> : [];
        const toolBlocks = content.filter((block) => block.type === "tool_use" && typeof block.name === "string");
        const proxyBlocks = toolBlocks.filter((block) => PROXY_TOOL_NAMES.has(String(block.name)));
        const realBlocks = toolBlocks.filter((block) => !PROXY_TOOL_NAMES.has(String(block.name)));
        if (proxyBlocks.length === 0 || realBlocks.length > 0) return current;
        const messages = Array.isArray(requestBody.messages) ? [...requestBody.messages as unknown[]] : [];
        messages.push({ role: "assistant", content });
        const results: Record<string, unknown>[] = [];
        for (const block of proxyBlocks) {
            const args = block.input && typeof block.input === "object" && !Array.isArray(block.input)
                ? block.input as Record<string, unknown>
                : {};
            const name = String(block.name);
            const result = executeProxyTool(name, args, ctx);
            ctx.log(`[acp-proxy: Anthropic JSON ${name} → ${result.slice(0, 120).replace(/\n/g, " ")}]`);
            results.push({
                type: "tool_result",
                tool_use_id: typeof block.id === "string" ? block.id : `toolu_${results.length}`,
                content: result,
            });
        }
        messages.push({ role: "user", content: results });
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
                    return anthropicJsonLoopError(current, `upstream error ${response.status}: ${detail.slice(0, 200)}`);
                }
                current = await response.json() as Record<string, unknown>;
            } finally {
                clearTimer();
            }
        } catch (error) {
            return anthropicJsonLoopError(current, String(error));
        }
    }
    return anthropicJsonLoopError(current, "JSON proxy loop limit reached");
}

function parseAnthropicSse(eventStr: string): { type: string; data: Record<string, unknown> } | null {
    const lines = eventStr.split("\n");
    let type = "";
    const dataLines: string[] = [];
    for (const l of lines) {
        if (l.startsWith("event:")) {
            type = l.slice(6).trim();
        } else if (l.startsWith("data:")) {
            dataLines.push(l.slice(5).replace(/^ /, ""));
        }
    }
    if (!type) return null;
    const jsonStr = dataLines.join("\n").trim();
    if (!jsonStr) return { type, data: {} };
    try {
        return { type, data: JSON.parse(jsonStr) as Record<string, unknown> };
    } catch {
        return { type, data: {} };
    }
}

function buildTextBlockSse(index: number, text: string): string {
    return (
        `event: content_block_start\n` +
        `data: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\n` +
        `data: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } })}\n\n` +
        `event: content_block_stop\n` +
        `data: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`
    );
}

function buildTerminalSse(
    stopReason: string,
    outputTokens: number,
    inputTokens: number,
    cachedTokens: number,
    messageId: string | undefined,
    model: string | undefined,
): string {
    // The synthetic message_delta must carry the FULL usage the upstream sent
    // in ITS message_delta — not just output_tokens. Standard clients (ZCode,
    // any Anthropic SDK) read input_tokens + cache_read_input_tokens from
    // message_delta (GLM puts the real values there; message_start's are 0).
    // If we emit only output_tokens, clients see input=0 and report a tiny
    // context size. Forward the accumulated totals so the client's context
    // meter reflects reality.
    const usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedTokens,
    };
    const extra: Record<string, unknown> = {};
    if (messageId) extra.id = messageId;
    if (model) extra.model = model;
    return (
        `event: message_delta\n` +
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage, ...extra })}\n\n` +
        `event: message_stop\n` +
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function remapIndex(json: string, oldIndex: number, newIndex: number): string {
    return json.replaceAll(`"index":${oldIndex}`, `"index":${newIndex}`)
        .replaceAll(`"index": ${oldIndex}`, `"index": ${newIndex}`);
}

function safeParse(s: string): Record<string, unknown> {
    try {
        const v = JSON.parse(s);
        return typeof v === "object" && v ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** Round-level state for the SSE processor.
 *  - `clientIndex`: next sequential index for a block the client WILL see
 *    (proxy tool_use blocks are suppressed — they don't consume a client index).
 *    Persists across rounds so round 2+ content continues after round 1.
 *  - `indexMap`: per-round mapping from upstream index → client index, so
 *    delta/stop events for non-proxy blocks find their assigned client index
 *    even after a proxy block was skipped (which creates a gap in upstream
 *    indices but not client indices). */
interface RoundState {
    clientIndex: number;
    toolBlocks: Map<number, ToolUseBlock>;
    indexMap: Map<number, number>;
}

export async function* compressLoopAnthropicStream(
    initialUpstream: ReadableStream<Uint8Array>,
    ctx: CompressLoopAnthropicCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
): AsyncGenerator<Buffer> {
    let upstream = initialUpstream;
    let activeClearTimer: (() => void) | null = null;
    try {
        const model = (requestBody.model as string) ?? undefined;
        let messageId: string | undefined;
        let clientIndex = 0;
        let totalOutputTokens = 0;
        let totalInputTokens = 0;
        let totalCachedTokens = 0;
        let totalCacheCreationTokens = 0;

        for (let loopCount = 1; ; loopCount++) {
            if (loopCount > 10) {
                ctx.log("[acp-proxy: anthropic compress loop limit (10) reached, finishing]");
                yield Buffer.from(buildTerminalSse("end_turn", totalOutputTokens, totalInputTokens, totalCachedTokens, messageId, model), "utf8");
                return;
            }
            const isFirstRound = loopCount === 1;
            const state: RoundState = { clientIndex, toolBlocks: new Map(), indexMap: new Map() };
            let hasRealToolUse = false;
            let roundText = "";
            let roundStopReason: string | undefined;

            const reader = upstream.getReader();
            const decoder = new TextDecoder("utf-8");
            let sseBuffer = "";
            const cbs: RouteCallbacks = {
                onRealToolUse: () => { hasRealToolUse = true; },
                onText: (t) => { roundText += t; },
                onOutputTokens: (n) => { totalOutputTokens += n; },
                onMessageId: (id) => { if (!messageId) messageId = id; },
                onStopReason: (r) => { roundStopReason = r; },
                onCacheUsage: (input, cached, cacheCreation) => {
                    if (typeof input === "number") {
                        ctx.session.stats.inputTokens += input;
                        // tokenCount drives the nudge decision: it must be the
                        // TOTAL context size (new + cached), not just the new
                        // billable input_tokens. Providers split the prompt into
                        // input_tokens (new) + cache_read_input_tokens (cached);
                        // only the SUM reflects how full the context window is.
                        // Using only input_tokens makes a cached session look
                        // tiny (e.g. 601 of a 40k context) and never compress.
                        ctx.session.stats.lastInputTokens = input + (typeof cached === "number" ? cached : 0);
                        recordWorkflowUsage(
                            ctx.session.workflow,
                            input + (typeof cached === "number" ? cached : 0),
                            cached,
                        );
                        totalInputTokens += input;
                    }
                    if (typeof cached === "number") {
                        ctx.session.stats.cachedTokens += cached;
                        ctx.session.stats.cacheSamples += 1;
                        totalCachedTokens += cached;
                    }
                    if (typeof cacheCreation === "number") totalCacheCreationTokens += cacheCreation;
                },
            };
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
                        for (const b of routeAnthropicEvent(eventStr, isFirstRound, state, cbs)) {
                            yield b;
                        }
                    }
                }
                sseBuffer += decoder.decode();
                sseBuffer = normalizeSseLineEndings(sseBuffer);
                let resSep: number;
                while ((resSep = sseBuffer.indexOf("\n\n")) >= 0) {
                    const eventStr = sseBuffer.slice(0, resSep);
                    sseBuffer = sseBuffer.slice(resSep + 2);
                    if (!eventStr.trim()) continue;
                    for (const b of routeAnthropicEvent(eventStr, isFirstRound, state, cbs)) {
                        yield b;
                    }
                }
            } finally {
                reader.releaseLock();
            }

            // Persist the clientIndex advance from this round.
            clientIndex = state.clientIndex;

            const proxyCalls = [...state.toolBlocks.values()].filter((b) => PROXY_TOOL_NAMES.has(b.name));
            const mutatingProxy = proxyCalls.filter((b) => MUTATING_PROXY_TOOLS.has(b.name));
            const readonlyProxy = proxyCalls.filter((b) => READONLY_PROXY_TOOLS.has(b.name));
            const hasMutatingOnly = mutatingProxy.length > 0 && !hasRealToolUse;

            if (!hasMutatingOnly) {
                for (const tc of readonlyProxy) {
                    const args = safeParse(tc.json);
                    let result: string;
                    try {
                        result = executeProxyTool(tc.name, args, ctx);
                    } catch (e) {
                        result = `[${tc.name} FAILED: ${e instanceof Error ? e.message : String(e)}]`;
                    }
                    const preview = result.length > 120 ? result.slice(0, 120) + "..." : result;
                    ctx.log(`[acp-proxy: ${tc.name} (${tc.id}) → ${preview.replace(/\n/g, " ")}]`);
                    yield Buffer.from(buildTextBlockSse(clientIndex, buildVisibilityMarker(tc.name, result)), "utf8");
                    clientIndex++;
                }
                const stop = hasRealToolUse ? "tool_use" : (roundStopReason ?? "end_turn");
                yield Buffer.from(buildTerminalSse(stop, totalOutputTokens, totalInputTokens, totalCachedTokens, messageId, model), "utf8");
                // Request ledger: one entry per completed request with the
                // accumulated usage across all compress rounds.
                if (ctx.usage) {
                    void captureUsage({
                        protocol: "anthropic",
                        usage: {
                            input_tokens: totalInputTokens,
                            output_tokens: totalOutputTokens,
                            cache_read_input_tokens: totalCachedTokens,
                            cache_creation_input_tokens: totalCacheCreationTokens,
                        },
                        sessionId: ctx.session.id,
                        ctx: ctx.usage,
                        sourceRequestId: messageId,
                        streaming: true,
                    });
                }
                return;
            }

            const names = proxyCalls.map((c) => c.name).join(", ");
            ctx.log(`[acp-proxy: anthropic round ${loopCount} — ${proxyCalls.length} proxy call(s): ${names}]`);

            const messages = (requestBody.messages as Array<Record<string, unknown>>) ?? [];
            const assistantContent: Record<string, unknown>[] = [];
            if (roundText.length > 0) {
                assistantContent.push({ type: "text", text: roundText });
            }
            for (const tc of proxyCalls) {
                assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeParse(tc.json) });
            }
            messages.push({ role: "assistant", content: assistantContent });

            for (const tc of proxyCalls) {
                const args = safeParse(tc.json);
                const result = executeProxyTool(tc.name, args, ctx);
                const preview = result.length > 120 ? result.slice(0, 120) + "..." : result;
                ctx.log(`[acp-proxy: ${tc.name} (${tc.id}) → ${preview.replace(/\n/g, " ")}]`);
                yield Buffer.from(buildTextBlockSse(clientIndex, buildVisibilityMarker(tc.name, result)), "utf8");
                clientIndex++;
                messages.push({
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: tc.id, content: result }],
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
                ctx.log(`[acp-proxy: anthropic compress loop upstream error ${resp.status}: ${errText.slice(0, 200)}]`);
                yield Buffer.from(buildTextBlockSse(clientIndex, `\n[acp-proxy: upstream error ${resp.status}: ${errText.slice(0, 200)}]\n`), "utf8");
                yield Buffer.from(buildTerminalSse("end_turn", totalOutputTokens, totalInputTokens, totalCachedTokens, messageId, model), "utf8");
                return;
            }

            upstream = resp.body as ReadableStream<Uint8Array>;
            if (activeClearTimer) activeClearTimer();
            activeClearTimer = clearTimer;
        }
    } finally {
        if (activeClearTimer) {
            activeClearTimer();
            activeClearTimer = null;
        }
    }
}

interface RouteCallbacks {
    onRealToolUse: () => void;
    onText: (t: string) => void;
    onOutputTokens: (n: number) => void;
    onMessageId: (id: string) => void;
    onStopReason: (r: string) => void;
    onCacheUsage: (input: number | undefined, cached: number | undefined, cacheCreation: number | undefined) => void;
}

function routeAnthropicEvent(
    eventStr: string,
    isFirstRound: boolean,
    state: RoundState,
    cb: RouteCallbacks,
): Buffer[] {
    const parsed = parseAnthropicSse(eventStr);
    if (!parsed) return [];
    const { type, data } = parsed;

    if (type === "message_start") {
        const msg = (data.message ?? {}) as Record<string, unknown>;
        if (typeof msg.id === "string") cb.onMessageId(msg.id);
        const u = (msg.usage ?? {}) as Record<string, unknown>;
        cb.onCacheUsage(
            u.input_tokens as number | undefined,
            u.cache_read_input_tokens as number | undefined,
            u.cache_creation_input_tokens as number | undefined,
        );
        // message_start is only valid once per SSE response. Forward it in
        // round 1; suppress in all subsequent rounds (client already has it).
        return isFirstRound ? [Buffer.from(eventStr + "\n\n", "utf8")] : [];
    }

    if (type === "ping") {
        return [Buffer.from(eventStr + "\n\n", "utf8")];
    }

    if (type === "content_block_start") {
        const upstreamIndex = (data.index as number) ?? 0;
        const block = (data.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "";
            const id = typeof block.id === "string" ? block.id : `toolu_${upstreamIndex}`;
            if (PROXY_TOOL_NAMES.has(name)) {
                state.toolBlocks.set(upstreamIndex, { id, name, json: "" });
                return [];
            }
            cb.onRealToolUse();
        }
        const ci = state.clientIndex++;
        state.indexMap.set(upstreamIndex, ci);
        if (isFirstRound) return [Buffer.from(eventStr + "\n\n", "utf8")];
        return [Buffer.from(remapIndex(eventStr + "\n\n", upstreamIndex, ci), "utf8")];
    }

    if (type === "content_block_delta") {
        const upstreamIndex = (data.index as number) ?? 0;
        const delta = (data.delta ?? {}) as Record<string, unknown>;
        if (state.toolBlocks.has(upstreamIndex)) {
            if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                state.toolBlocks.get(upstreamIndex)!.json += delta.partial_json;
            }
            return [];
        }
        if (delta.type === "text_delta" && typeof delta.text === "string") cb.onText(delta.text);
        if (isFirstRound) return [Buffer.from(eventStr + "\n\n", "utf8")];
        const ci = state.indexMap.get(upstreamIndex) ?? upstreamIndex;
        return [Buffer.from(remapIndex(eventStr + "\n\n", upstreamIndex, ci), "utf8")];
    }

    if (type === "content_block_stop") {
        const upstreamIndex = (data.index as number) ?? 0;
        if (state.toolBlocks.has(upstreamIndex)) return [];
        if (isFirstRound) return [Buffer.from(eventStr + "\n\n", "utf8")];
        const ci = state.indexMap.get(upstreamIndex) ?? upstreamIndex;
        return [Buffer.from(remapIndex(eventStr + "\n\n", upstreamIndex, ci), "utf8")];
    }

    if (type === "message_delta") {
        const u = (data.usage ?? {}) as Record<string, unknown>;
        const out = u.output_tokens as number | undefined;
        if (typeof out === "number") cb.onOutputTokens(out);
        // GLM (unlike Anthropic's spec) puts the REAL input_tokens in
        // message_delta.usage, with message_start.usage.input_tokens=0. Always
        // capture input + cache_read here so stats reflect the actual billable
        // tokens regardless of which event the provider chose for it.
        cb.onCacheUsage(
            u.input_tokens as number | undefined,
            u.cache_read_input_tokens as number | undefined,
            u.cache_creation_input_tokens as number | undefined,
        );
        const d = (data.delta ?? {}) as Record<string, unknown>;
        if (typeof d.stop_reason === "string") cb.onStopReason(d.stop_reason);
        // ALWAYS suppress — we emit our own terminal SSE at the end with
        // accumulated output_tokens across all rounds. Forwarding the upstream
        // message_delta here would close the response prematurely.
        return [];
    }

    if (type === "message_stop") {
        return [];
    }

    return isFirstRound ? [Buffer.from(eventStr + "\n\n", "utf8")] : [];
}
