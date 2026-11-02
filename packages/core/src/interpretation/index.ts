/**
 * Stage 3, interpretation: where Loutre adds its own value. Derives a typed route
 * table from the normalised document (methods, paths, parameters, bodies, responses
 * by status, data shapes); inconsistencies become errors with suggestions.
 */
import { Effect } from "effect"
import { InterpretationError } from "../errors"
import {
  HttpMethod,
  type ApiInfo,
  type DataShape,
  type Parameter,
  type ParameterLocation,
  type RequestBody,
  type ResponseSpec,
  type Route,
  type Json,
  type JsonObject,
  type RouteTable,
} from "../model"
import type { NormalisedSpec } from "../normalisation"
import { entityOf, exampleShaper, inlineRegistered } from "../collections"
import { inferSchema } from "../util/infer-schema"
import { isPlainObject } from "../util/pointer"
import { collectSchemaNames, isJson, makeShapeContext, siblingShapes, toShape, type ShapeContext } from "./shape"

const METHODS: ReadonlyArray<HttpMethod> = HttpMethod.literals
/** Shapes a route may always use while the table budget lasts, however many routes follow. */
const MIN_ROUTE_SHAPES = 100
const LOCATIONS: ReadonlyArray<ParameterLocation> = ["path", "query", "header", "cookie"]

export const interpret = (spec: NormalisedSpec): Effect.Effect<RouteTable, InterpretationError> =>
  Effect.suspend(() => {
    const document = spec.document as unknown as Record<string, unknown>
    const info = infoOf(document["info"])
    const paths = document["paths"]
    const entries = isPlainObject(paths) ? Object.entries(paths).filter(([key]) => key.startsWith("/")) : []
    const routes: Array<Route> = []
    const components = isPlainObject(document["components"]) ? document["components"] : {}
    const reserved = new Set(isPlainObject(components["schemas"]) ? Object.keys(components["schemas"]) : [])
    const ctx = { ...makeShapeContext(collectSchemaNames(components["schemas"])), examples: exampleSchemas(entries, reserved) }

    // The shape budget is shared fairly: each route may use its share of what is left, and what a
    // route does not use goes to the next ones.
    let left = entries.reduce((count, [, item]) => count + (isPlainObject(item) ? METHODS.filter((m) => isPlainObject(item[m])).length : 0), 0)
    for (const [path, item] of entries) {
      if (!isPlainObject(item)) continue
      const pathParameters = parametersOf(item["parameters"], ctx, (schema, assign) => assign(toShape(schema, ctx)))
      for (const method of METHODS) {
        const operation = item[method]
        if (!isPlainObject(operation)) continue
        const allowance = Math.min(ctx.budget.remaining, Math.max(MIN_ROUTE_SHAPES, Math.floor(ctx.budget.remaining / Math.max(1, left))))
        const budget = { remaining: allowance }
        routes.push(routeOf(method, path, operation, pathParameters, { ...ctx, budget }))
        ctx.budget.remaining -= allowance - budget.remaining
        left -= 1
      }
    }

    if (routes.length === 0) {
      return Effect.fail(noRoutesError(document))
    }
    const graphql = document["x-loutre-graphql"]
    if (isPlainObject(graphql) && typeof graphql["sdl"] === "string" && typeof graphql["path"] === "string") {
      const examples = isPlainObject(graphql["examples"]) ? (graphql["examples"] as Record<string, { query: string; variables: Record<string, Json> }>) : undefined
      return Effect.succeed({ format: spec.format, info, routes, graphql: { sdl: graphql["sdl"], path: graphql["path"], ...(examples === undefined ? {} : { examples }) } })
    }
    return Effect.succeed({ format: spec.format, info, routes })
  })

const noRoutesError = (document: Record<string, unknown>): InterpretationError => {
  const webhooks = isPlainObject(document["webhooks"]) ? Object.keys(document["webhooks"]).length : 0
  if (webhooks > 0) {
    return new InterpretationError({
      message: `Ce document ne décrit que des webhooks (${webhooks}) : Loutre mocke des routes HTTP entrantes, il lui faut un bloc \`paths\`.`,
      pointer: "#/webhooks",
      suggestions: ["Décrivez au moins une route sous `paths`, les webhooks pourront être rejoués plus tard."],
    })
  }
  return new InterpretationError({
    message: "Aucune route à mocker : le bloc `paths` est vide ou absent.",
    pointer: "#/paths",
    suggestions: [
      "Ajoutez au moins un chemin avec une opération, par exemple `paths: { /ping: { get: { responses: { '200': { description: ok } } } } }`.",
    ],
  })
}

const infoOf = (info: unknown): ApiInfo => {
  const source = isPlainObject(info) ? info : {}
  const result: { -readonly [K in keyof ApiInfo]: ApiInfo[K] } = {
    title: typeof source["title"] === "string" && source["title"].trim().length > 0 ? source["title"].trim() : "API sans nom",
  }
  if (typeof source["version"] === "string") result.version = source["version"]
  if (typeof source["description"] === "string" && source["description"].trim().length > 0) {
    result.description = source["description"].trim()
  }
  return result
}

