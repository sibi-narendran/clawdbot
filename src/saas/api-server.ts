/**
 * Simple REST API for multi-tenant SaaS management
 *
 * Run with: bun src/saas/api-server.ts
 *
 * For production, add:
 * - Database persistence (Prisma + Postgres)
 * - Proper auth (JWT, OAuth)
 * - Rate limiting
 * - Webhook handlers
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createTenant,
  getTenant,
  getTenantByApiKey,
  listTenants,
  addTenantChannel,
  generateFullConfig,
  type TenantChannel,
} from "./tenant-manager.ts";

const PORT = process.env.SAAS_API_PORT || 3000;

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
) => Promise<void>;

const routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = [];

function route(method: string, path: string, handler: RouteHandler) {
  // Convert :param to named capture groups
  const pattern = new RegExp(
    "^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"
  );
  routes.push({ method, pattern, handler });
}

async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

// Auth middleware helper
function requireAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  // For demo: accept any Bearer token or skip auth
  // In production: validate JWT/API key
  return true;
}

// Routes

route("GET", "/health", async (_req, res) => {
  json(res, { status: "ok", service: "moltbot-saas" });
});

route("POST", "/tenants", async (req, res) => {
  const body = await parseBody<{ name: string }>(req);
  if (!body.name) {
    return json(res, { error: "name is required" }, 400);
  }
  const tenant = createTenant(body.name);
  json(res, tenant, 201);
});

route("GET", "/tenants", async (_req, res) => {
  const tenants = listTenants();
  json(res, { tenants, count: tenants.length });
});

route("GET", "/tenants/:id", async (_req, res, params) => {
  const tenant = getTenant(params.id);
  if (!tenant) {
    return json(res, { error: "Tenant not found" }, 404);
  }
  json(res, tenant);
});

route("POST", "/tenants/:id/channels", async (req, res, params) => {
  const tenant = getTenant(params.id);
  if (!tenant) {
    return json(res, { error: "Tenant not found" }, 404);
  }

  const body = await parseBody<TenantChannel>(req);
  if (!body.channel) {
    return json(res, { error: "channel is required" }, 400);
  }

  const updated = addTenantChannel(params.id, {
    channel: body.channel,
    enabled: body.enabled ?? true,
    credentials: body.credentials,
  });

  json(res, updated);
});

route("GET", "/config", async (_req, res) => {
  // Generate combined Moltbot config for all tenants
  const config = generateFullConfig();
  json(res, config);
});

route("POST", "/webhooks/message", async (req, res) => {
  // Webhook endpoint for receiving messages from Moltbot gateway
  // Configure gateway to POST here on message events
  const body = await parseBody<{
    tenantId?: string;
    channel: string;
    from: string;
    message: string;
  }>(req);

  console.log("[webhook] Received message:", body);

  // Process message, trigger tenant-specific logic, etc.
  json(res, { received: true });
});

// Server

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  for (const { method, pattern, handler } of routes) {
    if (req.method === method) {
      const match = url.pathname.match(pattern);
      if (match) {
        try {
          await handler(req, res, match.groups || {});
          return;
        } catch (err) {
          console.error("Route error:", err);
          json(res, { error: "Internal server error" }, 500);
          return;
        }
      }
    }
  }

  json(res, { error: "Not found" }, 404);
});

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  Moltbot Multi-Tenant SaaS API                            ║
╠═══════════════════════════════════════════════════════════╣
║  Server running at http://localhost:${PORT}                  ║
║                                                           ║
║  Endpoints:                                               ║
║    GET  /health              - Health check               ║
║    POST /tenants             - Create tenant              ║
║    GET  /tenants             - List tenants               ║
║    GET  /tenants/:id         - Get tenant                 ║
║    POST /tenants/:id/channels - Add channel to tenant     ║
║    GET  /config              - Get combined Moltbot config║
║    POST /webhooks/message    - Receive message webhook    ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

export { server };
