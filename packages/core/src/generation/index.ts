/**
 * Step 4 — data generation.
 *
 * Produces realistic data once per route and documented status: semantics are
 * inferred from field names and formats, values stay coherent (created_at ≤
 * updated_at, totals match line items, list ↔ detail) and the seed is stable.
 */
import { Effect } from "effect"
import { GenerationError } from "../errors"
import type {
  ArrayShape,
  DataShape,
  Json,
  JsonObject,
  MockData,
  ObjectShape,
  ResponseSpec,
  Route,
  RouteTable,
} from "../model"
import { infer, singular, tokenize, type Semantic } from "./infer"
import { makeRng, randomSeed, type Rng } from "./random"
import {
  booleanValue,
  idPrefix,
  isoDateTime,
  laterDateTime,
  makeCompany,
  makePerson,
  numberValue,
  shortId,
  slugify,
  stringValue,
  type Identity,
  type ValueContext,
} from "./values"
import { CITIES } from "./pools"
import { setOwn } from "../util/pointer"

/** Suggested values per component and field: `{ Product: { name: ["Chaise Bistrot", …] } }`. */
export interface Vocabulary {
  readonly [title: string]: { readonly [field: string]: ReadonlyArray<string> }
}

export interface GenerationOptions {
  /** Deterministic: same seed + same spec → same data. */
  readonly seed: string
  readonly vocabulary?: Vocabulary | undefined
  readonly now?: Date | undefined
  /** Items per collection (default 8, fewer for large objects). */
  readonly collectionSize?: number | undefined
  /** Only generate these route ids (endpoint regeneration). */
  readonly only?: ReadonlyArray<string> | undefined
  /** Values generated at most in this run (default `MAX_GENERATED_VALUES`); lower on per-request paths. */
  readonly maxValues?: number | undefined
}

