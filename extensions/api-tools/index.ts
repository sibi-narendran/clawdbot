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

import { loadToolDefinitions } from "./yaml-loader.js";
import { buildParameterSchema } from "./schema-builder.js";
import { executeApiTool } from "./executor.js";

type ToolContext = {
  agentDir?: string;
  agentId?: string;
  workspaceDir?: string;
};

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
            return executeApiTool({ definition: def, args });
          },
        }));
      },
      { optional: true },
    );

    api.logger?.info?.("api-tools: plugin registered");
  },
};

export default apiToolsPlugin;
