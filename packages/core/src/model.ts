/**
 * Loutre's internal representation, described with Effect Schema.
 * Everything the pipeline outputs (route table, generated data) is plain JSON:
 * this is what gets stored in KV and served by the worker.
 */
import { Schema } from "effect"

export type Json = Schema.Json
export type JsonObject = Schema.JsonObject

// ─── Input formats ───────────────────────────────────────────────────────────

export const SpecFormat = Schema.Literals(["openapi-3.0", "openapi-3.1", "openapi-3.2", "swagger-2.0", "typescript", "postman", "insomnia", "bruno", "har", "json-server", "curl", "graphql"])
export type SpecFormat = typeof SpecFormat.Type

export const HttpMethod = Schema.Literals([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
  // OpenAPI 3.2: a safe, idempotent read that carries a body (HTTP QUERY).
  "query",
])
export type HttpMethod = typeof HttpMethod.Type

// ─── Data shapes (derived from OpenAPI 3.1 JSON Schemas) ─────────────────────

interface ShapeBase {
  /** Name of the source component ("Pet"); doubles as the collection key. */
  readonly title?: string
  readonly description?: string
  readonly nullable?: boolean
  readonly example?: Json
  readonly default?: Json
}

export interface PropertyShape {
  readonly name: string
  readonly required: boolean
  readonly shape: DataShape
}

export interface ObjectShape extends ShapeBase {
  readonly kind: "object"
  readonly properties: ReadonlyArray<PropertyShape>
  /** Typed `additionalProperties`, when present. */
  readonly additional?: DataShape
  /**
   * Data to serve as is instead of generating it (`x-loutre-fixtures` on a component):
   * a json-server `db.json` keeps its own records.
   */
  readonly fixtures?: ReadonlyArray<JsonObject>
}

export interface ArrayShape extends ShapeBase {
  readonly kind: "array"
  readonly items: DataShape
  readonly minItems?: number
  readonly maxItems?: number
}

export interface StringShape extends ShapeBase {
  readonly kind: "string"
  readonly format?: string
  readonly enum?: ReadonlyArray<string>
  readonly pattern?: string
  readonly minLength?: number
  readonly maxLength?: number
}

export interface NumberShape extends ShapeBase {
  readonly kind: "number"
  readonly integer: boolean
  readonly minimum?: number
  readonly maximum?: number
  readonly enum?: ReadonlyArray<number>
  readonly multipleOf?: number
}

export interface BooleanShape extends ShapeBase {
  readonly kind: "boolean"
}

export interface NullShape extends ShapeBase {
  readonly kind: "null"
}

/** `oneOf` / `anyOf`: the generator picks one variant. */
export interface UnionShape extends ShapeBase {
  readonly kind: "union"
  readonly variants: ReadonlyArray<DataShape>
}

/** `const`, or a single-value `enum`. */
export interface ConstShape extends ShapeBase {
  readonly kind: "const"
  readonly value: Json
}

/** Empty schema, `{}`, or unknown type. */
export interface UnknownShape extends ShapeBase {
  readonly kind: "unknown"
}

export type DataShape =
  | ObjectShape
  | ArrayShape
  | StringShape
  | NumberShape
  | BooleanShape
  | NullShape
  | UnionShape
  | ConstShape
  | UnknownShape

const shapeBase = {
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  nullable: Schema.optionalKey(Schema.Boolean),
  example: Schema.optionalKey(Schema.Json),
  default: Schema.optionalKey(Schema.Json),
}

const Shape = Schema.suspend((): Schema.Codec<DataShape> => DataShape)

export const PropertyShape = Schema.Struct({
  name: Schema.String,
  required: Schema.Boolean,
  shape: Shape,
})

export const ObjectShape = Schema.Struct({
  ...shapeBase,
  kind: Schema.Literal("object"),
  properties: Schema.Array(PropertyShape),
  additional: Schema.optionalKey(Shape),
  fixtures: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
})

export const ArrayShape = Schema.Struct({
  ...shapeBase,
  kind: Schema.Literal("array"),
  items: Shape,
  minItems: Schema.optionalKey(Schema.Number),
  maxItems: Schema.optionalKey(Schema.Number),
})

export const StringShape = Schema.Struct({
  ...shapeBase,
  kind: Schema.Literal("string"),
  format: Schema.optionalKey(Schema.String),
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
  pattern: Schema.optionalKey(Schema.String),
  minLength: Schema.optionalKey(Schema.Number),
  maxLength: Schema.optionalKey(Schema.Number),
})

export const NumberShape = Schema.Struct({
  ...shapeBase,
  kind: Schema.Literal("number"),
  integer: Schema.Boolean,
  minimum: Schema.optionalKey(Schema.Number),
  maximum: Schema.optionalKey(Schema.Number),
  enum: Schema.optionalKey(Schema.Array(Schema.Number)),
  multipleOf: Schema.optionalKey(Schema.Number),
})

