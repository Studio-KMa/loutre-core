/**
 * `curl` commands as input: the browser's "Copy as cURL" (one request or "Copy all"),
 * or the examples of an API's documentation, pasted one after the other. Each command
 * becomes a route; sent bodies give the shapes, as for a collection without examples.
 */
import { collectionToOpenApi, METHODS, parseJson, pathFromRaw, templateIds, type Collected } from "../collections"
import type { Diagnostic } from "../diagnostic"
import type { Json, JsonObject } from "../model"

export type CurlResult =
  | { readonly ok: true; readonly document: JsonObject; readonly version: string; readonly requests: number }
  | { readonly ok: false; readonly error: Diagnostic }

/** The first line that says something starts with `curl` (a `$ ` prompt allowed). */
export const looksLikeCurl = (text: string): boolean => {
  const first = text.split(/\r?\n/).find((line) => line.trim().length > 0 && !line.trim().startsWith("#"))
  return first !== undefined && /^\s*(\$\s+)?curl(\.exe)?\s/.test(first)
}

const ANSI_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v" }

/** Shell words, commands split on `;`, `&&`, `|` and unescaped newlines. Quotes: '…', "…", $'…'. */
export const shellCommands = (text: string): Array<Array<string>> => {
  const commands: Array<Array<string>> = []
  let words: Array<string> = []
  let word = ""
  let inWord = false
  const endWord = (): void => {
    if (inWord) words.push(word)
    word = ""
    inWord = false
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === "\\" && (text[i + 1] === "\n" || (text[i + 1] === "\r" && text[i + 2] === "\n"))) {
      i += text[i + 1] === "\r" ? 2 : 1
      continue
    }
    if (c === "#" && !inWord) {
      while (i < text.length && text[i] !== "\n") i++
      endCommand()
      continue
    }
    if (c === "\n" || c === ";" || c === "|" || (c === "&" && text[i + 1] === "&")) {
      if (c === "&") i++
      endCommand()
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord()
      continue
    }
    inWord = true
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      word += text.slice(i + 1, end === -1 ? text.length : end)
      i = end === -1 ? text.length : end
    } else if (c === "$" && text[i + 1] === "'") {
      i += 2
      while (i < text.length && text[i] !== "'") {
        if (text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1]!
          if (next === "x" && /^[0-9a-f]{2}$/i.test(text.slice(i + 2, i + 4))) {
            word += String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16))
            i += 4
          } else if (next === "u" && /^[0-9a-f]{4}$/i.test(text.slice(i + 2, i + 6))) {
            word += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16))
            i += 6
          } else {
            word += ANSI_ESCAPES[next] ?? next
            i += 2
          }
        } else word += text[i++]
      }
    } else if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1]!)) i++
        word += text[i++]
      }
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i]
    } else word += c
  }
  endCommand()
  return commands
}

/** Options followed by a value that says nothing about the route. */
const VALUE_OPTIONS = new Set([
  "-A", "--user-agent", "-e", "--referer", "-o", "--output", "-m", "--max-time", "-u", "--user", "-b", "--cookie", "-c", "--cookie-jar",
  "--connect-timeout", "-w", "--write-out", "--retry", "--proto", "-x", "--proxy", "-T", "--upload-file", "--cacert", "--cert", "--key",
  "-E", "--resolve", "--limit-rate", "-r", "--range", "--max-redirs", "--interface", "-K", "--config", "--oauth2-bearer", "--aws-sigv4",
])
const DATA_OPTIONS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json"])
const STATIC = /\.(js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|html?)$/i

interface Parsed {
  readonly method: string
  readonly url: string
  readonly body: Json | undefined
  readonly query: ReadonlyArray<string>
}

const formBody = (pairs: ReadonlyArray<string>): JsonObject | undefined => {
  const out: Record<string, Json> = {}
  for (const pair of pairs) {
    for (const part of pair.split("&")) {
      const [key, ...rest] = part.split("=")
      if (key !== undefined && key.length > 0 && !key.includes(" ")) out[decode(key)] = decode(rest.join("=")).replace(/^@.*/, "")
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const decodePath = (text: string): string => {
  try {
    return decodeURI(text)
  } catch {
    return text
  }
}

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "))
  } catch {
    return text
  }
}

const parseCommand = (words: ReadonlyArray<string>): Parsed | undefined => {
  const start = words.findIndex((w) => /^curl(\.exe)?$/.test(w))
  if (start === -1) return undefined
  let method: string | undefined
  let url: string | undefined
  let get = false
  const data: Array<string> = []
  const form: Array<string> = []
  for (let i = start + 1; i < words.length; i++) {
    const w = words[i]!
    const [name, inline] = w.startsWith("--") && w.includes("=") ? [w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)] : [w, undefined]
    const value = (): string => inline ?? words[++i] ?? ""
    if (name === "-X" || name === "--request") method = value()
    else if (w.startsWith("-X") && w.length > 2) method = w.slice(2)
    else if (name === "--url") url = value()
    else if (DATA_OPTIONS.has(name)) data.push(value())
    else if (name === "-F" || name === "--form" || name === "--form-string") form.push(value())
    else if (name === "-G" || name === "--get") get = true
    else if (name === "-H" || name === "--header") value()
    else if (VALUE_OPTIONS.has(name)) value()
    else if (!w.startsWith("-") && url === undefined) url = w
  }
  if (url === undefined) return undefined
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/\//, "")}`
  let body: Json | undefined
  const query: Array<string> = []
  if (get) {
    for (const name of Object.keys(formBody(data) ?? {})) query.push(name)
  } else if (data.length > 0) {
    body = parseJson(data.join("")) ?? formBody(data)
  } else if (form.length > 0) {
    body = formBody(form)
  }
  const verb = (method ?? (!get && (data.length > 0 || form.length > 0) ? "POST" : "GET")).toLowerCase()
  return { method: verb, url: withScheme, body, query }
}

export const curlToOpenApi = (text: string): CurlResult => {
  const collected: Array<Collected> = []
  let host: string | undefined
  for (const words of shellCommands(text)) {
    const parsed = parseCommand(words)
    if (parsed === undefined || !METHODS.has(parsed.method)) continue
    let url: URL
    try {
      url = new URL(parsed.url)
    } catch {
      continue
    }
    if (STATIC.test(url.pathname)) continue
    host ??= url.host
    // `new URL` encodes `{{id}}` and `{id}`: decode before reading the variables.
    const { path: raw, query } = pathFromRaw(decodePath(url.pathname) + url.search)
    const path = templateIds(raw)
    collected.push({ method: parsed.method, path, name: `${parsed.method.toUpperCase()} ${path}`, description: undefined, tags: [], query: [...query, ...parsed.query], body: parsed.body, responses: [] })
  }
  if (collected.length === 0) {
    return { ok: false, error: { stage: "ingestion", message: "Aucune commande curl avec une adresse HTTP.", pointer: "#", suggestions: ["Collez des commandes du type curl https://api.exemple.fr/users -H \"Authorization: …\", une par ligne ou séparées par des ;."] } }
  }
  const { document, requests } = collectionToOpenApi(collected, { title: host ?? "curl", version: "1.0.0" })
  return { ok: true, document, version: "", requests }
}
