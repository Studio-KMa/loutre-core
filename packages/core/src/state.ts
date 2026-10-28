/**
 * Persistent mock state: writes (POST, PUT, PATCH, DELETE) alter the collections
 * served afterwards, like a real backend. Everything here is pure; the worker
 * (or the CLI) stores the result and hands it back to `resolve` as an overlay.
 */
import type { Json, JsonObject, MockDefinition, Route } from "./model"
import { own } from "./util/pointer"

/** Beyond this, the oldest items drop out: a mock is not a database. */
export const MAX_STATE_ITEMS = 200
const ID_FIELDS = ["id", "uuid", "_id"] as const
/** Wrapper keys of a list (`{ data: [...] }`), and the counters to recompute. */
export const LIST_KEYS = ["data", "items", "results", "records", "entries", "rows", "list", "content"] as const
export const COUNTER_KEYS = ["count", "total", "total_count", "totalCount", "total_items", "size"] as const

export const isObject = (u: Json | undefined): u is JsonObject => typeof u === "object" && u !== null && !Array.isArray(u)

/** An object's id field: `id`, `uuid`, `_id`, else the first scalar field ending in id. */
export const idFieldOf = (item: JsonObject): string | undefined => {
  for (const field of ID_FIELDS) {
    const value = item[field]
    if (typeof value === "string" || typeof value === "number") return field
  }
  return Object.keys(item).find((k) => /(_id|Id)$/.test(k) && (typeof item[k] === "string" || typeof item[k] === "number"))
}

export const idOf = (item: Json | undefined): string | undefined => {
  if (!isObject(item)) return undefined
  const field = idFieldOf(item)
  const value = field === undefined ? undefined : item[field]
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined
}

/**
 * The collection a route depends on: its own, else that of the GET on the same path
 * (DELETE 204, PUT without a documented body), else, for a POST on a list, that of the detail route.
 */
export const collectionFor = (mock: MockDefinition, route: Route): string | undefined => {
  const own = mock.data.sources[route.id]
  if (own !== undefined) return own
  const sibling = mock.data.sources[`get:${route.path}`]
  if (sibling !== undefined) return sibling
  if (route.method === "post") {
    const detail = mock.table.routes.find(
      (r) => r.method === "get" && r.path.startsWith(`${route.path}/{`) && !r.path.slice(route.path.length + 1).includes("/"),
    )
    if (detail !== undefined) return mock.data.sources[detail.id]
  }
  return undefined
}

/** A parameterised path (`/users/{id}`) addresses one item; a bare one, a list or an action. */
export const hasPathParam = (route: Route): boolean => route.parameters.some((p) => p.in === "path")