export const generate = (table: RouteTable, options: GenerationOptions): Effect.Effect<MockData, GenerationError> =>
  Effect.try({
    try: () => generateSync(table, options),
    catch: (cause) =>
      new GenerationError({
        message: `La génération des données a échoué : ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  })

export const generateSync = (table: RouteTable, options: GenerationOptions): MockData =>
  new Generator(table, options).run()

/**
 * Generated data is stored with the mock and read back at every request. Deep specs embed the
 * lists of every level in the level above (a presentation's pages, their elements, their cells…):
 * past this weight, the data is drawn again with smaller collections.
 */
export const MAX_DATA_BYTES = 4 * 1024 * 1024
const COMPACT_COLLECTION_SIZES = [4, 2, 1]

/** `generateSync`, collections shrunk until the data stays under `maxBytes`; the size kept is recorded. */
export const generateCompact = (table: RouteTable, options: GenerationOptions, maxBytes = MAX_DATA_BYTES): MockData => {
  let data = generateSync(table, options)
  if (options.collectionSize !== undefined) return { ...data, collectionSize: options.collectionSize }
  for (const collectionSize of COMPACT_COLLECTION_SIZES) {
    if (!heavierThan(data, maxBytes)) return data
    data = { ...generateSync(table, { ...options, collectionSize }), collectionSize }
  }
  return data
}

/** Whether a value serializes to more than `limit` bytes, give or take; stops counting as soon as it does. */
const heavierThan = (value: unknown, limit: number): boolean => {
  let bytes = 0
  const visit = (node: unknown): boolean => {
    if (typeof node === "string") bytes += node.length + 2
    else if (node === null || typeof node !== "object") bytes += 6
    else if (Array.isArray(node)) {
      bytes += 2
      for (const item of node) if (visit(item)) return true
    } else {
      bytes += 2
      for (const [key, item] of Object.entries(node)) {
        bytes += key.length + 4
        if (visit(item)) return true
      }
    }
    return bytes > limit
  }
  return visit(value)
}

export { randomSeed }

interface GenContext extends ValueContext {
  readonly depth: number
}

const MAX_DEPTH = 10
const DEFAULT_COLLECTION_SIZE = 8
/** A list never holds more items than this, whatever `minItems` says: `minItems: 2000000` is not a mock. */
export const MAX_GENERATED_ITEMS = 100
/**
 * Values generated in one run, at most. Nested lists multiply (8 × 4 × 4…): past this budget the rest is empty,
 * so a few hundred bytes of schema can never cost the worker its memory. Real specs stay far below.
 */
export const MAX_GENERATED_VALUES = 100_000
/**
 * Each object is generated once, but a related entity embedded whole carries the entities it embeds:
 * collections of collections (a presentation, its pages, their elements…) would serialize as a tree
 * that grows with each level. Past this many JSON nodes, an embedded entity is summed up instead.
 */
const MAX_EMBEDDED_NODES = 300
const JSON_BODY = /^application\/(.+\+)?json\b|^\*\/\*$/i
/** Author-written records served per collection, at most: a mock is not a database dump. */
const MAX_FIXTURES = 500

const exampleFits = (shape: DataShape, example: Json): boolean => {
  switch (shape.kind) {
    case "string":
      return typeof example === "string"
    case "number":
      return typeof example === "number"
    case "boolean":
      return typeof example === "boolean"
    case "object":
      return typeof example === "object" && example !== null && !Array.isArray(example)
    case "array":
      return Array.isArray(example)
    default:
      return false
  }
}

/** Shapes of a subtree that are not `unknown`: how much of a component the shape budget left at that place. */
const knownShapes = (shape: DataShape, memo: WeakMap<object, number>): number => {
  const cached = memo.get(shape)
  if (cached !== undefined) return cached
  let count = shape.kind === "unknown" ? 0 : 1
  if (shape.kind === "object") {
    for (const property of shape.properties) count += knownShapes(property.shape, memo)
    if (shape.additional !== undefined) count += knownShapes(shape.additional, memo)
  } else if (shape.kind === "array") count += knownShapes(shape.items, memo)
  else if (shape.kind === "union") for (const variant of shape.variants) count += knownShapes(variant, memo)
  memo.set(shape, count)
  return count
}

class Generator {
  private readonly root: Rng
  private readonly now: Date
  private readonly collections = new Map<string, Array<Json>>()
  private readonly building = new Set<string>()
  private readonly titled = new Map<string, ObjectShape>()
  private readonly sources: Record<string, string> = {}
  private readonly weights = new WeakMap<object, number>()
  private readonly completeness = new WeakMap<object, number>()
  private produced = 0

  constructor(
    private readonly table: RouteTable,
    private readonly options: GenerationOptions,
  ) {
    this.root = makeRng(options.seed)
    this.now = options.now ?? new Date()
    for (const route of table.routes) {
      for (const response of route.responses) {
        if (response.shape !== undefined && !isErrorStatus(response.status)) this.registerTitled(response.shape, 0)
      }
      if (route.requestBody !== undefined) this.registerTitled(route.requestBody.shape, 0)
    }
  }

  run(): MockData {
    const bodies: Record<string, Record<string, Json>> = {}
    const only = this.options.only === undefined ? undefined : new Set(this.options.only)
    for (const route of this.table.routes) {
      if (only !== undefined && !only.has(route.id)) continue
      const perStatus: Record<string, Json> = {}
      for (const response of route.responses) {
        const body = this.body(route, response)
        if (body !== undefined) perStatus[response.status] = body
      }
      bodies[route.id] = perStatus
    }
    const collections: Record<string, Array<Json>> = {}
    for (const [title, items] of this.collections) collections[title] = items
    return { seed: this.options.seed, generatedAt: isoDateTime(this.now), bodies, collections, sources: this.sources }
  }

  private registerTitled(shape: DataShape, depth: number): void {
    if (depth > MAX_DEPTH) return
    switch (shape.kind) {
      case "object":
        if (shape.title !== undefined && shape.properties.length > 0) {
          // The same component may be cut short by the shape budget where it is nested deep (a customer inside a
          // charge): its collection is drawn from its most complete appearance.
          const existing = this.titled.get(shape.title)
          if (existing === undefined || knownShapes(shape, this.completeness) > knownShapes(existing, this.completeness)) {
            this.titled.set(shape.title, shape)
          }
        }
        for (const property of shape.properties) this.registerTitled(property.shape, depth + 1)
        if (shape.additional !== undefined) this.registerTitled(shape.additional, depth + 1)
        return
      case "array":
        this.registerTitled(shape.items, depth + 1)
        return
      case "union":
        for (const variant of shape.variants) this.registerTitled(variant, depth + 1)
        return
      default:
        return
    }
  }

  private body(route: Route, response: ResponseSpec): Json | undefined {
    const shape = response.shape
    if (shape === undefined) return undefined
    const status = statusNumber(response.status, route)
    const rng = this.root.fork(`${route.id}#${response.status}`)
    const ctx = this.rootContext(rng, status)
    // A schema that says nothing (`{}`, FastAPI's default) still answers a JSON object: `null` reads as a failure.
    if (shape.kind === "unknown" && shape.example === undefined && shape.default === undefined && status !== 204 && !isErrorStatus(response.status)) {
      if (response.contentType === undefined || JSON_BODY.test(response.contentType)) return {}
    }
    if (!isErrorStatus(response.status)) {
      if (shape.kind === "object" && shape.title !== undefined && this.titled.has(shape.title)) {
        const first = this.collection(shape.title)[0]
        if (first !== undefined) {
          if (Number(response.status) === route.defaultStatus) this.sources[route.id] = shape.title
          return first
        }
        return this.value(shape, ctx)
      }
      if (shape.kind === "array" && shape.items.kind === "object" && shape.items.title !== undefined && this.titled.has(shape.items.title)) {
        if (Number(response.status) === route.defaultStatus) this.sources[route.id] = shape.items.title
        return this.slice(this.collection(shape.items.title), shape, rng, true)
      }
    }
    return this.value(shape, ctx)
  }

  private rootContext(rng: Rng, status: number | undefined): GenContext {
    return {
      rng,
      now: this.now,
      name: "",
      parentTitle: undefined,
      status,
      index: 0,
      salt: rng.int(0, 1000),
      inCollection: false,
      identity: {},
      vocabulary: undefined,
      depth: 0,
    }
  }

  private collection(title: string): Array<Json> {
    const existing = this.collections.get(title)
    if (existing !== undefined) return existing
    const shape = this.titled.get(title)
    if (shape === undefined || this.building.has(title)) return []
    // Records written by the author (json-server `db.json`): served as they are.
    if (shape.fixtures !== undefined && shape.fixtures.length > 0) {
      const items = shape.fixtures.slice(0, MAX_FIXTURES) as Array<Json>
      this.collections.set(title, items)
      return items
    }
    this.building.add(title)
    const rng = this.root.fork(`collection:${title}`)
    const size = this.options.collectionSize ?? (shape.properties.length > 30 ? 4 : DEFAULT_COLLECTION_SIZE)
    const salt = rng.int(0, 1000)
    const items: Array<Json> = []
    for (let index = 0; index < size; index++) {
      const ctx: GenContext = {
        rng: rng.fork(String(index)),
        now: this.now,
        name: "",
        parentTitle: title,
        status: undefined,
        index,
        salt,
        inCollection: true,
        identity: {},
        vocabulary: undefined,
        depth: 1,
      }
      items.push(this.object(shape, ctx))
    }
    this.collections.set(title, items)
    this.building.delete(title)
    return items
  }

  private slice(items: ReadonlyArray<Json>, shape: ArrayShape, rng: Rng, full: boolean): Array<Json> {
    const max = Math.min(shape.maxItems ?? Infinity, items.length)
    const min = Math.min(shape.minItems ?? 0, max, MAX_GENERATED_ITEMS)
    if (full) return items.slice(0, Math.max(min, max))
    const count = Math.max(min, Math.min(max, rng.int(1, 3)))
    return rng.sample(items, count)
  }

  private value(shape: DataShape, ctx: GenContext): Json {
    if (ctx.depth > MAX_DEPTH || ++this.produced > (this.options.maxValues ?? MAX_GENERATED_VALUES)) return nullOrEmpty(shape)
    const semantic = ctx.name.length > 0 ? infer(ctx.name, shape, { parentTitle: ctx.parentTitle, status: ctx.status }) : "generic"
    if (shape.nullable === true && ctx.name.length > 0) {
      if (semantic === "datetime-deleted") return ctx.rng.chance(0.85) ? null : this.value({ ...shape, nullable: false }, ctx)
      if (ctx.rng.chance(0.12)) return null
    }
    // The schema's own example, for the first element: what the author wrote is what they expect to see.
    if (ctx.index === 0 && shape.example !== undefined && exampleFits(shape, shape.example)) return shape.example
    switch (shape.kind) {
      case "const":
        return shape.value
      case "null":
        return null
      case "unknown":
        return shape.example ?? shape.default ?? null
      case "boolean":
        return booleanValue(ctx)
      case "number":
        if (shape.enum !== undefined && shape.enum.length > 0) return shape.enum[(ctx.salt + ctx.index) % shape.enum.length]!
        return numberValue(semantic, shape, ctx)
      case "string":
        if (shape.enum !== undefined && shape.enum.length > 0) return shape.enum[(ctx.salt + ctx.index) % shape.enum.length]!
        return stringValue(semantic, shape, ctx)
      case "union": {
        const expandable = expandableReference(shape.variants)
        if (expandable !== undefined) return `${idPrefix(expandable)}_${shortId(ctx.rng)}`
        return this.value(pickVariant(shape.variants, ctx), ctx)
      }
      case "array":
        return this.array(shape, ctx)
      case "object":
        return this.objectOrReference(shape, ctx)
    }
  }

  private array(shape: ArrayShape, ctx: GenContext): Array<Json> {
    const items = shape.items
    // Items the schema says nothing about: an empty list reads as « nothing yet », a row of nulls as a bug.
    if (items.kind === "unknown" && items.example === undefined && items.default === undefined) return []
    if (items.kind === "object" && items.title !== undefined && this.titled.has(items.title) && !this.building.has(items.title)) {
      const slice = this.slice(this.collection(items.title), shape, ctx.rng, ctx.depth <= 1)
      return ctx.depth <= 1 ? slice : slice.map((item) => (isJsonObject(item) ? this.embed(item) : item))
    }
    const max = shape.maxItems ?? (ctx.depth <= 1 ? 8 : 4)
    const min = Math.min(shape.minItems ?? 0, MAX_GENERATED_ITEMS)
    const count = Math.min(MAX_GENERATED_ITEMS, Math.max(min, Math.min(max, ctx.rng.int(ctx.depth <= 1 ? 3 : 2, ctx.depth <= 1 ? 8 : 4))))
    const name = singular(ctx.name)
    const salt = ctx.rng.int(0, 1000)
    const out: Array<Json> = []
    for (let index = 0; index < count; index++) {
      out.push(
        this.value(items, {
          ...ctx,
          rng: ctx.rng.fork(`${name}[${index}]`),
          name,
          index,
          salt,
          inCollection: false,
          depth: ctx.depth + 1,
        }),
      )
    }
    return out
  }

  /** A nested named object points back to its collection: `issue.user` is a real `user` from the list. */
  private objectOrReference(shape: ObjectShape, ctx: GenContext): JsonObject {
    if (shape.title !== undefined && ctx.depth > 0 && this.titled.has(shape.title) && !this.building.has(shape.title)) {
      const items = this.collection(shape.title)
      const picked = items.length > 0 ? ctx.rng.pick(items) : undefined
      if (picked !== undefined && isJsonObject(picked)) return this.embed(picked)
    }
    return this.object(shape, ctx)
  }

  /**
   * A related entity is embedded whole while it stays light; past `MAX_EMBEDDED_NODES` it is summed up
   * by its own scalar fields (`{ id, name, status }`), as APIs do for expandable references.
   */
  private embed(item: JsonObject): JsonObject {
    if (this.weight(item) <= MAX_EMBEDDED_NODES) return item
    const summary: Record<string, Json> = {}
    for (const [key, value] of Object.entries(item)) if (value === null || typeof value !== "object") setOwn(summary, key, value)
    return summary
  }

  /** JSON nodes a value serializes to, shared values counted at each use; counting stops past the threshold. */
  private weight(value: Json): number {
    if (value === null || typeof value !== "object") return 1
    const known = this.weights.get(value)
    if (known !== undefined) return known
    let total = 1
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      total += this.weight(child)
      if (total > MAX_EMBEDDED_NODES) break
    }
    this.weights.set(value, total)
    return total
  }

  private object(shape: ObjectShape, ctx: GenContext): JsonObject {
    const title = shape.title ?? (ctx.name.length > 0 ? ctx.name : ctx.parentTitle)
    const identity = this.identityFor(shape, ctx)
    const vocabulary = this.vocabularyFor(shape.title)
    const out: Record<string, Json> = {}
    const semantics = new Map<string, Semantic>()
    for (const property of shape.properties) {
      const fieldRng = ctx.rng.fork(property.name)
      const propertyCtx: GenContext = {
        ...ctx,
        rng: fieldRng,
        name: property.name,
        parentTitle: title,
        identity,
        vocabulary: vocabulary?.[property.name],
        depth: ctx.depth + 1,
      }
      semantics.set(property.name, infer(property.name, property.shape, { parentTitle: title, status: ctx.status }))
      setOwn(out, property.name, this.value(property.shape, propertyCtx))
    }
    if (shape.additional !== undefined && shape.properties.length === 0) {
      const keys = ctx.rng.sample(MAP_KEYS, ctx.rng.int(2, 3))
      for (const key of keys) {
        out[key] = this.value(shape.additional, { ...ctx, rng: ctx.rng.fork(key), name: key, depth: ctx.depth + 1 })
      }
    }
    applyCoherence(out, shape, semantics, ctx)
    return out
  }

  private identityFor(shape: ObjectShape, ctx: GenContext): Identity {
    const semantics = shape.properties.map((p) => infer(p.name, p.shape, { parentTitle: shape.title ?? ctx.parentTitle, status: ctx.status }))
    const identity: { -readonly [K in keyof Identity]: Identity[K] } = { ...ctx.identity }
    const rng = ctx.rng.fork("identity")
    if (identity.person === undefined && semantics.some((s) => PERSON_SEMANTICS.has(s))) identity.person = makePerson(rng)
    if (identity.company === undefined && semantics.some((s) => COMPANY_SEMANTICS.has(s))) identity.company = makeCompany(rng)
    if (identity.city === undefined && semantics.some((s) => GEO_SEMANTICS.has(s))) identity.city = rng.pick(CITIES)
    return identity
  }

  private vocabularyFor(title: string | undefined): { readonly [field: string]: ReadonlyArray<string> } | undefined {
    const vocabulary = this.options.vocabulary
    if (vocabulary === undefined || title === undefined) return undefined
    const direct = vocabulary[title]
    if (direct !== undefined) return direct
    const wanted = title.toLowerCase()
    const key = Object.keys(vocabulary).find((k) => k.toLowerCase() === wanted)
    return key === undefined ? undefined : vocabulary[key]
  }
}

const MAP_KEYS = ["source", "campaign", "channel", "segment", "origin", "cohort"] as const

const PERSON_SEMANTICS: ReadonlySet<Semantic> = new Set(["email", "first-name", "last-name", "full-name", "username", "avatar"])
const COMPANY_SEMANTICS: ReadonlySet<Semantic> = new Set(["company", "url", "hostname"])
const GEO_SEMANTICS: ReadonlySet<Semantic> = new Set(["city", "zip", "region", "latitude", "longitude", "street"])

const isErrorStatus = (status: string): boolean => status === "DEFAULT" || /^[45]/.test(status)

const statusNumber = (status: string, route: Route): number | undefined => {
  if (/^\d{3}$/.test(status)) return Number(status)
  if (/^[1-5]XX$/.test(status)) return Number(status[0]) * 100
  if (status === "DEFAULT") return route.responses.some((r) => /^2/.test(r.status)) ? 500 : route.defaultStatus
  return undefined
}

const nullOrEmpty = (shape: DataShape): Json => {
  switch (shape.kind) {
    case "array":
      return []
    case "object":
      return {}
    default:
      return null
  }
}

/** Stripe-style "expandable" `anyOf: [string, Price]`: the string is the object's id. */
const expandableReference = (variants: ReadonlyArray<DataShape>): string | undefined => {
  const strings = variants.filter((v) => v.kind === "string" && v.enum === undefined && v.format === undefined)
  const objects = variants.filter((v): v is ObjectShape => v.kind === "object" && v.title !== undefined)
  if (strings.length === 1 && objects.length >= 1 && strings.length + objects.length === variants.length) {
    return objects[0]!.title
  }
  return undefined
}

/** Prefer a concrete variant; a discriminated union of objects rotates so every variant shows up in a collection. */
const pickVariant = (variants: ReadonlyArray<DataShape>, ctx: GenContext): DataShape => {
  const concrete = variants.filter((v) => v.kind !== "unknown" && v.kind !== "null")
  if (concrete.length === 0) return variants[0] ?? { kind: "unknown" }
  const objects = concrete.filter((v) => v.kind === "object")
  if (objects.length === concrete.length && objects.length > 1 && ctx.inCollection) {
    return objects[(ctx.salt + ctx.index) % objects.length]!
  }
  return concrete[0]!
}

// ─── Intra-object coherence ──────────────────────────────────────────────────

const applyCoherence = (
  out: Record<string, Json>,
  shape: ObjectShape,
  semantics: ReadonlyMap<string, Semantic>,
  ctx: GenContext,
): void => {
  const names = shape.properties.map((p) => p.name)
  const find = (predicate: (name: string, semantic: Semantic | undefined) => boolean): string | undefined =>
    names.find((n) => predicate(n, semantics.get(n)))

  const slugKey = find((_, s) => s === "slug")
  const labelKey = find((_, s) => s === "full-name" || s === "product-name" || s === "company" || s === "title" || s === "word" || s === "pet-name")
  if (slugKey !== undefined && labelKey !== undefined && typeof out[labelKey] === "string") {
    out[slugKey] = slugify(out[labelKey])
  }

  const created = find((_, s) => s === "datetime-created")
  const updated = find((_, s) => s === "datetime-updated")
  if (created !== undefined && updated !== undefined) {
    const from = parseDate(out[created])
    if (from !== undefined && typeof out[updated] === "string") {
      const to = parseDate(out[updated])
      if (to === undefined || to < from) out[updated] = isoDateTime(laterDateTime(ctx.rng.fork("updated"), from, ctx.now))
    }
  }
  for (const [startKey, endKey] of pairs(names, ["start", "from", "begin", "min", "opens", "since", "check_in", "checkin", "departure"], ["end", "to", "finish", "max", "closes", "until", "check_out", "checkout", "arrival"])) {
    const a = out[startKey]
    const b = out[endKey]
    if (typeof a === "number" && typeof b === "number" && b < a) {
      out[startKey] = b
      out[endKey] = a
    } else if (typeof a === "string" && typeof b === "string") {
      const da = parseDate(a)
      const db = parseDate(b)
      if (da !== undefined && db !== undefined && db < da) {
        out[startKey] = b
        out[endKey] = a
      }
    }
  }

  // Totals match line items, counters match list sizes, pagination stays sane.
  const arrays = names.filter((n) => Array.isArray(out[n]))
  for (const arrayKey of arrays) {
    const items = out[arrayKey] as Array<Json>
    const lineTotal = sumLines(items)
    const isMoneyList = lineTotal !== undefined
    const subtotalKey = find((n, s) => s === "money" && /^(sub_?total|net|ht|amount_?subtotal)$/i.test(n))
    const totalKey = find((n, s) => s === "money" && /^(total|total_?amount|amount|amount_?total|grand_?total|ttc|sum)$/i.test(n))
    const taxKey = find((n, s) => s === "money" && /^(tax|taxes|vat|tva|tax_?amount)$/i.test(n))
    const shippingKey = find((n, s) => s === "money" && /^(shipping|shipping_?cost|shipping_?fee|delivery_?fee|port)$/i.test(n))
    if (isMoneyList) {
      const integer = isIntegerMoney(shape, subtotalKey ?? totalKey)
      const money = (v: number): number => (integer ? Math.round(v) : Math.round(v * 100) / 100)
      const subtotal = money(lineTotal)
      if (subtotalKey !== undefined) out[subtotalKey] = subtotal
      const tax = taxKey !== undefined ? money(subtotal * 0.2) : 0
      if (taxKey !== undefined) out[taxKey] = tax
      const shipping = shippingKey !== undefined && typeof out[shippingKey] === "number" ? out[shippingKey] : 0
      if (totalKey !== undefined) out[totalKey] = money(subtotal + tax + shipping)
    }
    const countKey = find((n, s) =>
      (s === "count" || s === "generic" || s === "money") &&
      /^(count|total_?count|total_?items|total_?results|nb_?items|item_?count|num_?items|total|size|length|hits|n)$/i.test(n) &&
      !(isMoneyList && /^total$/i.test(n)),
    )
    if (countKey !== undefined && typeof out[countKey] === "number") out[countKey] = items.length
    const perPageKey = find((n) => /^(per_?page|page_?size|limit|page_?length)$/i.test(n))
    if (perPageKey !== undefined && typeof out[perPageKey] === "number") out[perPageKey] = Math.max(items.length, out[perPageKey])
  }
  // Only a pagination envelope (a list, or its companions) is on page 1 of 1: a book's `pages` is not.
  const paginated = arrays.length > 0 || names.some((n) => /^(page|current_?page|per_?page|page_?size|limit|offset|cursor|total|next(_?(cursor|page|url|token))?|total_?(count|items|results))$/i.test(n))
  for (const n of names) {
    if (!paginated) break
    if (/^(page|current_?page|page_?number)$/i.test(n) && typeof out[n] === "number") out[n] = 1
    if (/^(pages|total_?pages|page_?count|last_?page)$/i.test(n) && typeof out[n] === "number") out[n] = 1
    if (/^(next|next_?cursor|next_?page|next_?url|next_?token|after|ending_?before|previous|prev|prev_?cursor)$/i.test(n) && typeof out[n] === "string") {
      out[n] = null
    }
  }
}

const sumLines = (items: ReadonlyArray<Json>): number | undefined => {
  let total = 0
  let found = false
  for (const item of items) {
    if (!isJsonObject(item)) continue
    const priceKey = Object.keys(item).find((k) => /^(unit_?price|price|unit_?amount|amount|unit_?cost|cost|rate|line_?total|total)$/i.test(k))
    if (priceKey === undefined) continue
    const price = item[priceKey]
    if (typeof price !== "number") continue
    const quantityKey = Object.keys(item).find((k) => /^(quantity|qty|count|units|nb)$/i.test(k))
    const quantity = quantityKey !== undefined && typeof item[quantityKey] === "number" ? item[quantityKey] : 1
    total += /^(line_?total|total)$/i.test(priceKey) ? price : price * quantity
    found = true
  }
  return found ? total : undefined
}

const isIntegerMoney = (shape: ObjectShape, key: string | undefined): boolean => {
  if (key === undefined) return false
  const property = shape.properties.find((p) => p.name === key)
  return property?.shape.kind === "number" && property.shape.integer
}

const pairs = (
  names: ReadonlyArray<string>,
  starts: ReadonlyArray<string>,
  ends: ReadonlyArray<string>,
): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  // Each name tokenized once, then found by its tokens: an object with thousands of fields stays linear.
  const tokenized = names.map((name) => [name, tokenize(name)] as const)
  const byTokens = new Map<string, string>()
  for (const [name, tokens] of tokenized) if (!byTokens.has(tokens.join(" "))) byTokens.set(tokens.join(" "), name)
  for (const [name, tokens] of tokenized) {
    const index = tokens.findIndex((t) => starts.includes(t))
    if (index === -1) continue
    const startWord = tokens[index]!
    const endWord = ends[starts.indexOf(startWord)]
    if (endWord === undefined) continue
    const counterpart = byTokens.get(tokens.map((t, i) => (i === index ? endWord : t)).join(" "))
    if (counterpart !== undefined && counterpart !== name) out.push([name, counterpart])
  }
  return out
}

const isJsonObject = (u: Json | undefined): u is JsonObject => typeof u === "object" && u !== null && !Array.isArray(u)

const parseDate = (value: Json | undefined): Date | undefined => {
  if (typeof value !== "string") return undefined
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : new Date(time)
}
