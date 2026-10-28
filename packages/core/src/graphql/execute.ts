/**
 * Answers a GraphQL mock's endpoint. `resolve` handles the route like any other (forced
 * status, latency, error rate, rules, scenarios); when it answers normally, graphql-js
 * executes the query against the generated collections, persistent state included:
 * - root lists and `user(id:)` read the collection of their type, filtered by the arguments
 *   that match a field, paginated by `first` / `last` / `limit` / `offset` / `after`;
 * - a missing nested field is linked: `post.author` by `authorId`, `user.posts` by `userId`,
 *   else a deterministic pick; Relay connections are rebuilt from the collection;
 * - mutations `createX` / `updateX` / `deleteX` become state writes, returned to the caller.
 * A cost guard keeps a deep query from making the worker spin.
 */
import {
  buildSchema,
  executeSync,
  getNamedType,
  getNullableType,
  GraphQLError,
  isAbstractType,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  Kind,
  parse,
  specifiedRules,
  validate,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLFieldResolver,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  type GraphQLTypeResolver,
  type SelectionSetNode,
  type ValidationRule,
} from "graphql"
import { generateSync } from "../generation"
import type { Json, JsonObject, MockDefinition } from "../model"
import { resolve, type Behavior, type ResolveOptions, type ServingRequest, type ServingResult } from "../serving"
import { applyOp, freshId, idOf, isObject, type StateOp } from "../state"
import { titleFromName } from "../util/infer-schema"
import { own } from "../util/pointer"
import { internalRouteId } from "./schema"

const MAX_DEPTH = 10
const MAX_CALLS = 20_000
/** Any caller of the mock can send a query: its size bounds the parsing and the (quadratic) validation. */
const MAX_QUERY_LENGTH = 16 * 1024
const MAX_QUERY_TOKENS = 4000
const NESTED_LIST = 3
const PAGINATION = new Set(["first", "last", "after", "before", "limit", "offset", "skip", "take", "page", "perPage", "per_page", "pageSize", "orderBy", "order", "sort", "sortBy", "direction", "where", "filter", "input", "data"])

export interface GraphqlWrite {
  readonly source: string
  readonly op: StateOp
}

export interface GraphqlServingResult extends ServingResult {
  /** Writes made by mutations, to persist in the mock's state, in order. */
  readonly writes: ReadonlyArray<GraphqlWrite>
}

// ─── Schema cache ────────────────────────────────────────────────────────────

const cache = new Map<string, GraphQLSchema>()
const schemaFor = (sdl: string): GraphQLSchema => {
  const known = cache.get(sdl)
  if (known !== undefined) return known
  const schema = buildSchema(sdl, { assumeValidSDL: true })
  if (cache.size >= 20) cache.delete(cache.keys().next().value!)
  cache.set(sdl, schema)
  return schema
}

// ─── Execution context ───────────────────────────────────────────────────────

interface Context {
  readonly mock: MockDefinition
  readonly collections: Record<string, ReadonlyArray<Json>>
  readonly writes: Array<GraphqlWrite>
  readonly random: () => number
  readonly count: number | undefined
  calls: number
}

const itemsFor = (ctx: Context, schema: GraphQLSchema, type: GraphQLNamedType): ReadonlyArray<Json> => {
  if (isAbstractType(type)) return schema.getPossibleTypes(type).flatMap((t) => itemsFor(ctx, schema, t))
  return own(ctx.collections, type.name) ?? own(ctx.mock.data.collections, type.name) ?? []
}

const idArgument = (args: Readonly<Record<string, unknown>>): string | undefined => {
  for (const key of ["id", "ID", "uuid", "_id"]) {
    const value = args[key]
    if (typeof value === "string" || typeof value === "number") return String(value)
  }
  return undefined
}

