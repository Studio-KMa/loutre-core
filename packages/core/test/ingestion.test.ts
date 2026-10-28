import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { detect } from "../src/detect"
import { ingest } from "../src/ingestion"
import { fixture } from "./fixtures"

describe("détection de format", () => {
  it.each([
    ["petstore-3.0.yaml", "openapi-3.0", "3.0.0"],
    ["petstore-expanded-3.0.yaml", "openapi-3.0", "3.0.0"],
    ["uspto-3.0.yaml", "openapi-3.0", "3.0.1"],
    ["github-issues-3.1.json", "openapi-3.1", "3.1.0"],
    ["stripe-products-3.0.json", "openapi-3.0", "3.0.0"],
    ["webhook-only-3.1.yaml", "openapi-3.1", "3.1.0"],
    ["petstore-swagger-2.0.json", "swagger-2.0", "2.0"],
  ])("%s → %s", (file, format, version) => {
    const result = detect(fixture(file))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.detection).toEqual({ format, version })
    }
  })

  it("accepte un objet déjà parsé", () => {
    const result = detect({ openapi: "3.1.0", info: { title: "x", version: "1" }, paths: {} })
    expect(result.ok && result.detection.format).toBe("openapi-3.1")
  })

  it("refuse un document vide avec un message orienté action", () => {
    const result = detect("   \n")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/vide/)
  })

  it("signale un YAML invalide avec sa position", () => {
    const result = detect(fixture("invalid.yaml"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/YAML invalide, ligne \d+ colonne \d+/)
  })

  it("signale un JSON invalide (une virgule finale, elle, est tolérée)", () => {
    expect(detect('{ "openapi": "3.1.0", }').ok).toBe(true)
    const result = detect('{ "openapi": "3.1.0", "info": ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/^JSON invalide/)
  })

  it("explique qu'un document sans clé openapi/swagger n'est pas un schéma", () => {
    const result = detect(fixture("not-openapi.json"))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toMatch(/Aucune clé `openapi` ni `swagger`/)
      expect(result.error.suggestions[0]).toMatch(/openapi: 3\.1\.0/)
    }
  })

  it("refuse les versions non prises en charge", () => {
    const result = detect(fixture("unsupported-version.yaml"))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toMatch(/OpenAPI 4\.0\.0 n'est pas pris en charge/)
      expect(result.error.pointer).toBe("#/openapi")
    }
  })

  it("reconnaît AsyncAPI pour mieux le refuser", () => {
    const result = detect(fixture("asyncapi.yaml"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/AsyncAPI/)
  })

  it("refuse un tableau à la racine", () => {
    const result = detect("[1, 2]")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/pas un tableau/)
  })

  it("rend un diagnostic JSON brut, sans classe ni Effect", () => {
    const result = detect("")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ stage: "ingestion", message: expect.stringMatching(/vide/), pointer: undefined, suggestions: [] })
  })
})

describe("ingestion (Effect)", () => {
  it.effect("rend le document et sa détection", () =>
    Effect.gen(function* () {
      const raw = yield* ingest(fixture("petstore-3.0.yaml"))
      expect(raw.format).toBe("openapi-3.0")
      expect(raw.document["info"]).toMatchObject({ title: "Swagger Petstore" })
    }),
  )

  it.effect("échoue avec une IngestionError typée", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(ingest("just: yaml"))
      expect(error._tag).toBe("IngestionError")
    }),
  )
})
