/**
 * Ce que des specs réelles demandent au moteur : les exemples officiels d'OpenAPI (learn.openapis.org),
 * et les traits des grosses specs publiques (DigitalOcean, Xero, Google Slides) rejoués en miniature.
 */
import { readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { analyseToResult, generateCompact, generateSync, type JsonObject, type RouteTable } from "../src"
import { fixture } from "./fixtures"

const tableOf = async (spec: string): Promise<RouteTable> => {
  const result = await analyseToResult(spec)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.table
}

const openapi = (paths: JsonObject, schemas: JsonObject = {}): string =>
  JSON.stringify({ openapi: "3.0.3", info: { title: "Réel", version: "1" }, paths, components: { schemas } })

const ok = (schema: JsonObject): JsonObject => ({ get: { responses: { "200": { description: "ok", content: { "application/json": { schema } } } } } })

describe("exemples officiels d'OpenAPI", () => {
  const files = readdirSync(new URL("./fixtures/specs/learn/", import.meta.url)).sort()

  it.each(files)("%s : chaque réponse 2xx décrite a un corps", async (file) => {
    const table = await tableOf(fixture(`learn/${file}`))
    const data = generateSync(table, { seed: "learn" })
    for (const route of table.routes) {
      for (const response of route.responses) {
        if (!/^2/.test(response.status) || response.status === "204" || response.shape === undefined || response.shape.kind === "null") continue
        expect(data.bodies[route.id]?.[response.status], `${route.id} ${response.status}`).not.toBeNull()
      }
    }
  })
})

describe("grosses specs", () => {
  it("une première route très profonde ne prive pas les suivantes de leur forme", async () => {
    const schemas: Record<string, JsonObject> = {}
    for (let i = 0; i < 12; i++) {
      const next = i < 11 ? { $ref: `#/components/schemas/S${i + 1}` } : { type: "string" }
      schemas[`S${i}`] = { type: "object", properties: { a: next, b: next, c: next, d: next } }
    }
    const paths: Record<string, JsonObject> = { "/deep": ok({ $ref: "#/components/schemas/S0" }) }
    for (let i = 0; i < 60; i++) paths[`/r${i}`] = ok({ type: "object", properties: { name: { type: "string" }, total: { type: "number" } } })
    const table = await tableOf(openapi(paths, schemas))
    for (const route of table.routes.filter((r) => r.path.startsWith("/r"))) {
      expect(route.responses[0]!.shape?.kind, route.id).toBe("object")
    }
  })

  it("des collections de collections restent légères : les entités liées lourdes sont résumées", async () => {
    // Présentation → pages → éléments → cellules, chacun une collection nommée (Google Slides en miniature).
    const schemas: JsonObject = {
      Cell: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, notes: { type: "array", items: { type: "string" } } } },
      Element: { type: "object", properties: { id: { type: "string" }, kind: { type: "string" }, cells: { type: "array", items: { $ref: "#/components/schemas/Cell" } } } },
      Page: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, elements: { type: "array", items: { $ref: "#/components/schemas/Element" } } } },
      Presentation: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, pages: { type: "array", items: { $ref: "#/components/schemas/Page" } }, cover: { $ref: "#/components/schemas/Page" } } },
    }
    const table = await tableOf(openapi({ "/presentations": ok({ type: "array", items: { $ref: "#/components/schemas/Presentation" } }) }, schemas))
    const data = generateSync(table, { seed: "slides" })
    expect(JSON.stringify(data).length).toBeLessThan(400_000)
    const presentation = (data.bodies["get:/presentations"]?.["200"] as Array<JsonObject>)[0]!
    expect(typeof presentation["id"]).toBe("string")
    expect(Array.isArray(presentation["pages"])).toBe(true)
  })

  it("generateCompact réduit les collections jusqu'à passer sous le poids voulu, et le note", async () => {
    const table = await tableOf(fixture("petstore-3.0.yaml"))
    const heavy = generateCompact(table, { seed: "x" })
    expect(heavy.collectionSize).toBeUndefined()
    const light = generateCompact(table, { seed: "x" }, 600)
    expect(light.collectionSize).toBeDefined()
    expect(JSON.stringify(light.collections).length).toBeLessThan(JSON.stringify(heavy.collections).length)
  })

  it("une extension propriétaire qui pointe vers un autre fichier (Spotify) ne fait plus refuser le schéma", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Extensions", version: "1" },
      paths: { "/albums": { get: { "x-policy-list": { $ref: "#/components/x-policy/list" }, responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } } } },
      components: { "x-policy": { $ref: "../policies.yaml" } },
    })
    const table = await tableOf(spec)
    expect(table.routes.map((r) => r.id)).toEqual(["get:/albums"])
    // Une référence externe hors extension reste refusée, avec son explication.
    const external = await analyseToResult(JSON.stringify({ openapi: "3.0.3", info: { title: "x", version: "1" }, paths: { "/a": { get: { responses: { "200": { $ref: "./other.yaml#/r" } } } } } }))
    expect(external.ok).toBe(false)
  })

  it("API françaises et champs courants : le contexte et le nom donnent la bonne valeur", async () => {
    const schemas: JsonObject = {
      Commune: { type: "object", properties: { nom: { type: "string" }, codeDepartement: { type: "string" }, codesPostaux: { type: "array", items: { type: "string" } } } },
      Etablissement: { type: "object", properties: { nom_commercial: { type: "string" }, annee_tranche_effectif: { type: "string" } } },
      ExternalUrls: { type: "object", properties: { spotify: { type: "string" } } },
      Album: { type: "object", properties: { external_urls: { $ref: "#/components/schemas/ExternalUrls" }, available_markets: { type: "array", items: { type: "string" } }, tags: { type: "array", items: {} } } },
    }
    const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` })
    const table = await tableOf(openapi({ "/communes": ok(ref("Commune")), "/etablissements": ok(ref("Etablissement")), "/albums": ok(ref("Album")) }, schemas))
    const data = generateSync(table, { seed: "fr" })
    const commune = data.bodies["get:/communes"]?.["200"] as JsonObject
    expect(String(commune["nom"])).not.toMatch(/^(Martin|Durand|Bernard|Petit|Lefebvre)$/)
    expect(String(commune["codeDepartement"])).toMatch(/^(\d{2}|2A|2B)$/)
    for (const zip of commune["codesPostaux"] as Array<string>) expect(zip).toMatch(/^\d{5}$/)
    const etablissement = data.bodies["get:/etablissements"]?.["200"] as JsonObject
    expect(String(etablissement["annee_tranche_effectif"])).toMatch(/^20\d{2}$/)
    const album = data.bodies["get:/albums"]?.["200"] as JsonObject
    expect(String((album["external_urls"] as JsonObject)["spotify"])).toMatch(/^https:\/\//)
    for (const market of album["available_markets"] as Array<string>) expect(market).toMatch(/^[A-Z]{2}$/)
    // Des éléments sans schéma : une liste vide, jamais une rangée de null.
    expect(album["tags"]).toEqual([])
  })

  it("un schéma qui ne dit rien (`{}`, FastAPI) répond un objet vide, pas null", async () => {
    const table = await tableOf(openapi({ "/history/delete": ok({}) }))
    expect(generateSync(table, { seed: "x" }).bodies["get:/history/delete"]?.["200"]).toEqual({})
  })
})
