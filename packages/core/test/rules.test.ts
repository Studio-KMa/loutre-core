import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { MockDefinition } from "../src/model"
import { compile } from "../src/pipeline"
import { resolve, type Behavior, type ServingRequest } from "../src/serving"
import { fixture } from "./fixtures"

const NOW = new Date("2026-09-18T10:00:00Z")
let petstore: MockDefinition
const load = async (): Promise<void> => {
  petstore ??= await Effect.runPromise(compile(fixture("petstore-3.0.yaml"), { seed: "rules", now: NOW }))
}

const call = (behavior: Behavior, request: Partial<ServingRequest> & { pathname: string }) =>
  resolve(petstore, behavior, { method: "GET", headers: {}, ...request }, { random: () => 0.5 })

const behavior = (rules: NonNullable<NonNullable<Behavior["routes"]>[string]["rules"]>, routeId = "get:/pets"): Behavior => ({
  routes: { [routeId]: { rules } },
})

describe("règles conditionnelles", () => {
  it("un paramètre de requête déclenche un statut et un corps", async () => {
    await load()
    const b = behavior([{ when: { query: { page: "99" } }, status: 404, body: { error: "no_such_page" } }])
    expect(call(b, { pathname: "/pets", query: { page: "99" } })).toMatchObject({ kind: "rule", status: 404, body: { error: "no_such_page" } })
    expect(call(b, { pathname: "/pets", query: { page: "1" } })).toMatchObject({ kind: "ok", status: 200 })
    expect(call(b, { pathname: "/pets" })).toMatchObject({ kind: "ok", status: 200 })
  })

  it("en-tête (insensible à la casse du nom), paramètre de chemin et champ du corps", async () => {
    await load()
    const byHeader = behavior([{ when: { header: { "X-Tenant": "acme" } }, status: 403 }])
    expect(call(byHeader, { pathname: "/pets", headers: { "x-tenant": "acme" } }).status).toBe(403)
    expect(call(byHeader, { pathname: "/pets", headers: { "x-tenant": "other" } }).status).toBe(200)

    const byParam = behavior([{ when: { param: { petId: "13" } }, status: 410 }], "get:/pets/{petId}")
    expect(call(byParam, { pathname: "/pets/13" }).status).toBe(410)
    expect(call(byParam, { pathname: "/pets/14" }).status).toBe(200)

    const byBody = behavior([{ when: { body: { "owner.email": "x@y.fr", age: "3" } }, status: 422, body: { error: "too_young" } }], "post:/pets")
    expect(call(byBody, { method: "POST", pathname: "/pets", body: { owner: { email: "x@y.fr" }, age: 3 } })).toMatchObject({ status: 422, body: { error: "too_young" } })
    expect(call(byBody, { method: "POST", pathname: "/pets", body: { owner: { email: "x@y.fr" }, age: 4 } }).status).toBe(201)
    expect(call(byBody, { method: "POST", pathname: "/pets", body: { age: 3 } }).status).toBe(201)
  })

  it("la première règle gagne, une règle vide ne matche jamais, le header garde la priorité sur le statut", async () => {
    await load()
    const b = behavior([
      { when: {}, status: 500 },
      { when: { query: { a: "1" } }, status: 418, latencyMs: 2500 },
      { when: { query: { a: "1" } }, status: 404 },
    ])
    const hit = call(b, { pathname: "/pets", query: { a: "1" } })
    expect(hit).toMatchObject({ status: 418, delayMs: 2500 })
    expect(call(b, { pathname: "/pets", query: { a: "1" }, headers: { "x-loutre-status": "503", "x-loutre-delay": "0" } })).toMatchObject({ status: 503, delayMs: 0 })
    expect(call(b, { pathname: "/pets" })).toMatchObject({ kind: "ok", status: 200 })
  })

  it("un corps de règle sans statut habille la réponse par défaut", async () => {
    await load()
    const b = behavior([{ when: { query: { empty: "1" } }, body: [] }])
    expect(call(b, { pathname: "/pets", query: { empty: "1" } })).toMatchObject({ kind: "rule", status: 200, body: [] })
  })
})
