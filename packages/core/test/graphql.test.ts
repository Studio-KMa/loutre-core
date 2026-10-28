import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { buildSchema, introspectionFromSchema } from "graphql"
import { detect, isIntrospection, looksLikeGraphql } from "../src/detect"
import { answerGraphql, executeGraphql, type GraphqlWrite } from "../src/graphql/execute"
import type { Json, JsonObject, MockDefinition } from "../src/model"
import { compile } from "../src/pipeline"
import { applyOp } from "../src/state"
import { fixture } from "./fixtures"

const NOW = new Date("2026-09-24T10:00:00Z")
const SDL = fixture("graphql-shop.graphql")
const mockOf = (source: string): Promise<MockDefinition> => Effect.runPromise(compile(source, { seed: "gql", now: NOW }))
const run = (mock: MockDefinition, query: string, variables?: Record<string, unknown>, collections?: Record<string, ReadonlyArray<Json>>) =>
  executeGraphql(mock, { query, variables, operationName: undefined }, { collections, random: () => 0.5 })
const data = (result: { body: JsonObject }): JsonObject => {
  expect(result.body["errors"]).toBeUndefined()
  return result.body["data"] as JsonObject
}
const request = (method: string, pathname: string, body?: Json, headers: Record<string, string> = {}, query?: Record<string, string>) => ({ method, pathname, headers, body, query })

describe("GraphQL : détection", () => {
  it("reconnaît le SDL et l'introspection, jamais des types TypeScript", () => {
    expect(looksLikeGraphql(SDL)).toBe(true)
    expect(looksLikeGraphql("type Query = { users: User[] }")).toBe(false)
    expect(looksLikeGraphql(fixture("shop-types.ts.txt"))).toBe(false)
    expect(detect(SDL)).toMatchObject({ ok: true, detection: { format: "graphql" } })
    const introspection = { data: introspectionFromSchema(buildSchema(SDL)) } as unknown as JsonObject
    expect(isIntrospection(introspection)).toBe(true)
    expect(detect(JSON.stringify(introspection))).toMatchObject({ ok: true, detection: { format: "graphql" } })
  })

  it("un SDL invalide dit où et pourquoi", async () => {
    const failure = await Effect.runPromise(Effect.flip(compile("type Query { users: [Userr!]! }\ntype User { id: ID! }", { seed: "x" })))
    expect(failure.message).toMatch(/Userr/)
  })
})

