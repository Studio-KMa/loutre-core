import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Json, JsonObject, MockDefinition } from "../src/model"
import { compile } from "../src/pipeline"
import { resolve } from "../src/serving"
import { applyOp, collectionFor, freshId, idOf, listKeyFor, removeItem, replaceItems, upsertItem, writeOp, MAX_STATE_ITEMS } from "../src/state"
import { fixture } from "./fixtures"

const NOW = new Date("2026-09-18T10:00:00Z")
let petstore: MockDefinition
let expanded: MockDefinition
const load = async (): Promise<void> => {
  petstore ??= await Effect.runPromise(compile(fixture("petstore-3.0.yaml"), { seed: "state", now: NOW }))
  expanded ??= await Effect.runPromise(compile(fixture("petstore-expanded-3.0.yaml"), { seed: "state", now: NOW }))
}
const route = (id: string, mock: MockDefinition = petstore) => {
  const found = mock.table.routes.find((r) => r.id === id)
  if (found === undefined) throw new Error(`route ${id} absente`)
  return found
}
const random = () => 0.42

describe("état persistant — aides pures", () => {
  it("retrouve la collection d'une route, même sans corps documenté", async () => {
    await load()
    expect(collectionFor(petstore, route("get:/pets"))).toBe("Pet")
    expect(collectionFor(petstore, route("get:/pets/{petId}"))).toBe("Pet")
    expect(collectionFor(petstore, route("post:/pets"))).toBe("Pet")
    expect(collectionFor(expanded, route("delete:/pets/{id}", expanded))).toBe("Pet")
    expect(collectionFor(expanded, route("post:/pets", expanded))).toBe("Pet")
    expect(listKeyFor(route("get:/pets"), "Pet")).toBe("")
    expect(listKeyFor(route("get:/pets/{petId}"), "Pet")).toBeUndefined()
  })

  it("identifiants : entier suivant, préfixe conservé, uuid", () => {
    const numeric: Array<Json> = [{ id: 3 }, { id: 7 }]
    expect(freshId(numeric, 7, random)).toBe(8)
    const prefixed: Array<Json> = [{ id: "usr_8f3k2p" }]
    const fresh = freshId(prefixed, "usr_8f3k2p", random)
    expect(String(fresh).startsWith("usr_")).toBe(true)
    expect(fresh).not.toBe("usr_8f3k2p")
    const uuid = freshId([], "3fa85f64-5717-4562-b3fc-2c963f66afa6", random)
    expect(String(uuid)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(idOf({ uuid: "u1" })).toBe("u1")
    expect(idOf({ user_id: 5 })).toBe("5")
    expect(idOf([])).toBeUndefined()
  })

  it("insère, remplace, supprime, borne", () => {
    const items: Array<Json> = [{ id: 1, name: "a" }, { id: 2, name: "b" }]
    const inserted = upsertItem(items, { id: 3, name: "c" })
    expect(inserted.created).toBe(true)
    expect(inserted.items).toHaveLength(3)
    const replaced = upsertItem(inserted.items, { id: 2, name: "B" })
    expect(replaced.created).toBe(false)
    expect((replaced.items[1] as JsonObject)["name"]).toBe("B")
    const removed = removeItem(replaced.items, "1")
    expect(removed.removed).toBe(true)
    expect(removed.items.map(idOf)).toEqual(["2", "3"])
    expect(removeItem(removed.items, "99").removed).toBe(false)
    let many: ReadonlyArray<Json> = []
    for (let i = 0; i < MAX_STATE_ITEMS + 5; i++) many = upsertItem(many, { id: i }).items
    expect(many).toHaveLength(MAX_STATE_ITEMS)
    expect(idOf(many[0])).toBe("5")
  })

  it("remplace les éléments d'une enveloppe et recalcule les compteurs", () => {
    const body: Json = { data: [{ id: 1 }, { id: 2 }], total: 2, has_more: true }
    expect(replaceItems(body, [{ id: 9 }], "data")).toEqual({ data: [{ id: 9 }], total: 1, has_more: false })
    expect(replaceItems([{ id: 1 }], [{ id: 9 }], "")).toEqual([{ id: 9 }])
    expect(replaceItems({ order_lines: [] }, [{ id: 9 }], "data")).toEqual({ order_lines: [] })
  })
})

describe("état persistant — opérations", () => {
  it("insère avec un identifiant neuf, remplace, retire, et dit quand rien ne bouge", () => {
    const items: Array<Json> = [{ id: 1, name: "a" }, { id: 2, name: "b" }]
    const inserted = applyOp(items, { kind: "insert", item: { id: 1, name: "c" } }, random)
    expect(inserted.changed).toBe(true)
    expect((inserted.body as JsonObject)["id"]).toBe(3)
    expect(inserted.items).toHaveLength(3)
    const upserted = applyOp(items, { kind: "upsert", item: { id: 2, name: "B" } }, random)
    expect((upserted.items[1] as JsonObject)["name"]).toBe("B")
    expect(applyOp(items, { kind: "remove", id: "2" }, random)).toMatchObject({ changed: true })
    expect(applyOp(items, { kind: "remove", id: "9" }, random)).toMatchObject({ changed: false })
  })

  it("déduit l'opération d'une écriture", async () => {
    await load()
    expect(writeOp(expanded, route("post:/pets", expanded), {}, "POST", { name: "Rex" })).toEqual({ source: "Pet", op: { kind: "insert", item: { name: "Rex" } } })
    expect(writeOp(expanded, route("delete:/pets/{id}", expanded), { id: "4" }, "DELETE", undefined)).toEqual({ source: "Pet", op: { kind: "remove", id: "4" } })
    expect(writeOp(expanded, route("post:/pets", expanded), {}, "POST", "texte")).toBeUndefined()
  })
})

describe("état persistant — overlay au serving", () => {
  it("la liste et le détail reflètent la collection écrite, un id supprimé répond 404", async () => {
    await load()
    const written: Array<Json> = [{ id: 1, name: "Rex", tag: "chien" }, { id: 42, name: "Félix", tag: "chat" }]
    const options = { collections: { Pet: written }, random }
    const list = resolve(petstore, {}, { method: "GET", pathname: "/pets", headers: {} }, options)
    expect(list.body).toEqual(written)
    const detail = resolve(petstore, {}, { method: "GET", pathname: "/pets/42", headers: {} }, options)
    expect(detail).toMatchObject({ status: 200, body: { id: 42, name: "Félix" } })
    const gone = resolve(petstore, {}, { method: "GET", pathname: "/pets/7", headers: {} }, options)
    expect(gone).toMatchObject({ kind: "not-found", status: 404 })
    expect(gone.body).toBeDefined()
    // Sans état, un id inconnu reste servi (l'objet par défaut) : rien ne change pour les mocks existants.
    expect(resolve(petstore, {}, { method: "GET", pathname: "/pets/7", headers: {} }, { random }).status).toBe(200)
  })

  it("x-loutre-count s'applique par-dessus l'état, x-loutre-seed l'ignore", async () => {
    await load()
    const written: Array<Json> = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const truncated = resolve(petstore, {}, { method: "GET", pathname: "/pets", headers: { "x-loutre-count": "1" } }, { collections: { Pet: written }, random })
    expect(truncated.body).toEqual([{ id: 1 }])
    const seeded = resolve(petstore, {}, { method: "GET", pathname: "/pets", headers: { "x-loutre-seed": "variante" } }, { collections: { Pet: written }, random })
    expect(seeded.body).not.toEqual(written)
    expect(Array.isArray(seeded.body)).toBe(true)
  })
})
