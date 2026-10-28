/**
 * Bruno collections as input, in their two shapes:
 * - the JSON export (Share → Bruno Collection): `items`, folders nested, response `examples`;
 * - the `.bru` files themselves, pasted or dropped: one or several, one after the other.
 * gRPC, WebSocket and script items are left out: they are not HTTP routes.
 */
import { collectionToOpenApi, formObject, METHODS, parseJson, pathFromRaw, stringOf, type Collected, type CollectedResponse } from "../collections"
import type { Diagnostic } from "../diagnostic"
import type { Json, JsonObject } from "../model"
import { isPlainObject } from "../util/pointer"

export type BrunoResult =
  | { readonly ok: true; readonly document: JsonObject; readonly version: string; readonly requests: number }
  | { readonly ok: false; readonly error: Diagnostic }

/** Request item types, as stored (`http-request`) and as exported (`http`). */
const HTTP_TYPES = new Set(["http", "http-request", "graphql", "graphql-request"])
const ITEM_TYPES = new Set([...HTTP_TYPES, "folder", "grpc", "grpc-request", "ws", "ws-request", "js", "app"])

export const isBrunoCollection = (document: JsonObject): boolean => {
  const items = document["items"]
  if (!Array.isArray(items)) return false
  if (isPlainObject(document["brunoConfig"])) return true
  return items.length > 0 && items.every((item) => isPlainObject(item) && typeof item["type"] === "string" && ITEM_TYPES.has(item["type"]))
}

const noEmpty = (text: string | undefined): string | undefined => (text === undefined || text.trim().length === 0 ? undefined : text.trim())

const bodyOf = (body: unknown): Json | undefined => {
  if (!isPlainObject(body)) return undefined
  const mode = body["mode"]
  if (mode === "json") return isPlainObject(body["json"]) || Array.isArray(body["json"]) ? (body["json"] as Json) : parseJson(body["json"])
  if (mode === "formUrlEncoded" || mode === "multipartForm") return formObject(body[mode])
  return undefined
}

const examplesOf = (examples: unknown): Array<CollectedResponse> => {
  if (!Array.isArray(examples)) return []
  const out: Array<CollectedResponse> = []
  for (const example of examples) {
    if (!isPlainObject(example) || !isPlainObject(example["response"])) continue
    const response = example["response"]
    const code = typeof response["status"] === "number" ? response["status"] : Number(response["status"] ?? 200) || 200
    const content = isPlainObject(response["body"]) ? response["body"]["content"] : response["body"]
    const body = typeof content === "string" ? parseJson(content) : isPlainObject(content) || Array.isArray(content) ? (content as Json) : undefined
    out.push({ code, body, name: stringOf(example["name"]) })
  }
  return out
}

const fromItems = (items: ReadonlyArray<unknown>, tags: ReadonlyArray<string>, out: Array<Collected>): void => {
  for (const item of items) {
    if (!isPlainObject(item)) continue
    const name = stringOf(item["name"]) ?? "requête"
    if (item["type"] === "folder" || (Array.isArray(item["items"]) && item["request"] === undefined)) {
      if (Array.isArray(item["items"])) fromItems(item["items"], [...tags, name], out)
      continue
    }
    if (typeof item["type"] === "string" && !HTTP_TYPES.has(item["type"])) continue
    const request = item["request"]
    if (!isPlainObject(request)) continue
    const method = (stringOf(request["method"]) ?? "GET").toLowerCase()
    const url = stringOf(request["url"])
    if (!METHODS.has(method) || url === undefined) continue
    const { path, query } = pathFromRaw(url)
    if (Array.isArray(request["params"])) {
      for (const param of request["params"]) {
        if (isPlainObject(param) && param["type"] === "query" && param["enabled"] !== false && typeof param["name"] === "string" && param["name"].length > 0) query.push(param["name"])
      }
    }
    out.push({ method, path, name, description: noEmpty(stringOf(request["docs"])), tags: tags.slice(0, 1), query, body: bodyOf(request["body"]), responses: examplesOf(item["examples"]) })
  }
}

export const brunoToOpenApi = (collection: JsonObject): BrunoResult => {
  const collected: Array<Collected> = []
  fromItems(collection["items"] as ReadonlyArray<unknown>, [], collected)
  const config = isPlainObject(collection["brunoConfig"]) ? collection["brunoConfig"] : {}
  return finish(collected, stringOf(collection["name"]) ?? stringOf(config["name"]), stringOf(collection["version"]) ?? stringOf(config["version"]) ?? "1")
}

