/**
 * Pure serving: derives a response from a mock definition and a request.
 * No I/O here; the worker (and later the CLI) only adapt this to HTTP.
 */
import type { Json, JsonObject, MockDefinition, Route } from "./model"
import { generateSync, type Vocabulary } from "./generation"
import { errorTextFor } from "./generation/pools"
import { collectionFor, COUNTER_KEYS, hasPathParam, LIST_KEYS, listKeyFor, replaceItems } from "./state"
import { own } from "./util/pointer"

// ─── Route matching ──────────────────────────────────────────────────────────

export interface RouteMatch {
  readonly route: Route
  readonly params: Readonly<Record<string, string>>
}

const segmentsOf = (path: string): Array<string> => path.split("/").filter((s) => s.length > 0)

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const matchPath = (template: string, pathname: string): Record<string, string> | undefined => {
  const expected = segmentsOf(template)
  const actual = segmentsOf(pathname)
  if (expected.length !== actual.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < expected.length; i++) {
    const segment = expected[i]!
    const value = actual[i]!
    // A segment can mix text and parameters: "v{version}", "{a}-{b}", "file.{ext}".
    const parts = segment.split(/\{([^}]+)\}/)
    if (parts.length === 1) {
      if (segment !== value) return undefined
      continue
    }
    const captured = matchSegment(parts, value)
    if (captured === undefined) return undefined
    captured.forEach((raw, index) => {
      params[parts[2 * index + 1]!] = decode(raw)
    })
  }
  return params
}

/** Past this length (or this many parameters), a segment with several parameters matches nothing: the search below is quadratic. */
const MAX_MULTI_PARAM_SEGMENT = 128
const MAX_SEGMENT_PARAMS = 8

/**
 * `[literal, name, literal, name, …, literal]` against one segment of the request, as the regex
 * `^literal([^/]+)literal…$` would match it (greedy, with backtracking), without the regex's exponential worst case
 * on `{a}{b}{c}…`: each (parameter, position) that failed once is never tried again.
 */
const matchSegment = (parts: ReadonlyArray<string>, value: string): Array<string> | undefined => {
  const count = (parts.length - 1) / 2
  const first = parts[0]!
  if (!value.startsWith(first)) return undefined
  if (count > 1 && (value.length > MAX_MULTI_PARAM_SEGMENT || count > MAX_SEGMENT_PARAMS)) return undefined
  const captured: Array<string> = []
  const failed = new Set<number>()
  const solve = (index: number, pos: number): boolean => {
    const literal = parts[2 * index + 2]!
    if (index === count - 1) {
      const end = value.length - literal.length
      if (end <= pos || !value.endsWith(literal)) return false
      captured[index] = value.slice(pos, end)
      return true
    }
    const key = index * (value.length + 1) + pos
    if (failed.has(key)) return false
    for (let end = value.length - 1; end > pos; end--) {
      if (value.startsWith(literal, end) && solve(index + 1, end + literal.length)) {
        captured[index] = value.slice(pos, end)
        return true
      }
    }
    failed.add(key)
    return false
  }
  return solve(0, first.length) ? captured : undefined
}

const staticSegments = (route: Route): number => segmentsOf(route.path).filter((s) => !s.includes("{")).length

/** Most specific route for a method and pathname. */
export const matchRoute = (routes: ReadonlyArray<Route>, method: string, pathname: string): RouteMatch | undefined => {
  const wanted = method.toLowerCase()
  let best: RouteMatch | undefined
  let bestScore = -1
  for (const route of routes) {
    if (route.method !== wanted && !(wanted === "head" && route.method === "get")) continue
    const params = matchPath(route.path, pathname)
    if (params === undefined) continue
    const score = staticSegments(route)
    if (score > bestScore) {
      best = { route, params }
      bestScore = score
    }
  }
  // A QUERY operation also answers POST when the path has none: not every client sends QUERY yet.
  if (best === undefined && wanted === "post") return matchRoute(routes, "query", pathname)
  return best
}

/** Documented methods for a pathname, to answer 405 properly. */
export const allowedMethods = (routes: ReadonlyArray<Route>, pathname: string): Array<string> => {
  const methods = new Set<string>()
  for (const route of routes) {
    if (matchPath(route.path, pathname) !== undefined) methods.add(route.method.toUpperCase())
  }
  return [...methods]
}

// ─── Behaviour ───────────────────────────────────────────────────────────────

/**
 * Rule conditions, all of which must hold; a rule with no condition never applies.
 * Header names are case-insensitive; body fields are dotted paths, and a string also matches a number.
 */
