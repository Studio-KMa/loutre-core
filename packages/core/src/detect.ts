/**
 * Document reading and format detection. No Effect, no OpenAPI parser: this
 * module runs as-is in the browser, for the landing page's "openapi 3.1 detected" badge.
 */
import { parse as parseYaml, YAMLParseError } from "yaml"
import type { Diagnostic } from "./diagnostic"
import type { JsonObject, SpecFormat } from "./model"
import { bruToOpenApi, brunoToOpenApi, isBrunoCollection, looksLikeBru } from "./bruno"
import { curlToOpenApi, looksLikeCurl } from "./curl"
import { harToOpenApi, isHar, slimHar } from "./har"
import { insomniaToOpenApi, isInsomniaExport } from "./insomnia"
import { isJsonServerDb, jsonServerToOpenApi } from "./json-server"
import { isPostmanCollection, postmanToOpenApi } from "./postman"
import { looksLikeTypeScript, typescriptToOpenApi } from "./typescript"
import { isPlainObject } from "./util/pointer"

export type { Diagnostic }
export { isPlainObject }

export interface Detection {
  readonly format: SpecFormat
  /** Version declared in the document ("3.0.3", "2.0"), or empty. */
  readonly version: string
}

export type ReadResult =
  | {
      readonly ok: true
      /** The OpenAPI document, as pasted or converted (TypeScript, Postman, Insomnia, Bruno, HAR, db.json, curl). */
      readonly document: JsonObject
      /** Set when the document comes from a conversion: detection is already done. */
      readonly detected?: Detection | undefined
    }
  | { readonly ok: false; readonly error: Diagnostic }

export type DetectResult =
  | { readonly ok: true; readonly detection: Detection }
  | { readonly ok: false; readonly error: Diagnostic }

const describeType = (u: unknown): string =>
  u === null ? "null" : Array.isArray(u) ? "un tableau" : typeof u === "string" ? "une chaîne" : `un ${typeof u}`

/** Parses a string (JSON or YAML) or accepts an already parsed object. */
export const readDocument = (input: string | object, embedded = false): ReadResult => {
  if (typeof input !== "string") {
    if (!isPlainObject(input)) {
      return fail(`Le document doit être un objet à la racine, pas ${describeType(input)}.`)
    }
    return { ok: true, document: input as JsonObject }
  }
  const text = input.trim()
  if (text.length === 0) {
    return fail("Le document est vide. Collez un schéma OpenAPI 3.x (YAML ou JSON), un Swagger 2.0, des types TypeScript, une collection Postman, Insomnia ou Bruno, un fichier HAR, un db.json, des commandes curl ou un schéma GraphQL.")
  }
  if (looksLikeGraphql(text)) {
    return { ok: true, document: graphqlPlaceholder(text, sdlOperations(text)), detected: { format: "graphql", version: "" } }
  }
  if (looksLikeCurl(text)) {
    const converted = curlToOpenApi(text)
    if (!converted.ok) return converted
    return { ok: true, document: converted.document, detected: { format: "curl", version: "" } }
  }
  if (looksLikeBru(text)) {
    const converted = bruToOpenApi(text)
    if (!converted.ok) return converted
    return { ok: true, document: converted.document, detected: { format: "bruno", version: converted.version } }
  }
  if (looksLikeTypeScript(text)) {
    const converted = typescriptToOpenApi(text)
    if (!converted.ok) return converted
    return { ok: true, document: converted.document, detected: { format: "typescript", version: "" } }
  }
  let parsed: unknown
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      parsed = JSON.parse(text)
    } catch (cause) {
      // YAML reads JSON too, trailing commas included (`{ "a": 1, }`, common in hand-edited files): give it a chance.
      const lenient = lenientJson(text)
      if (lenient === undefined) {
        return fail(`JSON invalide : ${cause instanceof Error ? cause.message : String(cause)}`, {
          suggestions: ["Vérifiez les virgules en fin de liste et les guillemets : JSON n'accepte ni commentaires ni virgules finales."],
        })
      }
      parsed = lenient
    }
  } else {
    try {
      parsed = parseYaml(text, { maxAliasCount: 1000, uniqueKeys: false })
    } catch (cause) {
      const where =
        cause instanceof YAMLParseError && cause.linePos?.[0]
          ? `, ligne ${cause.linePos[0].line} colonne ${cause.linePos[0].col}`
          : ""
      const reason = cause instanceof Error ? cause.message.split("\n")[0] : String(cause)
      return fail(`YAML invalide${where} : ${reason}`)
    }
  }
  if (!isPlainObject(parsed)) {
    return fail(`Le document doit être un objet à la racine, pas ${describeType(parsed)}.`)
  }
  const document = parsed as JsonObject
  if (isIntrospection(document)) {
    return { ok: true, document: graphqlPlaceholder(JSON.stringify(document), introspectionOperations(document)), detected: { format: "graphql", version: "" } }
  }
  if (isPostmanCollection(document)) {
    const converted = postmanToOpenApi(document)
    if (!converted.ok) return converted
    return { ok: true, document: converted.document, detected: { format: "postman", version: converted.version } }
  }
  if (isInsomniaExport(document)) {
    // Checked before converting: an export nested in an export nested in… would be re-read at every level.
    if (embedded) return fail("Cet export Insomnia contient un autre export Insomnia en guise de spécification.")
    const converted = insomniaToOpenApi(document)
    if (!converted.ok) return converted
    // An Insomnia design document carries its specification: read it as if it had been pasted.
    if ("embedded" in converted) return embeddedSpec(converted.embedded)
    return { ok: true, document: converted.document, detected: { format: "insomnia", version: converted.version } }
  }
  if (isBrunoCollection(document)) {
    const converted = brunoToOpenApi(document)
    if (!converted.ok) return converted
    return { ok: true, document: converted.document, detected: { format: "bruno", version: converted.version } }
  }
  if (isHar(document)) {
    const converted = harToOpenApi(document)
    if (!converted.ok) return converted
    return { ok: true, document: converted.document, detected: { format: "har", version: converted.version } }
  }
  // Last: a json-server db.json is only lists and objects, which many documents also are.
  if (isJsonServerDb(document)) {
    const converted = jsonServerToOpenApi(document)
    if (!converted.ok) return converted
    return { ok: true, document: converted.document, detected: { format: "json-server", version: "" } }
  }
  return { ok: true, document }
}

