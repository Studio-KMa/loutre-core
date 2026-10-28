/**
 * Stage 2 — normalisation. Brings every document to the single internal format:
 * OpenAPI 3.1 with `$ref`s resolved. Swagger 2.0 goes through swagger2openapi,
 * OpenAPI 3.0 is upgraded in place (nullable → null type, boolean exclusiveMinimum → numeric).
 *
 * We dereference with json-schema-ref-parser rather than swagger-parser: the latter's
 * Ajv validation compiles code at runtime (forbidden on Cloudflare Workers) and its
 * `dereference` rejects documents without `paths`, which we still want to report
 * properly. Structural checks live in the interpretation stage.
 */
import $RefParser from "@apidevtools/json-schema-ref-parser"
import { Effect } from "effect"
import type { OpenAPIV2, OpenAPIV3_1 } from "openapi-types"
import * as converter from "swagger2openapi"
import { NormalisationError } from "../errors"
import type { RawSpec } from "../ingestion"
import type { SpecFormat } from "../model"
import { describeMissingRefs, inspectRefs } from "./refs"
import { downgradeFrom32 } from "./openapi32"
import { upgradeTo31 } from "./upgrade"

export interface NormalisedSpec {
  /** Original format, kept for the detection badge. */
  readonly format: SpecFormat
  readonly version: string
  readonly document: OpenAPIV3_1.Document
}

export const normalise = (raw: RawSpec): Effect.Effect<NormalisedSpec, NormalisationError> =>
  Effect.gen(function* () {
    // Clone: dereferencing mutates the document and the caller keeps theirs.
    const document = structuredClone(raw.document) as Record<string, unknown>
    pruneForeignExtensions(document)

    const refs = inspectRefs(document)
    if (refs.external.length > 0) {
      const first = refs.external[0]!
      return yield* new NormalisationError({
        message:
          `Référence externe non prise en charge : \`${first.ref}\` (en ${first.at}). ` +
          "Loutre ne lit qu'un document autonome : regroupez vos fichiers en un seul (par exemple avec `redocly bundle`).",
        pointer: first.at,
      })
    }
    if (refs.missing.length > 0) {
      const first = refs.missing[0]!
      return yield* new NormalisationError({
        message: describeMissingRefs(refs.missing),
        pointer: first.at,
        suggestions: first.suggestions,
      })
    }

    const openapi =
      raw.format === "swagger-2.0"
        ? yield* convertSwagger(document as unknown as OpenAPIV2.Document)
        : raw.format === "openapi-3.2"
          ? downgradeFrom32(document as unknown as Record<string, unknown>)
          : document

    const dereferenced = yield* Effect.tryPromise({
      try: () =>
        $RefParser.dereference(openapi, {
          dereference: { circular: true },
          resolve: { file: false, http: false },
        }),
      catch: (cause) =>
        new NormalisationError({
          message: `Impossible de résoudre les références du document : ${errorMessage(cause)}`,
          cause,
        }),
    })

    const upgraded = dereferenced as unknown as Record<string, unknown>
    upgradeTo31(upgraded)
    return {
      format: raw.format,
      version: raw.version,
      document: upgraded as unknown as OpenAPIV3_1.Document,
    }
  })

const convertSwagger = (document: OpenAPIV2.Document): Effect.Effect<Record<string, unknown>, NormalisationError> =>
  Effect.tryPromise({
    try: async () => {
      const result = await converter.convertObj(document, {
        patch: true,
        warnOnly: true,
        resolve: false,
        resolveInternal: false,
        direct: false,
      })
      return result.openapi as unknown as Record<string, unknown>
    },
    catch: (cause) =>
      new NormalisationError({
        message: `Conversion Swagger 2.0 → OpenAPI 3 impossible : ${errorMessage(cause)}`,
        cause,
      }),
  })

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message.split("\n")[0] ?? cause.message : String(cause)

/**
 * A vendor extension holding a `$ref` (`x-spotify-policy`, which points to another file) is dropped: a mock
 * never reads it, and an external or dangling reference in it would otherwise turn the whole document down.
 * Loutre's own `x-loutre-*` stay.
 */
const pruneForeignExtensions = (document: Record<string, unknown>): void => {
  const seen = new Set<object>()
  const hasRef = (node: unknown): boolean => {
    if (typeof node !== "object" || node === null || seen.has(node)) return false
    seen.add(node)
    if (!Array.isArray(node) && typeof (node as Record<string, unknown>)["$ref"] === "string") return true
    return Object.values(node).some(hasRef)
  }
  const visited = new Set<object>()
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null || visited.has(node)) return
    visited.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const record = node as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key.startsWith("x-") && !key.startsWith("x-loutre-")) {
        seen.clear()
        if (hasRef(record[key])) {
          delete record[key]
          continue
        }
      }
      walk(record[key])
    }
  }
  walk(document)
}
