/**
 * Brand Assets Plugin for Clawdbot
 *
 * Provides tools to access brand profile and assets stored in Supabase Brain storage.
 * This is a TypeScript plugin (not YAML) because it needs to return image content blocks
 * (type: "image") which YAML api-tools can't do (hardcoded type: "text").
 *
 * ## Tools Registered
 * - `get_brand_profile` — reads from `brain_brand` table via PostgREST
 * - `list_brand_assets` — reads from `brain_items` table via PostgREST
 * - `fetch_brand_image` — downloads image from Supabase Storage `brain` bucket,
 *   returns both an image content block (LLM can see it) and a signedUrl
 *   that can be passed to `generate_image`'s `reference_image_url` parameter
 *
 * ## Database Tables (platform/src/db/schema.ts)
 * - `brain_brand` — one row per tenant: business_name, tagline, primary_color,
 *   secondary_color, industry, target_audience, description, value_proposition,
 *   logo_url, website, social_links (jsonb)
 * - `brain_items` — uploaded assets: id, tenant_id, type ("image"|"document"|"video"|"file"),
 *   title, file_name, file_path (in brain storage bucket), mime_type, file_size
 *
 * ## Supabase Access Pattern
 * All tools use PostgREST (REST API) with service key auth — same pattern as image-gen plugin.
 * Headers: { apikey: SERVICE_KEY, Authorization: "Bearer SERVICE_KEY" }
 * Storage downloads: GET /storage/v1/object/authenticated/brain/{filePath}
 * Signed URLs:      POST /storage/v1/object/sign/brain/{filePath} { expiresIn: 3600 }
 *
 * ## Tenant Isolation
 * tenantId is extracted from ctx.agentDir path: .../tenants/{tenantId}/agents/...
 * All queries filter by tenant_id. Storage paths are namespaced under brain/{tenantId}/.
 *
 * ## Environment Variables (set via ecosystem.config.cjs -> PM2)
 * - SUPABASE_URL — Supabase project URL
 * - SUPABASE_SERVICE_KEY — Service role key
 *
 * ## Registration in templates.ts
 * Somi template has: plugins: ['image-gen', 'api-tools', 'brand-assets']
 * alsoAllow: ['get_brand_profile', 'list_brand_assets', 'fetch_brand_image']
 * Sync system auto-enables the plugin in per-tenant clawdbot.json.
 *
 * ## Workflow (how Somi uses these tools)
 * 1. get_brand_profile -> brand name, colors, tagline
 * 2. list_brand_assets -> find asset IDs
 * 3. fetch_brand_image(asset_id) -> LLM sees the image + gets signedUrl
 * 4. generate_image(prompt, reference_image_url: signedUrl) -> brand-consistent image
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";

type ToolContext = {
  agentDir?: string;
  agentId?: string;
  workspaceDir?: string;
};

/** Extract tenantId from agentDir path (e.g. .../tenants/{tenantId}/agents/...) */
function extractTenantId(agentDir: string): string | null {
  const parts = agentDir.split("/");
  const agentsIdx = parts.indexOf("agents");
  return agentsIdx > 0 ? parts[agentsIdx - 1] : null;
}

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errorResult(error: string) {
  return textResult({ success: false, error });
}