// ─── .bru files ─────────────────────────────────────────────────────────────

const METHOD_BLOCK = /^(get|post|put|patch|delete|head|options)\s*\{\s*$/m

/** A `.bru` file: a `meta { … }` block and a method block (`get { url: … }`). */
export const looksLikeBru = (text: string): boolean => /^meta\s*\{\s*$/m.test(text) && METHOD_BLOCK.test(text)

interface Block {
  readonly name: string
  readonly lines: ReadonlyArray<string>
}

/** Top-level blocks: `name {` at the start of a line, closed by `}` at the start of a line. */
const blocksOf = (text: string): Array<Block> => {
  const blocks: Array<Block> = []
  let current: { name: string; lines: Array<string> } | undefined
  for (const line of text.split(/\r?\n/)) {
    if (current === undefined) {
      const open = /^([\w:-]+)\s*\{\s*$/.exec(line)
      if (open !== null) current = { name: open[1]!, lines: [] }
      continue
    }
    if (/^\}\s*$/.test(line)) {
      blocks.push(current)
      current = undefined
      continue
    }
    current.lines.push(line)
  }
  return blocks
}

/** `key: value` lines; a `~` in front marks a disabled entry, left out. */
const dictionary = (block: Block | undefined): Map<string, string> => {
  const entries = new Map<string, string>()
  for (const line of block?.lines ?? []) {
    const match = /^\s+([^:~][^:]*|~[^:]*):\s?(.*)$/.exec(line)
    if (match === null || match[1]!.startsWith("~")) continue
    entries.set(match[1]!.trim(), match[2]!.trim())
  }
  return entries
}

/** A text block (`body:json`, `docs`), its two-space indent removed. */
const textOf = (block: Block | undefined): string | undefined =>
  block === undefined ? undefined : block.lines.map((line) => line.replace(/^ {2}/, "")).join("\n")

/**
 * Several `.bru` files one after the other: each `meta` block starts a new request.
 * A `meta` block of type `collection` (what readers make of `bruno.json`) names the mock.
 */
export const bruToOpenApi = (text: string): BrunoResult => {
  const files: Array<Array<Block>> = []
  for (const block of blocksOf(text)) {
    if (block.name === "meta" || files.length === 0) files.push([])
    files[files.length - 1]!.push(block)
  }
  const collected: Array<Collected> = []
  let title: string | undefined
  for (const blocks of files) {
    const find = (name: string): Block | undefined => blocks.find((b) => b.name === name)
    const meta = dictionary(find("meta"))
    if (meta.get("type") === "collection") title ??= meta.get("name")
    const methodBlock = blocks.find((b) => METHODS.has(b.name))
    if (methodBlock === undefined) continue
    const type = meta.get("type")
    if (type !== undefined && type !== "http" && type !== "graphql") continue
    const url = dictionary(methodBlock).get("url")
    if (url === undefined || url.length === 0) continue
    const { path, query } = pathFromRaw(url)
    for (const name of dictionary(find("params:query")).keys()) query.push(name)
    const json = textOf(find("body:json"))
    const form = dictionary(find("body:form-urlencoded"))
    const body: Json | undefined = json !== undefined ? parseJson(json) : form.size > 0 ? Object.fromEntries(form) : undefined
    const method = methodBlock.name
    collected.push({ method, path, name: meta.get("name") ?? `${method.toUpperCase()} ${path}`, description: noEmpty(textOf(find("docs"))), tags: [], query, body, responses: [] })
  }
  return finish(collected, title, "bru")
}

const finish = (collected: ReadonlyArray<Collected>, title: string | undefined, version: string): BrunoResult => {
  if (collected.length === 0) {
    return {
      ok: false,
      error: {
        stage: "ingestion",
        message: "Aucune requête HTTP dans cette collection Bruno.",
        pointer: "#",
        suggestions: ["Exportez la collection depuis Bruno (Share, puis Bruno Collection), ou collez ses fichiers .bru : gRPC et WebSocket ne sont pas repris."],
      },
    }
  }
  const { document, requests } = collectionToOpenApi(collected, { title: title ?? "collection-bruno", version: "1.0.0" })
  return { ok: true, document, version, requests }
}
