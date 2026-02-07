/**
 * Types for YAML-defined API tools
 */

export type ApiToolParameterType = "string" | "number" | "boolean" | "integer";

export interface ApiToolParameter {
  type: ApiToolParameterType;
  description?: string;
  required?: boolean;
  enum?: string[];
  default?: string | number | boolean;
}

export interface ApiToolRequestBody {
  type: "json" | "form" | "text";
  content: unknown;
}

export interface ApiToolRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: ApiToolRequestBody;
  timeout_ms?: number;
}

export interface ApiToolResponse {
  extract?: string;
  summary?: string;
  error_template?: string;
}

export interface ApiToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, ApiToolParameter>;
  request: ApiToolRequest;
  response?: ApiToolResponse;
  requires_env?: string[];
  allowed_hosts: string[];
}

export interface ApiToolExecuteParams {
  definition: ApiToolDefinition;
  args: Record<string, unknown>;
  extraEnv?: Record<string, string>;
}
