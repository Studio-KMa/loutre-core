/**
 * A GraphQL schema (SDL, or an introspection result) as a mock. graphql-js reads it; every
 * object type becomes a component the generator fills like any other, and every root field
 * an internal route (`GET /__graphql/query/users`, `POST /__graphql/mutation/createUser`)
 * so that its answer is generated too. The endpoint itself is a table route, `POST /graphql`
 * (and `GET` for queries): status, latency, rules and scenarios apply to it as to any route,
 * and `execute.ts` answers it from the generated collections.
 */
import {
  buildClientSchema,
  buildSchema,
  getNamedType,
  GraphQLError,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  printSchema,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql"
import type { Diagnostic } from "../diagnostic"
import type { Json, JsonObject } from "../model"
import { isPlainObject } from "../util/pointer"

/** The table route of the endpoint; each mock may serve it elsewhere (`behavior.graphqlPath`, Pro). */
export const GRAPHQL_PATH = "/graphql"
/** Internal routes, one per root field: generated, never served. */
export const INTERNAL_PREFIX = "/__graphql/"

export const internalRouteId = (operation: "query" | "mutation", field: string): string =>
  `${operation === "query" ? "get" : "post"}:${INTERNAL_PREFIX}${operation}/${field}`

export type GraphqlSchemaResult = { readonly ok: true; readonly schema: GraphQLSchema } | { readonly ok: false; readonly error: Diagnostic }

const failure = (message: string, suggestions: ReadonlyArray<string> = []): { readonly ok: false; readonly error: Diagnostic } => ({
  ok: false,
  error: { stage: "ingestion", message, pointer: undefined, suggestions },
})

/** SDL, or an introspection result (`{ data: { __schema } }` or `{ __schema }`), as a GraphQL schema. */
export const buildGraphqlSchema = (source: string): GraphqlSchemaResult => {
  try {
    const trimmed = source.trim()
    let schema: GraphQLSchema
    if (trimmed.startsWith("{")) {
      const parsed: unknown = JSON.parse(trimmed)
      const introspection = isPlainObject(parsed) && isPlainObject(parsed["data"]) ? parsed["data"] : parsed
      schema = buildClientSchema(introspection as unknown as IntrospectionQuery)
    } else {
      schema = buildSchema(source)
    }
    if (schema.getQueryType() === undefined || schema.getQueryType() === null) {
      return failure("Ce schéma GraphQL n'a pas de type Query : il n'y a rien à interroger.", ["Ajoutez un type racine, par exemple : type Query { users: [User!]! }"])
    }
    return { ok: true, schema }
  } catch (cause) {
    if (cause instanceof GraphQLError) {
      const where = cause.locations?.[0] === undefined ? "" : `, ligne ${cause.locations[0].line} colonne ${cause.locations[0].column}`
      return failure(`Schéma GraphQL invalide${where} : ${cause.message}`)
    }
    return failure(`Schéma GraphQL illisible : ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

const SCALARS: Readonly<Record<string, JsonObject>> = {
  ID: { type: "string" },
  String: { type: "string" },
  Int: { type: "integer" },
  Float: { type: "number" },
  Boolean: { type: "boolean" },
}

/** Custom scalars guessed by name, with the formats the generator already knows. */
const customScalar = (name: string): JsonObject => {
  const n = name.toLowerCase()
  if (/datetime|timestamp|instant/.test(n)) return { type: "string", format: "date-time" }
  if (/^(local)?date$/.test(n)) return { type: "string", format: "date" }
  if (/^(local)?time$/.test(n)) return { type: "string", format: "time" }
  if (/url|uri/.test(n)) return { type: "string", format: "uri" }
  if (/email/.test(n)) return { type: "string", format: "email" }
  if (/uuid|guid/.test(n)) return { type: "string", format: "uuid" }
  if (/^(json|jsonobject|object|map)$/.test(n)) return { type: "object" }
  if (/bigint|long|int64|positiveint|nonnegativeint|unsignedint/.test(n)) return { type: "integer" }
  if (/decimal|money|double|float|number/.test(n)) return { type: "number" }
  return { type: "string" }
}

const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` })

/** A GraphQL output type as a JSON Schema: lists, scalars, enums, references; an interface or union as its concrete types. */
const typeSchema = (schema: GraphQLSchema, type: GraphQLOutputType): JsonObject => {
  if (isNonNullType(type)) return typeSchema(schema, type.ofType)
  if (isListType(type)) return { type: "array", items: typeSchema(schema, type.ofType) }
  if (isScalarType(type)) return SCALARS[type.name] ?? customScalar(type.name)
  if (isEnumType(type)) return { type: "string", enum: type.getValues().map((value) => value.name) }
  // A field may hand back a root type (`relay: Query`, Relay's `query` on mutation payloads): roots are no components.
  if (isObjectType(type)) return isRoot(schema, type.name) ? { type: "object" } : ref(type.name)
  if (isInterfaceType(type) || isUnionType(type)) {
    const possible = schema.getPossibleTypes(type)
    return possible.length === 0 ? { type: "object" } : possible.length === 1 ? ref(possible[0]!.name) : { oneOf: possible.map((t) => ref(t.name)) }
  }
  return {}
}

// ─── Example operations, for the mock page and the docs ────────────────────────

/** A plausible value for a required argument; ids are `"__ID__"`, replaced by a real one where shown. */
const sampleValue = (type: GraphQLInputType, name: string, depth = 0): Json => {
  if (isNonNullType(type)) return sampleValue(type.ofType, name, depth)
  if (isListType(type)) return [sampleValue(type.ofType, name, depth)]
  if (isEnumType(type)) return type.getValues()[0]?.name ?? null
  if (isInputObjectType(type)) {
    const out: Record<string, Json> = {}
    if (depth > 3) return out
    for (const field of Object.values(type.getFields())) {
      if (isNonNullType(field.type) && field.defaultValue === undefined) out[field.name] = sampleValue(field.type, field.name, depth + 1)
    }
    return out
  }
  if (isScalarType(type)) {
    if (type.name === "ID" || /id$/i.test(name)) return "__ID__"
    if (type.name === "Int") return 1
    if (type.name === "Float") return 1.5
    if (type.name === "Boolean") return true
    const scalar = customScalar(type.name)
    if (scalar["format"] === "date-time") return "2026-10-01T09:00:00Z"
    if (scalar["format"] === "email" || /email/i.test(name)) return "camille@example.fr"
    return name === "text" || name === "query" || name === "q" ? "loutre" : `Exemple ${name}`
  }
  return null
}

/** Scalar fields, then a few of each linked object: enough to see the data, never a huge tree. */
const selection = (schema: GraphQLSchema, type: GraphQLOutputType, depth = 0): string => {
  const named = getNamedType(type)
  if (isScalarType(named) || isEnumType(named)) return ""
  if (isUnionType(named) || isInterfaceType(named)) {
    const fragments = schema.getPossibleTypes(named).slice(0, 4).map((possible) => `... on ${possible.name}${selection(schema, possible, depth + 1)}`)
    return ` { __typename ${fragments.join(" ")} }`
  }
  if (!isObjectType(named)) return ""
  const limit = depth === 0 ? 8 : 3
  const picked: Array<string> = []
  for (const field of Object.values(named.getFields())) {
    if (picked.length >= limit) break
    if (field.args.some((arg) => isNonNullType(arg.type))) continue
    const inner = getNamedType(field.type)
    if (isScalarType(inner) || isEnumType(inner)) picked.push(field.name)
    else if (depth === 0 && isObjectType(inner)) picked.push(`${field.name}${selection(schema, field.type, depth + 1)}`)
  }
  return picked.length === 0 ? " { __typename }" : ` { ${picked.join(" ")} }`
}

const exampleOf = (schema: GraphQLSchema, operation: "query" | "mutation", field: GraphQLField<unknown, unknown>): { query: string; variables: Record<string, Json> } => {
  const required = field.args.filter((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)
  const variables: Record<string, Json> = {}
  for (const arg of required) variables[arg.name] = sampleValue(arg.type, arg.name)
  const declared = required.map((arg) => `$${arg.name}: ${String(arg.type)}`).join(", ")
  const passed = required.map((arg) => `${arg.name}: $${arg.name}`).join(", ")
  const head = required.length === 0 ? operation : `${operation} (${declared})`
  return { query: `${head} {\n  ${field.name}${passed.length === 0 ? "" : `(${passed})`}${selection(schema, field.type)}\n}`, variables }
}

const isRoot = (schema: GraphQLSchema, name: string): boolean =>
  [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()].some((root) => root?.name === name)

export type GraphqlConversion = { readonly ok: true; readonly document: JsonObject; readonly operations: number } | { readonly ok: false; readonly error: Diagnostic }

/** The OpenAPI document the pipeline reads: components, internal routes, the endpoint, and the printed schema. */
export const graphqlToOpenApi = (source: string, title: string): GraphqlConversion => {
  const built = buildGraphqlSchema(source)
  if (!built.ok) return built
  const schema = built.schema
  const schemas: Record<string, Json> = {}
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith("__") || isRoot(schema, type.name) || !isObjectType(type)) continue
    const properties: Record<string, Json> = { __typename: { type: "string", const: type.name } }
    const required: Array<string> = ["__typename"]
    for (const field of Object.values(type.getFields())) {
      properties[field.name] = typeSchema(schema, field.type)
      if (isNonNullType(field.type)) required.push(field.name)
    }
    const component: Record<string, Json> = { type: "object", title: type.name, properties, required }
    if (type.description !== undefined && type.description !== null) component["description"] = type.description
    schemas[type.name] = component
  }

  const paths: Record<string, Json> = {}
  const examples: Record<string, Json> = {}
  let operations = 0
  const roots: Array<["query" | "mutation", ReturnType<GraphQLSchema["getQueryType"]>]> = [
    ["query", schema.getQueryType()],
    ["mutation", schema.getMutationType()],
  ]
  for (const [operation, root] of roots) {
    if (root === undefined || root === null) continue
    for (const field of Object.values(root.getFields())) {
      operations++
      examples[internalRouteId(operation, field.name)] = exampleOf(schema, operation, field)
      const response = { description: field.description ?? field.name, content: { "application/json": { schema: typeSchema(schema, field.type) } } }
      paths[`${INTERNAL_PREFIX}${operation}/${field.name}`] = { [operation === "query" ? "get" : "post"]: { summary: `${operation} ${field.name}`, responses: { "200": response } } }
    }
  }
  const endpoint = { description: "Réponse GraphQL", content: { "application/json": { schema: { type: "object" } } } }
  paths[GRAPHQL_PATH] = {
    post: { summary: "GraphQL", requestBody: { content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": endpoint } },
    get: { summary: "GraphQL (requêtes en GET)", responses: { "200": endpoint } },
  }
  const description = schema.description ?? undefined
  return {
    ok: true,
    operations,
    document: {
      openapi: "3.1.0",
      info: { title, version: "1.0.0", ...(description === undefined ? {} : { description }) },
      paths,
      components: { schemas },
      "x-loutre-graphql": { sdl: printSchema(schema), path: GRAPHQL_PATH, examples },
    },
  }
}