export interface RuleConditions {
  readonly query?: Readonly<Record<string, string>> | undefined
  readonly header?: Readonly<Record<string, string>> | undefined
  readonly param?: Readonly<Record<string, string>> | undefined
  readonly body?: Readonly<Record<string, Json>> | undefined
}

/** Conditional response: the first rule whose conditions match sets status, body and latency. */
export interface ResponseRule {
  readonly name?: string | undefined
  readonly when: RuleConditions
  readonly status?: number | undefined
  readonly body?: Json | undefined
  readonly latencyMs?: number | undefined
}

export const MAX_RULES = 20

export interface RouteBehavior {
  readonly status?: number | undefined
  readonly latencyMs?: number | undefined
  /** Share of requests that fail, from 0 to 1. */
  readonly errorRate?: number | undefined
  /** Hand-written bodies by status ("404" → JSON), which win over generated ones. */
  readonly bodies?: Readonly<Record<string, Json>> | undefined
  readonly rules?: ReadonlyArray<ResponseRule> | undefined
}

export interface Behavior extends RouteBehavior {
  /** Random latency variation, ±30% by default. */
  readonly jitter?: number | undefined
  readonly routes?: Readonly<Record<string, RouteBehavior>> | undefined
  /** Writes (POST, PUT, PATCH, DELETE) alter the collections served afterwards. True by default. */
  readonly stateful?: boolean | undefined
  /** Base URL of a real backend: routes the schema does not describe are forwarded there (partial mock). */
  readonly proxy?: string | undefined
  /** Named overlays of settings, applied with `x-loutre-scenario: <name>` or when `activeScenario` names one. */
  readonly scenarios?: Readonly<Record<string, Scenario>> | undefined
  readonly activeScenario?: string | undefined
  /** Where a GraphQL mock serves its endpoint, `/graphql` by default (Pro). */
  readonly graphqlPath?: string | undefined
}

/** A scenario is a bundle of settings that replaces the defaults while it applies. */
export interface Scenario extends RouteBehavior {
  readonly jitter?: number | undefined
  readonly routes?: Readonly<Record<string, RouteBehavior>> | undefined
}

export const HEADER_SCENARIO = "x-loutre-scenario"
export const MAX_SCENARIOS = 20

/** The behaviour once a scenario is laid over it: scalar settings replaced, per-route settings merged route by route. */
export const applyScenario = (behavior: Behavior, name: string | undefined): { readonly behavior: Behavior; readonly applied: string | undefined } => {
  if (name === undefined) return { behavior, applied: undefined }
  const scenario = behavior.scenarios?.[name]
  if (scenario === undefined) return { behavior, applied: undefined }
  const routes: Record<string, RouteBehavior> = { ...(behavior.routes ?? {}) }
  for (const [id, override] of Object.entries(scenario.routes ?? {})) {
    const base = routes[id] ?? {}
    routes[id] = { ...base, ...override, bodies: override.bodies === undefined ? base.bodies : { ...(base.bodies ?? {}), ...override.bodies } }
  }
  const { routes: _ignored, ...scalars } = scenario
  return { behavior: { ...behavior, ...scalars, routes }, applied: name }
}

export const DEFAULT_BEHAVIOR: Behavior = { latencyMs: 0, jitter: 0.3, errorRate: 0 }

export const HEADER_STATUS = "x-loutre-status"
export const HEADER_DELAY = "x-loutre-delay"
/** Size of the returned list (0 for the empty state). */
export const HEADER_COUNT = "x-loutre-count"
/** Message of an error response. */
export const HEADER_MESSAGE = "x-loutre-message"
/** Another variant of the data, regenerated with this seed, without any AI call. */
export const HEADER_SEED = "x-loutre-seed"
export const MAX_DELAY_MS = 30_000
export const MAX_COUNT = 500

// ─── Resolution ──────────────────────────────────────────────────────────────

export interface ServingRequest {
  readonly method: string
  readonly pathname: string
  /** Lowercased header names. */
  readonly headers: Readonly<Record<string, string>>
  /** Query string, first value of each key. */
  readonly query?: Readonly<Record<string, string>> | undefined
  readonly body?: Json | undefined
}

export type ServingKind = "ok" | "not-found" | "method-not-allowed" | "forced-error" | "forced-status" | "custom-body" | "rule"

export interface ServingResult {
  readonly kind: ServingKind
  readonly status: number
  readonly body: Json | undefined
  readonly delayMs: number
  readonly headers: Readonly<Record<string, string>>
  readonly route: Route | undefined
}

