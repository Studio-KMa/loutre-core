import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ArrayShape, JsonObject, ObjectShape } from "../src/model"
import { compile } from "../src/pipeline"
import { fixture } from "./fixtures"

const SPEC = `openapi: 3.1.0
info: { title: exemples, version: "1" }
paths:
  /members:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Member' }
  /settings:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                example: { theme: "dark", perPage: 25 }
                properties:
                  theme: { type: string }
                  perPage: { type: integer }
components:
  schemas:
    Member:
      type: object
      required: [id, name, age, email]
      properties:
        id: { type: integer }
        name: { type: string, example: "Ada Lovelace" }
        age: { type: integer, example: 36 }
        email: { type: string, format: email }
        tags: { type: array, items: { type: string }, example: ["math", "engines"] }
`

describe("exemples du schéma", () => {
  it("le premier élément reprend les exemples, les suivants sont générés", async () => {
    const mock = await Effect.runPromise(compile(SPEC, { seed: "ex", now: new Date("2026-09-22T10:00:00Z") }))
    const members = mock.data.collections["Member"] as Array<JsonObject>
    expect(members.length).toBeGreaterThan(2)
    expect(members[0]).toMatchObject({ name: "Ada Lovelace", age: 36, tags: ["math", "engines"] })
    expect(members[1]!["name"]).not.toBe("Ada Lovelace")
    expect(typeof members[1]!["age"]).toBe("number")
    expect(String(members[0]!["email"])).toMatch(/@/)
    const settings = mock.data.bodies["get:/settings"]?.["200"]
    expect(settings).toEqual({ theme: "dark", perPage: 25 })
  })
})

describe("exemples du media type, sans schéma", () => {
  it("la réponse prend la forme de `examples` (exemple officiel api-with-examples)", async () => {
    const mock = await Effect.runPromise(compile(fixture("api-with-examples-3.0.yaml"), { seed: "ex", now: new Date("2026-09-22T10:00:00Z") }))
    const list = mock.data.bodies["get:/"]?.["200"] as JsonObject
    const versions = list["versions"] as Array<JsonObject>
    expect(versions.length).toBeGreaterThan(0)
    expect(typeof versions[0]!["status"]).toBe("string")
    expect(Number.isNaN(Date.parse(String(versions[0]!["updated"])))).toBe(false)
    expect(Array.isArray(versions[0]!["links"])).toBe(true)
    const detail = (mock.data.bodies["get:/v2"]?.["200"] as JsonObject)["version"] as JsonObject
    expect(Array.isArray(detail["media-types"])).toBe(true)

    // Les valeurs montrées deviennent des repères : codes repris, pas de « Rel Lagune ».
    const statuses = new Set(versions.map((v) => v["status"]))
    for (const status of statuses) expect(["CURRENT", "EXPERIMENTAL"]).toContain(status)
    const links = [...versions, detail].flatMap((v) => v["links"] as Array<JsonObject>)
    for (const link of links) expect(["self", "describedby"]).toContain(link["rel"])
    const types = detail["media-types"] as Array<JsonObject>
    for (const media of types) expect(["application/xml", "application/json"]).toContain(media["base"])
    // Tous les éléments d'une liste comptent : `type` n'apparaît qu'à partir du deuxième lien.
    const version = mock.table.routes.find((r) => r.id === "get:/v2")!.responses[0]!.shape as ObjectShape
    const inner = version.properties.find((p) => p.name === "version")!.shape as ObjectShape
    expect(inner.title).toBe("Version")
    const link = (inner.properties.find((p) => p.name === "links")!.shape as ArrayShape).items as ObjectShape
    expect(link.properties.map((p) => p.name)).toEqual(["href", "rel", "type"])
    // `/` et `/v2` parlent de la même entité : une seule forme, celle qui a tous les champs.
    const listed = ((mock.table.routes.find((r) => r.id === "get:/")!.responses[0]!.shape as ObjectShape).properties[0]!.shape as ArrayShape).items as ObjectShape
    expect(listed.properties.map((p) => p.name)).toContain("media-types")
  })

  it("`example` au singulier vaut aussi", async () => {
    const spec = `openapi: 3.0.3
info: { title: exemple, version: "1" }
paths:
  /me:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              example: { name: "Ada Lovelace", email: "ada@example.com", age: 36 }
`
    const mock = await Effect.runPromise(compile(spec, { seed: "ex" }))
    const me = mock.data.bodies["get:/me"]?.["200"] as JsonObject
    expect(typeof me["name"]).toBe("string")
    expect(String(me["email"])).toMatch(/@/)
    expect(typeof me["age"]).toBe("number")
  })
})