/** Hands a schema over to be shaped later; `assign` receives its shape. */
type Defer = (schema: unknown, assign: (shape: DataShape) => void) => void
const UNSHAPED: DataShape = { kind: "unknown" }

const routeOf = (
  method: HttpMethod,
  path: string,
  operation: Record<string, unknown>,
  inherited: ReadonlyArray<Parameter>,
  ctx: ShapeContext,
): Route => {
  // Parameters, body and responses are shaped together, sharing the route's budget: a large success body
  // leaves the error bodies theirs (Stripe's `default` error after a list of customers).
  const pending: Array<readonly [unknown, (shape: DataShape) => void]> = []
  const defer: Defer = (schema, assign) => {
    pending.push([schema, assign])
  }
  const own = parametersOf(operation["parameters"], ctx, defer)
  const requestBody = requestBodyOf(operation["requestBody"], ctx, defer)
  const responses = responsesOf(operation["responses"], ctx, defer)
  siblingShapes(pending.map(([schema]) => schema), ctx).forEach((shape, index) => pending[index]![1](shape))
  const parameters = mergeParameters(inherited, own, path)
  const route: { -readonly [K in keyof Route]: Route[K] } = {
    id: `${method}:${path}`,
    method,
    path,
    tags: Array.isArray(operation["tags"]) ? operation["tags"].filter((t): t is string => typeof t === "string") : [],
    parameters,
    responses,
    defaultStatus: defaultStatusOf(responses),
  }
  if (typeof operation["operationId"] === "string") route.operationId = operation["operationId"]
  const summary = typeof operation["summary"] === "string" ? operation["summary"].trim() : ""
  const description = typeof operation["description"] === "string" ? operation["description"].trim() : ""
  if (summary.length > 0) route.summary = summary
  else if (description.length > 0) route.summary = description.split("\n")[0] ?? description
  if (requestBody !== undefined) route.requestBody = requestBody
  return route
}

const parametersOf = (list: unknown, ctx: ShapeContext, defer: Defer): Array<Parameter> => {
  if (!Array.isArray(list)) return []
  const out: Array<Parameter> = []
  for (const raw of list) {
    if (!isPlainObject(raw) || typeof raw["name"] !== "string") continue
    const location = raw["in"]
    if (typeof location !== "string" || !LOCATIONS.includes(location as ParameterLocation)) continue
    const schema = raw["schema"] !== undefined ? raw["schema"] : firstContentSchema(raw["content"], ctx)
    const parameter: { -readonly [K in keyof Parameter]: Parameter[K] } = {
      name: raw["name"],
      in: location as ParameterLocation,
      required: location === "path" ? true : raw["required"] === true,
      shape: UNSHAPED,
    }
    defer(schema, (shape) => {
      parameter.shape = shape
    })
    if (typeof raw["description"] === "string" && raw["description"].trim().length > 0) {
      parameter.description = raw["description"].trim()
    }
    out.push(parameter)
  }
  return out
}

/** Operation parameters override path-level ones; undeclared `{x}` in the template are synthesised. */
const mergeParameters = (
  inherited: ReadonlyArray<Parameter>,
  own: ReadonlyArray<Parameter>,
  path: string,
): Array<Parameter> => {
  const key = (p: Parameter) => `${p.in}:${p.name}`
  const merged = new Map<string, Parameter>()
  for (const p of inherited) merged.set(key(p), p)
  for (const p of own) merged.set(key(p), p)
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1] ?? ""
    if (name.length > 0 && !merged.has(`path:${name}`)) {
      merged.set(`path:${name}`, { name, in: "path", required: true, shape: { kind: "string" } })
    }
  }
  return [...merged.values()]
}

const JSON_LIKE = /^application\/(.+\+)?json\b/i

/** Picks the content type to mock: JSON first, else the first declared. */
const pickContent = (content: unknown, ctx: ShapeContext): { contentType: string; schema: unknown } | undefined => {
  if (!isPlainObject(content)) return undefined
  const types = Object.keys(content)
  const preferred =
    types.find((t) => t.toLowerCase() === "application/json") ??
    types.find((t) => JSON_LIKE.test(t)) ??
    types.find((t) => t === "*/*") ??
    types[0]
  if (preferred === undefined) return undefined
  const media = content[preferred]
  if (!isPlainObject(media)) return { contentType: preferred, schema: undefined }
  if (media["schema"] !== undefined) return { contentType: preferred, schema: media["schema"] }
  // No schema but an example: its shape stands in, realistic data is generated from it.
  const drawn = ctx.examples?.get(media)
  if (drawn !== undefined) return { contentType: preferred, schema: drawn }
  const example = mediaExample(media)
  return { contentType: preferred, schema: example === undefined ? undefined : anonymous(inferSchema(example)) }
}

/**
 * Media types that show an example but declare no schema (hand-written and older specs): their
 * schemas are drawn from all such examples at once, as for a collection. The same entity then has
 * one shape across routes (`versions[]` and `version` are both a `Version`), and the values shown
 * become hints: `status` keeps `CURRENT` and `EXPERIMENTAL`, a price stays in its range.
 */