export interface ResolveOptions {
  readonly random?: (() => number) | undefined
  /** The mock's vocabulary, so `x-loutre-seed` regenerates within the same universe. */
  readonly vocabulary?: Vocabulary | undefined
  /** Collections altered by writes (persistent state); they replace the generated ones, by name. */
  readonly collections?: Readonly<Record<string, ReadonlyArray<Json>>> | undefined
}

// ─── Rules ───────────────────────────────────────────────────────────────────

const pathValue = (body: Json | undefined, path: string): Json | undefined => {
  let current: Json | undefined = body
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment)
      current = Number.isInteger(index) ? current[index] : undefined
    } else if (isObject(current)) {
      current = own(current, segment)
    } else {
      return undefined
    }
    if (current === undefined) return undefined
  }
  return current
}

const ruleMatches = (when: RuleConditions, request: ServingRequest, params: Readonly<Record<string, string>>): boolean => {
  let conditions = 0
  for (const [key, expected] of Object.entries(when.query ?? {})) {
    conditions++
    if (own(request.query, key) !== expected) return false
  }
  for (const [key, expected] of Object.entries(when.header ?? {})) {
    conditions++
    if (own(request.headers, key.toLowerCase())?.trim() !== expected) return false
  }
  for (const [key, expected] of Object.entries(when.param ?? {})) {
    conditions++
    if (own(params, key) !== expected) return false
  }
  for (const [path, expected] of Object.entries(when.body ?? {})) {
    conditions++
    const actual = pathValue(request.body, path)
    if (actual === undefined) return false
    if (typeof expected === "string" && typeof actual !== "string") {
      if (String(actual) !== expected) return false
    } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return false
    }
  }
  return conditions > 0
}

/** First rule applicable to this request. */
export const matchRule = (
  rules: ReadonlyArray<ResponseRule> | undefined,
  request: ServingRequest,
  params: Readonly<Record<string, string>>,
): ResponseRule | undefined => rules?.find((rule) => ruleMatches(rule.when, request, params))

const withCollection = (mock: MockDefinition, source: string, items: ReadonlyArray<Json>): MockDefinition => ({
  ...mock,
  data: { ...mock.data, collections: { ...mock.data.collections, [source]: items } },
})

export const resolve = (
  mock: MockDefinition,
  baseBehavior: Behavior,
  request: ServingRequest,
  options: ResolveOptions = {},
): ServingResult => {
  const random = options.random ?? Math.random
  const requested = request.headers[HEADER_SCENARIO]?.trim()
  const scenario = applyScenario(baseBehavior, requested !== undefined && requested.length > 0 ? requested : baseBehavior.activeScenario)
  const behavior = scenario.behavior
  const scenarioHeaders: Record<string, string> = scenario.applied === undefined ? {} : { [HEADER_SCENARIO]: scenario.applied }
  const routes = mock.table.routes
  const match = matchRoute(routes, request.method, request.pathname)
  if (match === undefined) {
    const allowed = allowedMethods(routes, request.pathname)
    if (allowed.length > 0) {
      return {
        kind: "method-not-allowed",
        status: 405,
        body: {
          error: "method_not_allowed",
          message: `${request.method.toUpperCase()} n'est pas documenté sur ${request.pathname}.`,
          allowed,
        },
        delayMs: 0,
        headers: { allow: allowed.join(", ") },
        route: undefined,
      }
    }
    return {
      kind: "not-found",
      status: 404,
      body: {
        error: "not_found",
        message: `Aucune route ne correspond à ${request.method.toUpperCase()} ${request.pathname}.`,
        routes: routes.map((r) => `${r.method.toUpperCase()} ${r.path}`),
      },
      delayMs: 0,
      headers: {},
      route: undefined,
    }
  }

  const { route, params } = match
  const routeBehavior = behavior.routes?.[route.id]
  const rule = matchRule(routeBehavior?.rules, request, params)
  const forcedByHeader = parseStatus(request.headers[HEADER_STATUS])
  let kind: ServingKind = "ok"
  let status = route.defaultStatus
  if (forcedByHeader !== undefined) {
    status = forcedByHeader
    kind = "forced-status"
  } else if (rule?.status !== undefined) {
    status = rule.status
    kind = "rule"
  } else if (routeBehavior?.status !== undefined) {
    status = routeBehavior.status
    kind = "forced-status"
  } else if (behavior.status !== undefined) {
    status = behavior.status
    kind = "forced-status"
  } else {
    const errorRate = routeBehavior?.errorRate ?? behavior.errorRate ?? 0
    if (errorRate > 0 && random() < errorRate) {
      status = documentedErrorStatus(route) ?? 500
      kind = "forced-error"
    }
  }

  // Persistent state: the written collection replaces the generated one, for list and detail alike,
  // except under `x-loutre-seed`, which serves another generated variant without the writes.
  const source = collectionFor(mock, route)
  const seedHeader = request.headers[HEADER_SEED]
  const stateItems = source === undefined || (seedHeader !== undefined && seedHeader.trim().length > 0) ? undefined : own(options.collections, source)
  const effective = source !== undefined && stateItems !== undefined ? withCollection(mock, source, stateItems) : mock

  const ruleBody = rule !== undefined && rule.body !== undefined && (rule.status === undefined || rule.status === status) ? rule.body : undefined
  const custom = routeBehavior?.bodies?.[String(status)]
  let body: Json | undefined
  if (ruleBody !== undefined) {
    body = ruleBody
    if (kind === "ok") kind = "rule"
  } else if (custom !== undefined) {
    body = custom
    if (kind === "ok") kind = "custom-body"
  } else if (
    source !== undefined &&
    stateItems !== undefined &&
    status < 300 &&
    route.method !== "post" &&
    hasPathParam(route) &&
    lookup(effective, source, route, params) === undefined
  ) {
    // Under persistent state, an unknown (or deleted) id genuinely does not exist.
    status = 404
    kind = "not-found"
    body = bodyFor(effective, route, 404, params, request)
  } else {
    const seeded = seededBody(effective, route, status, request.headers[HEADER_SEED], options.vocabulary)
    const base = seeded === undefined ? effective : source !== undefined && stateItems !== undefined ? withCollection(seeded, source, stateItems) : seeded
    body = bodyFor(base, route, status, params, request)
    if (source !== undefined && stateItems !== undefined && status < 300 && body !== undefined) {
      const key = listKeyFor(route, source)
      if (key !== undefined) body = replaceItems(body, stateItems, key)
    }
  }
  body = withMessage(body, status, request.headers[HEADER_MESSAGE])
  body = withCount(body, request.headers[HEADER_COUNT])
  const delayMs = delayFor(request, rule, routeBehavior, behavior, random)
  return { kind, status, body, delayMs, headers: scenarioHeaders, route }
}

