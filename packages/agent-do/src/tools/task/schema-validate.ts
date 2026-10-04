/**
 * M1.5 T17 outputSchema enforcement (proposal §3 T17: "schema 连续 3 次失败
 * 放行带 schemaOverridden"). omp validates the child's `yield` data against
 * the caller's JSON Schema (docs/tools/task.md:48-49, yield.ts:272-278); the
 * retry ladder lives in the yield gate — this module is only the verdict.
 *
 * Supported subset: `type` (string or array, incl. `integer`), `enum`,
 * `required` + `properties` (+ `additionalProperties: false`), `items`, and
 * the boolean schema forms `true`/`false`. Unknown keywords are ignored
 * (lenient, JSON-Schema draft behavior) — the M1.5 contract shapes the
 * callers actually send are covered; exotic keywords degrade to no-op rather
 * than false rejections. Violations render as JSON-pointer-ish paths.
 */

export function validateAgainstJsonSchema(value: unknown, schema: unknown): string[] {
  return validate(value, schema, "#");
}

function validate(value: unknown, schema: unknown, path: string): string[] {
  if (schema === true || schema === undefined || schema === null) return [];
  if (schema === false) return [`${path}: schema is false (nothing validates)`];
  if (typeof schema !== "object" || Array.isArray(schema)) {
    return [`${path}: invalid schema (expected object, boolean)`];
  }
  const node = schema as Record<string, unknown>;
  const violations: string[] = [];

  const typeViolations = checkType(value, node.type, path);
  violations.push(...typeViolations);
  // Type mismatch makes the structural keywords noise — the type verdict
  // already fails the payload.
  if (typeViolations.length > 0) return violations;

  if (node.enum !== undefined) {
    const options = Array.isArray(node.enum) ? node.enum : [];
    if (!options.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
      violations.push(`${path}: value not in enum [${options.map((option) => JSON.stringify(option)).join(", ")}]`);
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties =
      typeof node.properties === "object" && node.properties !== null && !Array.isArray(node.properties)
        ? (node.properties as Record<string, unknown>)
        : {};
    for (const key of Array.isArray(node.required) ? (node.required as unknown[]) : []) {
      if (typeof key === "string" && !(key in record)) {
        violations.push(`${path}: missing required property "${key}"`);
      }
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          violations.push(`${path}: additional property "${key}" is not allowed`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in record) {
        violations.push(...validate(record[key], propertySchema, `${path}/${key}`));
      }
    }
  }

  if (Array.isArray(value) && node.items !== undefined) {
    value.forEach((item, index) => {
      violations.push(...validate(item, node.items, `${path}/${index}`));
    });
  }

  return violations;
}

function checkType(value: unknown, type: unknown, path: string): string[] {
  if (type === undefined) return [];
  const expected = Array.isArray(type) ? type : [type];
  const actual = actualTypeOf(value);
  for (const candidate of expected) {
    if (typeof candidate !== "string") continue;
    if (candidate === "integer" && actual === "number" && Number.isInteger(value)) return [];
    if (candidate === actual) return [];
  }
  return [`${path}: expected type ${expected.map(String).join("|")}, got ${actual}`];
}

function actualTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
