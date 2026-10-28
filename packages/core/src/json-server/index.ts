/**
 * A json-server `db.json` as input: every top-level list becomes a resource with the
 * routes json-server serves (`GET/POST /posts`, `GET/PUT/PATCH/DELETE /posts/{id}`),
 * a top-level object a singular one (`GET/PUT/PATCH /profile`), and a `postId` field
 * the nested route `GET /posts/{id}/comments`.
 *
 * Unlike every other format, the records are served as they are (`x-loutre-fixtures`):
 * whoever wrote a `db.json` wrote the data they want to see.
 */
import { collectionToOpenApi, type Collected } from "../collections"
import type { Diagnostic } from "../diagnostic"
import type { Json, JsonObject } from "../model"
import { singular, titleFromName } from "../util/infer-schema"
import { isPlainObject } from "../util/pointer"

export type JsonServerResult =
  | { readonly ok: true; readonly document: JsonObject; readonly version: string; readonly requests: number }
  | { readonly ok: false; readonly error: Diagnostic }

const RESOURCE = /^[A-Za-z_][\w-]*$/
/** Keys that belong to other formats: a document with one of them is not a `db.json`. */
const FOREIGN = new Set(["openapi", "swagger", "asyncapi", "paths", "components", "definitions", "_type", "log"])

const isRecordList = (value: unknown): value is Array<JsonObject> => Array.isArray(value) && value.length > 0 && value.every(isPlainObject)

/** Top-level lists of objects (at least one) and objects, named like resources, nothing else. */
export const isJsonServerDb = (document: JsonObject): boolean => {
  const entries = Object.entries(document)
  if (entries.length === 0 || entries.some(([key]) => FOREIGN.has(key) || !RESOURCE.test(key))) return false
  return entries.some(([, value]) => isRecordList(value)) && entries.every(([, value]) => isRecordList(value) || isPlainObject(value) || (Array.isArray(value) && value.length === 0))
}

/** One record gathering every field seen across the list: the first one may lack optional fields. */
const merged = (records: ReadonlyArray<JsonObject>): JsonObject => {
  const out: Record<string, Json> = {}
  for (const record of records.slice(0, 200)) {
    for (const [key, value] of Object.entries(record)) if (out[key] === undefined || out[key] === null) out[key] = value as Json
  }
  return out
}

const request = (method: string, path: string, name: string, body: Json | undefined, responses: Collected["responses"], query: ReadonlyArray<string> = []): Collected => ({
  method,
  path,
  name,
  description: undefined,
  tags: [],
  query,
  body,
  responses,
})

export const jsonServerToOpenApi = (document: JsonObject): JsonServerResult => {
  const lists = Object.entries(document).filter((entry): entry is [string, Array<JsonObject>] => isRecordList(entry[1]))
  const singles = Object.entries(document).filter((entry): entry is [string, JsonObject] => isPlainObject(entry[1]))
  if (lists.length === 0) {
    return { ok: false, error: { stage: "ingestion", message: "Ce db.json n'a aucune liste d'objets à servir.", pointer: "#", suggestions: ["Chaque ressource est une liste à la racine : { \"posts\": [{ \"id\": 1, \"title\": \"…\" }] }."] } }
  }
  const collected: Array<Collected> = []
  const names = new Set(lists.map(([name]) => name))
  for (const [name, records] of lists) {
    const sample = merged(records)
    const writable = Object.fromEntries(Object.entries(sample).filter(([key]) => key !== "id"))
    const base = `/${name}`
    const item = `${base}/{id}`
    // The query string json-server understands: pagination, sort, full-text search, filters by field.
    const query = ["_page", "_per_page", "_limit", "_sort", "_order", "q", "_embed", ...Object.keys(sample).filter((k) => !isPlainObject(sample[k]) && !Array.isArray(sample[k])).slice(0, 20)]
    collected.push(
      request("get", base, `Liste des ${name}`, undefined, [{ code: 200, body: records, name: undefined }], query),
      request("post", base, `Créer dans ${name}`, writable, [{ code: 201, body: sample, name: undefined }]),
      request("get", item, `Un élément de ${name}`, undefined, [{ code: 200, body: sample, name: undefined }, { code: 404, body: {}, name: "Introuvable" }]),
      request("put", item, `Remplacer dans ${name}`, writable, [{ code: 200, body: sample, name: undefined }]),
      request("patch", item, `Modifier dans ${name}`, writable, [{ code: 200, body: sample, name: undefined }]),
      request("delete", item, `Supprimer dans ${name}`, undefined, [{ code: 200, body: sample, name: undefined }]),
    )
    // `comments[].postId` → GET /posts/{id}/comments, as json-server does.
    for (const field of Object.keys(sample)) {
      const match = /^(\w+?)_?[Ii]d$/.exec(field)
      const parent = match === null ? undefined : [...names].find((other) => other !== name && singular(other.toLowerCase()) === match[1]!.toLowerCase())
      if (parent !== undefined) {
        collected.push(request("get", `/${parent}/{id}/${name}`, `${name} d'un élément de ${parent}`, undefined, [{ code: 200, body: records, name: undefined }]))
      }
    }
  }
  for (const [name, record] of singles) {
    const path = `/${name}`
    collected.push(
      request("get", path, name, undefined, [{ code: 200, body: record, name: undefined }]),
      request("put", path, `Remplacer ${name}`, record, [{ code: 200, body: record, name: undefined }]),
      request("patch", path, `Modifier ${name}`, record, [{ code: 200, body: record, name: undefined }]),
    )
  }
  const { document: openapi, requests } = collectionToOpenApi(collected, { title: "db.json", version: "1.0.0" })
  // The records themselves, served as written.
  const schemas = (openapi["components"] as JsonObject)["schemas"] as Record<string, JsonObject>
  for (const [name, records] of [...lists, ...singles.map(([name, record]): [string, Array<JsonObject>] => [name, [record]])]) {
    const schema = schemas[titleFromName(name)]
    if (schema !== undefined) schemas[titleFromName(name)] = { ...schema, "x-loutre-fixtures": records }
  }
  return { ok: true, document: openapi, version: "", requests }
}