/** Any caller can send `x-loutre-seed`: a variant is generated on a tighter budget than the mock itself. */
const SEEDED_MAX_VALUES = 20_000

/** `x-loutre-seed`: this route's bodies regenerated with the requested seed, in an ephemeral definition. */
const seededBody = (
  mock: MockDefinition,
  route: Route,
  status: number,
  seed: string | undefined,
  vocabulary: Vocabulary | undefined,
): MockDefinition | undefined => {
  if (seed === undefined || seed.trim().length === 0) return undefined
  const data = generateSync(mock.table, { seed: seed.trim().slice(0, 64), only: [route.id], vocabulary, maxValues: SEEDED_MAX_VALUES })
  if (data.bodies[route.id]?.[String(status)] === undefined && !(status >= 400)) return undefined
  return { ...mock, data: { ...mock.data, bodies: { ...mock.data.bodies, ...data.bodies }, collections: { ...mock.data.collections, ...data.collections } } }
}

/** In a generic error body, numeric `code` / `status` fields and the message follow the served status. */
const withStatusNumber = (body: Json, status: number): Json => {
  if (!isObject(body)) return body
  const patched: Record<string, Json> = { ...body }
  for (const key of ["code", "status", "statusCode", "status_code"]) {
    const value = patched[key]
    if (typeof value === "number" && value >= 100 && value <= 599) patched[key] = status
  }
  if (typeof patched["message"] === "string" && status >= 400) {
    const generic = errorTextFor(status)
    patched["message"] = generic.message
  }
  return patched
}

/** `x-loutre-message` on an error: replaces (or adds) the body's message field. */
const withMessage = (body: Json | undefined, status: number, message: string | undefined): Json | undefined => {
  if (message === undefined || status < 400) return body
  const text = message.trim().slice(0, 500)
  if (text.length === 0) return body
  if (isObject(body)) {
    const key = ["message", "error_description", "detail", "title", "error"].find((k) => typeof body[k] === "string") ?? "message"
    return { ...body, [key]: text }
  }
  return { error: errorTextFor(status).code, message: text, status }
}

/** `x-loutre-count` on a list: truncates it (0 → empty state), wrapped lists (`data`, `items`…) included. */
const withCount = (body: Json | undefined, raw: string | undefined): Json | undefined => {
  if (raw === undefined) return body
  const count = Number(raw.trim())
  if (!Number.isInteger(count) || count < 0) return body
  const n = Math.min(count, MAX_COUNT)
  if (Array.isArray(body)) return body.slice(0, n)
  if (isObject(body)) {
    const key = LIST_KEYS.find((k) => Array.isArray(body[k]))
    if (key !== undefined) {
      const items = (body[key] as ReadonlyArray<Json>).slice(0, n)
      const patched: Record<string, Json> = { ...body, [key]: items }
      for (const counter of COUNTER_KEYS) {
        if (typeof patched[counter] === "number") patched[counter] = items.length
      }
      if (typeof patched["has_more"] === "boolean") patched["has_more"] = false
      return patched
    }
  }
  return body
}

