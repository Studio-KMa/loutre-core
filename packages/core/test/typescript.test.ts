import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { detect } from "../src/detect"
import type { JsonObject } from "../src/model"
import { compile } from "../src/pipeline"
import { looksLikeTypeScript, pluralPath, typescriptToOpenApi } from "../src/typescript"
import { fixture } from "./fixtures"

const NOW = new Date("2026-09-22T10:00:00Z")
const shop = () => fixture("shop-types.ts.txt")
const routes = () => fixture("routes-types.ts.txt")

const schemasOf = (document: JsonObject): Record<string, JsonObject> => (document["components"] as JsonObject)["schemas"] as Record<string, JsonObject>

describe("types TypeScript — détection et conversion", () => {
  it("reconnaît du TypeScript, pas du YAML", () => {
    expect(looksLikeTypeScript(shop())).toBe(true)
    expect(looksLikeTypeScript("openapi: 3.1.0\ninfo:\n  title: x\npaths: {}")).toBe(false)
    expect(looksLikeTypeScript('{"openapi":"3.1.0"}')).toBe(false)
    expect(detect(shop())).toMatchObject({ ok: true, detection: { format: "typescript" } })
  })

  it("convertit interfaces, alias, enums, unions, génériques et JSDoc", () => {
    const result = typescriptToOpenApi(shop())
    if (!result.ok) throw new Error(result.error.message)
    const schemas = schemasOf(result.document)
    expect((result.document["info"] as JsonObject)["title"]).toBe("boutique-ts")
    const user = schemas["User"]!
    expect(user["description"]).toBe("Une personne qui achète chez nous.")
    const properties = user["properties"] as JsonObject
    expect(properties["email"]).toEqual({ type: "string" })
    expect(properties["createdAt"]).toEqual({ type: "string", format: "date-time" })
    expect(properties["status"]).toEqual({ $ref: "#/components/schemas/UserStatus" })
    expect(properties["city"]).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] })
    expect(properties["tags"]).toEqual({ type: "array", items: { type: "string" } })
    expect((properties["name"] as JsonObject)["description"]).toBe("Prénom et nom, tels que saisis.")
    expect(properties["greet"]).toBeUndefined()
    expect(user["required"]).toEqual(["id", "name", "email", "city", "status", "tags", "address", "createdAt", "updatedAt"])
    expect(schemas["UserStatus"]).toEqual({ title: "UserStatus", type: "string", enum: ["active", "invited", "blocked"] })
    expect(schemas["OrderStatus"]).toMatchObject({ type: "string", enum: ["pending", "paid", "shipped"] })
    expect((schemas["Address"]!["properties"] as JsonObject)["country"]).toEqual({ type: "string", enum: ["FR", "BE", "CH"] })
    const order = schemas["Order"]!["properties"] as JsonObject
    expect(order["items"]).toEqual({ type: "array", items: { $ref: "#/components/schemas/OrderLine" } })
    expect(order["notes"]).toEqual({ type: "object", additionalProperties: { type: "string" } })
    expect((order["meta"] as JsonObject)["required"]).toEqual(["source"])
    const create = schemas["CreateUser"]!
    expect(Object.keys(create["properties"] as JsonObject)).not.toContain("id")
    expect(Object.keys(create["properties"] as JsonObject)).toContain("address")
    expect(create["required"]).not.toContain("address")
    const update = schemas["UpdateUser"]!
    expect(Object.keys(update["properties"] as JsonObject)).toEqual(["name", "phone", "status"])
    expect(update["required"]).toBeUndefined()
  })

  it("déduit les routes CRUD des entités, et les corps d'écriture de CreateX / UpdateX", () => {
    const result = typescriptToOpenApi(shop())
    if (!result.ok) throw new Error(result.error.message)
    const paths = result.document["paths"] as Record<string, JsonObject>
    expect(Object.keys(paths).sort()).toEqual(["/orders", "/orders/{id}", "/users", "/users/{id}"])
    expect(Object.keys(paths["/users"]!)).toEqual(["get", "post"])
    expect(Object.keys(paths["/users/{id}"]!)).toEqual(["get", "put", "delete"])
    const post = paths["/users"]!["post"] as JsonObject
    expect(JSON.stringify(post["requestBody"])).toContain("#/components/schemas/CreateUser")
    const put = paths["/users/{id}"]!["put"] as JsonObject
    expect(JSON.stringify(put["requestBody"])).toContain("#/components/schemas/UpdateUser")
    // Address et OrderLine sont des objets imbriqués sans id : pas de routes, mais des composants.
    expect(paths["/addresses"]).toBeUndefined()
    expect(schemasOf(result.document)["Address"]).toBeDefined()
    expect(schemasOf(result.document)["Error"]).toBeDefined()
    expect(result.routes).toBe(10)
  })

  it("lit une carte des routes explicite, avec génériques, corps, statut et query", () => {
    const result = typescriptToOpenApi(routes())
    if (!result.ok) throw new Error(result.error.message)
    const paths = result.document["paths"] as Record<string, JsonObject>
    expect(Object.keys(paths).sort()).toEqual(["/products", "/products/{id}", "/search"])
    const list = (paths["/products"]!["get"] as JsonObject)["responses"] as JsonObject
    const page = ((list["200"] as JsonObject)["content"] as JsonObject)["application/json"] as JsonObject
    const pageSchema = page["schema"] as JsonObject
    expect((pageSchema["properties"] as JsonObject)["items"]).toEqual({ type: "array", items: { $ref: "#/components/schemas/Product" } })
    const post = paths["/products"]!["post"] as JsonObject
    expect(Object.keys(post["responses"] as JsonObject)).toEqual(["201"])
    expect(Object.keys(((post["requestBody"] as JsonObject)["content"] as JsonObject))).toEqual(["application/json"])
    const del = paths["/products/{id}"]!["delete"] as JsonObject
    expect(Object.keys(del["responses"] as JsonObject)).toEqual(["204"])
    const search = paths["/search"]!["get"] as JsonObject
    expect(search["parameters"]).toEqual([
      { name: "q", in: "query", required: true, schema: { type: "string" } },
      { name: "limit", in: "query", required: false, schema: { type: "number" } },
    ])
    expect(schemasOf(result.document)["Api"]).toBeUndefined()
    expect(schemasOf(result.document)["Page"]).toBeUndefined()
  })

  it("explique ses refus : type inconnu avec suggestion, syntaxe, classes, rien à mocker", () => {
    const unknown = typescriptToOpenApi("interface User { id: string; address: Adress }\ninterface Address { city: string }")
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.error.message).toContain("« Adress » n'existe pas")
      expect(unknown.error.message).toContain("ligne 1")
      expect(unknown.error.suggestions[0]).toContain("Address")
    }
    const syntax = typescriptToOpenApi("interface User {\n  id string\n}")
    expect(syntax.ok).toBe(false)
    if (!syntax.ok) expect(syntax.error.message).toContain("ligne 2")
    const klass = typescriptToOpenApi("class User { id = 1 }")
    expect(klass.ok).toBe(false)
    if (!klass.ok) expect(klass.error.message).toContain("class")
    // Des objets de premier niveau sans id restent des entités : chacun reçoit ses routes.
    const topLevel = typescriptToOpenApi("interface Config { debug: boolean }\ninterface Theme { color: string }")
    expect(topLevel.ok).toBe(true)
    if (topLevel.ok) expect(Object.keys(topLevel.document["paths"] as JsonObject).sort()).toEqual(["/configs", "/configs/{id}", "/themes", "/themes/{id}"])
    const nothing = typescriptToOpenApi('enum Color { Red = "red", Blue = "blue" }')
    expect(nothing.ok).toBe(false)
    if (!nothing.ok) expect(nothing.error.message).toContain("Aucune route")
    const empty = typescriptToOpenApi("import { x } from 'y'\nconst a = 1")
    expect(empty.ok).toBe(false)
  })

  it("passe le pipeline complet : données réalistes et cohérentes", async () => {
    const mock = await Effect.runPromise(compile(shop(), { seed: "ts", now: NOW }))
    expect(mock.table.format).toBe("typescript")
    expect(mock.table.routes.map((r) => r.id)).toContain("get:/users/{id}")
    const users = mock.data.collections["User"] as Array<JsonObject>
    expect(users.length).toBeGreaterThan(0)
    const first = users[0]!
    expect(String(first["email"])).toMatch(/@/)
    expect(["active", "invited", "blocked"]).toContain(first["status"])
    expect(Date.parse(String(first["createdAt"]))).toBeLessThanOrEqual(Date.parse(String(first["updatedAt"])))
    expect(typeof (first["address"] as JsonObject)["zip"]).toBe("string")
  })

  it("met au pluriel à la française des développeurs", () => {
    expect(pluralPath("User")).toBe("users")
    expect(pluralPath("OrderLine")).toBe("order-lines")
    expect(pluralPath("Category")).toBe("categories")
    expect(pluralPath("Address")).toBe("addresses")
    expect(pluralPath("HTTPRequest")).toBe("http-requests")
  })
})