/** Arguments that name a field of the items (`status: ACTIVE`, `authorId: 3`) filter them. */
const filtered = (items: ReadonlyArray<Json>, args: Readonly<Record<string, unknown>>): ReadonlyArray<Json> => {
  const conditions = Object.entries(args).filter(([key, value]) => !PAGINATION.has(key) && value !== undefined && value !== null && typeof value !== "object")
  if (conditions.length === 0) return items
  return items.filter((item) => isObject(item) && conditions.every(([key, value]) => !(key in item) || String(item[key]) === String(value)))
}

const asNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined)

/** `first` / `limit` / `take`, `offset` / `skip`, `after` (a cursor), `last`, and `x-loutre-count` on top. */
const paginate = (items: ReadonlyArray<Json>, args: Readonly<Record<string, unknown>>, count: number | undefined): { readonly page: ReadonlyArray<Json>; readonly start: number } => {
  let start = asNumber(args["offset"]) ?? asNumber(args["skip"]) ?? 0
  const page = asNumber(args["page"])
  const size = asNumber(args["first"]) ?? asNumber(args["limit"]) ?? asNumber(args["take"]) ?? asNumber(args["perPage"]) ?? asNumber(args["per_page"]) ?? asNumber(args["pageSize"])
  if (page !== undefined && size !== undefined && page > 0) start = (page - 1) * size
  if (typeof args["after"] === "string") {
    const index = items.findIndex((item, i) => cursorOf(item, i) === args["after"])
    if (index >= 0) start = index + 1
  }
  let slice = items.slice(start, size === undefined ? undefined : start + size)
  const last = asNumber(args["last"])
  if (last !== undefined) slice = slice.slice(Math.max(0, slice.length - last))
  if (count !== undefined) slice = slice.slice(0, count)
  return { page: slice, start }
}

const cursorOf = (item: Json, index: number): string => btoa(`cursor:${idOf(item) ?? index}`)

const connectionNode = (type: GraphQLNamedType): GraphQLNamedType | undefined => {
  if (!isObjectType(type) || !/Connection$/.test(type.name)) return undefined
  const edges = type.getFields()["edges"]
  if (edges === undefined) return undefined
  const edge = getNamedType(edges.type)
  if (!isObjectType(edge)) return undefined
  const node = edge.getFields()["node"]
  return node === undefined ? undefined : getNamedType(node.type)
}

const connection = (items: ReadonlyArray<Json>, args: Readonly<Record<string, unknown>>, count: number | undefined): JsonObject => {
  const { page, start } = paginate(items, args, count)
  const edges = page.map((node, i) => ({ node, cursor: cursorOf(node, start + i) }))
  return {
    edges,
    nodes: [...page],
    totalCount: items.length,
    pageInfo: {
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
  }
}

/** A stable choice for a source object and a field: same query, same answer. */
const hash = (text: string): number => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}
const pickFor = (source: JsonObject, field: string, items: ReadonlyArray<Json>): Json | null =>
  items.length === 0 ? null : items[hash(`${idOf(source) ?? JSON.stringify(source).slice(0, 64)}:${field}`) % items.length]!

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1)

// ─── Resolvers ───────────────────────────────────────────────────────────────

const generated = (ctx: Context, operation: "query" | "mutation", field: string): Json | null =>
  ctx.mock.data.bodies[internalRouteId(operation, field)]?.["200"] ?? null

const resolveQuery = (args: Readonly<Record<string, unknown>>, ctx: Context, info: GraphQLResolveInfo): unknown => {
  const named = getNamedType(info.returnType)
  const node = connectionNode(named)
  if (node !== undefined) return connection(filtered(itemsFor(ctx, info.schema, node), args), args, ctx.count)
  if (isObjectType(named) || isAbstractType(named)) {
    const items = filtered(itemsFor(ctx, info.schema, named), args)
    if (isListType(getNullableType(info.returnType))) return paginate(items, args, ctx.count).page
    const id = idArgument(args)
    if (id !== undefined) return items.find((item) => idOf(item) === id) ?? null
    return items[0] ?? generated(ctx, "query", info.fieldName)
  }
  return generated(ctx, "query", info.fieldName)
}

