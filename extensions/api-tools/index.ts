/**
 * API Tools Plugin for Clawdbot
 *
 * Registers native tools from YAML definitions in the agent's api-tools/ directory.
 * Each YAML file becomes a tool the LLM can call directly.
 *
 * No shell/exec access needed — runs HTTP requests directly via fetch().
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import fs from "node:fs";
import path from "node:path";
import { loadToolDefinitions } from "./yaml-loader.js";
import { buildParameterSchema } from "./schema-builder.js";
import { executeApiTool } from "./executor.js";

type ToolContext = {
  agentDir?: string;
  agentId?: string;
  workspaceDir?: string;
};

function extractTenantId(agentDir: string): string | null {
  const parts = agentDir.split("/");
  const agentsIdx = parts.indexOf("agents");
  return agentsIdx > 0 ? parts[agentsIdx - 1] : null;
}

function loadTenantEnv(agentDir: string): Record<string, string> {
  try {
    const tenantDir = path.resolve(agentDir, "../..");
    const configPath = path.join(tenantDir, "clawdbot.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config.env || {};
  } catch {
    return {};
  }
}

const apiToolsPlugin = {
  id: "api-tools",
  name: "API Tools",
  description: "Generic API tools from YAML definitions",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.registerTool(
      (ctx: ToolContext) => {
        const agentDir = ctx.agentDir;
        if (!agentDir) {
          return null;
        }

        const definitions = loadToolDefinitions(agentDir);
        if (definitions.length === 0) {
          return null;
        }

        const tenantEnv = loadTenantEnv(agentDir);
        const extraEnv: Record<string, string> = {
          ...tenantEnv,
          ...(agentDir ? { TENANT_ID: extractTenantId(agentDir) || "" } : {}),
          ...(ctx.agentId ? { AGENT_ID: ctx.agentId } : {}),
        };

        api.logger?.info?.(
          `api-tools: loaded ${definitions.length} tool(s) for agent ${ctx.agentId ?? "unknown"}: ${definitions.map(d => d.name).join(", ")}`,
        );

        // Return array of tools — one per YAML file
        return definitions.map((def) => ({
          name: def.name,
          label: def.name.replace(/_/g, " "),
          description: def.description,
          parameters: buildParameterSchema(def.parameters),

          async execute(
            _toolCallId: string,
            args: Record<string, unknown>,
          ) {
            api.logger?.debug?.(
              `api-tools: executing ${def.name}`,
            );
            return executeApiTool({ definition: def, args, extraEnv });
          },
        }));
      },
      { optional: true },
    );

    api.logger?.info?.("api-tools: plugin registered");
  },
};

export default apiToolsPlugin;
