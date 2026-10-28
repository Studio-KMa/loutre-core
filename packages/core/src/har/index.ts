/**
 * HAR files (HTTP Archive, "Save all as HAR" in the browser's network tab) as input:
 * the JSON calls to the main API host become routes, concrete ids in paths become
 * parameters (`/users/42` → `/users/{id}`), recorded responses give shapes and statuses.
 *
 * A HAR holds cookies, tokens and real people's data. `slimHar` keeps only what the
 * conversion needs (method, URL, JSON bodies, status), without any header, and the
 * conversion only takes shapes from the values: the mock serves generated data.
 */
import { collectionToOpenApi, formObject, keepsCategoryValue, METHODS, parseJson, stringOf, templateIds, type Collected, type CollectedResponse } from "../collections"
import type { Diagnostic } from "../diagnostic"
import type { Json, JsonObject } from "../model"
import { isPlainObject } from "../util/pointer"

export type HarResult =
  | { readonly ok: true; readonly document: JsonObject; readonly version: string; readonly requests: number }
  | { readonly ok: false; readonly error: Diagnostic }

export const isHar = (document: JsonObject): boolean => isPlainObject(document["log"]) && Array.isArray(document["log"]["entries"])

const STATIC = /\.(js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|html?|txt|xml|wasm)$/i
const MAX_LIST = 20

/** Response text, base64 or not, as JSON when it is JSON. */
const jsonText = (content: unknown): Json | undefined => {
  if (!isPlainObject(content)) return undefined
  let text = content["text"]
  if (typeof text !== "string" || text.length === 0) return undefined
  if (content["encoding"] === "base64") {
    try {
      text = new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)))
    } catch {
      return undefined
    }
  }
  return parseJson(text)
}

/** Long lists are cut to their first elements: enough for shapes, and the file stays small. */
const trimmed = (value: Json): Json => (Array.isArray(value) ? value.slice(0, MAX_LIST).map(trimmed) : isPlainObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimmed(v as Json)])) : value)

interface Kept {
  readonly method: string
  readonly url: URL
  readonly requestBody: Json | undefined
  readonly status: number
  readonly responseBody: Json | undefined
}

/** The calls worth mocking: HTTP(S), a JSON answer or a JSON request, no static asset, no preflight. */
const keptEntries = (document: JsonObject): Array<Kept> => {
  const entries = (document["log"] as JsonObject)["entries"] as ReadonlyArray<unknown>
  const kept: Array<Kept> = []
  for (const entry of entries) {
    if (!isPlainObject(entry) || !isPlainObject(entry["request"]) || !isPlainObject(entry["response"])) continue
    const request = entry["request"]
    const response = entry["response"]
    const method = (stringOf(request["method"]) ?? "GET").toLowerCase()
    if (!METHODS.has(method) || method === "options" || method === "head") continue
    let url: URL
    try {
      url = new URL(String(request["url"] ?? ""))
    } catch {
      continue
    }
    if (!/^https?:$/.test(url.protocol) || STATIC.test(url.pathname)) continue
    const status = typeof response["status"] === "number" ? response["status"] : Number(response["status"] ?? 0)
    if (!(status >= 200 && status < 300) && !(status >= 400 && status < 600)) continue
    const responseBody = jsonText(response["content"])
    const postData = isPlainObject(request["postData"]) ? request["postData"] : undefined
    const requestBody = postData === undefined ? undefined : (parseJson(postData["text"]) ?? formObject(postData["params"]))
    const mimeType = String((isPlainObject(response["content"]) ? response["content"]["mimeType"] : "") ?? "")
    if (responseBody === undefined && requestBody === undefined && !mimeType.includes("json")) continue
    kept.push({ method, url, requestBody, status, responseBody: responseBody === undefined ? undefined : trimmed(responseBody) })
  }
  // Only the main API host: analytics, CDNs and third-party calls are left out.
  const counts = new Map<string, number>()
  for (const entry of kept) counts.set(entry.url.origin, (counts.get(entry.url.origin) ?? 0) + 1)
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  return kept.filter((entry) => entry.url.origin === main)
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const URI = /^https?:\/\//

/**
 * What a recorded value may keep once it leaves the browser: its type, its format (a date stays a date, an email an
 * email) and the vocabulary of a category field; never the text itself. Numbers stay, they give ranges.
 */
const scrub = (value: Json, field: string): Json => {
  if (Array.isArray(value)) return value.map((item) => scrub(item, field))
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item as Json, key)]))
  if (typeof value !== "string") return value
  if (keepsCategoryValue(field, value)) return value
  if (DATE_TIME.test(value)) return "2024-01-01T00:00:00Z"
  if (DATE.test(value)) return "2024-01-01"
  if (EMAIL.test(value)) return "user@example.com"
  if (UUID.test(value)) return "00000000-0000-4000-8000-000000000000"
  if (URI.test(value)) return "https://example.com"
  return ""
}

