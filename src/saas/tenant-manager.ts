/**
 * Multi-tenant SaaS layer for Moltbot
 *
 * This provides a simple tenant management system using the existing
 * accountId + agent bindings architecture.
 */

import { randomUUID } from "node:crypto";

export interface Tenant {
  id: string;
  name: string;
  accountId: string; // Maps to Moltbot accountId
  agentId: string; // Maps to Moltbot agent
  createdAt: Date;
  channels: TenantChannel[];
  apiKey: string;
}

export interface TenantChannel {
  channel: "telegram" | "discord" | "slack" | "whatsapp";
  enabled: boolean;
  credentials?: Record<string, string>; // Encrypted in production
}

/**
 * In-memory tenant store (replace with database for production)
 */
const tenants = new Map<string, Tenant>();

export function createTenant(name: string): Tenant {
  const id = randomUUID();
  const tenant: Tenant = {
    id,
    name,
    accountId: `tenant-${id.slice(0, 8)}`,
    agentId: `agent-${id.slice(0, 8)}`,
    createdAt: new Date(),
    channels: [],
    apiKey: `sk-${randomUUID().replace(/-/g, "")}`,
  };
  tenants.set(id, tenant);
  return tenant;
}

export function getTenant(id: string): Tenant | undefined {
  return tenants.get(id);
}

export function getTenantByApiKey(apiKey: string): Tenant | undefined {
  for (const tenant of tenants.values()) {
    if (tenant.apiKey === apiKey) {
      return tenant;
    }
  }
  return undefined;
}

export function listTenants(): Tenant[] {
  return Array.from(tenants.values());
}

export function addTenantChannel(
  tenantId: string,
  channel: TenantChannel
): Tenant | undefined {
  const tenant = tenants.get(tenantId);
  if (!tenant) return undefined;
  tenant.channels.push(channel);
  return tenant;
}

/**
 * Generate Moltbot config fragment for a tenant
 * This can be merged into the main moltbot.json
 */
export function generateTenantConfig(tenant: Tenant) {
  return {
    agents: {
      list: [
        {
          id: tenant.agentId,
          name: tenant.name,
          // Tenant-specific agent config
        },
      ],
    },
    bindings: tenant.channels.map((ch) => ({
      agentId: tenant.agentId,
      match: {
        channel: ch.channel,
        accountId: tenant.accountId,
      },
    })),
  };
}

/**
 * Generate full multi-tenant config from all tenants
 */
export function generateFullConfig() {
  const allTenants = listTenants();

  const agents = {
    list: allTenants.map((t) => ({
      id: t.agentId,
      name: t.name,
    })),
  };

  const bindings = allTenants.flatMap((t) =>
    t.channels.map((ch) => ({
      agentId: t.agentId,
      match: {
        channel: ch.channel,
        accountId: t.accountId,
      },
    }))
  );

  return { agents, bindings };
}