/**
 * The entity a mutation touches: its return type when it has an `id`, else the entity inside
 * a payload (`CreatePostPayload.post`). A payload has no id; an entity does.
 */
const hasId = (type: GraphQLObjectType): boolean => type.getFields()["id"] !== undefined
const entityOf = (type: GraphQLNamedType): { readonly type: GraphQLObjectType; readonly field: string | undefined } | undefined => {
  if (!isObjectType(type)) return undefined
  if (hasId(type)) return { type, field: undefined }
  for (const field of Object.values(type.getFields())) {
    const inner = getNamedType(field.type)
    if (isObjectType(inner) && hasId(inner)) return { type: inner, field: field.name }
  }
  return undefined
}

const VERB = /^(create|add|insert|new|register|post|save|submit|update|edit|modify|set|patch|replace|change|toggle|rename|publish|mark|delete|remove|destroy|archive|cancel|unpublish)([A-Z]\w*)$/

/** `deleteUser: Boolean!` says nothing by its type: the entity comes from the name (`User`, `Tag` for `removeTags`). */
const entityNamed = (schema: GraphQLSchema, field: string): GraphQLObjectType | undefined => {
  const match = VERB.exec(field)
  if (match === null) return undefined
  for (const candidate of [match[2]!, titleFromName(match[2]!)]) {
    const type = schema.getType(candidate)
    if (isObjectType(type) && hasId(type)) return type
  }
  return undefined
}

const inputOf = (args: Readonly<Record<string, unknown>>): JsonObject => {
  for (const key of ["input", "data", "record", "attributes", "patch", "changes"]) {
    const value = args[key]
    if (isPlainJson(value)) return value
  }
  return Object.fromEntries(Object.entries(args).filter(([key, value]) => !["id", "ID", "_id"].includes(key) && value !== undefined)) as JsonObject
}
const isPlainJson = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)

const write = (ctx: Context, source: string, items: ReadonlyArray<Json>, op: StateOp): Json | undefined => {
  const applied = applyOp(items, op, ctx.random)
  ctx.collections[source] = applied.items
  const persisted: StateOp = op.kind === "insert" && isObject(applied.body) ? { kind: "insert", item: applied.body } : op
  ctx.writes.push({ source, op: persisted })
  return applied.body
}

const resolveMutation = (args: Readonly<Record<string, unknown>>, ctx: Context, info: GraphQLResolveInfo): unknown => {
  const named = getNamedType(info.returnType)
  const byName = entityNamed(info.schema, info.fieldName)
  const entity = entityOf(named) ?? (byName === undefined ? undefined : { type: byName, field: undefined })
  if (entity === undefined) {
    if (isScalarType(named) && named.name === "Boolean") return true
    return generated(ctx, "mutation", info.fieldName)
  }
  const source = entity.type.name
  const items = itemsFor(ctx, info.schema, entity.type)
  const input = inputOf(args)
  const id = idArgument(args) ?? (typeof input["id"] === "string" || typeof input["id"] === "number" ? String(input["id"]) : undefined)
  const found = id === undefined ? undefined : items.find((item) => idOf(item) === id)
  let result: Json | null
  if (/^(delete|remove|destroy|archive|cancel|unpublish)/i.test(info.fieldName)) {
    if (found === undefined || id === undefined) throw notFound(source, id)
    write(ctx, source, items, { kind: "remove", id })
    result = found
  } else if (/^(update|edit|modify|set|patch|replace|change|toggle|rename|publish|mark)/i.test(info.fieldName)) {
    if (found === undefined || !isObject(found)) throw notFound(source, id)
    result = write(ctx, source, items, { kind: "upsert", item: { ...found, ...input, ...(id === undefined ? {} : { id: found["id"] ?? id }) } as JsonObject }) ?? found
  } else {
    // Anything else creates: a generated element as a template, what was sent on top, a fresh id.
    const template = items[Math.floor(ctx.random() * items.length)]
    const base: Record<string, Json> = isObject(template) ? { ...template } : {}
    // The id is set here: without it, the state would take the first `…Id` field (`authorId`) for one.
    const id = freshId(items, base["id"], ctx.random)
    result = write(ctx, source, items, { kind: "insert", item: { ...base, ...input, id, __typename: source } as JsonObject }) ?? null
  }
  if (isScalarType(named)) return named.name === "Boolean" ? true : idOf(result ?? null) ?? null
  if (entity.field !== undefined) return { [entity.field]: result, success: true, errors: [], userErrors: [] }
  return isListType(getNullableType(info.returnType)) ? [result] : result
}

