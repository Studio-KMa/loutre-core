import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { parse as parseYaml } from "yaml"
import { brunoToOpenApi, bruToOpenApi, isBrunoCollection, looksLikeBru } from "../src/bruno"
import { collectionToOpenApi, pathFromRaw, type Collected } from "../src/collections"
import { detect, readDocument } from "../src/detect"
import { insomniaToOpenApi, isInsomniaExport } from "../src/insomnia"
import type { JsonObject } from "../src/model"
import { compile } from "../src/pipeline"
import { fixture } from "./fixtures"

const NOW = new Date("2026-09-24T10:00:00Z")
const json = (name: string): JsonObject => JSON.parse(fixture(name)) as JsonObject
const yaml = (name: string): JsonObject => parseYaml(fixture(name)) as JsonObject

const converted = (result: { ok: boolean }): JsonObject => {
  if (!result.ok || !("document" in result)) throw new Error(JSON.stringify(result))
  return result.document as JsonObject
}
const pathsOf = (document: JsonObject): Record<string, JsonObject> => document["paths"] as Record<string, JsonObject>
const schemasOf = (document: JsonObject): Record<string, JsonObject> => (document["components"] as JsonObject)["schemas"] as Record<string, JsonObject>
const responseSchema = (operation: unknown, code: string): JsonObject =>
  ((((operation as JsonObject)["responses"] as JsonObject)[code] as JsonObject)["content"] as JsonObject)["application/json"] as JsonObject

describe("chemins des collections", () => {
  it("ramène les variables de chaque outil à la syntaxe OpenAPI", () => {
    expect(pathFromRaw("{{baseUrl}}/users/:id?page=1&limit=2")).toEqual({ path: "/users/{id}", query: ["page", "limit"] })
    expect(pathFromRaw("{{ _.baseUrl }}/users/{{ _.userId }}/orders")).toEqual({ path: "/users/{userId}/orders", query: [] })
    expect(pathFromRaw("https://api.boutique.fr/v1/orders")).toEqual({ path: "/v1/orders", query: [] })
  })
})

describe("valeurs montrées par la collection", () => {
  const request = (method: string, path: string, body: JsonObject): Collected => ({ method, path, name: `${method} ${path}`, description: undefined, tags: [], query: [], body, responses: [] })
  const collected: Array<Collected> = [
    request("post", "/biens", { titre: "T3 lumineux avec balcon", type: "appartement", transaction: "vente", dpe: "C", prix: 329000, pieces: 3, annee: 1998, adresse: "14 rue Paul Bert", reference: "VLV-2024-00831", latitude: 45.75 }),
    request("put", "/biens/{id}", { type: "maison", transaction: "location", dpe: "E", prix: 1250 }),
  ]

  it("ordres de grandeur, vocabulaire et premier exemple repris", () => {
    const bien = ((collectionToOpenApi(collected, { title: "immo", version: "1" }).document["components"] as JsonObject)["schemas"] as Record<string, JsonObject>)["Bien"]!
    const properties = bien["properties"] as Record<string, JsonObject>
    expect(properties["type"]!["enum"]).toEqual(["appartement", "maison"])
    expect(properties["dpe"]!["enum"]).toEqual(["C", "E"])
    expect(properties["prix"]).toMatchObject({ minimum: 625, maximum: 493500 })
    expect(properties["prix"]!["example"]).toBeUndefined()
    expect(properties["pieces"]).toMatchObject({ minimum: 1, maximum: 5 })
    expect(properties["annee"]).toMatchObject({ minimum: 1978, maximum: 1998 })
    // Texte libre, adresse, référence : de la variété, avec l'exemple pour le premier élément.
    expect(properties["titre"]).toMatchObject({ example: "T3 lumineux avec balcon" })
    expect(properties["titre"]!["enum"]).toBeUndefined()
    expect(properties["adresse"]).toEqual({ type: "string" })
    expect(properties["reference"]!["enum"]).toBeUndefined()
    expect(properties["latitude"]!["minimum"]).toBeUndefined()
  })

  it("le mock généré reste dans ce que la collection montre", async () => {
    const mock = await Effect.runPromise(compile(fixture("bruno-shop.json"), { seed: "vals", now: NOW }))
    expect(mock.table.format).toBe("bruno")
    const text = `meta {\n  name: immo\n  type: collection\n}\n\nmeta {\n  name: Publier\n  type: http\n}\n\npost {\n  url: {{baseUrl}}/biens\n}\n\nbody:json {\n  ${JSON.stringify({ titre: "T3 lumineux", type: "appartement", prix: 329000, pieces: 3 })}\n}\n`
    const immo = await Effect.runPromise(compile(text, { seed: "vals", now: NOW }))
    const biens = immo.data.collections["Bien"] as Array<JsonObject>
    expect(biens[0]!["titre"]).toBe("T3 lumineux")
    expect(new Set(biens.map((b) => b["prix"])).size).toBeGreaterThan(3)
    for (const bien of biens) {
      expect(bien["type"]).toBe("appartement")
      expect(bien["prix"]).toBeGreaterThanOrEqual(164500)
      expect(bien["prix"]).toBeLessThanOrEqual(493500)
    }
  })
})

