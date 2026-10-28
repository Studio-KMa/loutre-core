import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { detect } from "../src/detect"
import type { JsonObject } from "../src/model"
import { compile } from "../src/pipeline"
import { isPostmanCollection, postmanToOpenApi } from "../src/postman"
import { inferSchema, titleFromName } from "../src/util/infer-schema"
import { fixture } from "./fixtures"

const NOW = new Date("2026-09-22T10:00:00Z")
const collection = (): JsonObject => JSON.parse(fixture("postman-shop.json")) as JsonObject

describe("collections Postman", () => {
  it("détecte une collection v2.1 et la convertit route par route", () => {
    expect(isPostmanCollection(collection())).toBe(true)
    expect(detect(fixture("postman-shop.json"))).toMatchObject({ ok: true, detection: { format: "postman", version: "2.1" } })
    const result = postmanToOpenApi(collection())
    if (!result.ok) throw new Error(result.error.message)
    expect(result.requests).toBe(4)
    const paths = result.document["paths"] as Record<string, JsonObject>
    expect(Object.keys(paths).sort()).toEqual(["/health", "/users", "/users/{id}"])
    const list = paths["/users"]!["get"] as JsonObject
    expect(list["tags"]).toEqual(["Users"])
    expect((list["parameters"] as Array<JsonObject>).map((p) => p["name"])).toEqual(["page", "limit"])
    const schemas = (result.document["components"] as JsonObject)["schemas"] as Record<string, JsonObject>
    const user = schemas["User"]!
    expect((user["properties"] as JsonObject)["email"]).toEqual({ type: "string", format: "email" })
    expect((user["properties"] as JsonObject)["created_at"]).toEqual({ type: "string", format: "date-time" })
    expect((user["properties"] as JsonObject)["active"]).toEqual({ type: "boolean" })
    const detail = paths["/users/{id}"]!["get"] as JsonObject
    expect(Object.keys(detail["responses"] as JsonObject).sort()).toEqual(["200", "404"])
    const post = paths["/users"]!["post"] as JsonObject
    expect(post["requestBody"]).toBeDefined()
    expect(Object.keys(post["responses"] as JsonObject)).toEqual(["201"])
    expect(Object.keys(paths["/health"]!["get"] as JsonObject)).toContain("responses")
  })

  it("refuse une collection sans requête, avec un conseil", () => {
    const empty = postmanToOpenApi({ info: { name: "vide" }, item: [{ name: "dossier", item: [] }] })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.suggestions.length).toBeGreaterThan(0)
  })

  it("déduit des schémas d'exemples, avec formats et titres", () => {
    expect(inferSchema({ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", url: "https://x.fr", n: 2.5, items: [{ a: 1 }] }, "Order")).toEqual({
      type: "object",
      title: "Order",
      properties: { id: { type: "string", format: "uuid" }, url: { type: "string", format: "uri" }, n: { type: "number" }, items: { type: "array", items: { type: "object", title: "Item", properties: { a: { type: "integer" } }, required: ["a"] } } },
      required: ["id", "url", "n", "items"],
    })
    expect(titleFromName("order-lines")).toBe("OrderLine")
    expect(titleFromName("categories")).toBe("Category")
  })

  it("passe le pipeline : la liste et le détail partagent la même collection", async () => {
    const mock = await Effect.runPromise(compile(fixture("postman-shop.json"), { seed: "pm", now: NOW }))
    expect(mock.table.format).toBe("postman")
    expect(mock.table.info.title).toBe("Boutique")
    expect(mock.data.sources["get:/users/{id}"]).toBe("User")
    expect(mock.data.sources["get:/users"]).toBe("User")
    const users = mock.data.collections["User"] as Array<JsonObject>
    expect(String(users[0]!["email"])).toMatch(/@/)
  })
})
