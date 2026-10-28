/**
 * Insomnia exports as input: the v4 JSON export (`_type: export`, a flat list of
 * resources linked by `parentId`) and the v5 YAML file (`type: collection.insomnia.rest/5.0`,
 * folders nested under `children`). An export that carries an API design document
 * hands back that OpenAPI document itself, richer than the requests.
 * WebSocket, Socket.IO and gRPC requests are left out: they are not HTTP routes.
 */
import { collectionToOpenApi, formObject, METHODS, parseJson, pathFromRaw, stringOf, type Collected } from "../collections"
import type { Diagnostic } from "../diagnostic"
import type { Json, JsonObject } from "../model"
import { isPlainObject } from "../util/pointer"

export type InsomniaResult =
  | { readonly ok: true; readonly document: JsonObject; readonly version: string; readonly requests: number }
  /** The export embeds an API specification: read it as a document of its own. */
  | { readonly ok: true; readonly embedded: string | JsonObject; readonly version: string }
  | { readonly ok: false; readonly error: Diagnostic }

const V5 = /^(collection|spec)\.insomnia\.rest\/5/

export const isInsomniaExport = (document: JsonObject): boolean =>
  (document["_type"] === "export" && Array.isArray(document["resources"])) || (typeof document["type"] === "string" && V5.test(document["type"]))

interface Request {
  readonly name: unknown
  readonly method: unknown
  readonly url: unknown
  readonly description: unknown
  readonly body: unknown
  readonly parameters: unknown
}

const toCollected = (request: Request, tags: ReadonlyArray<string>): Collected | undefined => {
  const method = (stringOf(request.method) ?? "GET").toLowerCase()
  const url = stringOf(request.url)
  if (!METHODS.has(method) || url === undefined) return undefined
  const { path, query } = pathFromRaw(url)
  if (Array.isArray(request.parameters)) {
    for (const parameter of request.parameters) {
      const name = isPlainObject(parameter) && parameter["disabled"] !== true ? stringOf(parameter["name"]) : undefined
      if (name !== undefined) query.push(name)
    }
  }
  return { method, path, name: stringOf(request.name) ?? `${method.toUpperCase()} ${path}`, description: stringOf(request.description), tags: tags.slice(0, 1), query, body: bodyOf(request.body), responses: [] }
}

/** JSON as sent (`mimeType` + `text`), or form fields as an object. */
const bodyOf = (body: unknown): Json | undefined => {
  if (!isPlainObject(body)) return undefined
  const mimeType = stringOf(body["mimeType"]) ?? ""
  if (mimeType.includes("json") || mimeType === "") {
    const parsed = parseJson(body["text"])
    if (parsed !== undefined) return parsed
  }
  if (mimeType.includes("form")) return formObject(body["params"])
  return undefined
}

const noSpec = (spec: unknown): boolean => {
  if (typeof spec === "string") return spec.trim().length === 0
  return !isPlainObject(spec) || Object.keys(spec).length === 0
}

/** v4: resources point to their parent; a request's tag is its top folder under the workspace. */
const fromV4 = (document: JsonObject): InsomniaResult => {
  const resources = (document["resources"] as ReadonlyArray<unknown>).filter(isPlainObject)
  const spec = resources.find((r) => r["_type"] === "api_spec" && !noSpec(r["contents"]))
  if (spec !== undefined) return { ok: true, embedded: spec["contents"] as string | JsonObject, version: "4" }
  const byId = new Map(resources.map((r) => [String(r["_id"] ?? ""), r]))
  const topFolder = (parentId: unknown): string | undefined => {
    let top: string | undefined
    let current = byId.get(String(parentId ?? ""))
    for (let depth = 0; current !== undefined && current["_type"] === "request_group" && depth < 50; depth++) {
      top = stringOf(current["name"])
      current = byId.get(String(current["parentId"] ?? ""))
    }
    return top
  }
  const collected: Array<Collected> = []
  for (const resource of resources) {
    if (resource["_type"] !== "request") continue
    const folder = topFolder(resource["parentId"])
    const request = toCollected(
      { name: resource["name"], method: resource["method"], url: resource["url"], description: resource["description"], body: resource["body"], parameters: resource["parameters"] },
      folder === undefined ? [] : [folder],
    )
    if (request !== undefined) collected.push(request)
  }
  const workspace = resources.find((r) => r["_type"] === "workspace")
  return finish(collected, stringOf(workspace?.["name"]), stringOf(workspace?.["description"]), "4")
}

const isNotHttp = (item: Record<string, unknown>): boolean => {
  const id = isPlainObject(item["meta"]) ? String(item["meta"]["id"] ?? "") : ""
  return /^(ws-req|socketio-req)/.test(id) || "reflectionApi" in item || "protoMethodName" in item
}

/** v5: folders carry their requests under `children`. */
const fromV5 = (document: JsonObject): InsomniaResult => {
  const version = stringOf(document["schema_version"]) ?? "5.0"
  const spec = document["spec"]
  if (isPlainObject(spec) && !noSpec(spec["contents"])) return { ok: true, embedded: spec["contents"] as string | JsonObject, version }
  const collected: Array<Collected> = []
  const walk = (items: unknown, tags: ReadonlyArray<string>): void => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (!isPlainObject(item)) continue
      if (Array.isArray(item["children"])) {
        walk(item["children"], [...tags, stringOf(item["name"]) ?? "dossier"])
        continue
      }
      if (isNotHttp(item)) continue
      const description = isPlainObject(item["meta"]) ? item["meta"]["description"] : undefined
      const request = toCollected(
        { name: item["name"], method: item["method"], url: item["url"], description: item["description"] ?? description, body: item["body"], parameters: item["parameters"] },
        tags,
      )
      if (request !== undefined) collected.push(request)
    }
  }
  walk(document["collection"], [])
  const meta = isPlainObject(document["meta"]) ? document["meta"] : {}
  return finish(collected, stringOf(document["name"]), stringOf(document["description"]) ?? stringOf(meta["description"]), version)
}

const finish = (collected: ReadonlyArray<Collected>, title: string | undefined, description: string | undefined, version: string): InsomniaResult => {
  if (collected.length === 0) {
    return {
      ok: false,
      error: {
        stage: "ingestion",
        message: "Aucune requête HTTP dans cet export Insomnia.",
        pointer: "#",
        suggestions: ["Exportez la collection depuis Insomnia (Export, format Insomnia v5 ou v4) avec ses requêtes : WebSocket et gRPC ne sont pas repris."],
      },
    }
  }
  const { document, requests } = collectionToOpenApi(collected, { title: title ?? "collection-insomnia", version: "1.0.0", description })
  return { ok: true, document, version, requests }
}

export const insomniaToOpenApi = (document: JsonObject): InsomniaResult => (document["_type"] === "export" ? fromV4(document) : fromV5(document))