const notFound = (source: string, id: string | undefined): GraphQLError =>
  new GraphQLError(id === undefined ? `Précisez l'identifiant du ${source} à modifier.` : `Aucun ${source} avec l'identifiant ${id}.`, { extensions: { code: "NOT_FOUND" } })

const fieldResolver: GraphQLFieldResolver<unknown, Context> = (source, args, ctx, info) => {
  if (++ctx.calls > MAX_CALLS) {
    if (ctx.calls === MAX_CALLS + 1) throw new GraphQLError(`Requête trop coûteuse : ${MAX_CALLS} champs résolus au plus.`, { extensions: { code: "QUERY_TOO_COMPLEX" } })
    return null
  }
  if (info.parentType === info.schema.getQueryType()) return resolveQuery(args, ctx, info)
  if (info.parentType === info.schema.getMutationType()) return resolveMutation(args, ctx, info)
  if (!isObject(source as Json)) return null
  const object = source as JsonObject
  const parent = info.parentType
  const named = getNamedType(info.returnType)
  const listy = isListType(getNullableType(info.returnType))

  // `post.authorId` follows the same link as `post.author`: the two always agree.
  const linkedBy = linkFieldOf(parent, info.fieldName)
  if (linkedBy !== undefined) return idOf(linkedOne(ctx, info.schema, object, parent, linkedBy) ?? null) ?? object[info.fieldName] ?? null

  const node = connectionNode(named)
  if (node !== undefined) {
    const value = object[info.fieldName]
    if (isObject(value) && Array.isArray(value["edges"])) return value
    return connection(linkedList(ctx, info.schema, object, parent, node, info.fieldName), args, ctx.count)
  }
  if (isObjectType(named) || isAbstractType(named)) {
    // An object field with its id beside it (`author` + `authorId`), a list pointed back at this
    // object (`user.posts` ← `post.author`): computed from the collections, never the generated copy.
    if (!listy && idFieldOf(parent, info.fieldName) !== undefined) return linkedOne(ctx, info.schema, object, parent, info.fieldName)
    if (listy && isObjectType(named) && backReference(named, parent) !== undefined) {
      return paginate(filtered(linkedList(ctx, info.schema, object, parent, named, info.fieldName), args), args, undefined).page
    }
    const value = object[info.fieldName]
    if (value !== undefined && value !== null) return listy && Array.isArray(value) && Object.keys(args).length > 0 ? paginate(filtered(value, args), args, undefined).page : value
    // Cut by the generator (a cycle) or absent: linked to the collections.
    if (value === null && !isNonNullType(info.returnType)) return null
    return listy ? paginate(filtered(linkedList(ctx, info.schema, object, parent, named, info.fieldName), args), args, undefined).page : linkedOne(ctx, info.schema, object, parent, info.fieldName)
  }
  const value = object[info.fieldName]
  if (value === undefined) return null
  if (isEnumType(named) && typeof value === "string" && named.getValue(value) === undefined) return named.getValues()[0]?.value ?? null
  return value
}

/** `authorId` beside `author: User`: the name of the object field this id stands for. */
const linkFieldOf = (parent: GraphQLObjectType, field: string): string | undefined => {
  const match = /^(.+?)(Id|_id)$/.exec(field)
  if (match === null) return undefined
  const target = parent.getFields()[match[1]!]
  return target !== undefined && isObjectType(getNamedType(target.type)) ? match[1] : undefined
}

