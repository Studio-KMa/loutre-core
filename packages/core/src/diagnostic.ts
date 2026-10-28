/** JSON shape of a pipeline error, as consumed by the API and the web app. Dependency-free. */
export type Stage = "ingestion" | "normalisation" | "interpretation" | "generation"

/** Location in the source document, as a JSON Pointer (e.g. "#/components/schemas/User"). */
export type Pointer = string

export interface Diagnostic {
  readonly stage: Stage
  readonly message: string
  readonly pointer?: Pointer | undefined
  readonly suggestions: ReadonlyArray<string>
}