export const BooleanShape = Schema.Struct({ ...shapeBase, kind: Schema.Literal("boolean") })
export const NullShape = Schema.Struct({ ...shapeBase, kind: Schema.Literal("null") })

export const UnionShape = Schema.Struct({
  ...shapeBase,
  kind: Schema.Literal("union"),
  variants: Schema.Array(Shape),
})

export const ConstShape = Schema.Struct({
  ...shapeBase,
  kind: Schema.Literal("const"),
  value: Schema.Json,
})

export const UnknownShape = Schema.Struct({ ...shapeBase, kind: Schema.Literal("unknown") })

export const DataShape: Schema.Codec<DataShape> = Schema.Union([
  ObjectShape,
  ArrayShape,
  StringShape,
  NumberShape,
  BooleanShape,
  NullShape,
  UnionShape,
  ConstShape,
  UnknownShape,
])

// ─── Route table ─────────────────────────────────────────────────────────────

export const ParameterLocation = Schema.Literals(["path", "query", "header", "cookie"])
export type ParameterLocation = typeof ParameterLocation.Type

export const Parameter = Schema.Struct({
  name: Schema.String,
  in: ParameterLocation,
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  shape: DataShape,
})
export type Parameter = typeof Parameter.Type

export const RequestBody = Schema.Struct({
  contentType: Schema.String,
  required: Schema.Boolean,
  shape: DataShape,
})
export type RequestBody = typeof RequestBody.Type

export const ResponseSpec = Schema.Struct({
  /** Key as documented, uppercased: "200", "404", "4XX", "DEFAULT". */
  status: Schema.String,
  description: Schema.optionalKey(Schema.String),
  contentType: Schema.optionalKey(Schema.String),
  shape: Schema.optionalKey(DataShape),
})
export type ResponseSpec = typeof ResponseSpec.Type

export const Route = Schema.Struct({
  /** Stable id: "get:/pets/{petId}". */
  id: Schema.String,
  method: HttpMethod,
  /** Path as declared, parameters in braces. */
  path: Schema.String,
  operationId: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  tags: Schema.Array(Schema.String),
  parameters: Schema.Array(Parameter),
  requestBody: Schema.optionalKey(RequestBody),
  responses: Schema.Array(ResponseSpec),
  /** Status served by default: first documented 2xx, else 200. */
  defaultStatus: Schema.Number,
})
export type Route = typeof Route.Type

export const ApiInfo = Schema.Struct({
  title: Schema.String,
  version: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
})
export type ApiInfo = typeof ApiInfo.Type

/** A GraphQL mock: the printed schema, and the table route its endpoint is (`/graphql`). */
export const GraphqlExample = Schema.Struct({
  query: Schema.String,
  variables: Schema.Record(Schema.String, Schema.Json),
})
export type GraphqlExample = typeof GraphqlExample.Type

export const GraphqlSpec = Schema.Struct({
  sdl: Schema.String,
  path: Schema.String,
  /** A ready-to-send operation per root field, by internal route id; `"__ID__"` stands for a real id. */
  examples: Schema.optionalKey(Schema.Record(Schema.String, GraphqlExample)),
})
export type GraphqlSpec = typeof GraphqlSpec.Type

export const RouteTable = Schema.Struct({
  format: SpecFormat,
  info: ApiInfo,
  routes: Schema.Array(Route),
  graphql: Schema.optionalKey(GraphqlSpec),
})
export type RouteTable = typeof RouteTable.Type

// ─── Generated data ──────────────────────────────────────────────────────────

export const MockData = Schema.Struct({
  seed: Schema.String,
  /** Generation date, ISO 8601. */
  generatedAt: Schema.String,
  /** Pre-generated response bodies: routeId → status → JSON. */
  bodies: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)),
  /** Objects per named component ("Pet" → 8 pets), keeping list and detail consistent. */
  collections: Schema.Record(Schema.String, Schema.Array(Schema.Json)),
  /** Source collection of a route's 2xx body ("get:/pets/{petId}" → "Pet"), for id lookups when serving. */
  sources: Schema.Record(Schema.String, Schema.String),
  /** Items per collection when the default ones made the data too heavy (`generateCompact`). */
  collectionSize: Schema.optionalKey(Schema.Number),
  /** Language of the data and of the error bodies served with it; French when absent (mocks made before the choice). */
  locale: Schema.optionalKey(Schema.Literals(["fr", "en"])),
})
export type MockData = typeof MockData.Type

// ─── Full mock definition ────────────────────────────────────────────────────

export const MockDefinition = Schema.Struct({
  version: Schema.Literal(1),
  table: RouteTable,
  data: MockData,
})
export type MockDefinition = typeof MockDefinition.Type
