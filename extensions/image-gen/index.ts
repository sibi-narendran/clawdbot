/**
 * Image Generation Plugin for Clawdbot
 *
 * Provides a `generate_image` tool that calls OpenRouter's Gemini 3 Pro Image Preview
 * model to generate images from text prompts. Uploads output to Supabase Storage (public bucket)
 * and returns a CDN-backed public URL.
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
      /** OpenRouter returns images in a separate field for some models (e.g. Gemini) */
      images?: Array<{
        type: string;
        image_url?: { url: string };
        index?: number;
      }>;
    };
  }>;
}

const DATA_URI_PATTERN = /data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)/;

/**
 * Extract base64 image data from a data URI string.
 */
function extractFromDataUri(url: string): { base64: string; ext: string } | null {
  const match = url.match(DATA_URI_PATTERN);
  return match ? { base64: match[2], ext: match[1] } : null;
}

/** Extract tenantId from agentDir path (e.g. .../tenants/{tenantId}/agents/...) */
function extractTenantId(agentDir: string): string | null {
  const parts = agentDir.split("/");
  const agentsIdx = parts.indexOf("agents");
  return agentsIdx > 0 ? parts[agentsIdx - 1] : null;
}

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Upload image buffer to Supabase Storage via REST API */
async function uploadToSupabase(
  imageBuffer: Buffer,
  storagePath: string,
  ext: string,
  logger?: { debug?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void },
): Promise<{ url: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_KEY not set");
  }

  const contentType = MIME_TYPES[ext] || "image/png";
  const uploadUrl = `${supabaseUrl}/storage/v1/object/media/${storagePath}`;

  logger?.debug?.(`image-gen: uploading to ${uploadUrl}`);

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": contentType,
    },
    body: imageBuffer,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Supabase upload failed (${res.status}): ${errorText}`);
  }

  const publicUrl = `${supabaseUrl}/storage/v1/object/public/media/${storagePath}`;
  return { url: publicUrl };
}

/**
 * Extract base64 image data from an OpenRouter response.
 * Handles three formats:
 * 1. String content with inline data URI
 * 2. Multipart content array with image_url parts
 * 3. Separate `images` field on the message (used by Gemini models via OpenRouter)
 */
function extractImage(choices: OpenRouterResponse["choices"]): {
  base64: string;
  ext: string;
} | null {
  const msg = choices?.[0]?.message;
  if (!msg) return null;

  // Check message.images[] first (OpenRouter's Gemini response format)
  if (Array.isArray(msg.images)) {
    for (const img of msg.images) {
      if (img.type === "image_url" && img.image_url?.url) {
        const result = extractFromDataUri(img.image_url.url);
        if (result) return result;
      }
    }
  }

  const content = msg.content;
  if (!content) return null;

  // String content: look for data URI
  if (typeof content === "string") {
    return extractFromDataUri(content);
  }

  // Multipart content array: look for image_url parts
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "image_url" && part.image_url?.url) {
        const result = extractFromDataUri(part.image_url.url);
        if (result) return result;
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
            "The image is uploaded to cloud storage and a public URL is returned.",
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
                        "No agent directory available. Cannot upload generated image.",
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
                  response_modalities: ["IMAGE", "TEXT"],
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

              // Upload to Supabase Storage
              const tenantId = extractTenantId(agentDir);
              if (!tenantId) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        success: false,
                        error: "Could not determine tenant ID from agent directory.",
                      }),
                    },
                  ],
                };
              }

              const agentId = ctx.agentId || agentDir.split("/").pop() || "unknown";
              const filename = `generated-${Date.now()}.${image.ext}`;
              const storagePath = `${tenantId}/${agentId}/${filename}`;
              const imageBuffer = Buffer.from(image.base64, "base64");

              const { url } = await uploadToSupabase(
                imageBuffer,
                storagePath,
                image.ext,
                api.logger,
              );

              api.logger?.info?.(
                `image-gen: uploaded image to ${url}`,
              );

              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      success: true,
                      url,
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
