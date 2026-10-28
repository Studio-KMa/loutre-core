import { Effect } from "effect"
import type { LoutreError } from "./errors"
import { generate, randomSeed, type Vocabulary } from "./generation"
import { ingest, type SpecInput } from "./ingestion"
import { interpret } from "./interpretation"
import type { MockDefinition, RouteTable } from "./model"
import { normalise } from "./normalisation"

export interface CompileOptions {
  /** Seed for the generated data; random when omitted. */
  readonly seed?: string | undefined
  /** Per-field candidate values from AI enrichment. */
  readonly vocabulary?: Vocabulary | undefined
  /** Reference instant for generated dates (tests). */
  readonly now?: Date | undefined
}

/**
 * Stages 1–3 only: from spec to route table, without data. Lets the caller
 * prepare an AI vocabulary before generating.
 */
export const analyse = (input: SpecInput): Effect.Effect<RouteTable, LoutreError> =>
  Effect.gen(function* () {
    const raw = yield* ingest(input)
    const spec = yield* normalise(raw)
    return yield* interpret(spec)
  })

/**
 * The full pipeline: ingestion → normalisation → interpretation → generation.
 * Fails on the first error, typed per stage.
 */
export const compile = (input: SpecInput, options: CompileOptions = {}): Effect.Effect<MockDefinition, LoutreError> =>
  Effect.gen(function* () {
    const raw = yield* ingest(input)
    const spec = yield* normalise(raw)
    const table = yield* interpret(spec)
    const data = yield* generate(table, {
      seed: options.seed ?? randomSeed(),
      vocabulary: options.vocabulary,
      now: options.now,
    })
    return { version: 1, table, data } as const
  })
