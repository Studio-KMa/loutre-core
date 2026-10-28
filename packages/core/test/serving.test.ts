import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { JsonObject, MockDefinition, Route } from "../src/model"
import { compile } from "../src/pipeline"
import { allowedMethods, matchRoute, resolve, type Behavior } from "../src/serving"
import { fixture } from "./fixtures"

const NOW = new Date("2026-09-18T10:00:00Z")
let petstore: MockDefinition
let stripe: MockDefinition

const load = async (): Promise<void> => {
  petstore ??= await Effect.runPromise(compile(fixture("petstore-3.0.yaml"), { seed: "serve", now: NOW }))
  stripe ??= await Effect.runPromise(compile(fixture("stripe-products-3.0.json"), { seed: "serve", now: NOW }))
}

const get = (mock: MockDefinition, pathname: string, headers: Record<string, string> = {}, behavior: Behavior = {}) =>
  resolve(mock, behavior, { method: "GET", pathname, headers }, { random: () => 0.5 })

describe("serving — correspondance", () => {
  it("préfère la route la plus spécifique et décode les paramètres", () => {
    const getRoute = (path: string): Route => ({
      id: `get:${path}`,
      method: "get",
      path,
      tags: [],
      parameters: [],
      responses: [],
      defaultStatus: 200,
    })
    const routes = [getRoute("/pets/{petId}"), getRoute("/pets/count"), getRoute("/files/{name}.{ext}")]
    expect(matchRoute(routes, "GET", "/pets/count")?.route.id).toBe("get:/pets/count")
    expect(matchRoute(routes, "GET", "/pets/42")).toMatchObject({ route: { id: "get:/pets/{petId}" }, params: { petId: "42" } })
    expect(matchRoute(routes, "GET", "/pets/caf%C3%A9/")?.params).toEqual({ petId: "café" })
    expect(matchRoute(routes, "HEAD", "/pets/1")?.route.id).toBe("get:/pets/{petId}")
    expect(matchRoute(routes, "GET", "/files/rapport.pdf")?.params).toEqual({ name: "rapport", ext: "pdf" })
    expect(matchRoute(routes, "GET", "/pets")).toBeUndefined()
    expect(matchRoute(routes, "POST", "/pets/1")).toBeUndefined()
    expect(allowedMethods(routes, "/pets/1")).toEqual(["GET"])
  })
})

