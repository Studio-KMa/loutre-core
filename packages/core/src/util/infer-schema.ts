/**
 * A JSON Schema inferred from a sample value (Postman response, request body):
 * types, recognisable formats, nested objects. Field names do the rest once
 * realistic data is generated.
 */
import type { Json, JsonObject } from "../model"
import { isPlainObject, setOwn } from "./pointer"

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const URI = /^https?:\/\//

export const singular = (word: string): string => {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2)
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1)
  return word
}

/** `order-lines` → `OrderLine`, `users` → `User`. */
export const titleFromName = (name: string): string =>
  singular(name)
    .split(/[^A-Za-z0-9]+/)
    .filter((p) => p.length > 0)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("")

/** Elements of a sample list read to draw its items: a field that only later elements carry still counts. */
const SAMPLED_ITEMS = 100

export const inferSchema = (value: Json, title?: string): JsonObject => {
  if (value === null) return { type: "null" }
  if (Array.isArray(value)) {
    let items: JsonObject | undefined
    for (const item of value.slice(0, SAMPLED_ITEMS)) {
      const schema = inferSchema(item, title)
      items = items === undefined ? schema : mergeSchemas(items, schema)
    }
    return { type: "array", items: items ?? {} }
  }
  if (typeof value === "object") {
    const properties: Record<string, Json> = {}
    const required: Array<string> = []
    for (const [key, item] of Object.entries(value)) {
      setOwn(properties, key, inferSchema(item, Array.isArray(item) || (typeof item === "object" && item !== null) ? titleFromName(key) : undefined))
      if (item !== null) required.push(key)
    }
    const schema: Record<string, Json> = { type: "object", properties }
    if (required.length > 0) schema["required"] = required
    if (title !== undefined && title.length > 0) schema["title"] = title
    return schema
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" }
  if (typeof value === "boolean") return { type: "boolean" }
  if (DATE_TIME.test(value)) return { type: "string", format: "date-time" }
  if (DATE.test(value)) return { type: "string", format: "date" }
  if (EMAIL.test(value)) return { type: "string", format: "email" }
  if (UUID.test(value)) return { type: "string", format: "uuid" }
  if (URI.test(value)) return { type: "string", format: "uri" }
  return { type: "string" }
}

/**
 * Two schemas inferred for the same thing, as one: the first keeps its fields and their
 * order, the second adds what it lacks; a field is required only when both require it,
 * and `null` gives way to the type it stands for.
 */
export const mergeSchemas = (a: JsonObject, b: JsonObject): JsonObject => {
  if (typeof a["$ref"] === "string") return a
  if (typeof b["$ref"] === "string") return b
  if (a["type"] === undefined || a["type"] === "null") return b["type"] === undefined ? a : b
  if (b["type"] === undefined || b["type"] === "null") return a
  if (a["type"] === "object" && b["type"] === "object") {
    const ownA = isPlainObject(a["properties"]) ? (a["properties"] as Record<string, Json>) : {}
    const ownB = isPlainObject(b["properties"]) ? (b["properties"] as Record<string, Json>) : {}
    const properties: Record<string, Json> = {}
    for (const [key, schema] of Object.entries(ownA)) setOwn(properties, key, schema)
    for (const [key, schema] of Object.entries(ownB)) {
      const known = Object.hasOwn(properties, key) ? properties[key] : undefined
      setOwn(properties, key, isPlainObject(known) && isPlainObject(schema) ? mergeSchemas(known as JsonObject, schema as JsonObject) : (known ?? schema))
    }
    const inB = new Set(Array.isArray(b["required"]) ? b["required"] : [])
    const required = (Array.isArray(a["required"]) ? a["required"] : []).filter((key) => inB.has(key))
    const merged: Record<string, Json> = { ...a, properties }
    if (required.length > 0) merged["required"] = required
    else delete merged["required"]
    return merged
  }
  if (a["type"] === "array" && b["type"] === "array") {
    const items = isPlainObject(a["items"]) && isPlainObject(b["items"]) ? mergeSchemas(a["items"] as JsonObject, b["items"] as JsonObject) : (a["items"] ?? b["items"] ?? {})
    return { ...a, items }
  }
  if (a["type"] === b["type"]) {
    if (a["format"] === b["format"]) return a
    const { format: _format, ...rest } = a
    return rest
  }
  const numeric = new Set(["integer", "number"])
  if (numeric.has(String(a["type"])) && numeric.has(String(b["type"]))) return { type: "number" }
  return a
}
