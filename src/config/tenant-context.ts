import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tenant context for multi-tenant request isolation.
 * Contains the tenant identifier and the resolved state directory path.
 */
export interface TenantContext {
  tenantId: string;
  stateDir: string;
}

/**
 * AsyncLocalStorage instance for thread-safe tenant context propagation.
 * This ensures each concurrent request maintains its own isolated tenant context
 * throughout the entire async call stack.
 */
const tenantContextStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Retrieve the current tenant's state directory from AsyncLocalStorage context.
 * Returns null if no tenant context is active (default/single-tenant mode).
 *
 * This is the safe replacement for the global _tenantStateDirOverride variable.
 * It correctly handles concurrent requests from different tenants.
 */
export function getTenantStateDirFromContext(): string | null {
  return tenantContextStorage.getStore()?.stateDir ?? null;
}

/**
 * Retrieve the current tenant ID from AsyncLocalStorage context.
 * Returns null if no tenant context is active.
 */
export function getTenantIdFromContext(): string | null {
  return tenantContextStorage.getStore()?.tenantId ?? null;
}

/**
 * Get the full tenant context from AsyncLocalStorage.
 * Returns undefined if no tenant context is active.
 */
export function getTenantContext(): TenantContext | undefined {
  return tenantContextStorage.getStore();
}

/**
 * Execute a synchronous callback within a tenant context.
 * All code in the callback (and any synchronous functions it calls)
 * will see the provided tenant context via getTenantStateDirFromContext().
 *
 * @param context - The tenant context to scope to this execution
 * @param callback - The synchronous function to execute
 * @returns The return value of the callback
 */
export function runWithTenantContext<T>(context: TenantContext, callback: () => T): T {
  return tenantContextStorage.run(context, callback);
}

/**
 * Execute an asynchronous callback within a tenant context.
 * All code in the callback's async call stack will see the provided
 * tenant context via getTenantStateDirFromContext().
 *
 * This is the primary function for wrapping HTTP/WebSocket request handlers.
 *
 * @param context - The tenant context to scope to this execution
 * @param callback - The async function to execute
 * @returns A promise that resolves to the callback's return value
 */
export async function runWithTenantContextAsync<T>(
  context: TenantContext,
  callback: () => Promise<T>,
): Promise<T> {
  return tenantContextStorage.run(context, callback);
}
