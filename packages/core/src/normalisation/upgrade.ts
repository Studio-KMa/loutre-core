/**
 * Lightweight OpenAPI 3.0 → 3.1 upgrade of a dereferenced document:
 * `nullable: true` → `type: [t, "null"]`, boolean `exclusiveMinimum` / `exclusiveMaximum`
 * → the numeric bound. Schemas are shared and sometimes cyclic, hence the visited set.
 */
import { isPlainObject } from "../util/pointer"

export const upgradeTo31 = (document: Record<string, unknown>): void => {
  const seen = new Set<object>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (seen.has(node)) return
      seen.add(node)
      for (const item of node) walk(item)
      return
    }
    if (!isPlainObject(node) || seen.has(node)) return
    seen.add(node)
    upgradeSchemaLike(node)
    for (const value of Object.values(node)) walk(value)
  }
  walk(document)
  document["openapi"] = "3.1.0"
}

const upgradeSchemaLike = (node: Record<string, unknown>): void => {
  if (node["nullable"] === true) {
    const type = node["type"]
    if (typeof type === "string") {
      node["type"] = type === "null" ? type : [type, "null"]
    } else if (Array.isArray(type) && !type.includes("null")) {
      node["type"] = [...type, "null"]
    } else if (type === undefined && (node["properties"] !== undefined || node["items"] !== undefined)) {
      node["type"] = [node["properties"] !== undefined ? "object" : "array", "null"]
    } else if (type === undefined) {
      // Nullable anyOf/oneOf: 3.1 expresses it as an extra `null` variant.
      const variants = node["anyOf"] ?? node["oneOf"]
      if (Array.isArray(variants) && !variants.some((v) => isPlainObject(v) && v["type"] === "null")) {
        variants.push({ type: "null" })
      } else if (!Array.isArray(variants)) {
        return // Not expressible in 3.1: keep `nullable`, interpretation reads it.
      }
    }
    delete node["nullable"]
  }
  if (node["exclusiveMinimum"] === true && typeof node["minimum"] === "number") {
    node["exclusiveMinimum"] = node["minimum"]
    delete node["minimum"]
  } else if (node["exclusiveMinimum"] === false) {
    delete node["exclusiveMinimum"]
  }
  if (node["exclusiveMaximum"] === true && typeof node["maximum"] === "number") {
    node["exclusiveMaximum"] = node["maximum"]
    delete node["maximum"]
  } else if (node["exclusiveMaximum"] === false) {
    delete node["exclusiveMaximum"]
  }
}
