import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { templateIds } from "../src/collections"
import { curlToOpenApi, looksLikeCurl, shellCommands } from "../src/curl"
import { detect, sanitizeSpec } from "../src/detect"
import { harToOpenApi, isHar, slimHar } from "../src/har"
import { isJsonServerDb, jsonServerToOpenApi } from "../src/json-server"
import type { JsonObject } from "../src/model"
import { compile } from "../src/pipeline"
import { resolve } from "../src/serving"
import { writeOp } from "../src/state"
import { fixture } from "./fixtures"

const NOW = new Date("2026-09-24T10:00:00Z")
const json = (name: string): JsonObject => JSON.parse(fixture(name)) as JsonObject
const converted = (result: { ok: boolean }): JsonObject => {
  if (!result.ok || !("document" in result)) throw new Error(JSON.stringify(result))
  return result.document as JsonObject
}
const pathsOf = (document: JsonObject): Record<string, JsonObject> => document["paths"] as Record<string, JsonObject>
const schemasOf = (document: JsonObject): Record<string, JsonObject> => (document["components"] as JsonObject)["schemas"] as Record<string, JsonObject>

describe("identifiants concrets dans un chemin", () => {
  it("deviennent des paramètres nommés d'après leur collection", () => {
    expect(templateIds("/v1/users/42")).toBe("/v1/users/{id}")
    expect(templateIds("/v1/users/42/orders/7")).toBe("/v1/users/{userId}/orders/{id}")
    expect(templateIds("/orders/3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe("/orders/{id}")
    expect(templateIds("/orders/ord_7f3a9c21/lines")).toBe("/orders/{orderId}/lines")
    expect(templateIds("/v2/search")).toBe("/v2/search")
    expect(templateIds("/users/{id}/orders/123")).toBe("/users/{id}/orders/{id2}")
  })
})

describe("fichiers HAR", () => {
  it("garde les appels JSON de l'hôte principal, sans statique, préflight ni tiers", () => {
    expect(isHar(json("boutique.har"))).toBe(true)
    expect(detect(fixture("boutique.har"))).toMatchObject({ ok: true, detection: { format: "har", version: "1.2" } })
    const document = converted(harToOpenApi(json("boutique.har")))
    expect((document["info"] as JsonObject)["title"]).toBe("api.boutique.fr")
    const paths = pathsOf(document)
    expect(Object.keys(paths).sort()).toEqual(["/v1/orders", "/v1/products", "/v1/users", "/v1/users/{id}", "/v1/users/{userId}/orders"])
    // /users/42, /users/57 et /users/999 : une seule route, 200 et 404.
    expect(Object.keys((paths["/v1/users/{id}"]!["get"] as JsonObject)["responses"] as JsonObject)).toEqual(["200", "404"])
    expect(((paths["/v1/users"]!["get"] as JsonObject)["parameters"] as Array<JsonObject>).map((p) => p["name"])).toEqual(["page", "limit"])
    // Réponse encodée en base64 : lue quand même.
    expect(Object.keys(schemasOf(document)["Product"]!["properties"] as JsonObject)).toEqual(["id", "name", "price", "stock"])
  })

  it("des vraies valeurs, seulement des formes : ni texte ni nom repris, les statuts si", () => {
    const user = schemasOf(converted(harToOpenApi(json("boutique.har"))))["User"]!["properties"] as Record<string, JsonObject>
    expect(user["status"]!["enum"]).toEqual(["active", "invited"])
    expect(user["plan"]!["enum"]).toEqual(["pro", "free"])
    expect(user["company"]!["enum"]).toBeUndefined()
    expect(user["name"]!["example"]).toBeUndefined()
    expect(JSON.stringify(user)).not.toContain("Dubois")
  })

  it("allégé avant l'envoi : ni en-tête, ni cookie, ni jeton", () => {
    const slim = slimHar(json("boutique.har"))
    const text = JSON.stringify(slim)
    expect(text).not.toContain("secret-token-123")
    expect(text).not.toContain("session=")
    expect(text).not.toContain("google-analytics")
    expect(((slim["log"] as JsonObject)["entries"] as Array<unknown>).length).toBe(7)
    expect(sanitizeSpec(fixture("boutique.har")).length).toBeLessThan(fixture("boutique.har").length / 2)
    expect(sanitizeSpec(fixture("petstore-3.0.yaml"))).toBe(fixture("petstore-3.0.yaml"))
    // L'allégé se relit comme l'original.
    expect(Object.keys(pathsOf(converted(harToOpenApi(slim)))).sort()).toEqual(Object.keys(pathsOf(converted(harToOpenApi(json("boutique.har"))))).sort())
  })

  it("passe le pipeline avec des données générées, pas les vraies", async () => {
    const mock = await Effect.runPromise(compile(sanitizeSpec(fixture("boutique.har")), { seed: "har", now: NOW }))
    expect(mock.table.format).toBe("har")
    const users = mock.data.collections["User"] as Array<JsonObject>
    expect(users.map((u) => u["email"])).not.toContain("marie.dubois@example.org")
    expect(String(users[0]!["email"])).toMatch(/@/)
    expect(["active", "invited"]).toContain(users[0]!["status"])
  })
})

describe("db.json de json-server", () => {
  it("les routes de json-server, routes imbriquées comprises", () => {
    expect(isJsonServerDb(json("json-server-db.json"))).toBe(true)
    expect(isJsonServerDb(json("not-openapi.json"))).toBe(false)
    expect(isJsonServerDb({ data: [{ a: 1 }], total: 1 })).toBe(false)
    expect(detect(fixture("json-server-db.json"))).toMatchObject({ ok: true, detection: { format: "json-server" } })
    const paths = pathsOf(converted(jsonServerToOpenApi(json("json-server-db.json"))))
    expect(Object.keys(paths).sort()).toEqual(["/authors", "/authors/{id}", "/authors/{id}/posts", "/comments", "/comments/{id}", "/posts", "/posts/{id}", "/posts/{id}/comments", "/profile"])
    expect(Object.keys(paths["/posts/{id}"]!)).toEqual(["get", "put", "patch", "delete"])
    expect(Object.keys(paths["/profile"]!)).toEqual(["get", "put", "patch"])
    const query = ((paths["/posts"]!["get"] as JsonObject)["parameters"] as Array<JsonObject>).map((p) => p["name"])
    expect(query).toEqual(expect.arrayContaining(["_page", "_sort", "q", "title", "authorId"]))
  })

  it("sert les enregistrements tels qu'écrits", async () => {
    const mock = await Effect.runPromise(compile(fixture("json-server-db.json"), { seed: "db", now: NOW }))
    expect(mock.table.format).toBe("json-server")
    expect(mock.data.collections["Post"]).toEqual(json("json-server-db.json")["posts"])
    expect(mock.data.collections["Comment"]).toHaveLength(3)
    expect((mock.data.collections["Profile"] as Array<JsonObject>)[0]).toEqual({ name: "Boutique Loutre", city: "Lyon" })
  })
})

describe("commandes curl", () => {
  it("découpe le shell : guillemets, $'…', lignes continuées, séparateurs", () => {
    const commands = shellCommands(`curl 'https://a.fr/x' \\\n  -H 'k: v' ;\ncurl -d $'{"n":"L\\u00e9a"}' "https://a.fr/y" && curl https://a.fr/z`)
    expect(commands).toEqual([
      ["curl", "https://a.fr/x", "-H", "k: v"],
      ["curl", "-d", '{"n":"Léa"}', "https://a.fr/y"],
      ["curl", "https://a.fr/z"],
    ])
  })

  it("chaque commande devient une route, les corps donnent les formes", () => {
    const text = fixture("curl-shop.sh.txt")
    expect(looksLikeCurl(text)).toBe(true)
    expect(looksLikeCurl("$ curl https://a.fr")).toBe(true)
    expect(looksLikeCurl(fixture("petstore-3.0.yaml"))).toBe(false)
    expect(detect(text)).toMatchObject({ ok: true, detection: { format: "curl" } })
    const document = converted(curlToOpenApi(text))
    const paths = pathsOf(document)
    expect(Object.keys(paths).sort()).toEqual(["/v1/orders", "/v1/search", "/v1/users", "/v1/users/{id}", "/v1/users/{userId}"])
    expect(Object.keys(paths["/v1/users/{id}"]!)).toEqual(["get", "patch"])
    expect(Object.keys(paths["/v1/users/{userId}"]!)).toEqual(["delete"])
    expect(((paths["/v1/search"]!["get"] as JsonObject)["parameters"] as Array<JsonObject>).map((p) => p["name"])).toEqual(["q", "limit"])
    const user = schemasOf(document)["User"]!["properties"] as Record<string, JsonObject>
    expect(Object.keys(user)).toEqual(["id", "name", "email", "plan", "seats"])
    expect(user["plan"]!["enum"]).toEqual(["pro", "free"])
    expect(Object.keys(schemasOf(document)["Order"]!["properties"] as JsonObject)).toEqual(["id", "user_id", "total", "currency"])
  })

  it("passe le pipeline", async () => {
    const mock = await Effect.runPromise(compile(fixture("curl-shop.sh.txt"), { seed: "curl", now: NOW }))
    expect(mock.table.format).toBe("curl")
    expect(String((mock.data.collections["User"] as Array<JsonObject>)[0]!["email"])).toMatch(/@/)
  })
})

describe("JSON écrit à la main", () => {
  it("une virgule finale ne fait plus refuser le schéma ; un JSON vraiment cassé garde son message", async () => {
    const spec = '{ "openapi": "3.0.3", "info": { "title": "Virgules", "version": "1", }, "paths": { "/ping": { "get": { "responses": { "200": { "description": "ok", }, }, }, }, }, }'
    expect(detect(spec)).toMatchObject({ ok: true, detection: { format: "openapi-3.0" } })
    const mock = await Effect.runPromise(compile(spec, { seed: "v", now: NOW }))
    expect(mock.table.routes.map((r) => r.id)).toEqual(["get:/ping"])
    const broken = detect('{ "openapi": "3.0.3", "info": { "title": ')
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.error.message).toMatch(/^JSON invalide/)
  })
})

describe("OpenAPI 3.2", () => {
  it("détecté, puis ramené en 3.1 : QUERY gardé, querystring et additionalOperations ignorés, itemSchema et dataValue repris", async () => {
    expect(detect(fixture("openapi-3.2-events.yaml"))).toMatchObject({ ok: true, detection: { format: "openapi-3.2", version: "3.2.0" } })
    const mock = await Effect.runPromise(compile(fixture("openapi-3.2-events.yaml"), { seed: "32", now: NOW }))
    expect(mock.table.format).toBe("openapi-3.2")
    const routes = mock.table.routes.map((r) => `${r.method} ${r.path}`).sort()
    expect(routes).toEqual(["get /events", "get /events/{id}", "query /events"])
    const list = mock.table.routes.find((r) => r.path === "/events" && r.method === "get")!
    expect(list.parameters.map((p) => p.name)).toEqual(["since"])
    const events = mock.data.collections["Event"] as Array<JsonObject>
    expect(events.length).toBeGreaterThan(1)
    expect(Array.isArray(mock.data.bodies["get:/events"]?.["200"])).toBe(true)
  })

  it("une opération QUERY est servie en QUERY, et en POST quand le chemin n'en a pas ; elle n'écrit jamais", async () => {
    const mock = await Effect.runPromise(compile(fixture("openapi-3.2-query.yaml"), { seed: "32", now: NOW }))
    expect(mock.table.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["query /flights/search"])
    const search = { origin: "ATL", destination: "LHR", departureDate: "2026-06-15" }
    for (const method of ["QUERY", "POST"]) {
      const served = resolve(mock, {}, { method, pathname: "/flights/search", headers: {}, body: search }, { random: () => 0.5 })
      expect(served.status).toBe(200)
      expect(Array.isArray((served.body as JsonObject)["flights"])).toBe(true)
      expect(writeOp(mock, served.route!, {}, method, served.body)).toBeUndefined()
    }
    expect(resolve(mock, {}, { method: "GET", pathname: "/flights/search", headers: {} }).status).toBe(405)
  })
})