/** The specification inside an Insomnia design document; never another export, so no loop. */
const embeddedSpec = (embedded: string | JsonObject): ReadResult => readDocument(embedded, true)

// ─── GraphQL, recognised without graphql-js ───────────────────────────────────
// The conversion itself (graphql/schema.ts) needs graphql-js; this module stays free of it,
// so the landing's badge costs nothing. Ingestion converts the placeholder below.

/** A GraphQL SDL: a root type or a schema block. `type Query {`, never TypeScript's `type Query = {`. */
export const looksLikeGraphql = (text: string): boolean =>
  /^\s*(extend\s+)?type\s+(Query|Mutation)\b[^={]*\{/m.test(text) || /^\s*schema\s*(@\w+\s*)*\{/m.test(text)

const introspectionSchema = (document: JsonObject): JsonObject | undefined => {
  const data = document["data"]
  const schema = isPlainObject(data) ? data["__schema"] : document["__schema"]
  return isPlainObject(schema) && Array.isArray(schema["types"]) ? (schema as JsonObject) : undefined
}

/** What GraphiQL, Apollo or get-graphql-schema save: `{ "data": { "__schema": … } }` or `{ "__schema": … }`. */
export const isIntrospection = (document: JsonObject): boolean => introspectionSchema(document) !== undefined

/** Root fields of `type Query { … }` and `type Mutation { … }`, counted for the badge. */
const sdlOperations = (text: string): number => {
  let count = 0
  for (const match of text.matchAll(/(?:^|\n)\s*(?:extend\s+)?type\s+(?:Query|Mutation)\b[^{]*\{([^}]*)\}/g)) {
    const body = (match[1] ?? "").replace(/"""[\s\S]*?"""|"[^"\n]*"|#[^\n]*/g, "")
    // A field starts a line with a name, then its arguments or a colon.
    count += [...body.matchAll(/^\s*\w+\s*[(:]/gm)].length
  }
  return count
}

const introspectionOperations = (document: JsonObject): number => {
  const schema = introspectionSchema(document)
  if (schema === undefined) return 0
  const roots = [schema["queryType"], schema["mutationType"]].map((t) => (isPlainObject(t) ? t["name"] : undefined)).filter((n): n is string => typeof n === "string")
  let count = 0
  for (const type of schema["types"] as ReadonlyArray<unknown>) {
    if (isPlainObject(type) && roots.includes(String(type["name"])) && Array.isArray(type["fields"])) count += type["fields"].length
  }
  return count
}

/** Until ingestion converts it (graphql-js), a GraphQL schema travels as this placeholder. */
const graphqlPlaceholder = (source: string, operations: number): JsonObject => ({
  openapi: "3.1.0",
  info: { title: /@title\s+([\w.-]+)/.exec(source)?.[1] ?? "graphql-api", version: "1.0.0" },
  paths: {},
  "x-loutre-graphql-source": source,
  "x-loutre-graphql-operations": operations,
})

/**
 * What leaves the browser, and what the API keeps: a HAR is reduced to its API calls,
 * without headers or cookies (`slimHar`); any other document is unchanged.
 */
const lenientJson = (text: string): unknown => {
  try {
    const parsed: unknown = parseYaml(text, { maxAliasCount: 1000, uniqueKeys: false })
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export const sanitizeSpec = (text: string): string => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") || !trimmed.includes('"log"')) return text
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isPlainObject(parsed) && isHar(parsed as JsonObject) ? JSON.stringify(slimHar(parsed as JsonObject)) : text
  } catch {
    return text
  }
}

const OPENAPI_30 = /^3\.0\.\d+$/
const OPENAPI_31 = /^3\.1\.\d+$/
const OPENAPI_32 = /^3\.2\.\d+$/

/** Detects the format of a parsed document. */
export const detectFormat = (document: JsonObject): DetectResult => {
  const openapi = document["openapi"]
  const swagger = document["swagger"]

  if (typeof openapi === "string") {
    const version = openapi.trim()
    if (OPENAPI_32.test(version)) return ok("openapi-3.2", version)
    if (OPENAPI_31.test(version)) return ok("openapi-3.1", version)
    if (OPENAPI_30.test(version)) return ok("openapi-3.0", version)
    return fail(`OpenAPI ${version} n'est pas pris en charge (versions lues : 3.0.x, 3.1.x et 3.2.x).`, {
      pointer: "#/openapi",
      suggestions: version.startsWith("3")
        ? [`Écrivez la version complète, par exemple \`openapi: 3.1.0\`.`]
        : ["Si votre document suit OpenAPI 3, passez la ligne `openapi:` à `3.1.0`."],
    })
  }
  if (typeof swagger === "string" || typeof swagger === "number") {
    const version = String(swagger).trim()
    if (version === "2.0") return ok("swagger-2.0", version)
    return fail(`Swagger ${version} n'est pas pris en charge : seule la 2.0 l'est (convertie automatiquement en OpenAPI 3.1).`, {
      pointer: "#/swagger",
    })
  }
  if (openapi !== undefined) {
    return fail(`La clé \`openapi\` doit être une chaîne (« 3.1.0 »), pas ${describeType(openapi)}.`, {
      pointer: "#/openapi",
    })
  }
  if ("asyncapi" in document) {
    return fail("Ceci est un document AsyncAPI. Loutre ne lit que des API HTTP : OpenAPI 3.x ou Swagger 2.0.", {
      pointer: "#/asyncapi",
    })
  }
  const suggestions: Array<string> = []
  if ("paths" in document) {
    suggestions.push("Ajoutez en tête de document `openapi: 3.1.0` et un bloc `info` avec `title` et `version`.")
  } else if ("collection" in document) {
    suggestions.push("On dirait un export Postman enveloppé : collez le contenu de `collection`, ou exportez la collection seule au format v2.1.")
  } else {
    suggestions.push("Un schéma OpenAPI commence par `openapi: 3.1.0` (ou `swagger: \"2.0\"`) et décrit ses routes sous `paths`. Des types TypeScript, une collection Postman, Insomnia ou Bruno, un fichier HAR, un db.json ou des commandes curl marchent aussi.")
  }
  return fail("Aucune clé `openapi` ni `swagger` à la racine : ce n'est pas un schéma OpenAPI.", {
    pointer: "#",
    suggestions,
  })
}

/** Reading and detection in one go. */
export const detect = (input: string | object): DetectResult => {
  const read = readDocument(input)
  if (!read.ok) return read
  return read.detected === undefined ? detectFormat(read.document) : { ok: true, detection: read.detected }
}

const ok = (format: SpecFormat, version: string): DetectResult => ({ ok: true, detection: { format, version } })

const fail = (
  message: string,
  extra: { pointer?: string; suggestions?: ReadonlyArray<string> } = {},
): { readonly ok: false; readonly error: Diagnostic } => ({
  ok: false,
  error: { stage: "ingestion", message, pointer: extra.pointer, suggestions: extra.suggestions ?? [] },
})
