/**
 * Postman collections (v2.0 and v2.1) as input: each request becomes a route,
 * and response examples and sent bodies provide the schemas. The output is an
 * OpenAPI 3.1 document (see `../collections`), read by the pipeline like any other.
 */
import { cleanSegments, collectionToOpenApi, formObject, METHODS, parseJson, pathFromRaw, stringOf, type Collected, type CollectedResponse } from "../collections"
import type { Diagnostic } from "../diagnostic"
import type { Json, JsonObject } from "../model"
import { isPlainObject } from "../util/pointer"

export type PostmanResult =
  | { readonly ok: true; readonly document: JsonObject; readonly version: string; readonly requests: number }
  | { readonly ok: false; readonly error: Diagnostic }

export const isPostmanCollection = (document: JsonObject): boolean => {
  const info = document["info"]
  if (isPlainObject(info) && typeof info["schema"] === "string" && info["schema"].includes("getpostman.com/json/collection")) return true
  return Array.isArray(document["item"]) && isPlainObject(info) && typeof info["name"] === "string"
}

const pathOf = (url: unknown): { path: string; query: Array<string> } => {
  if (typeof url === "string") return pathFromRaw(url)
  if (!isPlainObject(url)) return { path: "/", query: [] }
  const query: Array<string> = []
  if (Array.isArray(url["query"])) {
    for (const item of url["query"]) {
      if (isPlainObject(item) && typeof item["key"] === "string" && item["key"].length > 0 && item["disabled"] !== true) query.push(item["key"])
    }
  }
  if (Array.isArray(url["path"])) {
    return { path: cleanSegments(url["path"].map((s) => (isPlainObject(s) ? String(s["value"] ?? "") : String(s)))), query }
  }
  if (typeof url["raw"] === "string") return { path: pathFromRaw(url["raw"]).path, query }
  return { path: "/", query }
}

const bodyOf = (body: unknown): Json | undefined => {
  if (!isPlainObject(body)) return undefined
  const mode = body["mode"]
  if (mode === "raw") return parseJson(body["raw"])
  if (mode === "urlencoded" || mode === "formdata") return formObject(body[mode]) ?? {}
  return undefined
}

const collect = (items: ReadonlyArray<unknown>, tags: ReadonlyArray<string>, out: Array<Collected>): void => {
  for (const item of items) {
    if (!isPlainObject(item)) continue
    const name = stringOf(item["name"]) ?? "requête"
    if (Array.isArray(item["item"])) {
      collect(item["item"], [...tags, name], out)
      continue
    }
    const request = item["request"]
    if (request === undefined) continue
    const method = (isPlainObject(request) ? stringOf(request["method"]) : "GET")?.toLowerCase() ?? "get"
    if (!METHODS.has(method)) continue
    const url = isPlainObject(request) ? request["url"] : request
    const { path, query } = pathOf(url)
    const description = isPlainObject(request) ? (stringOf(request["description"]) ?? (isPlainObject(request["description"]) ? stringOf(request["description"]["content"]) : undefined)) : undefined
    const responses: Array<CollectedResponse> = []
    if (Array.isArray(item["response"])) {
      for (const response of item["response"]) {
        if (!isPlainObject(response)) continue
        const code = typeof response["code"] === "number" ? response["code"] : Number(response["code"] ?? 200) || 200
        responses.push({ code, body: parseJson(response["body"]), name: stringOf(response["name"]) })
      }
    }
    out.push({ method, path, name, description, tags: tags.slice(0, 1), query, body: isPlainObject(request) ? bodyOf(request["body"]) : undefined, responses })
  }
}

export const postmanToOpenApi = (collection: JsonObject): PostmanResult => {
  const info = isPlainObject(collection["info"]) ? collection["info"] : {}
  const schema = stringOf(info["schema"]) ?? ""
  const version = /v(\d+\.\d+)/.exec(schema)?.[1] ?? "2.1"
  if (!Array.isArray(collection["item"])) {
    return { ok: false, error: { stage: "ingestion", message: "Cette collection Postman n'a pas de liste `item` : rien à mocker.", pointer: "#/item", suggestions: [] } }
  }
  const collected: Array<Collected> = []
  collect(collection["item"], [], collected)
  if (collected.length === 0) {
    return {
      ok: false,
      error: { stage: "ingestion", message: "Aucune requête HTTP dans cette collection.", pointer: "#/item", suggestions: ["Exportez la collection depuis Postman au format v2.1 avec ses requêtes."] },
    }
  }
  const { document, requests } = collectionToOpenApi(collected, {
    title: stringOf(info["name"]) ?? "collection-postman",
    version: stringOf(info["version"]) ?? "1.0.0",
    description: stringOf(info["description"]),
  })
  return { ok: true, document, version, requests }
}