/** The id field beside an object field: `author` → `authorId` (or `author_id`). */
const idFieldOf = (parent: GraphQLObjectType, field: string): string | undefined =>
  [`${field}Id`, `${field}_id`].find((key) => parent.getFields()[key] !== undefined)

/** The element an object field points to: by its id when it names a real one, else a stable pick. */
const linkedOne = (ctx: Context, schema: GraphQLSchema, source: JsonObject, parent: GraphQLObjectType, field: string): Json | null => {
  const definition = parent.getFields()[field]
  if (definition === undefined) return null
  const items = itemsFor(ctx, schema, getNamedType(definition.type))
  const key = idFieldOf(parent, field)
  const foreign = key === undefined ? undefined : source[key]
  if (typeof foreign === "string" || typeof foreign === "number") {
    const found = items.find((item) => idOf(item) === String(foreign))
    if (found !== undefined) return found
  }
  return pickFor(source, field, items)
}

/** The field of `item` that points back to `parent` (`Post.author: User` for `User.posts`). */
const backReference = (item: GraphQLObjectType, parent: GraphQLObjectType): string | undefined =>
  Object.values(item.getFields()).find((field) => getNamedType(field.type) === parent && !isListType(getNullableType(field.type)))?.name

/** `user.posts`: the posts whose `author` is this user; without such a link, a few, always the same. */
const linkedList = (ctx: Context, schema: GraphQLSchema, source: JsonObject, parent: GraphQLObjectType, type: GraphQLNamedType, field: string): ReadonlyArray<Json> => {
  const items = itemsFor(ctx, schema, type)
  const id = idOf(source)
  if (id !== undefined && isObjectType(type)) {
    const back = backReference(type, parent)
    if (back !== undefined) return items.filter((item) => isObject(item) && idOf(linkedOne(ctx, schema, item, type, back) ?? null) === id)
    const keys = [`${lowerFirst(parent.name)}Id`, `${lowerFirst(parent.name)}_id`]
    const pointing = items.filter((item) => isObject(item) && keys.some((key) => item[key] !== undefined && String(item[key]) === id))
    if (pointing.length > 0) return pointing
  }
  if (items.length === 0) return []
  const start = hash(`${id ?? ""}:${field}`) % items.length
  return Array.from({ length: Math.min(NESTED_LIST, items.length) }, (_, i) => items[(start + i) % items.length]!)
}

const typeResolver: GraphQLTypeResolver<unknown, Context> = (value, ctx, info, abstractType) => {
  if (isObject(value as Json)) {
    const object = value as JsonObject
    if (typeof object["__typename"] === "string") return object["__typename"]
    const possible = info.schema.getPossibleTypes(abstractType)
    const owner = possible.find((type) => (own(ctx.collections, type.name) ?? own(ctx.mock.data.collections, type.name) ?? []).includes(object))
    if (owner !== undefined) return owner.name
    const keys = Object.keys(object)
    return (possible.find((type) => keys.every((key) => key in type.getFields())) ?? possible[0])?.name
  }
  return undefined
}

/** Depth of a selection, fragments followed (a fragment on the current path counts once: cycles are another rule's job). */
const selectionDepth = (selection: SelectionSetNode, fragments: ReadonlyMap<string, FragmentDefinitionNode>, path: ReadonlySet<string>): number => {
  let deepest = 0
  for (const node of selection.selections) {
    if (node.kind === Kind.FIELD) {
      deepest = Math.max(deepest, node.selectionSet === undefined ? 1 : 1 + selectionDepth(node.selectionSet, fragments, path))
    } else if (node.kind === Kind.INLINE_FRAGMENT) {
      deepest = Math.max(deepest, selectionDepth(node.selectionSet, fragments, path))
    } else {
      const fragment = fragments.get(node.name.value)
      if (fragment === undefined || path.has(fragment.name.value)) continue
      deepest = Math.max(deepest, selectionDepth(fragment.selectionSet, fragments, new Set([...path, fragment.name.value])))
    }
    if (deepest > MAX_DEPTH) return deepest
  }
  return deepest
}

