/**
 * Safe template variable interpolation
 * Only supports {{env.VAR}}, {{params.KEY}}, {{response.KEY}} patterns
 * No code execution, no eval, no Function constructor
 */

export type TemplateContext = {
  env: Record<string, string | undefined>;
  params: Record<string, unknown>;
  response?: Record<string, unknown>;
};

const TEMPLATE_PATTERN = /\{\{(env|params|response)\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

/**
 * Interpolate template variables in a string
 * Throws if a required env var is missing (doesn't silently empty-string)
 */
export function interpolateString(
  template: string,
  ctx: TemplateContext,
  strictEnv = true,
): string {
  return template.replace(TEMPLATE_PATTERN, (match, scope: string, key: string) => {
    if (scope === "env") {
      const value = ctx.env[key];
      if (value === undefined && strictEnv) {
        throw new Error(`Missing required environment variable: ${key}`);
      }
      return value ?? "";
    }
    if (scope === "params") {
      const value = ctx.params[key];
      if (value === undefined) return "";
      return String(value);
    }
    if (scope === "response") {
      if (!ctx.response) return "";
      const value = ctx.response[key];
      if (value === undefined) return "";
      return String(value);
    }
    return match;
  });
}

/**
 * Recursively interpolate all strings in an object/array structure
 */
export function interpolateDeep(
  value: unknown,
  ctx: TemplateContext,
  strictEnv = true,
): unknown {
  if (typeof value === "string") {
    return interpolateString(value, ctx, strictEnv);
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateDeep(item, ctx, strictEnv));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateDeep(v, ctx, strictEnv);
    }
    return result;
  }
  return value;
}
