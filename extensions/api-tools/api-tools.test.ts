import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { interpolateString, interpolateDeep } from "./template-engine.js";
import { buildParameterSchema } from "./schema-builder.js";
import { loadToolDefinitions } from "./yaml-loader.js";
import { executeApiTool } from "./executor.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("template-engine", () => {
  it("interpolates env variables", () => {
    const result = interpolateString("Bearer {{env.API_KEY}}", {
      env: { API_KEY: "secret123" },
      params: {},
    });
    expect(result).toBe("Bearer secret123");
  });

  it("interpolates params", () => {
    const result = interpolateString("Hello {{params.name}}", {
      env: {},
      params: { name: "World" },
    });
    expect(result).toBe("Hello World");
  });

  it("throws on missing env var in strict mode", () => {
    expect(() =>
      interpolateString("{{env.MISSING}}", { env: {}, params: {} }, true),
    ).toThrow("Missing required environment variable: MISSING");
  });

  it("interpolates deep objects", () => {
    const result = interpolateDeep(
      { header: "Bearer {{env.TOKEN}}", body: { text: "{{params.msg}}" } },
      { env: { TOKEN: "abc" }, params: { msg: "hello" } },
    );
    expect(result).toEqual({
      header: "Bearer abc",
      body: { text: "hello" },
    });
  });
});

describe("schema-builder", () => {
  it("builds empty schema for no parameters", () => {
    const schema = buildParameterSchema(undefined);
    expect(schema.type).toBe("object");
  });

  it("builds schema with required string param", () => {
    const schema = buildParameterSchema({
      text: { type: "string", description: "The text", required: true },
    });
    expect(schema.properties.text).toBeDefined();
  });

  it("builds schema with enum", () => {
    const schema = buildParameterSchema({
      visibility: {
        type: "string",
        enum: ["PUBLIC", "PRIVATE"],
        required: false,
      },
    });
    expect(schema.properties.visibility).toBeDefined();
  });
});

describe("yaml-loader", () => {
  const testDir = join(tmpdir(), `api-tools-test-${Date.now()}`);
  const apiToolsDir = join(testDir, "api-tools");

  beforeEach(() => {
    mkdirSync(apiToolsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loads valid YAML definitions", () => {
    writeFileSync(
      join(apiToolsDir, "test_tool.yaml"),
      `
name: test_tool
description: A test tool
parameters:
  msg:
    type: string
    required: true
request:
  method: POST
  url: https://api.example.com/test
  headers:
    Content-Type: application/json
  body:
    type: json
    content:
      message: "{{params.msg}}"
allowed_hosts:
  - api.example.com
`,
    );

    const defs = loadToolDefinitions(testDir);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("test_tool");
    expect(defs[0].allowed_hosts).toContain("api.example.com");
  });

  it("skips invalid YAML (missing name)", () => {
    writeFileSync(
      join(apiToolsDir, "bad.yaml"),
      `
description: Missing name field
request:
  method: GET
  url: https://example.com
allowed_hosts:
  - example.com
`,
    );

    const defs = loadToolDefinitions(testDir);
    expect(defs).toHaveLength(0);
  });

  it("returns empty array if no api-tools directory", () => {
    const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
    mkdirSync(emptyDir);
    const defs = loadToolDefinitions(emptyDir);
    expect(defs).toHaveLength(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

describe("executor", () => {
  it("blocks private IP addresses", async () => {
    const result = await executeApiTool({
      definition: {
        name: "bad_tool",
        description: "test",
        request: {
          method: "GET",
          url: "http://localhost:8080/secret",
        },
        allowed_hosts: ["localhost"],
      },
      args: {},
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("private/internal");
  });

  it("blocks hosts not in allowed_hosts", async () => {
    const result = await executeApiTool({
      definition: {
        name: "bad_tool",
        description: "test",
        request: {
          method: "GET",
          url: "https://evil.com/steal",
        },
        allowed_hosts: ["api.example.com"],
      },
      args: {},
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("not in allowed_hosts");
  });

  it("checks required env vars", async () => {
    const result = await executeApiTool({
      definition: {
        name: "test_tool",
        description: "test",
        request: {
          method: "GET",
          url: "https://api.example.com/test",
        },
        requires_env: ["NONEXISTENT_VAR_12345"],
        allowed_hosts: ["api.example.com"],
      },
      args: {},
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Missing required environment variables");
  });

  it("makes successful HTTP request", async () => {
    // Use httpbin.org for testing
    const result = await executeApiTool({
      definition: {
        name: "test_tool",
        description: "test",
        request: {
          method: "GET",
          url: "https://httpbin.org/get",
          timeout_ms: 10000,
        },
        allowed_hosts: ["httpbin.org"],
      },
      args: {},
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe(200);
  });

  it("sends POST with interpolated body", async () => {
    const result = await executeApiTool({
      definition: {
        name: "test_tool",
        description: "test",
        parameters: {
          message: { type: "string", required: true },
        },
        request: {
          method: "POST",
          url: "https://httpbin.org/post",
          headers: {
            "Content-Type": "application/json",
          },
          body: {
            type: "json",
            content: {
              text: "{{params.message}}",
            },
          },
          timeout_ms: 10000,
        },
        allowed_hosts: ["httpbin.org"],
      },
      args: { message: "Hello World" },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.json.text).toBe("Hello World");
  });
});
