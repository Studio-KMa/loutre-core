/**
 * @loutre-run/core — the Loutre engine. Input: an OpenAPI 3.0 / 3.1 schema (YAML or JSON),
 * Swagger 2.0, TypeScript types, a Postman, Insomnia or Bruno collection, a HAR file,
 * a json-server db.json or curl commands. Output: a typed route table
 * and realistic data, ready to serve.
 *
 * Two surfaces: `compile` is the native Effect, for composing and testing;
 * `compileToResult` is a Promise with a discriminated result, for everything else.
 */
import { Cause, Effect, Exit } from "effect"
import { toDiagnostic, type Diagnostic } from "./errors"
import type { SpecInput } from "./ingestion"
import type { MockDefinition, RouteTable } from "./model"
import { analyse, compile, type CompileOptions } from "./pipeline"

export {
  GenerationError,
  IngestionError,
  InterpretationError,
  NormalisationError,
  toDiagnostic,
  type Diagnostic,
  type LoutreError,
  type Pointer,
  type Stage,
} from "./errors"
export { detect, readDocument, detectFormat, sanitizeSpec, looksLikeGraphql, isIntrospection, type Detection, type DetectResult, type ReadResult } from "./detect"
export { typescriptToOpenApi, looksLikeTypeScript, pluralPath, type TypeScriptResult } from "./typescript"
export { postmanToOpenApi, isPostmanCollection, type PostmanResult } from "./postman"
export { insomniaToOpenApi, isInsomniaExport, type InsomniaResult } from "./insomnia"
export { brunoToOpenApi, bruToOpenApi, isBrunoCollection, looksLikeBru, type BrunoResult } from "./bruno"
export { harToOpenApi, isHar, slimHar, type HarResult } from "./har"
export { jsonServerToOpenApi, isJsonServerDb, type JsonServerResult } from "./json-server"
export { curlToOpenApi, looksLikeCurl, shellCommands, type CurlResult } from "./curl"
export { templateIds } from "./collections"
export { graphqlToOpenApi, buildGraphqlSchema, GRAPHQL_PATH, INTERNAL_PREFIX, internalRouteId } from "./graphql/schema"
export { answerGraphql, executeGraphql, type GraphqlServingResult, type GraphqlWrite } from "./graphql/execute"
export { inferSchema, titleFromName } from "./util/infer-schema"
export type { RawSpec, SpecInput } from "./ingestion"
export type { NormalisedSpec } from "./normalisation"
export { generate, generateCompact, generateSync, MAX_DATA_BYTES, randomSeed, type GenerationOptions, type Vocabulary } from "./generation"
export { infer, tokenize, type InferContext, type Semantic } from "./generation/infer"
export * from "./model"
export { analyse, compile, type CompileOptions } from "./pipeline"
export { ingest } from "./ingestion"
export { normalise } from "./normalisation"
export { interpret } from "./interpretation"
export {
  allowedMethods,
  DEFAULT_BEHAVIOR,
  HEADER_COUNT,
  HEADER_DELAY,
  HEADER_MESSAGE,
  HEADER_SCENARIO,
  HEADER_SEED,
  HEADER_STATUS,
  MAX_COUNT,
  MAX_DELAY_MS,
  MAX_SCENARIOS,
  applyScenario,
  matchRoute,
  matchRule,
  MAX_RULES,
  resolve,
  type Behavior,
  type ResolveOptions,
  type ResponseRule,
  type RouteBehavior,
  type RouteMatch,
  type RuleConditions,
  type Scenario,
  type ServingKind,
  type ServingRequest,
  type ServingResult,
} from "./serving"
export {
  applyOp,
  applyWrite,
  collectionFor,
  freshId,
  hasPathParam,
  idFieldOf,
  idOf,
  listKeyFor,
  MAX_STATE_ITEMS,
  pathId,
  removeItem,
  replaceItems,
  upsertItem,
  writeOp,
  type OpResult,
  type StateOp,
  type WriteRequest,
  type WriteResult,
} from "./state"

export type CompileResult =
  | { readonly ok: true; readonly mock: MockDefinition }
  | { readonly ok: false; readonly errors: ReadonlyArray<Diagnostic> }

/** The Effect-free public API: `(spec) → { routes, data, errors }`. */
export const compileToResult = async (
  input: SpecInput,
  options?: CompileOptions,
): Promise<CompileResult> => {
  const exit = await Effect.runPromiseExit(compile(input, options))
  if (Exit.isSuccess(exit)) {
    return { ok: true, mock: exit.value }
  }
  const failure = Cause.squash(exit.cause)
  if (isLoutreError(failure)) {
    return { ok: false, errors: [toDiagnostic(failure)] }
  }
  throw failure
}

export type AnalyseResult =
  | { readonly ok: true; readonly table: RouteTable }
  | { readonly ok: false; readonly errors: ReadonlyArray<Diagnostic> }

/** Promise variant of `analyse`: the route table or diagnostics. */
export const analyseToResult = async (input: SpecInput): Promise<AnalyseResult> => {
  const exit = await Effect.runPromiseExit(analyse(input))
  if (Exit.isSuccess(exit)) return { ok: true, table: exit.value }
  const failure = Cause.squash(exit.cause)
  if (isLoutreError(failure)) return { ok: false, errors: [toDiagnostic(failure)] }
  throw failure
}

const isLoutreError = (u: unknown): u is Parameters<typeof toDiagnostic>[0] =>
  typeof u === "object" &&
  u !== null &&
  "_tag" in u &&
  typeof u._tag === "string" &&
  u._tag.endsWith("Error") &&
  ["IngestionError", "NormalisationError", "InterpretationError", "GenerationError"].includes(u._tag)
