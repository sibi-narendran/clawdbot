# Moltbot Multi-Tenant SaaS

This module provides a foundation for building a multi-tenant SaaS on top of Moltbot.

## Quick Start

```bash
# Start the SaaS API server
bun src/saas/api-server.ts

# Create a tenant
curl -X POST http://localhost:3000/tenants \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme Corp"}'

# Add a channel
curl -X POST http://localhost:3000/tenants/{id}/channels \
  -H "Content-Type: application/json" \
  -d '{"channel": "telegram", "enabled": true}'

# Get combined config for Moltbot
curl http://localhost:3000/config
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Your SaaS Frontend (React, Next.js, etc.)              │
└─────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────┐
│  SaaS API Layer (src/saas/api-server.ts)                │
│  - Tenant CRUD                                          │
│  - Channel management                                   │
│  - Config generation                                    │
│  - Webhook handling                                     │
└─────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────┐
│  Database (Postgres + Prisma)                           │
│  - Tenants, channels, sessions                          │
│  - See schema.prisma                                    │
└─────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────┐
│  Moltbot Gateway                                        │
│  - Loads config from API                                │
│  - Routes messages by accountId → agentId               │
│  - Sends webhooks on events                             │
└─────────────────────────────────────────────────────────┘
```

## Key Concepts

### Tenant → AccountId Mapping

Each tenant gets a unique `accountId` that maps to Moltbot's routing:

```typescript
// Tenant created with:
tenant.accountId = `tenant-${uuid.slice(0, 8)}`;

// Moltbot routes via agent bindings:
{
  agentId: tenant.agentId,
  match: {
    channel: "telegram",
    accountId: tenant.accountId
  }
}
```

### Session Isolation

Sessions are scoped by `accountId` using Moltbot's DM scope:

- `per-account-channel-peer` - Full isolation (recommended for SaaS)
- Each tenant's conversations are completely separate

### Credential Storage

For production:

1. **Encrypt at rest** - Use Prisma's `@db.Jsonb` with column-level encryption
2. **Environment separation** - Never store prod creds in dev DB
3. **Rotate keys** - Implement key rotation for tenant API keys

## Production Checklist

- [ ] Set up Postgres database
- [ ] Run Prisma migrations: `npx prisma migrate deploy`
- [ ] Add proper authentication (JWT/OAuth)
- [ ] Implement rate limiting
- [ ] Add Stripe billing integration
- [ ] Set up monitoring (Sentry, metrics)
- [ ] Configure webhooks for message events
- [ ] Add admin dashboard UI
- [ ] Set up per-tenant subdomain routing (optional)

## Files

- `tenant-manager.ts` - Core tenant logic (in-memory, replace with Prisma)
- `api-server.ts` - REST API server
- `schema.prisma` - Database schema for production

## Next Steps

1. **Add Prisma**: `pnpm add prisma @prisma/client`
2. **Generate client**: `npx prisma generate`
3. **Replace in-memory store**: Update `tenant-manager.ts` to use Prisma
4. **Add auth**: Implement JWT middleware in `api-server.ts`
5. **Connect to gateway**: Configure Moltbot to load config from API