const depthLimit: ValidationRule = (context) => ({
  OperationDefinition(node) {
    const fragments = new Map<string, FragmentDefinitionNode>()
    for (const definition of context.getDocument().definitions) if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition)
    if (selectionDepth(node.selectionSet, fragments, new Set()) > MAX_DEPTH) {
      context.reportError(new GraphQLError(`Requête trop profonde : ${MAX_DEPTH} niveaux au plus.`, { nodes: node }))
    }
  },
})

// ─── HTTP ────────────────────────────────────────────────────────────────────

interface GraphqlRequest {
  readonly query: string | undefined
  readonly variables: Readonly<Record<string, unknown>> | undefined
  readonly operationName: string | undefined
}

const readRequest = (request: ServingRequest): GraphqlRequest => {
  if (request.method.toUpperCase() === "GET") {
    const raw = request.query?.["variables"]
    let variables: Record<string, unknown> | undefined
    try {
      variables = raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>)
    } catch {
      variables = undefined
    }
    return { query: request.query?.["query"], variables, operationName: request.query?.["operationName"] }
  }
  const body = request.body
  if (typeof body === "string") return { query: body, variables: undefined, operationName: undefined }
  if (!isObject(body)) return { query: undefined, variables: undefined, operationName: undefined }
  return {
    query: typeof body["query"] === "string" ? body["query"] : undefined,
    variables: isObject(body["variables"]) ? (body["variables"] as Record<string, unknown>) : undefined,
    operationName: typeof body["operationName"] === "string" ? body["operationName"] : undefined,
  }
}

const errorBody = (message: string, code: string, status?: number): JsonObject => ({
  data: null,
  errors: [{ message, extensions: { code, ...(status === undefined ? {} : { status }) } }],
})

const CODES: Readonly<Record<number, string>> = { 400: "BAD_REQUEST", 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 422: "BAD_USER_INPUT", 429: "RATE_LIMITED" }

export type GraphqlOptions = ResolveOptions

/** Executes a query against a mock, without going through `resolve`: tests and the CLI's inspector. */
export const executeGraphql = (
  mock: MockDefinition,
  request: GraphqlRequest,
  options: { readonly collections?: Readonly<Record<string, ReadonlyArray<Json>>> | undefined; readonly random?: (() => number) | undefined; readonly count?: number | undefined } = {},
): { readonly status: number; readonly body: JsonObject; readonly writes: ReadonlyArray<GraphqlWrite> } => {
  const sdl = mock.table.graphql?.sdl
  if (sdl === undefined) return { status: 400, body: errorBody("Ce mock n'est pas un mock GraphQL.", "BAD_REQUEST"), writes: [] }
  if (request.query === undefined || request.query.trim().length === 0) {
    return { status: 400, body: errorBody("Envoyez une requête GraphQL : { \"query\": \"{ … }\" }.", "BAD_REQUEST"), writes: [] }
  }
  if (request.query.length > MAX_QUERY_LENGTH) {
    return { status: 413, body: errorBody(`Requête GraphQL trop longue : ${MAX_QUERY_LENGTH / 1024} Ko au plus.`, "BAD_REQUEST", 413), writes: [] }
  }
  const schema = schemaFor(sdl)
  let document: DocumentNode
  try {
    document = parse(request.query, { maxTokens: MAX_QUERY_TOKENS })
  } catch (cause) {
    const message = cause instanceof GraphQLError ? cause.message : String(cause)
    return { status: 400, body: errorBody(`Requête GraphQL invalide : ${message}`, "GRAPHQL_PARSE_FAILED"), writes: [] }
  }
  const invalid = validate(schema, document, [...specifiedRules, depthLimit])
  if (invalid.length > 0) return { status: 400, body: { data: null, errors: invalid.map((error) => error.toJSON() as unknown as Json) }, writes: [] }
  const ctx: Context = {
    mock,
    collections: { ...(options.collections ?? {}) },
    writes: [],
    random: options.random ?? Math.random,
    count: options.count,
    calls: 0,
  }
  const result = executeSync({ schema, document, contextValue: ctx, variableValues: request.variables ?? null, operationName: request.operationName ?? null, fieldResolver, typeResolver })
  const body: Record<string, Json> = { data: (result.data ?? null) as Json }
  if (result.errors !== undefined && result.errors.length > 0) body["errors"] = result.errors.map((error) => error.toJSON() as unknown as Json)
  return { status: 200, body, writes: ctx.writes }
}

