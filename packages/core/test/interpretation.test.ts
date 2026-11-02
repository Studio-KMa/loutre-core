import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ingest } from "../src/ingestion"
import { interpret } from "../src/interpretation"
import { toShape, makeShapeContext } from "../src/interpretation/shape"
import type { ObjectShape, Route, RouteTable } from "../src/model"
import { normalise } from "../src/normalisation"
import { fixture } from "./fixtures"

const table = (file: string): Effect.Effect<RouteTable, unknown> =>
  ingest(fixture(file)).pipe(Effect.flatMap(normalise), Effect.flatMap(interpret))

const route = (t: RouteTable, id: string): Route => {
  const found = t.routes.find((r) => r.id === id)
  if (found === undefined) throw new Error(`route ${id} absente : ${t.routes.map((r) => r.id).join(", ")}`)
  return found
}

const shape = (schema: unknown) => toShape(schema, makeShapeContext(new WeakMap()))

describe("interprétation — table de routes", () => {
  it.effect("petstore 3.0 : trois routes, paramètres et statuts par défaut", () =>
    Effect.gen(function* () {
      const t = yield* table("petstore-3.0.yaml")
      expect(t.info).toMatchObject({ title: "Swagger Petstore", version: "1.0.0" })
      expect(t.routes.map((r) => r.id)).toEqual(["get:/pets", "post:/pets", "get:/pets/{petId}"])

      const list = route(t, "get:/pets")
      expect(list.operationId).toBe("listPets")
      expect(list.parameters).toEqual([
        {
          name: "limit",
          in: "query",
          required: false,
          description: "How many items to return at one time (max 100)",
          shape: { kind: "number", integer: true, maximum: 100 },
        },
      ])
      expect(list.defaultStatus).toBe(200)
      expect(list.responses.map((r) => r.status)).toEqual(["200", "DEFAULT"])
      expect(list.responses[0]?.shape).toMatchObject({
        kind: "array",
        title: "Pets",
        items: { kind: "object", title: "Pet" },
      })

      expect(route(t, "post:/pets").defaultStatus).toBe(201)
      const one = route(t, "get:/pets/{petId}")
      expect(one.parameters).toEqual([
        {
          name: "petId",
          in: "path",
          required: true,
          description: "The id of the pet to retrieve",
          shape: { kind: "string" },
        },
      ])
    }),
  )

  it.effect("petstore étendu : allOf fusionné, corps de requête, 204 sans corps", () =>
    Effect.gen(function* () {
      const t = yield* table("petstore-expanded-3.0.yaml")
      const list = route(t, "get:/pets")
      const items = (list.responses[0]?.shape as { items: ObjectShape }).items
      expect(items.kind).toBe("object")
      expect(items.properties.map((p) => [p.name, p.required])).toEqual([
        ["name", true],
        ["tag", false],
        ["id", true],
      ])
      const create = route(t, "post:/pets")
      expect(create.requestBody).toMatchObject({ contentType: "application/json", required: true })
      expect((create.requestBody?.shape as ObjectShape).title).toBe("NewPet")
      const remove = route(t, "delete:/pets/{id}")
      expect(remove.defaultStatus).toBe(204)
      expect(remove.responses[0]).toEqual({ status: "204", description: "pet deleted" })
    }),
  )

  it.effect("swagger 2.0 converti : 20 opérations, enum de query, multipart", () =>
    Effect.gen(function* () {
      const t = yield* table("petstore-swagger-2.0.json")
      expect(t.routes).toHaveLength(20)
      const byStatus = route(t, "get:/pet/findByStatus")
      expect(byStatus.parameters[0]).toMatchObject({
        name: "status",
        in: "query",
        required: true,
        shape: { kind: "array", items: { kind: "string", enum: ["available", "pending", "sold"] } },
      })
      const upload = route(t, "post:/pet/{petId}/uploadImage")
      expect(upload.requestBody?.contentType).toBe("multipart/form-data")
      expect(route(t, "post:/pet").requestBody?.shape).toMatchObject({ kind: "object", title: "Pet" })
      // addPet ne documente que 405 : on servira 200 sans corps.
      expect(route(t, "post:/pet").defaultStatus).toBe(200)
    }),
  )

  it.effect("github 3.1 : paramètres hérités, nullable, cycles coupés", () =>
    Effect.gen(function* () {
      const t = yield* table("github-issues-3.1.json")
      const issues = route(t, "get:/repos/{owner}/{repo}/issues")
      expect(issues.parameters.filter((p) => p.in === "path").map((p) => p.name)).toEqual(["owner", "repo"])
      const state = issues.parameters.find((p) => p.name === "state")
      expect(state?.shape).toMatchObject({ kind: "string", enum: ["open", "closed", "all"], default: "open" })
      const issue = (issues.responses[0]?.shape as { items: ObjectShape }).items
      expect(issue.title).toBe("Issue")
      const body = issue.properties.find((p) => p.name === "body")
      expect(body?.shape).toMatchObject({ kind: "string", nullable: true })
      const user = route(t, "get:/users/{username}")
      expect(user.responses[0]?.shape?.kind).toBe("union")
    }),
  )

  it.effect("stripe : liste enveloppée, union expandable, formulaire", () =>
    Effect.gen(function* () {
      const t = yield* table("stripe-products-3.0.json")
      const list = route(t, "get:/v1/products")
      const envelope = list.responses[0]?.shape as ObjectShape
      expect(envelope.properties.map((p) => p.name)).toEqual(["data", "has_more", "object", "url"])
      expect(envelope.properties[2]?.shape).toMatchObject({ kind: "const", value: "list" })
      const product = (envelope.properties[0]?.shape as { items: ObjectShape }).items
      expect(product.title).toBe("Product")
      const price = product.properties.find((p) => p.name === "default_price")
      expect(price?.shape).toMatchObject({ kind: "union", nullable: true })
      const create = route(t, "post:/v1/products")
      expect(create.requestBody?.contentType).toBe("application/x-www-form-urlencoded")
    }),
  )

  it.effect("uspto : paramètres de chemin hérités du path item", () =>
    Effect.gen(function* () {
      const t = yield* table("uspto-3.0.yaml")
      const records = route(t, "post:/{dataset}/{version}/records")
      expect(records.parameters.filter((p) => p.in === "path").map((p) => p.name)).toEqual(["version", "dataset"])
      expect(records.requestBody?.contentType).toBe("application/x-www-form-urlencoded")
    }),
  )

  it.effect("un document sans paths est refusé avec une piste", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(table("no-paths-3.1.yaml"))
      expect(error).toMatchObject({ _tag: "InterpretationError", pointer: "#/paths" })
    }),
  )

  it.effect("un document webhooks-only est refusé en le nommant", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(table("webhook-only-3.1.yaml"))
      expect(error).toMatchObject({ _tag: "InterpretationError", pointer: "#/webhooks" })
      expect((error as { message: string }).message).toMatch(/webhooks \(1\)/)
    }),
  )
})