const exampleSchemas = (entries: ReadonlyArray<readonly [string, unknown]>, reserved: ReadonlySet<string>): WeakMap<object, JsonObject> => {
  const found: Array<{ readonly media: object; readonly title: string | undefined; readonly value: Json; readonly error: boolean }> = []
  const collect = (content: unknown, title: string | undefined, error: boolean): void => {
    if (!isPlainObject(content)) return
    for (const media of Object.values(content)) {
      if (!isPlainObject(media) || media["schema"] !== undefined) continue
      const value = mediaExample(media)
      if (value !== undefined) found.push({ media, title, value, error })
    }
  }
  for (const [path, item] of entries) {
    if (!isPlainObject(item)) continue
    const title = entityOf(path)?.title
    for (const method of METHODS) {
      const operation = item[method]
      if (!isPlainObject(operation)) continue
      if (isPlainObject(operation["requestBody"])) collect(operation["requestBody"]["content"], title, false)
      const responses = operation["responses"]
      if (!isPlainObject(responses)) continue
      for (const [status, response] of Object.entries(responses)) {
        if (isPlainObject(response)) collect(response["content"], title, !/^[123]/.test(status))
      }
    }
  }
  const drawn = new WeakMap<object, JsonObject>()
  if (found.length === 0) return drawn
  const shaper = exampleShaper({ reserved })
  for (const sample of found) if (!sample.error) shaper.observe(sample.value, sample.title)
  // An error has its own shape (`{ error, message }`), never the resource's.
  const roots = found.map((sample) => (sample.error ? anonymous(inferSchema(sample.value)) : shaper.register(shaper.shaped(sample.value, sample.title))))
  const inlined = inlineRegistered(shaper.schemas, roots)
  found.forEach((sample, index) => drawn.set(sample.media, inlined[index]!))
  return drawn
}

/**
 * Titles drawn from field names would make one entity of unrelated examples (and could
 * shadow a component of the same name): inferred schemas stay anonymous.
 */
const anonymous = (schema: JsonObject): JsonObject => {
  const out: Record<string, Json> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "title") continue
    if (key === "items" && isPlainObject(value)) out[key] = anonymous(value as JsonObject)
    else if (key === "properties" && isPlainObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, property]) => [name, anonymous(property as JsonObject)]))
    } else out[key] = value
  }
  return out
}

/** The media type's `example`, else the first `examples` entry with a `value` (`externalValue` is not fetched). */
const mediaExample = (media: Record<string, unknown>): Json | undefined => {
  if (media["example"] !== undefined && isJson(media["example"])) return media["example"]
  const examples = media["examples"]
  if (!isPlainObject(examples)) return undefined
  for (const example of Object.values(examples)) {
    if (isPlainObject(example) && example["value"] !== undefined && isJson(example["value"])) return example["value"]
  }
  return undefined
}

const firstContentSchema = (content: unknown, ctx: ShapeContext): unknown => pickContent(content, ctx)?.schema

const requestBodyOf = (raw: unknown, ctx: ShapeContext, defer: Defer): RequestBody | undefined => {
  if (!isPlainObject(raw)) return undefined
  const picked = pickContent(raw["content"], ctx)
  if (picked === undefined) return undefined
  const body: { -readonly [K in keyof RequestBody]: RequestBody[K] } = {
    contentType: picked.contentType,
    required: raw["required"] === true,
    shape: UNSHAPED,
  }
  defer(picked.schema, (shape) => {
    body.shape = shape
  })
  return body
}

const statusOrder = (status: string): number => {
  if (/^\d{3}$/.test(status)) return Number(status)
  if (/^[1-5]XX$/i.test(status)) return Number(status[0]) * 100 + 99.5
  return 1000
}

const responsesOf = (raw: unknown, ctx: ShapeContext, defer: Defer): Array<ResponseSpec> => {
  if (!isPlainObject(raw)) return []
  const keys = Object.keys(raw)
    .filter((k) => /^\d{3}$/.test(k) || /^[1-5]XX$/i.test(k) || k === "default")
    .sort((a, b) => statusOrder(a) - statusOrder(b))
  const out: Array<ResponseSpec> = []
  for (const status of keys) {
    const response = raw[status]
    const spec: { -readonly [K in keyof ResponseSpec]: ResponseSpec[K] } = { status: status.toUpperCase() }
    if (isPlainObject(response)) {
      if (typeof response["description"] === "string" && response["description"].trim().length > 0) {
        spec.description = response["description"].trim()
      }
      const picked = pickContent(response["content"], ctx)
      if (picked !== undefined) {
        spec.contentType = picked.contentType
        spec.shape = UNSHAPED
        defer(picked.schema, (shape) => {
          spec.shape = shape
        })
      }
    }
    out.push(spec)
  }
  return out
}

const defaultStatusOf = (responses: ReadonlyArray<ResponseSpec>): number => {
  const exact = responses.find((r) => /^2\d\d$/.test(r.status))
  if (exact !== undefined) return Number(exact.status)
  if (responses.some((r) => r.status === "2XX")) return 200
  return 200
}