/** The URL without credentials nor query values (their names are enough), an email in the path read as an id. */
const scrubUrl = (url: URL): string => {
  const clean = new URL(url.href)
  clean.username = ""
  clean.password = ""
  clean.hash = ""
  const names = [...new Set(clean.searchParams.keys())]
  clean.search = ""
  for (const name of names) clean.searchParams.append(name, "")
  clean.pathname = clean.pathname
    .split("/")
    .map((segment) => (segment.includes("@") || segment.includes("%40") ? "1" : segment))
    .join("/")
  return clean.href
}

/** The HAR reduced to what Loutre reads: no header, no cookie, no timing, no static file, no recorded text. */
export const slimHar = (document: JsonObject): JsonObject => ({
  log: {
    version: "1.2",
    creator: { name: "loutre", version: "slim" },
    entries: keptEntries(document).map((entry) => {
      const request: Record<string, Json> = { method: entry.method.toUpperCase(), url: scrubUrl(entry.url) }
      if (entry.requestBody !== undefined) request["postData"] = { mimeType: "application/json", text: JSON.stringify(scrub(entry.requestBody, "")) }
      const response: Record<string, Json> = { status: entry.status, content: { mimeType: "application/json", ...(entry.responseBody === undefined ? {} : { text: JSON.stringify(scrub(entry.responseBody, "")) }) } }
      return { request, response }
    }),
  },
})

export const harToOpenApi = (document: JsonObject): HarResult => {
  const kept = keptEntries(document)
  const grouped = new Map<string, { method: string; path: string; query: Set<string>; body: Json | undefined; responses: Map<number, Json | undefined> }>()
  for (const entry of kept) {
    const path = templateIds(entry.url.pathname)
    const key = `${entry.method} ${path}`
    const group = grouped.get(key) ?? { method: entry.method, path, query: new Set<string>(), body: undefined, responses: new Map<number, Json | undefined>() }
    for (const name of entry.url.searchParams.keys()) group.query.add(name)
    group.body ??= entry.requestBody
    // Per status, the richest body recorded: a list of twenty says more than an empty one.
    const known = group.responses.get(entry.status)
    if (known === undefined || JSON.stringify(entry.responseBody ?? null).length > JSON.stringify(known).length) group.responses.set(entry.status, entry.responseBody)
    grouped.set(key, group)
  }
  if (grouped.size === 0) {
    return {
      ok: false,
      error: {
        stage: "ingestion",
        message: "Aucun appel d'API en JSON dans ce fichier HAR.",
        pointer: "#/log/entries",
        suggestions: ["Dans l'onglet Réseau du navigateur, filtrez sur Fetch/XHR, faites vos appels, puis « Save all as HAR »."],
      },
    }
  }
  const collected: Array<Collected> = [...grouped.values()].map((group) => {
    const responses: Array<CollectedResponse> = [...group.responses.entries()].sort((a, b) => a[0] - b[0]).map(([code, body]) => ({ code, body, name: undefined }))
    return { method: group.method, path: group.path, name: `${group.method.toUpperCase()} ${group.path}`, description: undefined, tags: [], query: [...group.query], body: group.body, responses }
  })
  const host = kept[0]?.url.host
  const { document: openapi, requests } = collectionToOpenApi(collected, { title: host ?? "har", version: "1.0.0" }, { values: "shapes" })
  return { ok: true, document: openapi, version: stringOf((document["log"] as JsonObject)["version"]) ?? "1.2", requests }
}