describe("interprétation — formes", () => {
  it("enum à une valeur → const ; enum mixte → union de const", () => {
    expect(shape({ type: "string", enum: ["list"] })).toEqual({ kind: "const", value: "list" })
    expect(shape({ enum: [1, "a"] })).toEqual({
      kind: "union",
      variants: [
        { kind: "const", value: 1 },
        { kind: "const", value: "a" },
      ],
    })
    expect(shape({ enum: ["a", null] })).toEqual({ kind: "const", value: "a", nullable: true })
    expect(shape({ enum: ["a", "b", null] })).toEqual({ kind: "string", enum: ["a", "b"], nullable: true })
  })

  it("type tableau 3.1 → nullable / union", () => {
    expect(shape({ type: ["string", "null"] })).toEqual({ kind: "string", nullable: true })
    expect(shape({ type: ["string", "integer"] })).toEqual({
      kind: "union",
      variants: [{ kind: "string" }, { kind: "number", integer: true }],
    })
  })

  it("infère object/array/string sans type explicite", () => {
    expect(shape({ properties: { a: { type: "boolean" } } })).toMatchObject({ kind: "object" })
    expect(shape({ items: {} })).toEqual({ kind: "array", items: { kind: "unknown" } })
    expect(shape({ format: "email" })).toEqual({ kind: "string", format: "email" })
    expect(shape({})).toEqual({ kind: "unknown" })
    expect(shape(true)).toEqual({ kind: "unknown" })
  })

  it("exclusiveMinimum numérique → minimum", () => {
    expect(shape({ type: "integer", exclusiveMinimum: 0 })).toEqual({ kind: "number", integer: true, minimum: 1 })
    expect(shape({ type: "number", exclusiveMaximum: 1 })).toEqual({ kind: "number", integer: false, maximum: 0.99 })
  })

  it("coupe les cycles en unknown", () => {
    const node: Record<string, unknown> = { type: "object", properties: {} }
    ;(node["properties"] as Record<string, unknown>)["next"] = node
    expect(shape(node)).toEqual({
      kind: "object",
      properties: [{ name: "next", required: false, shape: { kind: "unknown" } }],
    })
  })
})

describe("interprétation — budget de formes", () => {
  /** Quatre propriétés par niveau qui pointent toutes vers le niveau suivant : 4^levels formes une fois développé. */
  const wide = (levels: number): Record<string, unknown> => {
    let node: Record<string, unknown> = { type: "string" }
    for (let i = 0; i < levels; i++) node = { type: "object", properties: { a: node, b: node, c: node, d: node } }
    return node
  }

  it("une première propriété profonde laisse leur forme aux suivantes", () => {
    const ctx = { ...makeShapeContext(new WeakMap()), budget: { remaining: 200 } }
    const charge = toShape({ type: "object", properties: { fee: wide(6), id: { type: "string" }, status: { enum: ["paid", "failed"] }, billing: { type: "object", properties: { email: { type: "string", format: "email" } } } } }, ctx) as ObjectShape
    const kinds = Object.fromEntries(charge.properties.map((p) => [p.name, p.shape.kind]))
    expect(kinds).toEqual({ fee: "object", id: "string", status: "string", billing: "object" })
    expect((charge.properties[3]!.shape as ObjectShape).properties[0]!.shape).toMatchObject({ kind: "string", format: "email" })
  })

  it.effect("l'erreur default garde sa forme derrière une grosse réponse 200", () =>
    Effect.gen(function* () {
      const schemas: Record<string, unknown> = {}
      for (let i = 0; i < 9; i++) {
        const next = i < 8 ? { $ref: `#/components/schemas/S${i + 1}` } : { type: "string" }
        schemas[`S${i}`] = { type: "object", properties: { a: next, b: next, c: next, d: next } }
      }
      const document = {
        openapi: "3.1.0",
        info: { title: "Budget", version: "1" },
        paths: {
          "/customers": {
            get: {
              responses: {
                "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/S0" } } } },
                default: { description: "erreur", content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { message: { type: "string" } } } } } } } },
              },
            },
          },
        },
        components: { schemas },
      }
      const t = yield* ingest(document).pipe(Effect.flatMap(normalise), Effect.flatMap(interpret))
      const error = route(t, "get:/customers").responses.find((r) => r.status === "DEFAULT")!.shape as ObjectShape
      expect(error.properties[0]!.shape).toMatchObject({ kind: "object", properties: [{ name: "message", shape: { kind: "string" } }] })
    }),
  )
})