const parseStatus = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number(raw.trim())
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined
}

const documentedErrorStatus = (route: Route): number | undefined => {
  const five = route.responses.find((r) => /^5\d\d$/.test(r.status))
  if (five !== undefined) return Number(five.status)
  const four = route.responses.find((r) => /^(4\d\d)$/.test(r.status) && r.status !== "404")
  return four === undefined ? undefined : Number(four.status)
}

const delayFor = (
  request: ServingRequest,
  rule: ResponseRule | undefined,
  routeBehavior: RouteBehavior | undefined,
  behavior: Behavior,
  random: () => number,
): number => {
  const header = request.headers[HEADER_DELAY]
  if (header !== undefined) {
    const n = Number(header.trim())
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.round(n), MAX_DELAY_MS)
  }
  const base = rule?.latencyMs ?? routeBehavior?.latencyMs ?? behavior.latencyMs ?? 0
  if (base <= 0) return 0
  const jitter = behavior.jitter ?? DEFAULT_BEHAVIOR.jitter ?? 0
  const factor = 1 + (random() * 2 - 1) * jitter
  return Math.min(Math.max(0, Math.round(base * factor)), MAX_DELAY_MS)
}

const isObject = (u: Json | undefined): u is JsonObject => typeof u === "object" && u !== null && !Array.isArray(u)

const ID_PARAM = /(^id$|_id$|Id$|^uuid$|_uuid$|Uuid$)/

const bodyFor = (
  mock: MockDefinition,
  route: Route,
  status: number,
  params: Readonly<Record<string, string>>,
  request: ServingRequest,
): Json | undefined => {
  const perStatus = mock.data.bodies[route.id] ?? {}
  const key = String(status)
  let body: Json | undefined = perStatus[key]
  if (body === undefined) {
    // Documented generic body ("4XX", "default"): make it carry the status actually served.
    const fallback = perStatus[`${key[0]}XX`] ?? (status >= 400 ? perStatus["DEFAULT"] : undefined)
    if (fallback !== undefined) body = withStatusNumber(fallback, status)
  }
  if (body === undefined) {
    if (status >= 400) {
      const text = errorTextFor(status)
      return { error: text.code, message: text.message, status }
    }
    return undefined
  }
  if (status >= 400) return body

  // Detail by id: `/pets/3` returns pet 3 from the collection.
  const source = mock.data.sources[route.id]
  if (source !== undefined && isObject(body)) {
    const found = lookup(mock, source, route, params)
    if (found !== undefined) body = found
    else body = withRequestedId(body, route, params)
  }

  // Create / update: echo what was sent, completed by the generated body.
  const method = route.method
  if ((method === "post" || method === "put" || method === "patch") && isObject(body) && isObject(request.body)) {
    const merged: Record<string, Json> = { ...body, ...request.body }
    if ("id" in body) merged["id"] = body["id"]!
    body = merged
  }
  return body
}

const lookup = (
  mock: MockDefinition,
  source: string,
  route: Route,
  params: Readonly<Record<string, string>>,
): Json | undefined => {
  const items = own(mock.data.collections, source)
  if (items === undefined) return undefined
  for (const parameter of route.parameters) {
    if (parameter.in !== "path") continue
    const value = params[parameter.name]
    if (value === undefined) continue
    const fields = ID_PARAM.test(parameter.name) ? ["id", "uuid", parameter.name] : [parameter.name, "id"]
    for (const item of items) {
      if (!isObject(item)) continue
      for (const field of fields) {
        const candidate = item[field]
        if (candidate !== undefined && candidate !== null && String(candidate) === value) return item
      }
    }
  }
  return undefined
}

const withRequestedId = (body: JsonObject, route: Route, params: Readonly<Record<string, string>>): JsonObject => {
  const parameter = route.parameters.find((p) => p.in === "path" && ID_PARAM.test(p.name))
  if (parameter === undefined) return body
  const value = params[parameter.name]
  if (value === undefined || !("id" in body)) return body
  const current = body["id"]
  if (typeof current === "number") {
    const n = Number(value)
    return Number.isFinite(n) ? { ...body, id: n } : body
  }
  if (typeof current === "string") return { ...body, id: value }
  return body
}
