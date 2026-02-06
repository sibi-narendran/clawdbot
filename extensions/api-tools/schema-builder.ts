/**
 * Convert YAML parameter definitions to TypeBox schemas
 */

import { Type, type TObject, type TProperties } from "@sinclair/typebox";
import type { ApiToolParameter } from "./types.js";

export function buildParameterSchema(
  parameters: Record<string, ApiToolParameter> | undefined,
): TObject<TProperties> {
  if (!parameters || Object.keys(parameters).length === 0) {
    return Type.Object({});
  }

  const properties: TProperties = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(parameters)) {
    let schema;

    // Build base schema by type
    switch (param.type) {
      case "string":
        if (param.enum && param.enum.length > 0) {
          schema = Type.Union(
            param.enum.map((v) => Type.Literal(v)),
            { description: param.description },
          );
        } else {
          schema = Type.String({ description: param.description });
        }
        break;
      case "number":
        schema = Type.Number({ description: param.description });
        break;
      case "integer":
        schema = Type.Integer({ description: param.description });
        break;
      case "boolean":
        schema = Type.Boolean({ description: param.description });
        break;
      default:
        schema = Type.String({ description: param.description });
    }

    // Wrap in Optional if not required
    if (param.required) {
      required.push(name);
      properties[name] = schema;
    } else {
      properties[name] = Type.Optional(schema);
    }
  }

  return Type.Object(properties);
}