describe("types TypeScript — fichiers réels", () => {
  const paths = (source: string): Array<string> => {
    const result = typescriptToOpenApi(source)
    if (!result.ok) throw new Error(result.error.message)
    return Object.keys(result.document["paths"] as JsonObject).sort()
  }
  const schemas = (source: string): Record<string, JsonObject> => {
    const result = typescriptToOpenApi(source)
    if (!result.ok) throw new Error(result.error.message)
    return schemasOf(result.document)
  }

  it("lit les namespaces et les modules déclarés (DefinitelyTyped), noms qualifiés compris", () => {
    const source = `declare namespace SpotifyApi {
      interface ArtistObject { id: string; name: string; images: SpotifyApi.ImageObject[] }
      interface ImageObject { url: string; width?: number }
    }
    declare module "pokedex" { export interface Pokemon { id: number; name: string } }`
    expect(paths(source)).toContain("/artist-objects")
    expect(paths(source)).toContain("/pokemons")
  })

  it("un type importé d'un autre fichier devient un objet opaque ; une faute de frappe reste signalée", () => {
    const source = `import type { ApiCustomEmojiJSON } from "./custom_emoji"\nexport interface Account { id: string; emojis: ApiCustomEmojiJSON[] }`
    const account = schemas(source)["Account"]!
    expect(((account["properties"] as JsonObject)["emojis"] as JsonObject)["items"]).toEqual({ type: "object" })
    const typo = typescriptToOpenApi("interface User { id: string; address: Adress }\ninterface Address { city: string }")
    expect(typo.ok).toBe(false)
  })

  it("saute les utilitaires hors du sous-ensemble (types conditionnels, keyof) et lit le reste", () => {
    const source = `export interface User { id: string; email: string }
    export type Tables<T extends keyof Db> = T extends string ? Db[T] : never
    type Keys = keyof User`
    expect(paths(source)).toEqual(["/users", "/users/{id}"])
  })

  it("ignore méthodes, signatures d'appel et propriétés fonction, lit les template literals comme des chaînes", () => {
    const source = `interface Button { id: string; label: string; onClick: () => void; (event: string): void; new (x: number): Button; slug: \`btn_\${string}\` }`
    const properties = schemas(source)["Button"]!["properties"] as JsonObject
    expect(Object.keys(properties)).toEqual(["id", "label", "slug"])
    expect(properties["slug"]).toEqual({ type: "string" })
  })

  it("résout les accès indexés, lit les types mappés comme des tables, fusionne les interfaces du même nom", () => {
    const source = `interface Address { city: string; zip: string }
    interface User { id: string; address: Address; city: User["address"]["city"]; tags: string[]; first: User["tags"][number]; extra: { [K in "a" | "b"]?: number } }
    interface User { nickname: string }`
    const properties = schemas(source)["User"]!["properties"] as JsonObject
    expect(properties["city"]).toEqual({ type: "string" })
    expect(properties["first"]).toEqual({ type: "string" })
    expect(properties["extra"]).toMatchObject({ type: "object", additionalProperties: { type: "number" } })
    expect(properties["nickname"]).toEqual({ type: "string" })
  })

  it("un générique récursif s'arrête au lieu de faire déborder la pile", () => {
    expect(paths("type Tree<T> = { value: T; children: Tree<T>[] }\ninterface Doc { id: string; tree: Tree<string> }")).toEqual(["/docs", "/docs/{id}"])
  })

  it("une liste qui porte des champs (`Array<T> & { meta }`, Ghost) est servie comme la liste", () => {
    const source = `interface Post { id: string; title: string }\ninterface Feed { id: string; posts: Array<Post> & { meta: { total: number } } }`
    expect((schemas(source)["Feed"]!["properties"] as JsonObject)["posts"]).toMatchObject({ type: "array" })
  })

  it("les types générés par Supabase donnent une ressource par table, Insert et Update comme corps d'écriture", () => {
    const source = `export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]
    export type Database = {
      public: {
        Tables: {
          partners: {
            Row: { id: number; title: string; type: Database["public"]["Enums"]["partner_type"]; meta: Json | null }
            Insert: { id?: never; title: string; type: Database["public"]["Enums"]["partner_type"] }
            Update: { title?: string }
            Relationships: []
          }
        }
        Views: { [_ in never]: never }
        Enums: { partner_type: "technology" | "expert" }
        CompositeTypes: { [_ in never]: never }
      }
    }
    type PublicSchema = Database[Extract<keyof Database, "public">]`
    expect(paths(source)).toEqual(["/partners", "/partners/{id}"])
    const partner = schemas(source)["Partner"]!["properties"] as JsonObject
    expect(partner["type"]).toEqual({ type: "string", enum: ["technology", "expert"] })
  })
})
