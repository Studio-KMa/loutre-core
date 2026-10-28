/**
 * Dereferenced JSON Schema (OpenAPI 3.1) → `DataShape`, the compact AST the generator consumes.
 * Lenient by construction: an incomprehensible schema becomes `unknown`, never an exception.
 * Cycles (Stripe's customer ↔ subscription) are cut to `unknown` as soon as a schema appears in its own lineage.
 */
import type {
  ArrayShape,
  DataShape,
  Json,
  NumberShape,
  ObjectShape,
  PropertyShape,
  StringShape,
  JsonObject,
} from "../model"
import { isPlainObject } from "../util/pointer"

export interface ShapeContext {
  /** Component name by object identity (`components.schemas.Pet` → "Pet"). */
  readonly names: WeakMap<object, string>
  /** Schemas currently being traversed, for cycle detection. */
  readonly stack: Set<object>
  readonly depth: number
  /** Shapes left to build for the whole table, shared by every route. */
  readonly budget: { remaining: number }
  /** Schemas drawn from the examples of media types that declare none, by media type object. */
  readonly examples?: WeakMap<object, JsonObject> | undefined
}

const MAX_DEPTH = 16
/**
 * Shared `$ref`s are expanded at each use: a few kilobytes of components that reference each other four times per
 * level would otherwise build a tree of hundreds of megabytes. Past this many shapes for a whole table, the rest is
 * `unknown`. Real specs of a few hundred routes (DigitalOcean, Xero, Box) need 20 000 to 35 000; each route gets
 * its share (`interpret`), so a deep first route never leaves the last ones empty.
 */
export const MAX_SHAPES = 40_000

/**
 * A description is copied at every expansion of its schema: only its beginning is kept, which is all that
 * reads it (the AI prompt quotes 120 characters, the generator goes by field names).
 */
