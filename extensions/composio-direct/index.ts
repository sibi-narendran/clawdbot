/**
 * Composio Direct Plugin for Clawdbot
 *
 * Provides access to 150+ tool integrations (Gmail, Slack, Notion, Calendar, etc.)
 * using a single generic tool pattern:
 *
 * - `composio`: Execute any Composio action by name
 * - `composio_list_actions`: Discover available actions for the current tenant/agent
 *
 * This design avoids async calls in the tool factory (which causes timing/race issues)
 * by moving all async operations to execute() time where they work correctly.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { getTenantIdFromContext, getTenantContext } from "../../src/config/tenant-context.js";

// Platform API URL - configurable via environment
const PLATFORM_API_URL = process.env.PLATFORM_API_URL || "http://localhost:3000";

interface ComposioTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  toolkit: string;
}

interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Fetch available tools from Platform API
 * This is called at execute() time, not factory time
 */
async function fetchToolsForAgent(
  tenantId: string,
  agentId?: string
): Promise<ComposioTool[]> {
  const url = new URL(`${PLATFORM_API_URL}/api/internal/composio/tools`);
  url.searchParams.set("tenantId", tenantId);
  if (agentId) {
    url.searchParams.set("agentId", agentId);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch tools: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { tools?: ComposioTool[] };
  return data.tools || [];
}

/**
 * Execute a tool via Platform API
 * The Platform API handles the Composio SDK interaction with proper tenant entity ID
 */
async function executeToolViaPlatform(
  tenantId: string,
  toolName: string,
  params: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const response = await fetch(`${PLATFORM_API_URL}/api/internal/composio/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, toolName, params }),
  });

  return (await response.json()) as ToolExecutionResult;
}

/**
 * Plugin definition
 */
const composioDirectPlugin = {
  id: "composio-direct",
  name: "Composio Direct Integration",
  description: "Direct Composio integration with 150+ apps via a single generic tool",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Register the main composio execution tool - NO async fetch needed in factory
    api.registerTool(
      {
        name: "composio",
        label: "composio integration",
        description:
          "Execute Composio actions for connected integrations (Gmail, Slack, Notion, Calendar, etc.). " +
          "Use composio_list_actions first to discover available actions and their parameters.",
        parameters: Type.Object({
          action: Type.String({
            description:
              "The action to execute (e.g., GMAIL_SEND_EMAIL, SLACK_SEND_MESSAGE, NOTION_CREATE_PAGE). " +
              "Use composio_list_actions to see available actions.",
          }),
          params: Type.Optional(
            Type.Record(Type.String(), Type.Any(), {
              description: "Action parameters (varies by action). Use composio_list_actions to see required params.",
            })
          ),
        }),

        async execute(_toolCallId: string, args: { action: string; params?: Record<string, unknown> }) {
          // Get tenant context at execution time - this is where async calls are allowed
          const tenantId = getTenantIdFromContext();
          if (!tenantId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: No tenant context available. This tool requires multi-tenant mode.",
                },
              ],
            };
          }

          const { action, params = {} } = args;

          if (!action) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: action parameter is required. Use composio_list_actions to see available actions.",
                },
              ],
            };
          }

          try {
            api.logger?.debug?.(`composio: executing ${action} for tenant ${tenantId}`);
            const result = await executeToolViaPlatform(tenantId, action, params);

            if (!result.success) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Error executing ${action}: ${result.error || "Unknown error"}`,
                  },
                ],
              };
            }

            // Format result
            const resultText =
              typeof result.data === "string"
                ? result.data
                : JSON.stringify(result.data, null, 2);

            return {
              content: [
                {
                  type: "text" as const,
                  text: resultText,
                },
              ],
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            api.logger?.error?.(`composio: execution failed - ${errorMessage}`);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error executing ${action}: ${errorMessage}`,
                },
              ],
            };
          }
        },
      },
      { optional: true }
    );

    // Register helper tool to list available actions - NO async fetch needed in factory
    api.registerTool(
      {
        name: "composio_list_actions",
        label: "list composio actions",
        description:
          "List available Composio actions for the current tenant. " +
          "Call this to discover what integrations are connected and what actions you can execute with the composio tool.",
        parameters: Type.Object({}),

        async execute(_toolCallId: string, _args: Record<string, unknown>, ctx?: { agentId?: string }) {
          // Get tenant context at execution time
          const tenantId = getTenantIdFromContext();
          if (!tenantId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: No tenant context available. This tool requires multi-tenant mode.",
                },
              ],
            };
          }

          // Get agent ID from context if available
          const agentId = ctx?.agentId;

          try {
            api.logger?.debug?.(
              `composio_list_actions: fetching tools for tenant ${tenantId}${agentId ? ` (agent: ${agentId})` : ""}`
            );
            const tools = await fetchToolsForAgent(tenantId, agentId);

            if (tools.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      "No Composio integrations are connected for this tenant.\n\n" +
                      "To use Composio actions, the tenant needs to connect integrations " +
                      "(Gmail, Slack, Notion, etc.) through the platform dashboard.",
                  },
                ],
              };
            }

            // Group tools by toolkit for better organization
            const toolsByToolkit = new Map<string, ComposioTool[]>();
            for (const tool of tools) {
              const toolkit = tool.toolkit || "other";
              if (!toolsByToolkit.has(toolkit)) {
                toolsByToolkit.set(toolkit, []);
              }
              toolsByToolkit.get(toolkit)!.push(tool);
            }

            // Format output
            let output = `# Available Composio Actions (${tools.length} total)\n\n`;
            output += "Use the `composio` tool to execute any of these actions.\n\n";

            for (const [toolkit, toolkitTools] of toolsByToolkit) {
              output += `## ${toolkit.toUpperCase()}\n\n`;
              for (const tool of toolkitTools) {
                output += `### ${tool.name}\n`;
                output += `${tool.description || "No description"}\n`;

                // Show parameters if available
                if (tool.parameters && typeof tool.parameters === "object") {
                  const params = tool.parameters as { properties?: Record<string, { description?: string }> };
                  if (params.properties && Object.keys(params.properties).length > 0) {
                    output += "\n**Parameters:**\n";
                    for (const [paramName, paramDef] of Object.entries(params.properties)) {
                      const desc = paramDef?.description || "No description";
                      output += `- \`${paramName}\`: ${desc}\n`;
                    }
                  }
                }
                output += "\n";
              }
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: output,
                },
              ],
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            api.logger?.error?.(`composio_list_actions: fetch failed - ${errorMessage}`);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error fetching available actions: ${errorMessage}`,
                },
              ],
            };
          }
        },
      },
      { optional: true }
    );

    api.logger?.info?.("composio-direct: plugin registered with generic tool pattern");
  },
};

export default composioDirectPlugin;
