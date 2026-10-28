/**
 * Stage 1 — ingestion. Reads a raw document (YAML/JSON string or parsed object),
 * detects its format (OpenAPI 3.0 to 3.2, Swagger 2.0, TypeScript types, Postman, Insomnia, Bruno,
 * HAR, db.json, curl, GraphQL) and returns it as an OpenAPI object. No semantic validation here:
 * that is normalisation's job.
 */
import { Effect } from "effect"
import { detectFormat, readDocument, type Detection } from "../detect"
import type { Diagnostic } from "../diagnostic"
import { IngestionError } from "../errors"
import { graphqlToOpenApi } from "../graphql/schema"
import type { JsonObject } from "../model"

export interface RawSpec extends Detection {
  readonly document: JsonObject
}

export type SpecInput = string | object

const toError = (diagnostic: Diagnostic): IngestionError =>
  new IngestionError({ message: diagnostic.message, pointer: diagnostic.pointer, suggestions: diagnostic.suggestions })

export const ingest = (input: SpecInput): Effect.Effect<RawSpec, IngestionError> =>
  Effect.suspend(() => {
    const read = readDocument(input)
    if (!read.ok) return Effect.fail(toError(read.error))
    // A GraphQL schema arrives as a placeholder (detect.ts has no graphql-js): converted here.
    if (read.detected?.format === "graphql") {
      const info = read.document["info"] as JsonObject | undefined
      const title = typeof info?.["title"] === "string" ? info["title"] : "graphql-api"
      const converted = graphqlToOpenApi(String(read.document["x-loutre-graphql-source"] ?? ""), title)
      if (!converted.ok) return Effect.fail(toError(converted.error))
      return Effect.succeed({ ...read.detected, document: converted.document })
    }
    if (read.detected !== undefined) return Effect.succeed({ ...read.detected, document: read.document })
    const detected = detectFormat(read.document)
    if (!detected.ok) return Effect.fail(toError(detected.error))
    return Effect.succeed({ ...detected.detection, document: read.document })
  })