describe("GraphQL : le mock", () => {
  it("génère une collection par type, le SDL voyage dans la table", async () => {
    const mock = await mockOf(SDL)
    expect(mock.table.format).toBe("graphql")
    expect(mock.table.info.title).toBe("boutique-graphql")
    expect(mock.table.graphql?.path).toBe("/graphql")
    expect(mock.table.graphql?.sdl).toContain("type User implements Node")
    const users = mock.data.collections["User"] as Array<JsonObject>
    expect(users.length).toBeGreaterThan(3)
    expect(String(users[0]!["email"])).toMatch(/@/)
    expect(users[0]!["__typename"]).toBe("User")
    expect(["ADMIN", "EDITOR", "CUSTOMER"]).toContain(users[0]!["role"])
  })

  it("listes, filtres, détail par id, liens entre types", async () => {
    const mock = await mockOf(SDL)
    const all = data(run(mock, "{ users { id name email role createdAt } }"))["users"] as Array<JsonObject>
    expect(all.length).toBe((mock.data.collections["User"] as Array<unknown>).length)
    const admins = data(run(mock, "{ users(role: ADMIN) { role } }"))["users"] as Array<JsonObject>
    expect(admins.every((u) => u["role"] === "ADMIN")).toBe(true)
    expect((data(run(mock, "{ users(first: 2, offset: 1) { id } }"))["users"] as Array<unknown>).length).toBe(2)
    const id = String(all[1]!["id"])
    const one = data(run(mock, "query ($id: ID!) { user(id: $id) { id name } }", { id }))["user"] as JsonObject
    expect(one["id"]).toBe(id)
    // Les liens sont cohérents dans les deux sens : les articles d'un auteur ont cet auteur, et son id.
    const authors = data(run(mock, "{ users { id posts { authorId author { id } } } }"))["users"] as Array<JsonObject>
    const posts = authors.flatMap((user) => (user["posts"] as Array<JsonObject>).map((post) => [user["id"], post] as const))
    expect(posts.length).toBeGreaterThan(0)
    for (const [userId, post] of posts) {
      expect(post["authorId"]).toBe(userId)
      expect((post["author"] as JsonObject)["id"]).toBe(userId)
    }
    expect(data(run(mock, '{ user(id: "inconnu") { id } }'))["user"]).toBeNull()
    // Même requête, même réponse.
    expect(run(mock, "{ me { posts { title } } }").body).toEqual(run(mock, "{ me { posts { title } } }").body)
  })

  it("connexions Relay, unions et interfaces", async () => {
    const mock = await mockOf(SDL)
    const page = data(run(mock, "{ posts(first: 2) { totalCount edges { cursor node { id title } } pageInfo { hasNextPage endCursor } } }"))["posts"] as JsonObject
    expect((page["edges"] as Array<unknown>).length).toBe(2)
    expect((page["pageInfo"] as JsonObject)["hasNextPage"]).toBe(true)
    const after = String((page["pageInfo"] as JsonObject)["endCursor"])
    const next = data(run(mock, "query ($after: String) { posts(first: 2, after: $after) { edges { node { id } } } }", { after }))["posts"] as JsonObject
    const firstIds = (page["edges"] as Array<JsonObject>).map((e) => (e["node"] as JsonObject)["id"])
    expect((next["edges"] as Array<JsonObject>).map((e) => (e["node"] as JsonObject)["id"])).not.toContain(firstIds[0])
    const found = data(run(mock, '{ search(text: "a") { __typename ... on User { email } ... on Post { title } } }'))["search"] as Array<JsonObject>
    expect(found.length).toBeGreaterThan(0)
    for (const item of found) expect(["User", "Post"]).toContain(item["__typename"])
    const userId = String((mock.data.collections["User"] as Array<JsonObject>)[0]!["id"])
    expect(data(run(mock, `{ node(id: "${userId}") { __typename id } }`))["node"]).toEqual({ __typename: "User", id: userId })
  })

  it("mutations : écritures rendues à l'appelant et visibles ensuite", async () => {
    const mock = await mockOf(SDL)
    const created = run(mock, 'mutation { createUser(input: { name: "Nina Loutre", email: "nina@loutre.run", role: EDITOR }) { id name email role createdAt } }')
    const user = data(created)["createUser"] as JsonObject
    expect(user).toMatchObject({ name: "Nina Loutre", email: "nina@loutre.run", role: "EDITOR" })
    expect(user["id"]).toBeTruthy()
    expect(created.writes).toHaveLength(1)
    expect(created.writes[0]).toMatchObject({ source: "User", op: { kind: "insert" } })
    // L'état appliqué, la liste suivante le montre.
    const state = apply(mock, created.writes)
    const users = data(run(mock, "{ users { email } }", undefined, state))["users"] as Array<JsonObject>
    expect(users.map((u) => u["email"])).toContain("nina@loutre.run")
    const updated = run(mock, `mutation { updateUser(id: "${String(user["id"])}", input: { name: "Nina L.", email: "nina@loutre.run" }) { name } }`, undefined, state)
    expect(data(updated)["updateUser"]).toEqual({ name: "Nina L." })
    const removed = run(mock, `mutation { deleteUser(id: "${String(user["id"])}") }`, undefined, apply(mock, updated.writes, state))
    expect(data(removed)["deleteUser"]).toBe(true)
    const author = String((mock.data.collections["User"] as Array<JsonObject>)[2]!["id"])
    const payload = run(mock, `mutation { createPost(title: "Nouveau", authorId: "${author}") { post { title authorId author { id } } errors } }`)
    expect(data(payload)["createPost"]).toEqual({ post: { title: "Nouveau", authorId: author, author: { id: author } }, errors: [] })
    const missing = run(mock, 'mutation { deleteUser(id: "nope") }')
    expect((missing.body["errors"] as Array<JsonObject>)[0]!["message"]).toMatch(/nope/)
  })

  it("requêtes invalides, trop profondes : des erreurs GraphQL, pas un plantage", async () => {
    const mock = await mockOf(SDL)
    expect(run(mock, "{ users { ").status).toBe(400)
    const unknown = run(mock, "{ users { password } }")
    expect(unknown.status).toBe(400)
    expect(JSON.stringify(unknown.body)).toMatch(/password/)
    const deep = "{ me { posts { author { posts { author { posts { author { posts { author { posts { author { id } } } } } } } } } } } }"
    expect(JSON.stringify(run(mock, deep).body)).toMatch(/trop profonde/)
  })

  it("le point d'accès : chemin, GET, statut forcé, chemin réglable", async () => {
    const mock = await mockOf(SDL)
    const ok = answerGraphql(mock, {}, request("POST", "/graphql", { query: "{ stats }" }))
    expect(ok.status).toBe(200)
    expect(typeof ((ok.body as JsonObject)["data"] as JsonObject)["stats"]).toBe("number")
    expect(answerGraphql(mock, {}, request("GET", "/graphql", undefined, {}, { query: "{ me { id } }" })).status).toBe(200)
    expect(answerGraphql(mock, {}, request("GET", "/graphql", undefined, {}, { query: "mutation { deleteUser(id: \"x\") }" })).status).toBe(405)
    expect(answerGraphql(mock, {}, request("POST", "/users", { query: "{ stats }" })).status).toBe(404)
    const forced = answerGraphql(mock, {}, request("POST", "/graphql", { query: "{ stats }" }, { "x-loutre-status": "503" }))
    expect(forced.status).toBe(503)
    expect(((forced.body as JsonObject)["errors"] as Array<JsonObject>)[0]!["extensions"]).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 503 })
    const moved = { graphqlPath: "/api/v2/gql" }
    expect(answerGraphql(mock, moved, request("POST", "/api/v2/gql", { query: "{ stats }" })).status).toBe(200)
    expect(answerGraphql(mock, moved, request("POST", "/graphql", { query: "{ stats }" })).status).toBe(404)
    const counted = answerGraphql(mock, {}, request("POST", "/graphql", { query: "{ users { id } }" }, { "x-loutre-count": "0" }))
    expect(((counted.body as JsonObject)["data"] as JsonObject)["users"]).toEqual([])
  })

  it("une requête d'exemple par opération, valide et exécutable", async () => {
    const mock = await mockOf(SDL)
    const examples = mock.table.graphql?.examples ?? {}
    expect(Object.keys(examples)).toHaveLength(11)
    expect(examples["get:/__graphql/query/user"]).toEqual({ query: "query ($id: ID!) {\n  user(id: $id) { id name email role city createdAt posts { id title body } }\n}", variables: { id: "__ID__" } })
    expect(examples["post:/__graphql/mutation/createUser"]!.variables).toEqual({ input: { name: "Exemple name", email: "camille@example.fr" } })
    const realId = String((mock.data.collections["User"] as Array<JsonObject>)[0]!["id"])
    for (const [routeId, example] of Object.entries(examples)) {
      const variables = JSON.parse(JSON.stringify(example.variables).replaceAll("__ID__", realId)) as Record<string, unknown>
      const result = run(mock, example.query, variables)
      expect(result.status, routeId).toBe(200)
      if (!routeId.includes("delete")) expect(result.body["errors"], `${routeId} ${JSON.stringify(result.body["errors"])}`).toBeUndefined()
    }
  })

  it("l'introspection marche, pour GraphiQL, Apollo et les générateurs de code", async () => {
    const mock = await mockOf(JSON.stringify({ data: introspectionFromSchema(buildSchema(SDL)) }))
    const result = run(mock, "{ __schema { queryType { name } types { name } } }")
    const schema = data(result)["__schema"] as JsonObject
    expect((schema["queryType"] as JsonObject)["name"]).toBe("Query")
    expect((schema["types"] as Array<JsonObject>).map((t) => t["name"])).toContain("User")
  })
})

const apply = (mock: MockDefinition, writes: ReadonlyArray<GraphqlWrite>, base: Record<string, ReadonlyArray<Json>> = {}): Record<string, ReadonlyArray<Json>> => {
  const state: Record<string, ReadonlyArray<Json>> = { ...base }
  for (const write of writes) state[write.source] = applyOp(state[write.source] ?? mock.data.collections[write.source] ?? [], write.op).items
  return state
}