const brandAssetsPlugin = {
  id: "brand-assets",
  name: "Brand Assets",
  description: "Access brand profile, logos, and assets from Supabase Brain storage",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // ── get_brand_profile ──────────────────────────────────────────────
    api.registerTool(
      (ctx: ToolContext) => {
        const agentDir = ctx.agentDir;

        return {
          name: "get_brand_profile",
          label: "get brand profile",
          description:
            "Get the tenant's brand profile — name, tagline, colors, industry, target audience, and description.",
          parameters: Type.Object({}),

          async execute() {
            const config = getSupabaseConfig();
            if (!config) return errorResult("SUPABASE_URL or SUPABASE_SERVICE_KEY not set.");

            if (!agentDir) return errorResult("No agent directory available.");

            const tenantId = extractTenantId(agentDir);
            if (!tenantId) return errorResult("Could not determine tenant ID.");

            try {
              const url = `${config.supabaseUrl}/rest/v1/brain_brand?tenant_id=eq.${tenantId}&limit=1`;
              const res = await fetch(url, {
                headers: {
                  apikey: config.serviceKey,
                  Authorization: `Bearer ${config.serviceKey}`,
                },
              });

              if (!res.ok) {
                const errText = await res.text();
                api.logger?.error?.(`brand-assets: brand profile fetch failed (${res.status}): ${errText}`);
                return errorResult(`Failed to fetch brand profile: ${res.status}`);
              }

              const rows = (await res.json()) as Record<string, unknown>[];
              if (!rows.length) {
                return textResult({
                  success: true,
                  brand: null,
                  message: "No brand profile found. The user hasn't set one up yet.",
                });
              }

              const row = rows[0];
              return textResult({
                success: true,
                brand: {
                  businessName: row.business_name,
                  website: row.website,
                  tagline: row.tagline,
                  industry: row.industry,
                  targetAudience: row.target_audience,
                  description: row.description,
                  valueProposition: row.value_proposition,
                  primaryColor: row.primary_color,
                  secondaryColor: row.secondary_color,
                  logoUrl: row.logo_url,
                  socialLinks: row.social_links,
                },
              });
            } catch (error) {
              const msg = error instanceof Error ? error.message : "Unknown error";
              api.logger?.error?.(`brand-assets: get_brand_profile error — ${msg}`);
              return errorResult(`Brand profile fetch failed: ${msg}`);
            }
          },
        };
      },
      // optional: true means this tool requires explicit inclusion in the agent's
      // alsoAllow list (set in templates.ts → requiredTools.alsoAllow). Without it,
      // the tool would be available to ALL agents, which we don't want.
      { optional: true },
    );

    // ── list_brand_assets ──────────────────────────────────────────────
    api.registerTool(
      (ctx: ToolContext) => {
        const agentDir = ctx.agentDir;

        return {
          name: "list_brand_assets",
          label: "list brand assets",
          description:
            "List brand assets (images, documents, files) uploaded to the Brain. " +
            "Returns id, title, fileName, mimeType, and fileSize for each asset.",
          parameters: Type.Object({
            type: Type.Optional(
              Type.String({
                description:
                  "Filter by asset type: 'image', 'document', 'video', or 'file'. Defaults to all types.",
              }),
            ),
          }),

          async execute(_toolCallId: string, args: { type?: string }) {
            const config = getSupabaseConfig();
            if (!config) return errorResult("SUPABASE_URL or SUPABASE_SERVICE_KEY not set.");

            if (!agentDir) return errorResult("No agent directory available.");

            const tenantId = extractTenantId(agentDir);
            if (!tenantId) return errorResult("Could not determine tenant ID.");

            try {
              let url = `${config.supabaseUrl}/rest/v1/brain_items?tenant_id=eq.${tenantId}&order=created_at.desc`;
              if (args.type) {
                url += `&type=eq.${encodeURIComponent(args.type)}`;
              }

              const res = await fetch(url, {
                headers: {
                  apikey: config.serviceKey,
                  Authorization: `Bearer ${config.serviceKey}`,
                },
              });

              if (!res.ok) {
                const errText = await res.text();
                api.logger?.error?.(`brand-assets: list failed (${res.status}): ${errText}`);
                return errorResult(`Failed to list brand assets: ${res.status}`);
              }

              const rows = (await res.json()) as Record<string, unknown>[];
              const assets = rows.map((r) => ({
                id: r.id,
                title: r.title,
                fileName: r.file_name,
                mimeType: r.mime_type,
                fileSize: r.file_size,
                type: r.type,
              }));

              return textResult({
                success: true,
                count: assets.length,
                assets,
              });
            } catch (error) {
              const msg = error instanceof Error ? error.message : "Unknown error";
              api.logger?.error?.(`brand-assets: list_brand_assets error — ${msg}`);
              return errorResult(`Brand assets list failed: ${msg}`);
            }
          },
        };
      },
      { optional: true },
    );

    // ── fetch_brand_image ──────────────────────────────────────────────
    api.registerTool(
      (ctx: ToolContext) => {
        const agentDir = ctx.agentDir;

        return {
          name: "fetch_brand_image",
          label: "fetch brand image",
          description:
            "Fetch a brand image by asset ID so you can see it. Returns the image visually " +
            "plus a signed URL you can pass to generate_image's reference_image_url parameter.",
          parameters: Type.Object({
            asset_id: Type.String({
              description: "The asset ID from list_brand_assets.",
            }),
          }),

          async execute(_toolCallId: string, args: { asset_id: string }) {
            const config = getSupabaseConfig();
            if (!config) return errorResult("SUPABASE_URL or SUPABASE_SERVICE_KEY not set.");

            if (!agentDir) return errorResult("No agent directory available.");

            const tenantId = extractTenantId(agentDir);
            if (!tenantId) return errorResult("Could not determine tenant ID.");

            const { asset_id } = args;
            if (!asset_id) return errorResult("No asset_id provided.");

            try {
              // Look up the brain item
              const itemUrl = `${config.supabaseUrl}/rest/v1/brain_items?id=eq.${encodeURIComponent(asset_id)}&tenant_id=eq.${tenantId}&limit=1`;
              const itemRes = await fetch(itemUrl, {
                headers: {
                  apikey: config.serviceKey,
                  Authorization: `Bearer ${config.serviceKey}`,
                },
              });

              if (!itemRes.ok) {
                return errorResult(`Failed to look up asset: ${itemRes.status}`);
              }

              const items = (await itemRes.json()) as Record<string, unknown>[];
              if (!items.length) {
                return errorResult("Asset not found or does not belong to this tenant.");
              }

              const item = items[0];
              const filePath = item.file_path as string;
              const mimeType = (item.mime_type as string) || "image/png";

              // Create a signed URL (expires in 1 hour).
              // This URL is returned in the text block so the LLM can pass it to
              // generate_image's reference_image_url parameter for brand-consistent generation.
              const signRes = await fetch(
                `${config.supabaseUrl}/storage/v1/object/sign/brain/${filePath}`,
                {
                  method: "POST",
                  headers: {
                    apikey: config.serviceKey,
                    Authorization: `Bearer ${config.serviceKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ expiresIn: 3600 }),
                },
              );

              let signedUrl: string | null = null;
              if (signRes.ok) {
                const signData = (await signRes.json()) as { signedURL?: string };
                if (signData.signedURL) {
                  signedUrl = `${config.supabaseUrl}/storage/v1${signData.signedURL}`;
                }
              }

              // Download the image
              const downloadUrl = `${config.supabaseUrl}/storage/v1/object/authenticated/brain/${filePath}`;
              const imgRes = await fetch(downloadUrl, {
                headers: {
                  apikey: config.serviceKey,
                  Authorization: `Bearer ${config.serviceKey}`,
                },
              });

              if (!imgRes.ok) {
                const errText = await imgRes.text();
                api.logger?.error?.(`brand-assets: image download failed (${imgRes.status}): ${errText}`);
                return errorResult(`Failed to download image: ${imgRes.status}`);
              }

              const arrayBuffer = await imgRes.arrayBuffer();
              const base64 = Buffer.from(arrayBuffer).toString("base64");

              api.logger?.info?.(
                `brand-assets: fetched image "${item.title}" (${Math.round(arrayBuffer.byteLength / 1024)}KB)`,
              );

              // Return both a text block (with metadata + signedUrl) and an image content block.
              // The "type: image" block is WHY this plugin exists as TypeScript — YAML api-tools
              // hardcode type: "text" and can't return image content blocks for the LLM to see.
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      success: true,
                      title: item.title,
                      fileName: item.file_name,
                      mimeType,
                      signedUrl,
                    }),
                  },
                  {
                    type: "image" as const,
                    data: base64,
                    mimeType,
                  },
                ],
              };
            } catch (error) {
              const msg = error instanceof Error ? error.message : "Unknown error";
              api.logger?.error?.(`brand-assets: fetch_brand_image error — ${msg}`);
              return errorResult(`Image fetch failed: ${msg}`);
            }
          },
        };
      },
      { optional: true },
    );

    api.logger?.info?.("brand-assets: plugin registered");
  },
};

export default brandAssetsPlugin;
