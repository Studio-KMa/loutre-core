/**
 * Bornes du moteur face à un schéma ou une requête hostiles : un anonyme colle le schéma, n'importe qui appelle le
 * mock. Chaque cas vient de l'audit de sécurité du 30 septembre 2026.
 */
import { describe, expect, it } from "vitest"
import { analyseToResult, generateSync, matchRoute, resolve, slimHar, type JsonObject, type MockDefinition, type Route, type RouteTable } from "../src"
import { executeGraphql } from "../src/graphql/execute"
import { MAX_GENERATED_ITEMS } from "../src/generation"
import { suggest } from "../src/util/suggest"

const openapi = (schema: JsonObject, components: JsonObject = {}): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Bornes", version: "1" },
    paths: { "/x": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema } } } } } } },
    components: { schemas: components },
  })

const tableOf = async (spec: string): Promise<RouteTable> => {
  const result = await analyseToResult(spec)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.table
}

const timed = <T>(work: () => T): { value: T; ms: number } => {
  const started = performance.now()
  const value = work()
  return { value, ms: performance.now() - started }
}

describe("schéma hostile", () => {
  it("des références partagées ne font pas exploser la table ni les données", async () => {
    const components: Record<string, JsonObject> = {}
    for (let i = 0; i < 12; i++) {
      const next = i < 11 ? { $ref: `#/components/schemas/S${i + 1}` } : { type: "string" }
      components[`S${i}`] = { type: "object", properties: { a: next, b: next, c: next, d: next } }
    }
    const table = await tableOf(openapi({ $ref: "#/components/schemas/S0" }, components))
    expect(JSON.stringify(table).length).toBeLessThan(12_000_000)
    const { value: data, ms } = timed(() => generateSync(table, { seed: "x" }))
    expect(JSON.stringify(data).length).toBeLessThan(12_000_000)
    expect(ms).toBeLessThan(10_000)
  })

  it("minItems et minLength démesurés sont ramenés à une taille de mock", async () => {
    const table = await tableOf(openapi({ type: "array", minItems: 2_000_000, items: { type: "string", minLength: 5_000_000 } }))
    const body = generateSync(table, { seed: "x" }).bodies["get:/x"]?.["200"] as Array<string>
    expect(body.length).toBeLessThanOrEqual(MAX_GENERATED_ITEMS)
    expect(Math.max(...body.map((s) => s.length))).toBeLessThanOrEqual(4096)
  })

  it("des listes imbriquées s'arrêtent au budget de valeurs", async () => {
    let schema: JsonObject = { type: "string" }
    for (let i = 0; i < 9; i++) schema = { type: "array", minItems: 100, items: schema }
    const table = await tableOf(openapi(schema))
    const { value: data, ms } = timed(() => generateSync(table, { seed: "x" }))
    expect(JSON.stringify(data).length).toBeLessThan(12_000_000)
    expect(ms).toBeLessThan(10_000)
  })

  it("les suggestions « vouliez-vous dire » ignorent les noms démesurés", () => {
    const long = "a".repeat(20_000)
    const { value, ms } = timed(() => suggest(long, [`${long}b`]))
    expect(value).toEqual([])
    expect(ms).toBeLessThan(100)
    expect(suggest("Usr", ["User", "Order"])).toEqual(["User"])
  })

  it("une propriété nommée __proto__ reste un champ", async () => {
    const properties = JSON.parse('{"__proto__": {"type": "object", "properties": {"id": {"type": "integer"}}}, "name": {"type": "string"}}') as JsonObject
    const table = await tableOf(openapi({ type: "object", properties }))
    const body = generateSync(table, { seed: "x" }).bodies["get:/x"]?.["200"] as Record<string, unknown>
    expect(Object.hasOwn(body, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype)
  })
})

describe("requête hostile", () => {
  const route = (path: string): Route => ({ id: `get:${path}`, method: "get", path, responses: [], parameters: [], defaultStatus: 200 }) as unknown as Route

  it("un segment à plusieurs paramètres se lit sans explosion", () => {
    const template = `/${Array.from({ length: 8 }, (_, i) => `{p${i}}`).join("")}.json`
    const { ms } = timed(() => {
      for (let i = 0; i < 300; i++) matchRoute([route(template)], "GET", `/${"a".repeat(120)}.jsox`)
    })
    expect(ms).toBeLessThan(1000)
    expect(matchRoute([route("/files/{name}.{ext}")], "GET", "/files/report.final.pdf")?.params).toEqual({ name: "report.final", ext: "pdf" })
    expect(matchRoute([route("/v{version}/items")], "GET", "/v2/items")?.params).toEqual({ version: "2" })
  })

  it("une règle sur un en-tête nommé constructor ne fait pas planter le mock", async () => {
    const table = await tableOf(openapi({ type: "string" }))
    const mock: MockDefinition = { version: 1, table, data: generateSync(table, { seed: "x" }) }
    const behavior = { routes: { "get:/x": { rules: [{ when: { header: { constructor: "x" }, query: { toString: "y" } }, status: 418 }] } } }
    const result = resolve(mock, behavior, { method: "GET", pathname: "/x", headers: {}, query: {} })
    expect(result.status).toBe(200)
  })

  it("GraphQL : requête trop longue refusée, profondeur comptée à travers les fragments", async () => {
    const table = await tableOf("type Query { users: [User!]! }\ntype User { id: ID!, friends: [User!]! }")
    const mock: MockDefinition = { version: 1, table, data: generateSync(table, { seed: "x" }) }
    const huge = `{ users { ${"id ".repeat(10_000)} } }`
    expect(executeGraphql(mock, { query: huge, variables: undefined, operationName: undefined }).status).toBe(413)
    const fragments = Array.from({ length: 12 }, (_, i) => `fragment F${i} on User { friends { ${i < 11 ? `...F${i + 1}` : "id"} } }`).join("\n")
    const deep = executeGraphql(mock, { query: `{ users { ...F0 } }\n${fragments}`, variables: undefined, operationName: undefined })
    expect(JSON.stringify(deep.body)).toMatch(/trop profonde/)
  })
})

describe("HAR", () => {
  it("rien de ce qui a été enregistré ne sort du navigateur, hors formes et catégories", () => {
    const har = {
      log: {
        version: "1.2",
        entries: [
          {
            request: {
              method: "POST",
              url: "https://alice:hunter2@api.example.com/users/alice@example.com/login?access_token=SECRET&page=2",
              headers: [{ name: "authorization", value: "Bearer SECRET" }],
              postData: { mimeType: "application/json", text: JSON.stringify({ email: "alice@example.com", password: "hunter2" }) },
            },
            response: {
              status: 200,
              headers: [],
              content: { mimeType: "application/json", text: JSON.stringify({ id: 7, name: "Alice Martin", status: "active", created_at: "2026-09-01T10:00:00Z" }) },
            },
          },
        ],
      },
    }
    const slim = JSON.stringify(slimHar(har as unknown as JsonObject))
    for (const secret of ["SECRET", "hunter2", "alice", "Alice", "Martin"]) expect(slim).not.toContain(secret)
    expect(slim).toContain("access_token=")
    expect(slim).toContain("active")
    expect(slim).toContain("user@example.com")
  })
})