/**
 * The endpoint of a GraphQL mock, as served on loutre.run and by the CLI. `resolve` decides the
 * status, the latency and any hand-written body; a normal answer is the query's execution.
 */
export const answerGraphql = (mock: MockDefinition, behavior: Behavior, request: ServingRequest, options: GraphqlOptions = {}): GraphqlServingResult => {
  const spec = mock.table.graphql
  const served = behavior.graphqlPath ?? spec?.path ?? "/graphql"
  if (spec === undefined || request.pathname !== served) {
    return { kind: "not-found", status: 404, body: errorBody(`Ce mock GraphQL répond sur ${served} : POST avec { "query": … }, ou GET ?query=… pour une lecture.`, "NOT_FOUND"), delayMs: 0, headers: {}, route: undefined, writes: [] }
  }
  const verb = request.method.toUpperCase()
  if (verb !== "GET" && verb !== "POST") {
    return { kind: "method-not-allowed", status: 405, body: errorBody(`${verb} n'est pas accepté : POST pour tout, GET pour les lectures.`, "METHOD_NOT_ALLOWED", 405), delayMs: 0, headers: { allow: "GET, POST" }, route: undefined, writes: [] }
  }
  // GET and POST share the settings of `POST /graphql`: one endpoint, one set of settings.
  const routed = resolve(mock, behavior, { ...request, method: "POST", pathname: spec.path }, { ...options, collections: undefined })
  // A hand-written body (rule, response set by hand) is served as written.
  if (routed.kind === "rule" || routed.kind === "custom-body") return { ...routed, writes: [] }
  if (routed.status >= 400) {
    const message = isObject(routed.body) && typeof routed.body["message"] === "string" ? routed.body["message"] : `Erreur ${routed.status}`
    return { ...routed, body: errorBody(message, CODES[routed.status] ?? (routed.status >= 500 ? "INTERNAL_SERVER_ERROR" : "BAD_REQUEST"), routed.status), writes: [] }
  }
  const graphqlRequest = readRequest(request)
  if (request.method.toUpperCase() === "GET" && graphqlRequest.query !== undefined && /^\s*mutation\b/.test(graphqlRequest.query)) {
    return { ...routed, status: 405, body: errorBody("Une mutation passe par POST, pas par GET.", "METHOD_NOT_ALLOWED", 405), writes: [] }
  }
  // `x-loutre-seed`: another generated universe for this call, without the writes.
  const seed = request.headers["x-loutre-seed"]?.trim()
  const effective = seed !== undefined && seed.length > 0 ? { ...mock, data: generateSync(mock.table, { seed: seed.slice(0, 64), vocabulary: options.vocabulary }) } : mock
  const rawCount = request.headers["x-loutre-count"]
  const count = rawCount !== undefined && /^\d+$/.test(rawCount.trim()) ? Math.min(Number(rawCount.trim()), 200) : undefined
  const executed = executeGraphql(effective, graphqlRequest, {
    collections: effective === mock ? options.collections : undefined,
    random: options.random,
    count,
  })
  return { ...routed, status: executed.status, body: executed.body, writes: effective === mock ? executed.writes : [] }
}