describe("serving — résolution", () => {
  it("sert le corps pré-généré du statut par défaut", async () => {
    await load()
    const result = get(petstore, "/pets")
    expect(result).toMatchObject({ kind: "ok", status: 200, delayMs: 0 })
    expect(Array.isArray(result.body)).toBe(true)
    expect(result.route?.id).toBe("get:/pets")
  })

  it("retrouve un élément de collection par id, ou renvoie l'objet par défaut avec l'id demandé", async () => {
    await load()
    const pets = petstore.data.collections["Pet"] as Array<JsonObject>
    expect(get(petstore, "/pets/3").body).toEqual(pets[2])
    const unknown = get(petstore, "/pets/999").body as JsonObject
    expect(unknown).toEqual({ ...pets[0], id: 999 })
    const nonNumeric = get(petstore, "/pets/abc").body as JsonObject
    expect(nonNumeric).toEqual(pets[0])
  })

  it("retrouve par id chaîne (Stripe)", async () => {
    await load()
    const products = stripe.data.collections["Product"] as Array<JsonObject>
    const target = products[1]!
    expect(get(stripe, `/v1/products/${String(target["id"])}`).body).toEqual(target)
    expect((get(stripe, "/v1/products/prod_inconnu").body as JsonObject)["id"]).toBe("prod_inconnu")
  })

  it("404 utile hors des routes, 405 avec Allow sur un chemin connu", async () => {
    await load()
    const missing = get(petstore, "/nope")
    expect(missing).toMatchObject({ kind: "not-found", status: 404 })
    expect((missing.body as JsonObject)["routes"]).toEqual(["GET /pets", "POST /pets", "GET /pets/{petId}"])
    const wrongMethod = resolve(petstore, {}, { method: "DELETE", pathname: "/pets/1", headers: {} })
    expect(wrongMethod).toMatchObject({ kind: "method-not-allowed", status: 405, headers: { allow: "GET" } })
  })

  it("x-loutre-status force un statut, avec le corps documenté ou un corps d'erreur générique", async () => {
    await load()
    const forced = get(petstore, "/pets", { "x-loutre-status": "500" })
    expect(forced).toMatchObject({ kind: "forced-status", status: 500 })
    expect(forced.body).toMatchObject({ code: 500 })
    const undocumented = get(petstore, "/pets", { "x-loutre-status": "418" })
    expect(undocumented.body).toMatchObject({ code: 418 })
    const stripe404 = get(stripe, "/v1/products", { "x-loutre-status": "404" })
    expect(stripe404.body).toEqual({ error: "not_found", message: "La ressource demandée est introuvable.", status: 404 })
    expect(get(petstore, "/pets", { "x-loutre-status": "abc" }).status).toBe(200)
    expect(get(petstore, "/pets", { "x-loutre-status": "204" }).body).toBeUndefined()
  })

  it("x-loutre-delay et la latence configurée avec variation ±30 %", async () => {
    await load()
    expect(get(petstore, "/pets", { "x-loutre-delay": "250" }).delayMs).toBe(250)
    expect(get(petstore, "/pets", { "x-loutre-delay": "99999" }).delayMs).toBe(30000)
    const configured = resolve(petstore, { latencyMs: 1000, jitter: 0.3 }, { method: "GET", pathname: "/pets", headers: {} }, { random: () => 1 })
    expect(configured.delayMs).toBe(1300)
    const low = resolve(petstore, { latencyMs: 1000 }, { method: "GET", pathname: "/pets", headers: {} }, { random: () => 0 })
    expect(low.delayMs).toBe(700)
    const perRoute = resolve(petstore, { routes: { "get:/pets": { latencyMs: 80 } }, jitter: 0 }, { method: "GET", pathname: "/pets", headers: {} })
    expect(perRoute.delayMs).toBe(80)
  })

  it("taux d'erreur : une part des requêtes échoue avec un statut d'erreur documenté", async () => {
    await load()
    const failing = resolve(petstore, { errorRate: 0.5 }, { method: "GET", pathname: "/pets", headers: {} }, { random: () => 0.1 })
    expect(failing).toMatchObject({ kind: "forced-error", status: 500 })
    const passing = resolve(petstore, { errorRate: 0.5 }, { method: "GET", pathname: "/pets", headers: {} }, { random: () => 0.9 })
    expect(passing.status).toBe(200)
    const perRoute = resolve(petstore, { routes: { "get:/pets": { status: 404 } } }, { method: "GET", pathname: "/pets", headers: {} })
    expect(perRoute.status).toBe(404)
  })

  it("POST renvoie le corps envoyé complété par l'objet généré", async () => {
    await load()
    const created = resolve(petstore, {}, { method: "POST", pathname: "/pets", headers: {}, body: { name: "Rex", tag: "chien" } })
    // createPets ne documente pas de corps 201 : réponse vide.
    expect(created.status).toBe(201)
    expect(created.body).toBeUndefined()
    const product = resolve(stripe, {}, { method: "POST", pathname: "/v1/products", headers: {}, body: { name: "Lampe Nomade", id: "hack" } })
    expect(product.status).toBe(200)
    const body = product.body as JsonObject
    expect(body["name"]).toBe("Lampe Nomade")
    expect(body["id"]).not.toBe("hack")
    expect(body["object"]).toBe("product")
  })

  it("x-loutre-count tronque les listes, nues ou enveloppées", async () => {
    await load()
    expect(get(petstore, "/pets", { "x-loutre-count": "0" }).body).toEqual([])
    expect((get(petstore, "/pets", { "x-loutre-count": "3" }).body as Array<unknown>).length).toBe(3)
    expect((get(petstore, "/pets", { "x-loutre-count": "999" }).body as Array<unknown>).length).toBe(8)
    expect((get(petstore, "/pets", { "x-loutre-count": "abc" }).body as Array<unknown>).length).toBe(8)
    const wrapped = get(stripe, "/v1/products", { "x-loutre-count": "1" }).body as JsonObject
    expect((wrapped["data"] as Array<unknown>).length).toBe(1)
    expect(wrapped["has_more"]).toBe(false)
  })

  it("x-loutre-message remplace le message d'une erreur, jamais d'un succès", async () => {
    await load()
    const forced = get(petstore, "/pets", { "x-loutre-status": "402", "x-loutre-message": "Solde insuffisant" })
    expect(forced.body).toEqual({ code: 402, message: "Solde insuffisant" })
    expect(get(petstore, "/pets", { "x-loutre-status": "402" }).body).toEqual({ code: 402, message: "Paiement requis pour accéder à cette ressource." })
    const documented = get(petstore, "/pets", { "x-loutre-status": "500", "x-loutre-message": "Boum" })
    expect(documented.body).toMatchObject({ code: 500, message: "Boum" })
    expect(get(petstore, "/pets", { "x-loutre-message": "ignoré" }).body).toEqual(get(petstore, "/pets").body)
  })

  it("x-loutre-seed donne une autre variante stable des données", async () => {
    await load()
    const base = get(petstore, "/pets").body
    const a = get(petstore, "/pets", { "x-loutre-seed": "cas-42" }).body
    const b = get(petstore, "/pets", { "x-loutre-seed": "cas-42" }).body
    expect(a).toEqual(b)
    expect(a).not.toEqual(base)
    expect(get(petstore, "/pets/2", { "x-loutre-seed": "cas-42" }).body).toEqual((a as Array<JsonObject>)[1])
  })

  it("une réponse écrite à la main prime sur la réponse générée", async () => {
    await load()
    const behavior: Behavior = { routes: { "get:/pets/{petId}": { bodies: { "404": { code: "PET_GONE", message: "Parti sans laisser d'adresse" }, "200": { id: 1, name: "Fixe" } } } } }
    const notFound = resolve(petstore, behavior, { method: "GET", pathname: "/pets/3", headers: { "x-loutre-status": "404" } })
    expect(notFound.body).toEqual({ code: "PET_GONE", message: "Parti sans laisser d'adresse" })
    const ok = resolve(petstore, behavior, { method: "GET", pathname: "/pets/3", headers: {} })
    expect(ok).toMatchObject({ kind: "custom-body", body: { id: 1, name: "Fixe" } })
    expect(resolve(petstore, behavior, { method: "GET", pathname: "/pets/3", headers: { "x-loutre-status": "404", "x-loutre-message": "Autre" } }).body).toMatchObject({ message: "Autre" })
  })
})
