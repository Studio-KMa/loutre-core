import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { MockDefinition } from "../src/model"
import { compile } from "../src/pipeline"
import { applyScenario, resolve, type Behavior } from "../src/serving"
import { fixture } from "./fixtures"

let petstore: MockDefinition
const load = async (): Promise<void> => {
  petstore ??= await Effect.runPromise(compile(fixture("petstore-3.0.yaml"), { seed: "scenario", now: new Date("2026-09-22T10:00:00Z") }))
}
const behavior: Behavior = {
  latencyMs: 100,
  routes: { "get:/pets": { latencyMs: 50, bodies: { "500": { error: "base" } } } },
  scenarios: {
    panne: { status: 500, latencyMs: 2000, routes: { "get:/pets": { bodies: { "503": { error: "maintenance" } } } } },
    vide: { routes: { "get:/pets": { bodies: { "200": [] } } } },
  },
}

describe("scénarios nommés", () => {
  it("se superposent aux réglages, par en-tête ou par activation", async () => {
    await load()
    const plain = resolve(petstore, behavior, { method: "GET", pathname: "/pets", headers: {} }, { random: () => 0.5 })
    expect(plain.status).toBe(200)
    expect(plain.headers["x-loutre-scenario"]).toBeUndefined()

    const byHeader = resolve(petstore, behavior, { method: "GET", pathname: "/pets", headers: { "x-loutre-scenario": "panne" } }, { random: () => 0.5 })
    expect(byHeader.status).toBe(500)
    expect(byHeader.body).toEqual({ error: "base" })
    // Le réglage par route (50 ms) garde la main sur la latence globale du scénario.
    expect(byHeader.delayMs).toBe(50)
    expect(byHeader.headers["x-loutre-scenario"]).toBe("panne")
    const other = resolve(petstore, behavior, { method: "GET", pathname: "/pets/1", headers: { "x-loutre-scenario": "panne" } }, { random: () => 0.5 })
    expect(other.status).toBe(500)
    expect(other.delayMs).toBe(2000)

    const active = resolve(petstore, { ...behavior, activeScenario: "vide" }, { method: "GET", pathname: "/pets", headers: {} }, { random: () => 0.5 })
    expect(active.body).toEqual([])
    expect(active.headers["x-loutre-scenario"]).toBe("vide")

    const unknown = resolve(petstore, behavior, { method: "GET", pathname: "/pets", headers: { "x-loutre-scenario": "nope" } }, { random: () => 0.5 })
    expect(unknown.status).toBe(200)
    expect(unknown.headers["x-loutre-scenario"]).toBeUndefined()

    // L'en-tête de statut garde la priorité sur le scénario.
    const forced = resolve(petstore, behavior, { method: "GET", pathname: "/pets", headers: { "x-loutre-scenario": "panne", "x-loutre-status": "503" } }, { random: () => 0.5 })
    expect(forced).toMatchObject({ status: 503, body: { error: "maintenance" } })
  })

  it("fusionne route par route et corps par statut", () => {
    const merged = applyScenario(behavior, "panne").behavior
    expect(merged.routes?.["get:/pets"]?.bodies).toEqual({ "500": { error: "base" }, "503": { error: "maintenance" } })
    expect(merged.routes?.["get:/pets"]?.latencyMs).toBe(50)
    expect(merged.latencyMs).toBe(2000)
    expect(merged.scenarios).toBe(behavior.scenarios)
  })
})
