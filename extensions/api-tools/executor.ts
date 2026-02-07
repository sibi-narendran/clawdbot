/**
 * HTTP request execution with security checks
 */

import type { ApiToolDefinition, ApiToolExecuteParams } from "./types.js";
import { interpolateDeep, interpolateString, type TemplateContext } from "./template-engine.js";

const MAX_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;

// Private IP patterns to block
const PRIVATE_IP_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /\.local$/i,
  /\.internal$/i,
];

// AWS metadata endpoint
const BLOCKED_HOSTS = ["169.254.169.254"];

function isPrivateHost(hostname: string): boolean {
  if (BLOCKED_HOSTS.includes(hostname)) return true;
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname));
}

function isAllowedHost(hostname: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((allowed) => {
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(1);
      return hostname.endsWith(suffix) || hostname === allowed.slice(2);
    }
    return hostname === allowed;
  });
}

function validateUrl(url: string, allowedHosts: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const hostname = parsed.hostname;

  if (isPrivateHost(hostname)) {
    throw new Error(`Blocked: requests to private/internal hosts not allowed (${hostname})`);
  }

  if (!isAllowedHost(hostname, allowedHosts)) {
    throw new Error(
      `Blocked: host '${hostname}' not in allowed_hosts [${allowedHosts.join(", ")}]`,
    );
  }
}

function checkRequiredEnvVars(requires: string[] | undefined, env?: Record<string, string>): void {
  if (!requires || requires.length === 0) return;
  const merged = { ...process.env, ...env };
  const missing = requires.filter((key) => !merged[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

export interface ExecuteResult {
  success: boolean;
  data?: unknown;
  status?: number;
  error?: string;
  summary?: string;
}

export async function executeApiTool(params: ApiToolExecuteParams): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const { definition, args } = params;

  try {
    // Check required env vars
    checkRequiredEnvVars(definition.requires_env, params.extraEnv);

    // Build template context
    const ctx: TemplateContext = {
      env: { ...process.env, ...params.extraEnv } as Record<string, string | undefined>,
      params: args,
    };

    // Interpolate URL
    const url = interpolateString(definition.request.url, ctx);

    // Validate URL against security constraints
    validateUrl(url, definition.allowed_hosts);

    // Interpolate headers
    const headers: Record<string, string> = {};
    if (definition.request.headers) {
      for (const [key, value] of Object.entries(definition.request.headers)) {
        headers[key] = interpolateString(value, ctx);
      }
    }

    // Build request body
    let body: string | undefined;
    if (definition.request.body) {
      const interpolatedContent = interpolateDeep(definition.request.body.content, ctx);
      if (definition.request.body.type === "json") {
        body = JSON.stringify(interpolatedContent);
        if (!headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
      } else if (definition.request.body.type === "form") {
        const formData = new URLSearchParams();
        if (typeof interpolatedContent === "object" && interpolatedContent !== null) {
          for (const [k, v] of Object.entries(interpolatedContent)) {
            formData.append(k, String(v));
          }
        }
        body = formData.toString();
        if (!headers["Content-Type"]) {
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        }
      } else {
        body = String(interpolatedContent);
      }
    }

    // Calculate timeout
    const timeout = Math.min(
      definition.request.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );

    // Execute request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method: definition.request.method,
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // Parse response
    let responseData: unknown;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      responseData = await response.json();
    } else {
      responseData = await response.text();
    }

    // Build result
    const result: ExecuteResult = {
      success: response.ok,
      status: response.status,
      data: responseData,
    };

    // Generate summary if template provided
    if (definition.response?.summary && response.ok) {
      const responseCtx: TemplateContext = {
        env: ctx.env,
        params: ctx.params,
        response:
          typeof responseData === "object" && responseData !== null
            ? (responseData as Record<string, unknown>)
            : { value: responseData },
      };
      result.summary = interpolateString(definition.response.summary, responseCtx, false);
    }

    // Generate error message if template provided and request failed
    if (definition.response?.error_template && !response.ok) {
      const responseCtx: TemplateContext = {
        env: ctx.env,
        params: ctx.params,
        response: {
          status: response.status,
          ...(typeof responseData === "object" && responseData !== null
            ? (responseData as Record<string, unknown>)
            : { message: responseData }),
        },
      };
      result.error = interpolateString(definition.response.error_template, responseCtx, false);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }),
        },
      ],
    };
  }
}