const MAX_DESCRIPTION = 160
const clip = (text: string): string => (text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`)

export const makeShapeContext = (names: WeakMap<object, string>): ShapeContext => ({
  names,
  stack: new Set(),
  depth: 0,
  budget: { remaining: MAX_SHAPES },
})

/** Collects component names by identity, after dereferencing. */
export const collectSchemaNames = (schemas: unknown): WeakMap<object, string> => {
  const names = new WeakMap<object, string>()
  if (isPlainObject(schemas)) {
    for (const [name, schema] of Object.entries(schemas)) {
      if (isPlainObject(schema) && !names.has(schema)) names.set(schema, name)
    }
  }
  return names
}

type Schema = Record<string, unknown>

export const toShape = (schema: unknown, ctx: ShapeContext): DataShape => {
  if (schema === true) return { kind: "unknown" }
  if (!isPlainObject(schema)) return { kind: "unknown" }
  const base = baseOf(schema, ctx)
  if (ctx.stack.has(schema) || ctx.depth > MAX_DEPTH || ctx.budget.remaining <= 0) {
    return { ...base, kind: "unknown" }
  }
  ctx.budget.remaining -= 1
  ctx.stack.add(schema)
  try {
    // The current schema's common fields win (title of the enclosing component).
    return { ...body(schema, { ...ctx, depth: ctx.depth + 1 }), ...base } as DataShape
  } finally {
    ctx.stack.delete(schema)
  }
}

/** A shape's body; its common fields (title, description…) are set afterwards by `toShape`. */
type ShapeBody = DataShape
type BaseFields = {
  readonly title?: string
  readonly description?: string
  readonly nullable?: boolean
  readonly example?: Json
  readonly default?: Json
}

const baseOf = (schema: Schema, ctx: ShapeContext): BaseFields => {
  const base: { -readonly [K in keyof BaseFields]: BaseFields[K] } = {}
  const title = typeof schema["title"] === "string" ? schema["title"] : ctx.names.get(schema)
  if (title !== undefined) base.title = title
  if (typeof schema["description"] === "string" && schema["description"].length > 0) {
    base.description = clip(schema["description"])
  }
  const types = typesOf(schema)
  const enumHasNull = Array.isArray(schema["enum"]) && schema["enum"].includes(null)
  if (types.includes("null") || schema["nullable"] === true || enumHasNull) base.nullable = true
  const example = exampleOf(schema)
  if (example !== undefined) base.example = example
  if (schema["default"] !== undefined && isJson(schema["default"])) base.default = schema["default"]
  return base
}

const exampleOf = (schema: Schema): Json | undefined => {
  if (schema["example"] !== undefined && isJson(schema["example"])) return schema["example"]
  const examples = schema["examples"]
  if (Array.isArray(examples) && examples.length > 0 && isJson(examples[0])) return examples[0]
  return undefined
}

const typesOf = (schema: Schema): Array<string> => {
  const type = schema["type"]
  if (typeof type === "string") return [type]
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string")
  return []
}

const body = (schema: Schema, ctx: ShapeContext): ShapeBody => {
  const allOf = schema["allOf"]
  if (Array.isArray(allOf) && allOf.length > 0) {
    const members = allOf.map((m) => toShape(m, ctx))
    const own = hasOwnStructure(schema) ? [body({ ...schema, allOf: undefined }, ctx) as DataShape] : []
    return mergeAllOf([...members, ...own])
  }
  const oneOf = schema["oneOf"] ?? schema["anyOf"]
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    const all = dedupe(oneOf.map((m) => toShape(m, ctx)))
    // A `null` variant is not a variant: it is `nullable`.
    const variants = all.filter((v) => v.kind !== "null")
    const nullable = variants.length < all.length
    if (variants.length === 0) return { kind: "null" }
    if (variants.length === 1) return nullable ? { ...variants[0]!, nullable: true } : variants[0]!
    return nullable ? { kind: "union", variants, nullable: true } : { kind: "union", variants }
  }
  if (schema["const"] !== undefined && isJson(schema["const"])) {
    return { kind: "const", value: schema["const"] }
  }
  const enumValues = schema["enum"]
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumBody(enumValues.filter(isJson), schema)
  }

  const types = typesOf(schema).filter((t) => t !== "null")
  if (types.length > 1) {
    return { kind: "union", variants: types.map((t) => ({ ...typedBody(t, schema, ctx) })) }
  }
  const type = types[0] ?? inferType(schema)
  if (type === undefined) {
    return typesOf(schema).includes("null") ? { kind: "null" } : { kind: "unknown" }
  }
  return typedBody(type, schema, ctx)
}

const hasOwnStructure = (schema: Schema): boolean =>
  schema["properties"] !== undefined || schema["required"] !== undefined || schema["items"] !== undefined

const inferType = (schema: Schema): string | undefined => {
  if (schema["properties"] !== undefined || schema["additionalProperties"] !== undefined) return "object"
  if (schema["items"] !== undefined) return "array"
  if (
    schema["format"] !== undefined ||
    schema["pattern"] !== undefined ||
    schema["minLength"] !== undefined ||
    schema["maxLength"] !== undefined
  ) {
    return "string"
  }
  if (schema["minimum"] !== undefined || schema["maximum"] !== undefined || schema["multipleOf"] !== undefined) {
    return "number"
  }
  return undefined
}

const typedBody = (type: string, schema: Schema, ctx: ShapeContext): ShapeBody => {
  switch (type) {
    case "object":
      return objectBody(schema, ctx)
    case "array":
      return arrayBody(schema, ctx)
    case "string":
      return stringBody(schema)
    case "integer":
    case "number":
      return numberBody(schema, type === "integer")
    case "boolean":
      return { kind: "boolean" }
    case "null":
      return { kind: "null" }
    default:
      return { kind: "unknown" }
  }
}

const objectBody = (schema: Schema, ctx: ShapeContext): Omit<ObjectShape, keyof BaseFields> => {
  const required = new Set(
    Array.isArray(schema["required"]) ? schema["required"].filter((r): r is string => typeof r === "string") : [],
  )
  const properties: Array<PropertyShape> = []
  if (isPlainObject(schema["properties"])) {
    for (const [name, property] of Object.entries(schema["properties"])) {
      properties.push({ name, required: required.has(name), shape: toShape(property, ctx) })
    }
  }
  const additional = schema["additionalProperties"]
  const result: { -readonly [K in keyof ObjectShape]: ObjectShape[K] } = { kind: "object", properties }
  if (isPlainObject(additional)) {
    result.additional = toShape(additional, ctx)
  } else if (additional === true && properties.length === 0) {
    result.additional = { kind: "unknown" }
  }
  const fixtures = schema["x-loutre-fixtures"]
  if (Array.isArray(fixtures) && fixtures.length > 0 && fixtures.every((item) => isPlainObject(item) && isJson(item))) {
    result.fixtures = fixtures as ReadonlyArray<JsonObject>
  }
  return result
}

const arrayBody = (schema: Schema, ctx: ShapeContext): Omit<ArrayShape, keyof BaseFields> => {
  const result: { -readonly [K in keyof ArrayShape]: ArrayShape[K] } = {
    kind: "array",
    items: schema["items"] === undefined ? { kind: "unknown" } : toShape(schema["items"], ctx),
  }
  if (typeof schema["minItems"] === "number") result.minItems = schema["minItems"]
  if (typeof schema["maxItems"] === "number") result.maxItems = schema["maxItems"]
  return result
}

const stringBody = (schema: Schema): Omit<StringShape, keyof BaseFields> => {
  const result: { -readonly [K in keyof StringShape]: StringShape[K] } = { kind: "string" }
  if (typeof schema["format"] === "string") result.format = schema["format"]
  if (typeof schema["pattern"] === "string") result.pattern = schema["pattern"]
  if (typeof schema["minLength"] === "number") result.minLength = schema["minLength"]
  if (typeof schema["maxLength"] === "number") result.maxLength = schema["maxLength"]
  return result
}

const numberBody = (schema: Schema, integer: boolean): Omit<NumberShape, keyof BaseFields> => {
  const result: { -readonly [K in keyof NumberShape]: NumberShape[K] } = { kind: "number", integer }
  const step = integer ? 1 : 0.01
  if (typeof schema["minimum"] === "number") result.minimum = schema["minimum"]
  else if (typeof schema["exclusiveMinimum"] === "number") result.minimum = schema["exclusiveMinimum"] + step
  if (typeof schema["maximum"] === "number") result.maximum = schema["maximum"]
  else if (typeof schema["exclusiveMaximum"] === "number") result.maximum = schema["exclusiveMaximum"] - step
  if (typeof schema["multipleOf"] === "number" && schema["multipleOf"] > 0) result.multipleOf = schema["multipleOf"]
  return result
}

const enumBody = (values: ReadonlyArray<Json>, schema: Schema): ShapeBody => {
  const nonNull = values.filter((v) => v !== null)
  if (nonNull.length === 1) return { kind: "const", value: nonNull[0]! }
  if (nonNull.length === 0) return { kind: "null" }
  if (nonNull.every((v): v is string => typeof v === "string")) {
    const result: { -readonly [K in keyof StringShape]: StringShape[K] } = { kind: "string", enum: nonNull }
    if (typeof schema["format"] === "string") result.format = schema["format"]
    return result
  }
  if (nonNull.every((v): v is number => typeof v === "number")) {
    return { kind: "number", integer: nonNull.every(Number.isInteger), enum: nonNull }
  }
  return { kind: "union", variants: nonNull.map((value) => ({ kind: "const", value })) }
}

/** Merges the members of an `allOf`: objects combined, else the first useful member. */
const mergeAllOf = (members: ReadonlyArray<DataShape>): ShapeBody => {
  const objects = members.filter((m): m is ObjectShape => m.kind === "object")
  if (objects.length === 0) {
    return (members.find((m) => m.kind !== "unknown") ?? { kind: "unknown" }) as ShapeBody
  }
  const byName = new Map<string, PropertyShape>()
  let additional: DataShape | undefined
  for (const object of objects) {
    for (const property of object.properties) {
      const existing = byName.get(property.name)
      byName.set(property.name, {
        name: property.name,
        required: property.required || (existing?.required ?? false),
        shape: property.shape.kind === "unknown" && existing ? existing.shape : property.shape,
      })
    }
    if (object.additional !== undefined) additional = object.additional
  }
  const merged: { -readonly [K in keyof ObjectShape]: ObjectShape[K] } = {
    kind: "object",
    properties: [...byName.values()],
  }
  if (additional !== undefined) merged.additional = additional
  const title = objects.find((o) => o.title !== undefined)?.title
  if (title !== undefined) merged.title = title
  return merged
}

const dedupe = (shapes: ReadonlyArray<DataShape>): Array<DataShape> => {
  const seen = new Set<string>()
  const out: Array<DataShape> = []
  for (const shape of shapes) {
    const key = JSON.stringify(shape)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(shape)
    }
  }
  return out
}

export const isJson = (u: unknown): u is Json => {
  if (u === null) return true
  switch (typeof u) {
    case "string":
    case "boolean":
      return true
    case "number":
      return Number.isFinite(u)
    case "object":
      return Array.isArray(u) ? u.every(isJson) : Object.values(u as object).every(isJson)
    default:
      return false
  }
}
