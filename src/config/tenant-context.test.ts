import { describe, expect, it } from "vitest";

import {
  getTenantContext,
  getTenantIdFromContext,
  getTenantStateDirFromContext,
  runWithTenantContext,
  runWithTenantContextAsync,
  type TenantContext,
} from "./tenant-context.js";

describe("tenant context", () => {
  describe("getTenantStateDirFromContext", () => {
    it("returns null when no context is active", () => {
      expect(getTenantStateDirFromContext()).toBeNull();
    });

    it("returns stateDir within synchronous context", () => {
      const context: TenantContext = { tenantId: "tenant-a", stateDir: "/data/tenants/tenant-a" };
      const result = runWithTenantContext(context, () => {
        return getTenantStateDirFromContext();
      });
      expect(result).toBe("/data/tenants/tenant-a");
    });

    it("returns stateDir within async context", async () => {
      const context: TenantContext = { tenantId: "tenant-b", stateDir: "/data/tenants/tenant-b" };
      const result = await runWithTenantContextAsync(context, async () => {
        return getTenantStateDirFromContext();
      });
      expect(result).toBe("/data/tenants/tenant-b");
    });
  });

  describe("getTenantIdFromContext", () => {
    it("returns null when no context is active", () => {
      expect(getTenantIdFromContext()).toBeNull();
    });

    it("returns tenantId within context", () => {
      const context: TenantContext = { tenantId: "my-tenant", stateDir: "/data/tenants/my-tenant" };
      const result = runWithTenantContext(context, () => {
        return getTenantIdFromContext();
      });
      expect(result).toBe("my-tenant");
    });
  });

  describe("getTenantContext", () => {
    it("returns undefined when no context is active", () => {
      expect(getTenantContext()).toBeUndefined();
    });

    it("returns full context within context", () => {
      const context: TenantContext = { tenantId: "tenant-c", stateDir: "/data/tenants/tenant-c" };
      const result = runWithTenantContext(context, () => {
        return getTenantContext();
      });
      expect(result).toEqual(context);
    });
  });

  describe("context isolation", () => {
    it("isolates context across synchronous nested calls", () => {
      const contextA: TenantContext = { tenantId: "tenant-a", stateDir: "/data/tenants/a" };
      const contextB: TenantContext = { tenantId: "tenant-b", stateDir: "/data/tenants/b" };

      const results: string[] = [];

      runWithTenantContext(contextA, () => {
        results.push(`outer-start: ${getTenantIdFromContext()}`);

        runWithTenantContext(contextB, () => {
          results.push(`inner: ${getTenantIdFromContext()}`);
        });

        results.push(`outer-end: ${getTenantIdFromContext()}`);
      });

      expect(results).toEqual(["outer-start: tenant-a", "inner: tenant-b", "outer-end: tenant-a"]);
    });

    it("isolates context across concurrent async operations", async () => {
      const contextA: TenantContext = { tenantId: "tenant-a", stateDir: "/data/tenants/a" };
      const contextB: TenantContext = { tenantId: "tenant-b", stateDir: "/data/tenants/b" };

      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      // Start two async operations concurrently with different contexts
      const promiseA = runWithTenantContextAsync(contextA, async () => {
        const start = getTenantIdFromContext();
        await delay(50); // Simulate async work
        const middle = getTenantIdFromContext();
        await delay(50); // More async work
        const end = getTenantIdFromContext();
        return { start, middle, end };
      });

      const promiseB = runWithTenantContextAsync(contextB, async () => {
        const start = getTenantIdFromContext();
        await delay(25); // Different timing
        const middle = getTenantIdFromContext();
        await delay(75); // Different timing
        const end = getTenantIdFromContext();
        return { start, middle, end };
      });

      const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

      // Each context should maintain its own tenant ID throughout the async chain
      expect(resultA.start).toBe("tenant-a");
      expect(resultA.middle).toBe("tenant-a");
      expect(resultA.end).toBe("tenant-a");

      expect(resultB.start).toBe("tenant-b");
      expect(resultB.middle).toBe("tenant-b");
      expect(resultB.end).toBe("tenant-b");
    });

    it("maintains context through promise chains", async () => {
      const context: TenantContext = { tenantId: "chained", stateDir: "/data/tenants/chained" };

      const result = await runWithTenantContextAsync(context, async () => {
        const step1 = await Promise.resolve().then(() => getTenantIdFromContext());
        const step2 = await Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => getTenantIdFromContext());
        return { step1, step2 };
      });

      expect(result.step1).toBe("chained");
      expect(result.step2).toBe("chained");
    });

    it("maintains context through multiple awaits", async () => {
      const context: TenantContext = { tenantId: "multi-await", stateDir: "/data/tenants/multi" };

      const checkContext = async (): Promise<string | null> => {
        await Promise.resolve();
        return getTenantIdFromContext();
      };

      const result = await runWithTenantContextAsync(context, async () => {
        const results: (string | null)[] = [];
        results.push(await checkContext());
        results.push(await checkContext());
        results.push(await checkContext());
        return results;
      });

      expect(result).toEqual(["multi-await", "multi-await", "multi-await"]);
    });

    it("isolates contexts during interleaved concurrent operations", async () => {
      const tenants = ["alpha", "beta", "gamma", "delta"];
      const contexts = tenants.map((id) => ({
        tenantId: id,
        stateDir: `/data/tenants/${id}`,
      }));

      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      // Start many concurrent operations with different contexts
      const promises = contexts.map((ctx) =>
        runWithTenantContextAsync(ctx, async () => {
          const samples: (string | null)[] = [];

          // Collect multiple samples with varying delays
          for (let i = 0; i < 5; i++) {
            await delay(Math.random() * 20);
            samples.push(getTenantIdFromContext());
          }

          return { tenantId: ctx.tenantId, samples };
        }),
      );

      const results = await Promise.all(promises);

      // Each operation should have maintained its own context
      for (const result of results) {
        expect(result.samples.every((s) => s === result.tenantId)).toBe(true);
      }
    });
  });

  describe("edge cases", () => {
    it("handles null context values correctly", () => {
      // Context is active but with empty values
      const context: TenantContext = { tenantId: "", stateDir: "" };
      const result = runWithTenantContext(context, () => ({
        id: getTenantIdFromContext(),
        dir: getTenantStateDirFromContext(),
      }));
      expect(result.id).toBe("");
      expect(result.dir).toBe("");
    });

    it("returns null after context exits", () => {
      const context: TenantContext = { tenantId: "temp", stateDir: "/tmp" };

      runWithTenantContext(context, () => {
        expect(getTenantIdFromContext()).toBe("temp");
      });

      // After context exits, should be null again
      expect(getTenantIdFromContext()).toBeNull();
    });

    it("handles exceptions within context", () => {
      const context: TenantContext = { tenantId: "error-test", stateDir: "/error" };

      expect(() => {
        runWithTenantContext(context, () => {
          expect(getTenantIdFromContext()).toBe("error-test");
          throw new Error("test error");
        });
      }).toThrow("test error");

      // Context should still be cleaned up after error
      expect(getTenantIdFromContext()).toBeNull();
    });

    it("handles async exceptions within context", async () => {
      const context: TenantContext = { tenantId: "async-error", stateDir: "/async-error" };

      await expect(
        runWithTenantContextAsync(context, async () => {
          expect(getTenantIdFromContext()).toBe("async-error");
          await Promise.resolve();
          throw new Error("async test error");
        }),
      ).rejects.toThrow("async test error");

      // Context should still be cleaned up after async error
      expect(getTenantIdFromContext()).toBeNull();
    });
  });
});