describe("exports Insomnia", () => {
  it("v4 : requêtes, dossiers, paramètres ; WebSocket laissé de côté", () => {
    expect(isInsomniaExport(json("insomnia-v4-shop.json"))).toBe(true)
    expect(detect(fixture("insomnia-v4-shop.json"))).toMatchObject({ ok: true, detection: { format: "insomnia", version: "4" } })
    const document = converted(insomniaToOpenApi(json("insomnia-v4-shop.json")))
    expect((document["info"] as JsonObject)["title"]).toBe("Boutique")
    const paths = pathsOf(document)
    expect(Object.keys(paths).sort()).toEqual(["/orders", "/users", "/users/{id}", "/users/{userId}"])
    const list = paths["/users"]!["get"] as JsonObject
    expect(list["tags"]).toEqual(["Users"])
    expect((list["parameters"] as Array<JsonObject>).map((p) => p["name"])).toEqual(["page", "limit"])
    // Le dossier « Admin » est rangé sous « Users » : l'étiquette reste celle du dossier du haut.
    expect((paths["/users/{id}"]!["delete"] as JsonObject)["tags"]).toEqual(["Users"])
    expect(Object.keys((paths["/users/{id}"]!["delete"] as JsonObject)["responses"] as JsonObject)).toEqual(["204"])
  })

  it("sans exemple de réponse, la liste renvoie la ressource créée par POST, identifiant compris", () => {
    const document = converted(insomniaToOpenApi(json("insomnia-v4-shop.json")))
    const paths = pathsOf(document)
    expect(responseSchema(paths["/users"]!["get"], "200")["schema"]).toEqual({ type: "array", items: { $ref: "#/components/schemas/User" } })
    expect(responseSchema(paths["/users/{userId}"]!["get"], "200")["schema"]).toEqual({ $ref: "#/components/schemas/User" })
    const user = schemasOf(document)["User"]!
    expect(Object.keys(user["properties"] as JsonObject)).toEqual(["id", "name", "email", "created_at", "active"])
    expect((user["properties"] as JsonObject)["email"]).toEqual({ type: "string", format: "email" })
    // Un formulaire devient un objet, comme le reçoit le serveur.
    expect(Object.keys(schemasOf(document)["Order"]!["properties"] as JsonObject)).toEqual(["id", "user_id", "total"])
  })

  it("v5 YAML : dossiers imbriqués, paramètres désactivés et WebSocket ignorés", () => {
    expect(isInsomniaExport(yaml("insomnia-v5-shop.yaml"))).toBe(true)
    expect(detect(fixture("insomnia-v5-shop.yaml"))).toMatchObject({ ok: true, detection: { format: "insomnia", version: "5.1" } })
    const document = converted(insomniaToOpenApi(yaml("insomnia-v5-shop.yaml")))
    const paths = pathsOf(document)
    expect(Object.keys(paths).sort()).toEqual(["/health", "/users", "/users/{id}"])
    const list = paths["/users"]!["get"] as JsonObject
    expect((list["parameters"] as Array<JsonObject>).map((p) => p["name"])).toEqual(["page"])
    expect(list["tags"]).toEqual(["Users"])
    expect(Object.keys(paths["/users"]!)).toEqual(["get", "post"])
  })

  it("un document de design embarque sa spécification : on lit celle-ci", () => {
    const read = readDocument(fixture("insomnia-v5-spec.yaml"))
    expect(read.ok && read.detected === undefined && (read.document["info"] as JsonObject)["title"] === "Boutique design").toBe(true)
    expect(detect(fixture("insomnia-v5-spec.yaml"))).toMatchObject({ ok: true, detection: { format: "openapi-3.0", version: "3.0.3" } })
  })

  it("refuse un export sans requête HTTP, avec un conseil", () => {
    const empty = insomniaToOpenApi({ _type: "export", resources: [{ _id: "wrk", _type: "workspace", name: "vide" }] })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.suggestions[0]).toMatch(/Insomnia/)
  })

  it("passe le pipeline avec des données réalistes", async () => {
    const mock = await Effect.runPromise(compile(fixture("insomnia-v4-shop.json"), { seed: "in", now: NOW }))
    expect(mock.table.format).toBe("insomnia")
    const users = mock.data.collections["User"] as Array<JsonObject>
    expect(users.length).toBeGreaterThan(1)
    expect(String(users[0]!["email"])).toMatch(/@/)
    expect(users[0]!["id"]).toBeDefined()
  })
})

