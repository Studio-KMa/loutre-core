/**
 * The local server: same engine as loutre.run, in memory. Writes persist for
 * the session and the x-loutre-* headers behave the same.
 */
import { createServer, type IncomingMessage, type Server } from "node:http"
import { answerGraphql, applyOp, applyWrite, matchRoute, resolve, type Json, type MockDefinition, type ServingRequest } from "@loutre-run/core"

const CORS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, QUERY, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "x-loutre-route, x-loutre-kind, x-loutre-delay, x-loutre-state, allow",
  "cache-control": "no-store",
}
const NO_BODY = new Set([204, 205, 304])
const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"])

export interface ServerOptions {
  /** Keep writes in memory (default true). */
  readonly stateful?: boolean | undefined
  readonly log?: ((line: string) => void) | undefined
}

export interface MockServer {
  readonly server: Server
  /** Swap the served definition (reload) and drop all writes. */
  readonly replace: (mock: MockDefinition) => void
  readonly reset: () => void
}

/** Comme sur loutre.run : au-delà d'un mégaoctet, le corps n'est pas lu. */
const MAX_BODY_BYTES = 1024 * 1024

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolveBody, reject) => {
    const chunks: Array<Buffer> = []
    let received = 0
    req.on("data", (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error("corps de requête trop volumineux"))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

export const createMockServer = (initial: MockDefinition, options: ServerOptions = {}): MockServer => {
  let mock = initial
  let collections: Readonly<Record<string, ReadonlyArray<Json>>> = {}
  const stateful = options.stateful !== false
  const log = options.log ?? (() => undefined)

  const server = createServer((req, res) => {
    void (async () => {
      const method = (req.method ?? "GET").toUpperCase()
      const url = new URL(req.url ?? "/", "http://localhost")
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key.toLowerCase()] = value
        else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(", ")
      }
      if (method === "OPTIONS") {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      const routes = mock.table.routes
      if (url.pathname === "/" && !routes.some((r) => r.path === "/")) {
        const graphql = mock.table.graphql
        send(res, 200, graphql === undefined ? { mock: mock.table.info.title, routes: routes.map((r) => `${r.method.toUpperCase()} ${r.path}`), stateful } : { mock: mock.table.info.title, graphql: graphql.path, stateful }, {})
        return
      }
      let body: Json | undefined
      if (method !== "GET" && method !== "HEAD") {
        const text = await readBody(req)
        if (text.length > 0) {
          try {
            body = JSON.parse(text) as Json
          } catch {
            body = undefined
          }
        }
      }
      const query: Record<string, string> = {}
      url.searchParams.forEach((value, key) => {
        if (!(key in query)) query[key] = value
      })
      const request: ServingRequest = { method, pathname: url.pathname, headers, query, body }
      if (mock.table.graphql !== undefined) {
        // GraphQL: the query runs on the collections, mutations write into the session's state.
        const answered = answerGraphql(mock, {}, request, { collections: stateful ? collections : undefined })
        if (stateful) {
          for (const write of answered.writes) {
            collections = { ...collections, [write.source]: applyOp(collections[write.source] ?? mock.data.collections[write.source] ?? [], write.op).items }
          }
        }
        if (answered.delayMs > 0) await new Promise((r) => setTimeout(r, answered.delayMs))
        const operation = typeof (body as { operationName?: unknown } | undefined)?.operationName === "string" ? ` ${(body as { operationName: string }).operationName}` : ""
        log(`${method} ${url.pathname}${operation} → ${answered.status}${answered.writes.length > 0 ? ` · ${answered.writes.length} écriture(s)` : ""}`)
        send(res, answered.status, answered.body ?? null, { "x-loutre-kind": answered.kind, "x-loutre-delay": String(answered.delayMs), ...answered.headers })
        return
      }
      const result = resolve(mock, {}, request, { collections: stateful ? collections : undefined })
      let responseBody = result.body
      const extra: Record<string, string> = { "x-loutre-kind": result.kind, "x-loutre-delay": String(result.delayMs), ...result.headers }
      if (result.route !== undefined) extra["x-loutre-route"] = result.route.id
      if (stateful && WRITE.has(method) && result.kind === "ok" && result.status < 300) {
        const match = matchRoute(routes, method, url.pathname)
        const write = match === undefined ? undefined : applyWrite(mock, collections, { method, route: match.route, params: match.params, body: result.body })
        if (write !== undefined) {
          collections = write.collections
          responseBody = write.body
          extra["x-loutre-state"] = "saved"
        }
      }
      if (result.delayMs > 0) await new Promise((r) => setTimeout(r, result.delayMs))
      log(`${method} ${url.pathname}${url.search} → ${result.status} ${result.kind}${result.delayMs > 0 ? ` · ${result.delayMs} ms` : ""}`)
      if (responseBody === undefined || method === "HEAD" || NO_BODY.has(result.status)) {
        res.writeHead(result.status, { ...CORS, ...extra })
        res.end()
        return
      }
      send(res, result.status, responseBody, extra)
    })().catch((error: unknown) => {
      log(`erreur : ${error instanceof Error ? error.message : String(error)}`)
      send(res, 500, { error: "internal_error", message: "Une erreur inattendue est survenue." }, {})
    })
  })

  return {
    server,
    replace: (next) => {
      mock = next
      collections = {}
    },
    reset: () => {
      collections = {}
    },
  }
}

const send = (res: import("node:http").ServerResponse, status: number, body: Json, extra: Record<string, string>): void => {
  res.writeHead(status, { ...CORS, ...extra, "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body, null, 2))
}
