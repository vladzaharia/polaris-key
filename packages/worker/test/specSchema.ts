/**
 * A small validator for the OpenAPI document's own schemas (3.1 / JSON Schema 2020-12 subset): the
 * keywords `polaris-key.v3.yaml` actually uses for a response body. It exists so a contract test can
 * hold REAL responses to the SCHEMA the spec publishes, with no new dependency: `$ref` into
 * `components`, `allOf`, `oneOf`, `type` (a name or a list), `enum`, `const`, `pattern`,
 * `required`, `properties`, `additionalProperties` (`false`, `true` or a schema) and `items`.
 *
 * A keyword this file does not know is ignored, not guessed at, so a schema that leans on one it
 * lacks would pass too loosely: add the keyword here before the spec starts using it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

type Node = Record<string, unknown>;

export interface Spec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Node> };
}

const here = dirname(fileURLToPath(import.meta.url));

/** The Worker's OpenAPI document, parsed once. */
export const SPEC = parseYaml(
  readFileSync(join(here, "..", "openapi", "polaris-key.v3.yaml"), "utf8"),
) as Spec;

function resolve(ref: string): Node {
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) throw new Error(`unsupported $ref ${ref}`);
  const found = SPEC.components.schemas[ref.slice(prefix.length)];
  if (!found) throw new Error(`dangling $ref ${ref}`);
  return found;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function hasType(name: string, v: unknown): boolean {
  switch (name) {
    case "string":
      return typeof v === "string";
    case "integer":
      return Number.isInteger(v);
    case "number":
      return typeof v === "number";
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "object":
      return isObject(v);
    case "array":
      return Array.isArray(v);
    default:
      throw new Error(`unsupported type ${name}`);
  }
}

function check(schema: unknown, value: unknown, path: string): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${path}: no value is allowed here`];
  if (!isObject(schema)) throw new Error(`bad schema at ${path}`);
  if (typeof schema.$ref === "string")
    return check(resolve(schema.$ref), value, path);

  const errors: string[] = [];
  if (Array.isArray(schema.allOf))
    for (const sub of schema.allOf) errors.push(...check(sub, value, path));
  if (Array.isArray(schema.oneOf)) {
    const matching = schema.oneOf.filter(
      (sub) => check(sub, value, path).length === 0,
    ).length;
    if (matching !== 1)
      errors.push(
        `${path}: matches ${matching} of ${schema.oneOf.length} oneOf branches (${JSON.stringify(value)?.slice(0, 80)})`,
      );
  }
  if (schema.type !== undefined) {
    const names = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!names.some((n) => hasType(String(n), value))) {
      errors.push(
        `${path}: expected ${names.join("|")}, got ${value === null ? "null" : typeof value}`,
      );
      return errors;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    errors.push(`${path}: ${JSON.stringify(value)} is not in the enum`);
  if ("const" in schema && schema.const !== value)
    errors.push(`${path}: expected the constant ${String(schema.const)}`);
  if (
    typeof schema.pattern === "string" &&
    typeof value === "string" &&
    !new RegExp(schema.pattern).test(value)
  )
    errors.push(`${path}: ${JSON.stringify(value)} does not match the pattern`);

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required))
      for (const name of schema.required)
        if (!(String(name) in value))
          errors.push(`${path}: missing required member ${String(name)}`);
    for (const [name, member] of Object.entries(value)) {
      if (name in properties)
        errors.push(...check(properties[name], member, `${path}.${name}`));
      else if (schema.additionalProperties === false)
        errors.push(`${path}: undocumented member ${name}`);
      else if (isObject(schema.additionalProperties))
        errors.push(
          ...check(schema.additionalProperties, member, `${path}.${name}`),
        );
    }
  }
  if (Array.isArray(value) && schema.items !== undefined)
    value.forEach((item, i) =>
      errors.push(...check(schema.items, item, `${path}[${i}]`)),
    );
  return errors;
}

/** Every way `value` departs from the named `components.schemas` entry (empty: it conforms). */
export function validateAgainst(schemaName: string, value: unknown): string[] {
  return check({ $ref: `#/components/schemas/${schemaName}` }, value, "$");
}