describe("collections Bruno", () => {
  it("export JSON : dossiers, exemples de réponse, gRPC laissé de côté", () => {
    expect(isBrunoCollection(json("bruno-shop.json"))).toBe(true)
    expect(detect(fixture("bruno-shop.json"))).toMatchObject({ ok: true, detection: { format: "bruno", version: "1" } })
    const document = converted(brunoToOpenApi(json("bruno-shop.json")))
    const paths = pathsOf(document)
    expect(Object.keys(paths).sort()).toEqual(["/health", "/users", "/users/{id}"])
    const list = paths["/users"]!["get"] as JsonObject
    expect(list["description"]).toBe("Liste paginée des clients.")
    expect((list["parameters"] as Array<JsonObject>).map((p) => p["name"])).toEqual(["page"])
    const user = schemasOf(document)["User"]!
    // L'exemple de la liste l'emporte sur le corps envoyé : il montre ce que le serveur renvoie.
    expect(Object.keys(user["properties"] as JsonObject)).toEqual(["id", "name", "email", "city", "created_at"])
    expect(Object.keys((paths["/users/{id}"]!["get"] as JsonObject)["responses"] as JsonObject)).toEqual(["404"])
  })

  it("fichiers .bru collés à la suite, entrée désactivée ignorée", () => {
    const text = fixture("bruno-users.bru.txt")
    expect(looksLikeBru(text)).toBe(true)
    expect(looksLikeBru(fixture("petstore-3.0.yaml"))).toBe(false)
    expect(detect(text)).toMatchObject({ ok: true, detection: { format: "bruno", version: "bru" } })
    const document = converted(bruToOpenApi(text))
    const paths = pathsOf(document)
    expect(Object.keys(paths).sort()).toEqual(["/users", "/users/{id}"])
    const list = paths["/users"]!["get"] as JsonObject
    expect(list["summary"]).toBe("List users")
    expect(list["description"]).toBe("Liste paginée des clients.")
    expect((list["parameters"] as Array<JsonObject>).map((p) => p["name"])).toEqual(["page"])
    expect(responseSchema(list, "200")["schema"]).toEqual({ type: "array", items: { $ref: "#/components/schemas/User" } })
    expect(Object.keys(schemasOf(document)["User"]!["properties"] as JsonObject)).toEqual(["id", "name", "email", "created_at"])
  })

  it("un bloc meta de type collection (tiré de bruno.json) nomme le mock", () => {
    const text = `meta {\n  name: agence-immo\n  type: collection\n}\n\n${fixture("bruno-users.bru.txt")}`
    expect((converted(bruToOpenApi(text))["info"] as JsonObject)["title"]).toBe("agence-immo")
    expect((converted(bruToOpenApi(fixture("bruno-users.bru.txt")))["info"] as JsonObject)["title"]).toBe("collection-bruno")
  })

  it("passe le pipeline depuis des fichiers .bru", async () => {
    const mock = await Effect.runPromise(compile(fixture("bruno-users.bru.txt"), { seed: "br", now: NOW }))
    expect(mock.table.format).toBe("bruno")
    expect(mock.data.sources["get:/users/{id}"]).toBe("User")
    const users = mock.data.collections["User"] as Array<JsonObject>
    expect(String(users[0]!["email"])).toMatch(/@/)
  })
})
