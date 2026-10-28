import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { OpenAPIV3_1 } from "openapi-types"
import { ingest } from "../src/ingestion"
import { normalise } from "../src/normalisation"
import { inspectRefs } from "../src/normalisation/refs"
import { fixture } from "./fixtures"

const normalised = (file: string) => ingest(fixture(file)).pipe(Effect.flatMap(normalise))

const response = (r: unknown) => r as OpenAPIV3_1.ResponseObject | undefined

/** Cherche une clé dans un graphe potentiellement cyclique. */
const hasKeyDeep = (node: unknown, key: string, seen = new Set<object>()): boolean => {
  if (typeof node !== "object" || node === null || seen.has(node)) return false
  seen.add(node)
  if (!Array.isArray(node) && key in node) return true
  return Object.values(node).some((v) => hasKeyDeep(v, key, seen))
}

describe("normalisation", () => {
  it.effect("déréférence un OpenAPI 3.0 et le passe en 3.1", () =>
    Effect.gen(function* () {
      const spec = yield* normalised("petstore-3.0.yaml")
      expect(spec.format).toBe("openapi-3.0")
      expect(spec.document.openapi).toBe("3.1.0")
      const listPets = spec.document.paths?.["/pets"]?.get
      const schema = response(listPets?.responses?.["200"])?.content?.["application/json"]?.schema
      // Le `$ref` vers Pets → Pet est résolu en place.
      expect(schema).toMatchObject({ type: "array", items: { type: "object", required: ["id", "name"] } })
    }),
  )

  it.effect("convertit un Swagger 2.0 legacy en OpenAPI 3.1", () =>
    Effect.gen(function* () {
      const spec = yield* normalised("petstore-swagger-2.0.json")
      expect(spec.format).toBe("swagger-2.0")
      expect(spec.document.openapi).toBe("3.1.0")
      const addPet = spec.document.paths?.["/pet"]?.post
      expect(addPet?.requestBody).toBeDefined()
      const findByStatus = spec.document.paths?.["/pet/findByStatus"]?.get
      expect(response(findByStatus?.responses?.["200"])?.content?.["application/json"]?.schema).toMatchObject({
        type: "array",
      })
      expect(spec.document.components?.schemas?.["Pet"]).toBeDefined()
    }),
  )

  it.effect("traduit nullable en type null (3.0 → 3.1)", () =>
    Effect.gen(function* () {
      const spec = yield* normalised("stripe-products-3.0.json")
      const product = spec.document.components?.schemas?.["product"] as { properties: Record<string, unknown> }
      expect(product.properties["description"]).toMatchObject({ type: ["string", "null"] })
      expect(hasKeyDeep(product, "nullable")).toBe(false)
    }),
  )

  it.effect("supporte les références circulaires (GitHub)", () =>
    Effect.gen(function* () {
      const spec = yield* normalised("github-issues-3.1.json")
      expect(Object.keys(spec.document.paths ?? {})).toContain("/repos/{owner}/{repo}/issues")
    }),
  )

  it.effect("liste les références introuvables avec des suggestions", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(normalised("broken-ref-3.0.yaml"))
      expect(error._tag).toBe("NormalisationError")
      expect(error.message).toMatch(/`#\/components\/schemas\/User` n'existe pas/)
      expect(error.message).toMatch(/vouliez-vous dire `#\/components\/schemas\/UserDto`/)
      expect(error.pointer).toBe("#/paths/~1users/get/responses/200/content/application~1json/schema/items/$ref")
      expect(error.suggestions).toEqual(["#/components/schemas/UserDto"])
    }),
  )

  it.effect("refuse les références externes", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        normalise({
          format: "openapi-3.1",
          version: "3.1.0",
          document: {
            openapi: "3.1.0",
            info: { title: "x", version: "1" },
            paths: { "/a": { get: { responses: { "200": { $ref: "./common.yaml#/components/responses/Ok" } } } } },
          },
        }),
      )
      expect(error.message).toMatch(/Référence externe non prise en charge : `\.\/common\.yaml#\/components\/responses\/Ok`/)
    }),
  )

  it("inspecte toutes les références en une passe", () => {
    const report = inspectRefs({
      a: { $ref: "#/defs/Uzer" },
      b: { $ref: "#/defs/User" },
      c: { $ref: "#/nope/Thing" },
      defs: { User: {}, UserDto: {} },
    })
    expect(report.missing.map((m) => m.ref)).toEqual(["#/defs/Uzer", "#/nope/Thing"])
    expect(report.missing[0]?.suggestions).toEqual(["#/defs/User"])
    expect(report.missing[1]?.reachable).toBe("#")
  })
})
