/**
 * Load and validate YAML tool definitions from agent directory
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ApiToolDefinition } from "./types.js";

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

function validateDefinition(def: unknown, filename: string): ApiToolDefinition | null {
  if (!def || typeof def !== "object") {
    console.warn(`api-tools: ${filename} is not a valid object`);
    return null;
  }

  const d = def as Record<string, unknown>;

  // Required fields
  if (typeof d.name !== "string" || !TOOL_NAME_PATTERN.test(d.name)) {
    console.warn(
      `api-tools: ${filename} has invalid name (must match ${TOOL_NAME_PATTERN})`,
    );
    return null;
  }

  if (typeof d.description !== "string") {
    console.warn(`api-tools: ${filename} missing description`);
    return null;
  }

  if (!d.request || typeof d.request !== "object") {
    console.warn(`api-tools: ${filename} missing request block`);
    return null;
  }

  const req = d.request as Record<string, unknown>;
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(req.method as string)) {
    console.warn(`api-tools: ${filename} has invalid request.method`);
    return null;
  }

  if (typeof req.url !== "string") {
    console.warn(`api-tools: ${filename} missing request.url`);
    return null;
  }

  if (!Array.isArray(d.allowed_hosts) || d.allowed_hosts.length === 0) {
    console.warn(`api-tools: ${filename} missing or empty allowed_hosts`);
    return null;
  }

  // Validate parameters if present
  if (d.parameters !== undefined) {
    if (typeof d.parameters !== "object" || d.parameters === null) {
      console.warn(`api-tools: ${filename} has invalid parameters`);
      return null;
    }
    for (const [key, param] of Object.entries(d.parameters as Record<string, unknown>)) {
      if (!param || typeof param !== "object") {
        console.warn(`api-tools: ${filename} parameter '${key}' is invalid`);
        return null;
      }
      const p = param as Record<string, unknown>;
      if (!["string", "number", "boolean", "integer"].includes(p.type as string)) {
        console.warn(
          `api-tools: ${filename} parameter '${key}' has invalid type`,
        );
        return null;
      }
    }
  }

  return d as unknown as ApiToolDefinition;
}

export function loadToolDefinitions(agentDir: string): ApiToolDefinition[] {
  const apiToolsDir = join(agentDir, "api-tools");

  if (!existsSync(apiToolsDir)) {
    return [];
  }

  const definitions: ApiToolDefinition[] = [];

  let files: string[];
  try {
    files = readdirSync(apiToolsDir);
  } catch {
    return [];
  }

  for (const file of files) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) {
      continue;
    }

    const filePath = join(apiToolsDir, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const parsed = parseYaml(content);
      const validated = validateDefinition(parsed, file);
      if (validated) {
        definitions.push(validated);
      }
    } catch (error) {
      console.warn(
        `api-tools: failed to parse ${file}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  return definitions;
}
