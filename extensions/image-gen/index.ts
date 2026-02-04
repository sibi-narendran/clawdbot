/**
 * Image Generation Plugin for Clawdbot
 *
 * Provides a `generate_image` tool that calls OpenRouter's Gemini 3 Pro Image Preview
 * model to generate images from text prompts. Saves output to the agent's canvas/ directory.
 *
 * No shell/exec access needed — runs the API call directly in-process via fetch().
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";

/** Matches OpenClawPluginToolContext from clawdbot plugin system */
type ToolContext = {
  agentDir?: string;
  agentId?: string;
  workspaceDir?: string;
};
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MODEL = "google/gemini-3-pro-image-preview";
const API_URL = "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterResponse {
  error?: { message?: string };
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type: string;
            text?: string;
            image_url?: { url: string };
          }>;
    };
  }>;
}

/**
 * Extract base64 image data from an OpenRouter response.
 * Handles both string content (with inline data URI) and multipart content array.
 */
function extractImage(content: OpenRouterResponse["choices"]): {
  base64: string;
  ext: string;
} | null {
  const message = content?.[0]?.message?.content;
  if (!message) return null;

  // String content: look for data URI
  if (typeof message === "string") {
    const match = message.match(
      /data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)/,
    );
    if (match) {
      return { base64: match[2], ext: match[1] };
    }
    return null;
  }

  // Multipart content array: look for image_url parts
  if (Array.isArray(message)) {
    for (const part of message) {
      if (part.type === "image_url" && part.image_url?.url) {
        const match = part.image_url.url.match(
          /data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)/,
        );
        if (match) {
          return { base64: match[2], ext: match[1] };
        }
      }
    }
  }

  return null;
}

const imageGenPlugin = {
  id: "image-gen",
  name: "AI Image Generation",
  description:
    "Generate images from text prompts using OpenRouter (Gemini 3 Pro Image Preview)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Use factory pattern to receive agentDir context
    api.registerTool(
      (ctx: ToolContext) => {
        const agentDir = ctx.agentDir;

        return {
          name: "generate_image",
          label: "generate image",
          description:
            "Generate an image from a text prompt using AI. " +
            "The image is saved to the agent's canvas/ directory and the path is returned.",
          parameters: Type.Object({
            prompt: Type.String({
              description:
                "A detailed text description of the image to generate. Be specific about subject, style, colors, and composition.",
            }),
            style: Type.Optional(
              Type.String({
                description:
                  "Optional style modifier (e.g., 'photorealistic', 'watercolor', 'minimalist', 'cartoon'). " +
                  "Appended to the prompt for style guidance.",
              }),
            ),
          }),

          async execute(
            _toolCallId: string,
            args: { prompt: string; style?: string },
          ) {
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      success: false,
                      error:
                        "OPENROUTER_API_KEY not set. Image generation requires an OpenRouter API key.",
                    }),
                  },
                ],
              };
            }

            if (!agentDir) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      success: false,
                      error:
                        "No agent directory available. Cannot save generated image.",
                    }),
                  },
                ],
              };
            }

            const { prompt, style } = args;
            if (!prompt) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      success: false,
                      error: "No prompt provided.",
                    }),
                  },
                ],
              };
            }

            const fullPrompt = style ? `${prompt}, ${style} style` : prompt;

            try {
              api.logger?.debug?.(
                `image-gen: generating image for prompt: "${fullPrompt.slice(0, 80)}..."`,
              );

              const response = await fetch(API_URL, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${apiKey}`,
                  "HTTP-Referer": "https://workforce.dooza.ai",
                  "X-Title": "Workforce Image Generation",
                },
                body: JSON.stringify({
                  model: MODEL,
                  modalities: ["image", "text"],
                  messages: [{ role: "user", content: fullPrompt }],
                }),
              });

              if (!response.ok) {
                const errorText = await response.text();
                api.logger?.error?.(
                  `image-gen: API error ${response.status}: ${errorText}`,
                );
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        success: false,
                        error: `OpenRouter API error: ${response.status} ${response.statusText}`,
                      }),
                    },
                  ],
                };
              }

              const data = (await response.json()) as OpenRouterResponse;

              if (data.error) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        success: false,
                        error: data.error.message || "API returned an error",
                      }),
                    },
                  ],
                };
              }

              const image = extractImage(data.choices);

              if (!image) {
                // Model returned text instead of image
                const textContent = data.choices?.[0]?.message?.content;
                const message =
                  typeof textContent === "string"
                    ? textContent
                    : "Model did not return an image";
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        success: false,
                        error: "No image in response",
                        message,
                      }),
                    },
                  ],
                };
              }

              // Save to canvas/ directory
              const canvasDir = join(agentDir, "canvas");
              await mkdir(canvasDir, { recursive: true });

              const filename = `generated-${Date.now()}.${image.ext}`;
              const outputPath = join(canvasDir, filename);

              await writeFile(
                outputPath,
                Buffer.from(image.base64, "base64"),
              );

              api.logger?.info?.(
                `image-gen: saved image to ${outputPath}`,
              );

              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      success: true,
                      path: outputPath,
                      filename,
                      prompt: fullPrompt,
                    }),
                  },
                ],
              };
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
              api.logger?.error?.(
                `image-gen: generation failed - ${errorMessage}`,
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      success: false,
                      error: `Image generation failed: ${errorMessage}`,
                    }),
                  },
                ],
              };
            }
          },
        };
      },
      { optional: true },
    );

    api.logger?.info?.("image-gen: plugin registered");
  },
};

export default imageGenPlugin;