/** Key of the list in a route's default body: `""` for a bare array, `"data"` for a wrapper, else nothing. */
export const listKeyFor = (route: Route, source: string): string | undefined => {
  const response = route.responses.find((r) => r.status === String(route.defaultStatus))
  const shape = response?.shape
  if (shape === undefined) return undefined
  if (shape.kind === "array") return shape.items.kind === "object" && shape.items.title === source ? "" : undefined
  if (shape.kind === "object") {
    const property = shape.properties.find(
      (p) => p.shape.kind === "array" && p.shape.items.kind === "object" && p.shape.items.title === source && (LIST_KEYS as ReadonlyArray<string>).includes(p.name),
    )
    return property?.name
  }
  return undefined
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"
const randomChars = (random: () => number, length: number, alphabet = BASE36): string => {
  let out = ""
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(random() * alphabet.length) % alphabet.length]
  return out
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A free id in the style of the collection's: next integer, `usr_x8k2…`, or UUID. */
export const freshId = (items: ReadonlyArray<Json>, sample: Json | undefined, random: () => number): string | number => {
  const existing = new Set<string>()
  let numeric = items.length > 0 || typeof sample === "number"
  let max = 0
  for (const item of items) {
    const id = idOf(item)
    if (id !== undefined) existing.add(id)
    const raw = isObject(item) ? item[idFieldOf(item) ?? "id"] : undefined
    if (typeof raw === "number") max = Math.max(max, raw)
    else numeric = false
  }
  if (typeof sample === "number") max = Math.max(max, Math.floor(sample))
  if (numeric && typeof sample !== "string") return max + 1
  const text = typeof sample === "string" ? sample : ""
  for (let attempt = 0; attempt < 64; attempt++) {
    let candidate: string
    if (UUID.test(text)) {
      const h = randomChars(random, 32, "0123456789abcdef")
      candidate = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
    } else {
      const prefix = text.match(/^([a-z]+[_-])/i)?.[1] ?? ""
      const width = Math.max(6, Math.min(12, text.length - prefix.length))
      candidate = `${prefix}${randomChars(random, width)}`
    }
    if (!existing.has(candidate)) return candidate
  }
  return `${text}-${randomChars(random, 12)}`
}

/** Inserts or replaces (same id); the collection stays bounded. */
export const upsertItem = (items: ReadonlyArray<Json>, item: Json): { readonly items: ReadonlyArray<Json>; readonly created: boolean } => {
  const id = idOf(item)
  if (id !== undefined) {
    const index = items.findIndex((i) => idOf(i) === id)
    if (index >= 0) {
      const next = [...items]
      next[index] = item
      return { items: next, created: false }
    }
  }
  const next = [...items, item]
  return { items: next.length > MAX_STATE_ITEMS ? next.slice(next.length - MAX_STATE_ITEMS) : next, created: true }
}

export const removeItem = (items: ReadonlyArray<Json>, id: string): { readonly items: ReadonlyArray<Json>; readonly removed: boolean } => {
  const next = items.filter((i) => idOf(i) !== id)
  return { items: next, removed: next.length !== items.length }
}

/** Replaces the items of a list body (bare array or wrapper) and recomputes the counters. */
export const replaceItems = (body: Json, items: ReadonlyArray<Json>, key: string): Json => {
  if (key === "") return Array.isArray(body) ? [...items] : body
  if (!isObject(body) || !Array.isArray(body[key])) return body
  const patched: Record<string, Json> = { ...body, [key]: [...items] }
  for (const counter of COUNTER_KEYS) if (typeof patched[counter] === "number") patched[counter] = items.length
  if (typeof patched["has_more"] === "boolean") patched["has_more"] = false
  return patched
}

const ID_PARAM = /(^id$|_id$|Id$|^uuid$|_uuid$|Uuid$)/

/** Value of the path parameter identifying the item (`{id}`, `{petId}`, else the last one). */
export const pathId = (route: Route, params: Readonly<Record<string, string>>): string | undefined => {
  const pathParams = route.parameters.filter((p) => p.in === "path")
  const named = pathParams.find((p) => ID_PARAM.test(p.name)) ?? pathParams[pathParams.length - 1]
  if (named !== undefined) return params[named.name]
  const values = Object.values(params)
  return values[values.length - 1]
}

/** A serialisable state operation: it travels to whatever object holds the state. */
export type StateOp =
  | { readonly kind: "insert"; readonly item: JsonObject }
  | { readonly kind: "upsert"; readonly item: JsonObject }
  | { readonly kind: "remove"; readonly id: string }

export interface OpResult {
  readonly items: ReadonlyArray<Json>
  readonly body: Json | undefined
  readonly changed: boolean
}

/** Applies an operation to a collection: insert with a fresh id, replace, or remove. */
export const applyOp = (items: ReadonlyArray<Json>, op: StateOp, random: () => number = Math.random): OpResult => {
  switch (op.kind) {
    case "remove": {
      const removed = removeItem(items, op.id)
      return { items: removed.items, body: undefined, changed: removed.removed }
    }
    case "insert": {
      let item = op.item
      const existing = idOf(item)
      if (existing === undefined || items.some((i) => idOf(i) === existing)) {
        const field = idFieldOf(item) ?? "id"
        item = { ...item, [field]: freshId(items, item[field], random) }
      }
      return { items: upsertItem(items, item).items, body: item, changed: true }
    }
    case "upsert":
      return { items: upsertItem(items, op.item).items, body: op.item, changed: true }
  }
}

/** The operation implied by a successful write on a route, or nothing if the route has no collection. */
export const writeOp = (
  mock: MockDefinition,
  route: Route,
  params: Readonly<Record<string, string>>,
  method: string,
  body: Json | undefined,
): { readonly source: string; readonly op: StateOp } | undefined => {
  // A QUERY is a read, even when it arrives as POST.
  if (route.method === "query") return undefined
  const source = collectionFor(mock, route)
  if (source === undefined) return undefined
  const verb = method.toUpperCase()
  if (verb === "DELETE") {
    const id = pathId(route, params)
    return id === undefined ? undefined : { source, op: { kind: "remove", id } }
  }
  if (!isObject(body)) return undefined
  if (verb === "POST") return { source, op: { kind: "insert", item: body } }
  if (verb === "PUT" || verb === "PATCH") return { source, op: { kind: "upsert", item: body } }
  return undefined
}

export interface WriteRequest {
  readonly method: string
  readonly route: Route
  readonly params: Readonly<Record<string, string>>
  /** The body resolved by `resolve`: the created or modified object (absent for DELETE). */
  readonly body: Json | undefined
  readonly random?: (() => number) | undefined
}

export interface WriteResult {
  readonly collections: Readonly<Record<string, ReadonlyArray<Json>>>
  /** The body to return; an inserted object carries its fresh id. */
  readonly body: Json | undefined
  readonly source: string
}

/**
 * Applies a successful write to in-memory collections (CLI): POST inserts with a fresh id,
 * PUT and PATCH replace, DELETE removes. `undefined` when there is nothing to keep.
 */
export const applyWrite = (
  mock: MockDefinition,
  collections: Readonly<Record<string, ReadonlyArray<Json>>>,
  write: WriteRequest,
): WriteResult | undefined => {
  const planned = writeOp(mock, write.route, write.params, write.method, write.body)
  if (planned === undefined) return undefined
  const items = own(collections, planned.source) ?? own(mock.data.collections, planned.source) ?? []
  const applied = applyOp(items, planned.op, write.random ?? Math.random)
  if (!applied.changed) return undefined
  return {
    collections: { ...collections, [planned.source]: applied.items },
    body: planned.op.kind === "remove" ? write.body : applied.body,
    source: planned.source,
  }
}
