import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { generateSync, type Vocabulary } from "../src/generation"
import { ibanValid, luhnValid } from "../src/generation/values"
import { ingest } from "../src/ingestion"
import { interpret } from "../src/interpretation"
import type { JsonObject, RouteTable } from "../src/model"
import { normalise } from "../src/normalisation"
import { fixture } from "./fixtures"

const NOW = new Date("2026-09-18T10:00:00Z")

const tableOf = (input: string | object): Promise<RouteTable> =>
  Effect.runPromise(ingest(input).pipe(Effect.flatMap(normalise), Effect.flatMap(interpret)))

const obj = (v: unknown): JsonObject => v as JsonObject
const arr = (v: unknown): Array<JsonObject> => v as Array<JsonObject>

const ORDERS_SPEC = {
  openapi: "3.1.0",
  info: { title: "Boutique", version: "1.0.0" },
  paths: {
    "/orders": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Order" } } } },
          },
        },
      },
    },
    "/orders/{orderId}": {
      get: {
        parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } },
          "404": { description: "introuvable", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/companies": {
      get: {
        responses: {
          "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Company" } } } },
        },
      },
    },
  },
  components: {
    schemas: {
      Order: {
        type: "object",
        required: ["id", "customer", "items", "subtotal", "tax", "total", "status", "created_at", "updated_at"],
        properties: {
          id: { type: "string" },
          reference: { type: "string" },
          customer: { $ref: "#/components/schemas/Customer" },
          items: { type: "array", items: { $ref: "#/components/schemas/Line" }, minItems: 1 },
          subtotal: { type: "number" },
          tax: { type: "number" },
          total: { type: "number" },
          status: { type: "string", enum: ["pending", "paid", "shipped"] },
          currency: { type: "string" },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
          deleted_at: { type: ["string", "null"], format: "date-time" },
          shipped_on: { type: "string", format: "date" },
        },
      },
      Customer: {
        type: "object",
        properties: {
          id: { type: "integer" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string" },
          avatar_url: { type: "string" },
          address: {
            type: "object",
            properties: {
              street: { type: "string" },
              city: { type: "string" },
              zip: { type: "string" },
              country_code: { type: "string" },
              lat: { type: "number" },
              lng: { type: "number" },
            },
          },
        },
      },
      Line: {
        type: "object",
        properties: {
          product_name: { type: "string" },
          unit_price: { type: "number" },
          quantity: { type: "integer", minimum: 1 },
        },
      },
      Company: {
        type: "object",
        properties: {
          name: { type: "string" },
          slug: { type: "string" },
          siret: { type: "string" },
          siren: { type: "string" },
          iban: { type: "string" },
          vat_number: { type: "string" },
          website: { type: "string" },
          plan: { type: "string" },
          employees_count: { type: "integer", maximum: 50 },
          color: { type: "string" },
          rating: { type: "number", minimum: 0, maximum: 5 },
          code: { type: "string", maxLength: 4 },
          score: { type: "integer", multipleOf: 10, maximum: 100 },
        },
      },
      Error: {
        type: "object",
        properties: { code: { type: "integer" }, message: { type: "string" } },
      },
    },
  },
}

describe("génération — déterminisme", () => {
  it("même seed → mêmes données, seed différente → données différentes", async () => {
    const table = await tableOf(fixture("petstore-3.0.yaml"))
    const a = generateSync(table, { seed: "loutre", now: NOW })
    const b = generateSync(table, { seed: "loutre", now: NOW })
    const c = generateSync(table, { seed: "otter", now: NOW })
    expect(a).toEqual(b)
    expect(a.bodies).not.toEqual(c.bodies)
    expect(a.generatedAt).toBe("2026-09-18T10:00:00Z")
  })
})

