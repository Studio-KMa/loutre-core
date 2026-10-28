import { Data } from "effect"
import type { Diagnostic, Pointer, Stage } from "./diagnostic"

export type { Diagnostic, Pointer, Stage }

/** Fields shared by every pipeline error. */
export interface ErrorFields {
  /** Human-readable message, in French, oriented toward fixing the spec. */
  readonly message: string
  readonly pointer?: Pointer | undefined
  /** Fix hints ("did you mean `UserDto`?"). */
  readonly suggestions?: ReadonlyArray<string> | undefined
  readonly cause?: unknown
}

/** Stage 1 — the document could not be read or its format is not recognised. */
export class IngestionError extends Data.TaggedError("IngestionError")<ErrorFields> {}

/** Stage 2 — conversion to OpenAPI 3.1 or `$ref` resolution failed. */
export class NormalisationError extends Data.TaggedError("NormalisationError")<ErrorFields> {}

/** Stage 3 — the spec is valid but no route table can be derived from it. */
export class InterpretationError extends Data.TaggedError("InterpretationError")<ErrorFields> {}

/** Stage 4 — data generation failed. */
export class GenerationError extends Data.TaggedError("GenerationError")<ErrorFields> {}

export type LoutreError =
  | IngestionError
  | NormalisationError
  | InterpretationError
  | GenerationError

const stageOf: Record<LoutreError["_tag"], Stage> = {
  IngestionError: "ingestion",
  NormalisationError: "normalisation",
  InterpretationError: "interpretation",
  GenerationError: "generation",
}

export const toDiagnostic = (error: LoutreError): Diagnostic => ({
  stage: stageOf[error._tag],
  message: error.message,
  pointer: error.pointer,
  suggestions: error.suggestions ?? [],
})
