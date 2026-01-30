import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { buildHistoryContextFromEntries, type HistoryEntry } from "../auto-reply/reply/history.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import {
  clearConfigCacheForTenant,
  resolveTenantStateDirFromId,
  runWithTenantContextAsync,
  type TenantContext,
} from "../config/config.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { defaultRuntime } from "../runtime.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
  setSseHeaders,
  writeDone,
} from "./http-common.js";
import { getBearerToken, resolveAgentIdForRequest, resolveSessionKey } from "./http-utils.js";

/**
 * Extract tenant ID from request headers.
 * Supports: X-Tenant-ID, X-Tenant-Id (case-insensitive)
 */
function getTenantIdFromRequest(req: IncomingMessage): string | undefined {
  const header = req.headers["x-tenant-id"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  if (Array.isArray(header) && header[0]?.trim()) {
    return header[0].trim();
  }
  return undefined;
}

/**
 * Build tenant context from request headers.
 * Returns null if no tenant ID is present (single-tenant mode).
 */
function buildTenantContextFromRequest(req: IncomingMessage): TenantContext | null {
  const tenantId = getTenantIdFromRequest(req);
  if (!tenantId) {
    return null;
  }

  const stateDir = resolveTenantStateDirFromId(tenantId);
  return { tenantId, stateDir };
}

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  messages?: unknown;
  user?: unknown;
};

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") return text;
        if (type === "input_text" && typeof text === "string") return text;
        if (typeof inputText === "string") return inputText;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function buildAgentPrompt(messagesUnknown: unknown): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: Array<{ role: "user" | "assistant" | "tool"; entry: HistoryEntry }> =
    [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = typeof msg.role === "string" ? msg.role.trim() : "";
    const content = extractTextContent(msg.content).trim();
    if (!role || !content) continue;
    if (role === "system" || role === "developer") {
      systemParts.push(content);
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: content },
    });
  }

  let message = "";
  if (conversationEntries.length > 0) {
    let currentIndex = -1;
    for (let i = conversationEntries.length - 1; i >= 0; i -= 1) {
      const entryRole = conversationEntries[i]?.role;
      if (entryRole === "user" || entryRole === "tool") {
        currentIndex = i;
        break;
      }
    }
    if (currentIndex < 0) currentIndex = conversationEntries.length - 1;
    const currentEntry = conversationEntries[currentIndex]?.entry;
    if (currentEntry) {
      const historyEntries = conversationEntries.slice(0, currentIndex).map((entry) => entry.entry);
      if (historyEntries.length === 0) {
        message = currentEntry.body;
      } else {
        const formatEntry = (entry: HistoryEntry) => `${entry.sender}: ${entry.body}`;
        message = buildHistoryContextFromEntries({
          entries: [...historyEntries, currentEntry],
          currentMessage: formatEntry(currentEntry),
          formatEntry,
        });
      }
    }
  }

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveOpenAiSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
}): string {
  return resolveSessionKey({ ...params, prefix: "openai" });
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") return {};
  return val as OpenAiChatCompletionRequest;
}

/**
 * Core implementation of OpenAI HTTP request handling.
 * This is called within the tenant context (if any).
 */
async function handleOpenAiHttpRequestImpl(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
  body: unknown,
): Promise<boolean> {
  const payload = coerceRequest(body);
  const stream = Boolean(payload.stream);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;

  const agentId = resolveAgentIdForRequest({ req, model });
  const sessionKey = resolveOpenAiSessionKey({ req, agentId, user });
  const prompt = buildAgentPrompt(payload.messages);
  if (!prompt.message) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  // Clear config cache at start of tenant request to ensure fresh config
  clearConfigCacheForTenant();

  const runId = `chatcmpl_${randomUUID()}`;
  const deps = createDefaultDeps();

  if (!stream) {
    try {
      const result = await agentCommand(
        {
          message: prompt.message,
          extraSystemPrompt: prompt.extraSystemPrompt,
          sessionKey,
          runId,
          deliver: false,
          messageChannel: "webchat",
          bestEffortDeliver: false,
        },
        defaultRuntime,
        deps,
      );

      const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
      const content =
        Array.isArray(payloads) && payloads.length > 0
          ? payloads
              .map((p) => (typeof p.text === "string" ? p.text : ""))
              .filter(Boolean)
              .join("\n\n")
          : "No response from OpenClaw.";

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: String(err), type: "api_error" },
      });
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let sawAssistantDelta = false;
  let closed = false;

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) return;
    if (closed) return;

    if (evt.stream === "assistant") {
      const delta = evt.data?.delta;
      const text = evt.data?.text;
      const content = typeof delta === "string" ? delta : typeof text === "string" ? text : "";
      if (!content) return;

      if (!wroteRole) {
        wroteRole = true;
        writeSse(res, {
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: "assistant" } }],
        });
      }

      sawAssistantDelta = true;
      writeSse(res, {
        id: runId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content },
            finish_reason: null,
          },
        ],
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommand(
        {
          message: prompt.message,
          extraSystemPrompt: prompt.extraSystemPrompt,
          sessionKey,
          runId,
          deliver: false,
          messageChannel: "webchat",
          bestEffortDeliver: false,
        },
        defaultRuntime,
        deps,
      );

      if (closed) return;

      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeSse(res, {
            id: runId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { role: "assistant" } }],
          });
        }

        const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
        const content =
          Array.isArray(payloads) && payloads.length > 0
            ? payloads
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("\n\n")
            : "No response from OpenClaw.";

        sawAssistantDelta = true;
        writeSse(res, {
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { content },
              finish_reason: null,
            },
          ],
        });
      }
    } catch (err) {
      if (closed) return;
      writeSse(res, {
        id: runId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content: `Error: ${String(err)}` },
            finish_reason: "stop",
          },
        ],
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  })();

  return true;
}

/**
 * Handle OpenAI-compatible HTTP requests.
 * Wraps request processing in tenant context for multi-tenant isolation.
 */
export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/v1/chat/completions") return false;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: { token, password: token },
    req,
    trustedProxies: opts.trustedProxies,
  });
  if (!authResult.ok) {
    sendUnauthorized(res);
    return true;
  }

  const body = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? 1024 * 1024);
  if (body === undefined) return true;

  // Build tenant context from X-Tenant-ID header
  const tenantContext = buildTenantContextFromRequest(req);

  // If no tenant context, run without isolation (single-tenant mode)
  if (!tenantContext) {
    return handleOpenAiHttpRequestImpl(req, res, opts, body);
  }

  // Wrap the entire request handling in the tenant context
  // This ensures all async operations see the correct tenant state directory
  return runWithTenantContextAsync(tenantContext, async () => {
    return handleOpenAiHttpRequestImpl(req, res, opts, body);
  });
}