describe("génération — petstore", () => {
  it("liste et détail partagent la même collection, ids séquentiels, noms d'animaux", async () => {
    const table = await tableOf(fixture("petstore-3.0.yaml"))
    const data = generateSync(table, { seed: "loutre", now: NOW })
    const pets = arr(data.bodies["get:/pets"]?.["200"])
    expect(pets).toHaveLength(8)
    expect(pets.map((p) => p["id"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    for (const pet of pets) {
      expect(pet["name"]).toMatch(/^[A-ZÉ][a-zéèçîï]+$/)
      expect(typeof pet["tag"]).toBe("string")
    }
    expect(new Set(pets.map((p) => p["name"])).size).toBe(8)
    expect(data.bodies["get:/pets/{petId}"]?.["200"]).toEqual(pets[0])
    expect(data.collections["Pet"]).toEqual(pets)
    // La réponse `default` (Error) parle comme une erreur serveur.
    expect(data.bodies["get:/pets"]?.["DEFAULT"]).toEqual({
      code: 500,
      message: "Une erreur interne est survenue, nos loutres sont dessus.",
    })
  })
})

describe("génération — cohérence", () => {
  it("emails, téléphones, adresses, totaux et dates cohérents", async () => {
    const table = await tableOf(ORDERS_SPEC)
    const data = generateSync(table, { seed: "boutique", now: NOW })
    const orders = arr(data.bodies["get:/orders"]?.["200"])
    expect(orders).toHaveLength(8)
    for (const order of orders) {
      expect(order["id"]).toMatch(/^ord_[0-9a-z]{6}$/)
      expect(order["status"]).toMatch(/^(pending|paid|shipped)$/)
      expect(order["currency"]).toMatch(/^[A-Z]{3}$/)

      const customer = obj(order["customer"])
      const first = String(customer["first_name"])
      const last = String(customer["last_name"])
      expect(String(customer["email"])).toMatch(/^[a-z.]+@[a-z.]+$/)
      expect(String(customer["email"]).startsWith(first.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase())).toBe(true)
      expect(String(customer["email"])).toContain(last.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/ /g, "."))
      expect(customer["phone"]).toMatch(/^\+33 [67] \d{2} \d{2} \d{2} \d{2}$/)
      expect(customer["avatar_url"]).toMatch(/^https:\/\/i\.pravatar\.cc\/150\?u=/)
      const address = obj(customer["address"])
      expect(address["zip"]).toMatch(/^\d{5}$/)
      expect(address["country_code"]).toMatch(/^[A-Z]{2}$/)
      expect(typeof address["lat"]).toBe("number")

      const lines = arr(order["items"])
      expect(lines.length).toBeGreaterThanOrEqual(1)
      const expectedSubtotal = Math.round(lines.reduce((sum, l) => sum + Number(l["unit_price"]) * Number(l["quantity"]), 0) * 100) / 100
      expect(order["subtotal"]).toBe(expectedSubtotal)
      expect(order["tax"]).toBe(Math.round(expectedSubtotal * 0.2 * 100) / 100)
      expect(order["total"]).toBe(Math.round((expectedSubtotal + Number(order["tax"])) * 100) / 100)

      const created = Date.parse(String(order["created_at"]))
      const updated = Date.parse(String(order["updated_at"]))
      expect(created).toBeLessThanOrEqual(updated)
      expect(updated).toBeLessThanOrEqual(NOW.getTime())
      expect(order["created_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      expect(order["shipped_on"]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    // deleted_at est presque toujours null.
    expect(orders.filter((o) => o["deleted_at"] === null).length).toBeGreaterThanOrEqual(6)
    // Le 404 documenté parle d'introuvable.
    expect(data.bodies["get:/orders/{orderId}"]?.["404"]).toEqual({
      code: 404,
      message: "La ressource demandée est introuvable.",
    })
  })

  it("identifiants français valides, contraintes respectées, slug dérivé du nom", async () => {
    const table = await tableOf(ORDERS_SPEC)
    const data = generateSync(table, { seed: "société", now: NOW })
    const company = obj(data.bodies["get:/companies"]?.["200"])
    expect(company["siret"]).toMatch(/^\d{14}$/)
    expect(luhnValid(String(company["siret"]))).toBe(true)
    expect(company["siren"]).toMatch(/^\d{9}$/)
    expect(luhnValid(String(company["siren"]))).toBe(true)
    expect(company["iban"]).toMatch(/^FR\d{25}$/)
    expect(ibanValid(String(company["iban"]))).toBe(true)
    expect(company["vat_number"]).toMatch(/^FR\d{11}$/)
    expect(company["website"]).toMatch(/^https:\/\/[a-z0-9-]+\.fr$/)
    expect(company["plan"]).toMatch(/^(free|pro|team|enterprise)$/)
    expect(Number(company["employees_count"])).toBeLessThanOrEqual(50)
    expect(company["color"]).toMatch(/^#[0-9A-F]{6}$/)
    expect(Number(company["rating"])).toBeLessThanOrEqual(5)
    expect(String(company["code"]).length).toBeLessThanOrEqual(4)
    expect(Number(company["score"]) % 10).toBe(0)
    expect(company["slug"]).toBe(
      String(company["name"]).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    )
  })

  it("le vocabulaire fourni (IA) prime sur les réservoirs", async () => {
    const table = await tableOf(fixture("petstore-3.0.yaml"))
    const vocabulary: Vocabulary = { Pet: { name: ["Rex", "Médor", "Croquette"] } }
    const data = generateSync(table, { seed: "loutre", now: NOW, vocabulary })
    const names = arr(data.bodies["get:/pets"]?.["200"]).map((p) => p["name"])
    expect(new Set(names)).toEqual(new Set(["Rex", "Médor", "Croquette"]))
  })

  it("ne génère que les routes demandées", async () => {
    const table = await tableOf(fixture("petstore-3.0.yaml"))
    const data = generateSync(table, { seed: "loutre", now: NOW, only: ["get:/pets"] })
    expect(Object.keys(data.bodies)).toEqual(["get:/pets"])
  })
})

describe("génération — specs réelles", () => {
  it("stripe : enveloppe de liste, const, timestamps, union expandable", async () => {
    const table = await tableOf(fixture("stripe-products-3.0.json"))
    const data = generateSync(table, { seed: "stripe", now: NOW })
    const list = obj(data.bodies["get:/v1/products"]?.["200"])
    expect(list["object"]).toBe("list")
    expect(list["has_more"]).toBe(false)
    expect(list["url"]).toMatch(/^https?:\/\//)
    const products = arr(list["data"])
    expect(products.length).toBeGreaterThanOrEqual(1)
    for (const product of products) {
      expect(product["object"]).toBe("product")
      expect(typeof product["created"]).toBe("number")
      expect(Number(product["created"])).toBeLessThan(NOW.getTime() / 1000)
      expect(product["default_price"] === null || typeof product["default_price"] === "string").toBe(true)
      expect(typeof product["name"]).toBe("string")
    }
    expect(data.bodies["get:/v1/products/{id}"]?.["200"]).toEqual(products[0])
  })

  it("github : les auteurs des issues viennent de la collection d'utilisateurs", async () => {
    const table = await tableOf(fixture("github-issues-3.1.json"))
    const data = generateSync(table, { seed: "octocat", now: NOW })
    const issues = arr(data.bodies["get:/repos/{owner}/{repo}/issues"]?.["200"])
    expect(issues.length).toBeGreaterThanOrEqual(1)
    const users = data.collections["Simple User"] ?? data.collections["simple-user"]
    expect(users).toBeDefined()
    for (const issue of issues) {
      expect(typeof issue["title"]).toBe("string")
      expect(typeof issue["state"]).toBe("string")
      if (issue["user"] !== null) expect(users).toContainEqual(issue["user"])
      expect(String(issue["html_url"])).toMatch(/^https:\/\//)
    }
  })

  it("swagger 2.0 converti : toutes les routes ont un corps pour leur statut par défaut quand il est documenté", async () => {
    const table = await tableOf(fixture("petstore-swagger-2.0.json"))
    const data = generateSync(table, { seed: "legacy", now: NOW })
    for (const route of table.routes) {
      const documented = route.responses.find((r) => r.status === String(route.defaultStatus))
      if (documented?.shape !== undefined) {
        expect(data.bodies[route.id]?.[String(route.defaultStatus)]).toBeDefined()
      }
    }
    const pet = obj(data.bodies["get:/pet/{petId}"]?.["200"])
    expect(pet["status"]).toMatch(/^(available|pending|sold)$/)
    expect(obj(pet["category"])["name"]).toBeTypeOf("string")
  })
  it("les bornes déclarées priment sur le nom du champ ; auteurs et noms nus lisibles", async () => {
    const table = await tableOf({
      openapi: "3.1.0",
      info: { title: "Médiathèque", version: "1.0.0" },
      paths: {
        "/livres": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Livre" } } } } } } } },
        "/restaurants": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Restaurant" } } } } } } } },
      },
      components: {
        schemas: {
          Livre: {
            type: "object",
            properties: {
              id: { type: "string" },
              pages: { type: "integer", minimum: 64, maximum: 900 },
              montant_penalite: { type: "number", minimum: 0, maximum: 12 },
              author: { type: "string" },
            },
          },
          Restaurant: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
        },
      },
    })
    const data = generateSync(table, { seed: "bornes", now: NOW })
    const livres = arr(data.collections["Livre"])
    for (const livre of livres) {
      expect(livre["pages"]).toBeGreaterThanOrEqual(64)
      expect(livre["pages"]).toBeLessThanOrEqual(900)
      expect(livre["montant_penalite"]).toBeLessThanOrEqual(12)
      expect(String(livre["author"])).toMatch(/^[A-ZÀ-Ý][\p{L}'-]+ [A-ZÀ-Ý][\p{L}' -]+$/u)
    }
    // Plafonnée, la pénalité ne reste pas collée au maximum.
    expect(new Set(livres.map((l) => l["montant_penalite"])).size).toBeGreaterThan(3)
    expect(String(arr(data.collections["Restaurant"])[0]!["name"])).toMatch(/^Restaurant /)
  })
})
