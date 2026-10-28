/**
 * Request collections (Postman, Insomnia, Bruno) as input. Each reader brings its
 * requests down to the same shape (`Collected`); this module turns them into an
 * OpenAPI 3.1 document: paths, parameters, schemas from examples and sent bodies.
 *
 * Many collections carry no response example (Insomnia never exports any): the
 * answer is then deduced from what the collection sends to the same resource,
 * so `GET /users` returns a list of the users that `POST /users` creates.
 *
 * The values a collection shows are kept as hints (`hint`): numbers stay in the order
 * of magnitude seen, category-like strings keep the vocabulary seen, and the first
 * generated element reproduces sample titles and notes, as with an OpenAPI `example`.
 */
import type { Json, JsonObject } from "../model"
import { inferSchema, mergeSchemas, singular, titleFromName } from "../util/infer-schema"
import { isPlainObject, setOwn } from "../util/pointer"

export const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"])

export interface CollectedResponse {
  readonly code: number
  readonly body: Json | undefined
  readonly name: string | undefined
}

export interface Collected {
  readonly method: string
  readonly path: string
  readonly name: string
  readonly description: string | undefined
  readonly tags: ReadonlyArray<string>
  readonly query: ReadonlyArray<string>
  readonly body: Json | undefined
  readonly responses: ReadonlyArray<CollectedResponse>
}

export const stringOf = (u: unknown): string | undefined => (typeof u === "string" && u.length > 0 ? u : undefined)

export const parseJson = (text: unknown): Json | undefined => {
  if (typeof text !== "string" || text.trim().length === 0) return undefined
  try {
    return JSON.parse(text) as Json
  } catch {
    return undefined
  }
}

/** Form fields (`[{ key | name, value, disabled | enabled }]`) as the object the server receives. */
export const formObject = (fields: unknown): JsonObject | undefined => {
  if (!Array.isArray(fields)) return undefined
  const object: Record<string, Json> = {}
  for (const field of fields) {
    if (!isPlainObject(field) || field["disabled"] === true || field["enabled"] === false) continue
    const key = stringOf(field["key"]) ?? stringOf(field["name"])
    if (key !== undefined) object[key] = typeof field["value"] === "string" ? field["value"] : ""
  }
  return Object.keys(object).length === 0 ? undefined : object
}

/**
 * Path segments of every tool's syntax to OpenAPI: `:id`, `{{id}}` (Postman, Bruno)
 * and `{{ _.id }}` (Insomnia) become `{id}`; the host, or a leading host variable, is dropped.
 */
export const cleanSegments = (segments: ReadonlyArray<string>): string =>
  `/${segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      if (s.startsWith(":")) return `{${s.slice(1)}}`
      const variable = /^\{\{\s*(?:_\.)?([\w-]+)\s*\}\}$/.exec(s)
      return variable === null ? s.replace(/\{\{\s*(?:_\.)?([\w-]+)\s*\}\}/g, "{$1}") : `{${variable[1]}}`
    })
    .join("/")}`

/** A raw URL (`{{baseUrl}}/users/:id?page=1`) to its path and query parameter names. */
export const pathFromRaw = (raw: string): { path: string; query: Array<string> } => {
  const [beforeQuery = "", queryString] = raw.split("?", 2) as [string, string | undefined]
  const text = beforeQuery
    .trim()
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\{\{[^}]+\}\}/, "")
  const query: Array<string> = []
  if (queryString !== undefined) {
    for (const pair of queryString.split("&")) {
      const name = safeDecode(pair.split("=")[0] ?? "")
      if (name.length > 0) query.push(name)
    }
  }
  return { path: cleanSegments(text.split("/")), query }
}

const safeDecode = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

const V_SEGMENT = /^v\d+(\.\d+)?$/i
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24}|(?=[\w-]*\d)[\w-]{8,})$/i

/**
 * Concrete ids in a recorded path become parameters: `/v1/users/42/orders/7` →
 * `/v1/users/{userId}/orders/{id}`. An id ending the path is `id`, the others are named
 * after their collection; names already in the path are never reused.
 */
export const templateIds = (path: string): string => {
  const segments = path.split("/").filter((s) => s.length > 0).map(safeDecode)
  const isId = segments.map((s) => !s.startsWith("{") && !V_SEGMENT.test(s) && ID_SEGMENT.test(s))
  const taken = new Set(segments.filter((s) => s.startsWith("{")).map((s) => s.slice(1, -1)))
  const unique = (name: string): string => {
    let candidate = name
    for (let n = 2; taken.has(candidate); n++) candidate = `${name}${n}`
    taken.add(candidate)
    return candidate
  }
  return `/${segments
    .map((segment, index) => {
      if (!isId[index]) return segment
      const previous = segments[index - 1]
      const named = index === segments.length - 1 ? "id" : previous === undefined || previous.startsWith("{") ? `param${index}` : `${singular(previous).replace(/[^\w]/g, "")}Id`
      return `{${unique(named)}}`
    })
    .join("/")}`
}


/** Component name for a route: `/users/{id}` → `User`, `/orders/{id}/lines` → `Line`. */
export const entityOf = (path: string): { title: string; plural: boolean; item: boolean } | undefined => {
  const segments = path.split("/").filter((s) => s.length > 0)
  const statics = segments.filter((s) => !s.startsWith("{"))
  const last = statics[statics.length - 1]
  if (last === undefined) return undefined
  const lastSegment = segments[segments.length - 1] ?? ""
  return { title: titleFromName(last), plural: singular(last.toLowerCase()) !== last.toLowerCase(), item: lastSegment.startsWith("{") }
}

const defaultStatus = (method: string): number => (method === "post" ? 201 : method === "delete" ? 204 : 200)

// ─── Hints from the values a collection shows ───────────────────────────────

interface Observed {
  readonly strings: Set<string>
  readonly numbers: Array<number>
}

const tokensOf = (name: string): Array<string> =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)

/** Fields whose values must vary from one element to the next, whatever the sample says. */
const OWN_VALUE = new Set([
  "id", "ids", "uuid", "name", "nom", "prenom", "firstname", "lastname", "email", "mail", "phone", "tel", "telephone", "mobile",
  "address", "adresse", "street", "rue", "city", "ville", "zip", "postal", "url", "website", "site", "link", "photo", "photos",
  "image", "avatar", "logo", "serial", "numero", "number", "ref", "reference", "sku", "isbn", "ean", "siret", "siren", "iban",
  "plate", "immatriculation", "licence", "license", "matricule", "token", "password", "slug", "login", "username",
  "description", "comment", "message", "note", "notes", "title", "titre", "text", "content", "body", "bio", "summary",
])
const COORDINATES = new Set(["lat", "lng", "lon", "latitude", "longitude"])
/**
 * Free text the first element may reproduce: a listing's title, a note, an object's own name.
 * Never a person's name, email or address, which the generator keeps consistent with each other.
 */
const SHOWN_TEXT = new Set(["title", "titre", "description", "message", "comment", "note", "notes", "text", "content", "summary", "bio", "subject", "objet", "label", "libelle"])
const showsText = (tokens: ReadonlyArray<string>): boolean => tokens.some((t) => SHOWN_TEXT.has(t)) || (tokens.length === 1 && tokens[0] === "name")
/** With real traffic (HAR), only these fields may keep their values: a status is not personal data, a company name may be. */
const CATEGORY = new Set(["status", "state", "statut", "etat", "type", "kind", "category", "categorie", "genre", "role", "plan", "tier", "level", "currency", "devise", "country", "pays", "lang", "language", "locale", "method", "mode", "priority", "priorite", "visibility", "channel", "source", "format", "unit", "unite", "gender", "civilite"])

export interface CollectionOptions {
  /**
   * `shapes` for real traffic (HAR): values only give ranges and category vocabularies,
   * never a text or a name reproduced in a mock that may be public.
   */
  readonly values?: "shown" | "shapes"
}

/** A category-like value: a word or three, not an identifier. */
const categorical = (field: string, value: string): boolean => {
  const tokens = tokensOf(field)
  if (tokens.some((t) => OWN_VALUE.has(t)) || tokens[tokens.length - 1] === "id") return false
  const text = value.trim()
  const words = text.split(/\s+/).length
  // A code reads as one token (`application/json`, `describedby`), a label as up to three words.
  const fits = words === 1 ? text.length <= 64 : text.length <= 32 && words <= 3
  return text.length > 0 && fits && (text.match(/\d/g) ?? []).length < 3
}

/** A string that `shapes` mode would still read: the value of a category field (`status: "paid"`). */
export const keepsCategoryValue = (field: string, value: string): boolean => tokensOf(field).some((t) => CATEGORY.has(t)) && categorical(field, value)

/** Around the values seen: half to one and a half times, years kept as years, 0–100 kept under 100. */
const rangeOf = (values: ReadonlyArray<number>): { minimum: number; maximum: number } => {
  const low = Math.min(...values)
  const high = Math.max(...values)
  const integer = values.every(Number.isInteger)
  if (integer && low >= 1900 && high <= 2100) return { minimum: low - 20, maximum: high }
  let minimum = low >= 0 ? low * 0.5 : low * 1.5
  let maximum = high >= 0 ? high * 1.5 : high * 0.5
  if (low >= 0 && high <= 100 && maximum > 100) maximum = 100
  if (integer) {
    minimum = Math.floor(minimum)
    maximum = Math.ceil(maximum)
    if (maximum - minimum < 4) maximum = minimum + 4
  } else {
    minimum = Math.round(minimum * 100) / 100
    maximum = Math.round(maximum * 100) / 100
  }
  return { minimum, maximum }
}

const isObjectSchema = (schema: JsonObject): boolean => schema["type"] === "object"

const COMPONENT = "#/components/schemas/"

/** Schemas drawn from samples (example responses, sent bodies), with the values they show as hints. */
export interface ExampleShaper {
  /** The values a sample shows, field by field (`User.email`): every sample, before any is shaped. */
  readonly observe: (value: Json | undefined, title: string | undefined) => void
  /** The schema inferred from a sample, with the magnitudes and vocabulary the samples show. */
  readonly shaped: (value: Json, title: string | undefined) => Record<string, Json>
  /**
   * Titled objects, at any depth, become `$ref`s to one schema per title: a later sample of the
   * same entity adds the fields the first lacked, instead of the first one winning.
   */
  readonly register: (schema: Record<string, Json>) => JsonObject
  readonly schemas: Record<string, Record<string, Json>>
}

export const exampleShaper = (
  options: CollectionOptions & {
    /** Names a titled sample may not take (the document's own components): such objects stay anonymous. */
    readonly reserved?: ReadonlySet<string> | undefined
  } = {},
): ExampleShaper => {
  const shapesOnly = options.values === "shapes"
  const schemas: Record<string, Record<string, Json>> = {}
  const observed = new Map<string, Observed>()

  const observe = (value: Json | undefined, title: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 100)) observe(item, title)
      return
    }
    if (!isPlainObject(value)) return
    for (const [field, item] of Object.entries(value)) {
      if (Array.isArray(item) || isPlainObject(item)) {
        observe(item as Json, titleFromName(field))
        continue
      }
      // An anonymous wrapper (`{ data: [...] }`) has no fields of its own worth a hint, but its entities do.
      if (title === undefined) continue
      const key = `${title}.${field}`
      const entry = observed.get(key) ?? { strings: new Set<string>(), numbers: [] }
      if (typeof item === "string") entry.strings.add(item)
      else if (typeof item === "number" && Number.isFinite(item)) entry.numbers.push(item)
      observed.set(key, entry)
    }
  }

  const hint = (schema: Record<string, Json>): Record<string, Json> => {
    if (schema["type"] === "array" && isPlainObject(schema["items"])) return { ...schema, items: hint(schema["items"] as Record<string, Json>) }
    if (schema["type"] !== "object" || !isPlainObject(schema["properties"])) return schema
    const title = typeof schema["title"] === "string" ? schema["title"] : undefined
    const properties: Record<string, Json> = {}
    for (const [field, property] of Object.entries(schema["properties"] as Record<string, Json>)) {
      const seen = title === undefined ? undefined : observed.get(`${title}.${field}`)
      setOwn(properties, field, isPlainObject(property) ? hintField(field, property as Record<string, Json>, seen) : property)
    }
    return { ...schema, properties }
  }
  const hintField = (field: string, property: Record<string, Json>, seen: Observed | undefined): Json => {
    if (property["type"] === "object" || property["type"] === "array") return hint(property)
    if (seen === undefined) return property
    const tokens = tokensOf(field)
    if ((property["type"] === "number" || property["type"] === "integer") && seen.numbers.length > 0) {
      if (tokens.some((t) => COORDINATES.has(t)) || tokens[tokens.length - 1] === "id") return property
      // A range, not an example: an example would be copied onto every element.
      return { ...property, ...rangeOf(seen.numbers) }
    }
    if (property["type"] === "string" && property["format"] === undefined && seen.strings.size > 0) {
      const values = [...seen.strings]
      const allowed = !shapesOnly || tokens.some((t) => CATEGORY.has(t))
      if (allowed && values.every((value) => categorical(field, value))) return { ...property, enum: values.slice(0, 12) }
      if (!shapesOnly && showsText(tokens)) return { ...property, example: values[0]! }
    }
    return property
  }
  const shaped = (value: Json, title: string | undefined): Record<string, Json> => hint(inferSchema(value, title) as Record<string, Json>)

  const register = (schema: Record<string, Json>): JsonObject => {
    if (schema["type"] === "array" && isPlainObject(schema["items"])) return { ...schema, items: register(schema["items"] as Record<string, Json>) }
    if (!isObjectSchema(schema) || !isPlainObject(schema["properties"])) return schema
    const properties: Record<string, Json> = {}
    for (const [field, property] of Object.entries(schema["properties"] as Record<string, Json>)) {
      setOwn(properties, field, isPlainObject(property) ? register(property as Record<string, Json>) : property)
    }
    const own: Record<string, Json> = { ...schema, properties }
    const title = schema["title"]
    if (typeof title !== "string") return own
    if (options.reserved?.has(title) === true) {
      delete own["title"]
      return own
    }
    const known = schemas[title]
    schemas[title] = known === undefined ? own : (mergeSchemas(known, own) as Record<string, Json>)
    return { $ref: `${COMPONENT}${title}` }
  }

  return { observe, shaped, register, schemas }
}

/**
 * `$ref`s from `register`, replaced by the schemas themselves, for a document that is already
 * dereferenced: the schemas are shared by identity (an entity inside itself stays a cycle).
 */
export const inlineRegistered = (schemas: Record<string, Record<string, Json>>, roots: ReadonlyArray<JsonObject>): Array<JsonObject> => {
  const target = (node: Json): Json => {
    if (!isPlainObject(node)) return node
    const ref = node["$ref"]
    if (typeof ref === "string" && ref.startsWith(COMPONENT)) return schemas[ref.slice(COMPONENT.length)] ?? {}
    replace(node as Record<string, Json>)
    return node
  }
  const replace = (schema: Record<string, Json>): void => {
    if (isPlainObject(schema["items"])) schema["items"] = target(schema["items"] as Json)
    if (isPlainObject(schema["properties"])) {
      const properties = schema["properties"] as Record<string, Json>
      for (const field of Object.keys(properties)) setOwn(properties, field, target(properties[field]!))
    }
  }
  for (const schema of Object.values(schemas)) replace(schema)
  return roots.map((root) => target(root) as JsonObject)
}

export const collectionToOpenApi = (
  collected: ReadonlyArray<Collected>,
  info: { readonly title: string; readonly version: string; readonly description?: string | undefined },
  options: CollectionOptions = {},
): { readonly document: JsonObject; readonly requests: number } => {
  const paths: Record<string, Record<string, Json>> = {}
  const { observe, shaped, register, schemas } = exampleShaper(options)
  for (const request of collected) {
    const title = entityOf(request.path)?.title
    for (const response of request.responses) if (response.code < 400) observe(response.body, title)
    if (["post", "put", "patch"].includes(request.method)) observe(request.body, title)
  }

  // First the shapes the collection shows: successful response examples, then bodies sent to create or replace.
  for (const request of collected) {
    const title = entityOf(request.path)?.title
    for (const response of request.responses) {
      if (response.body !== undefined && response.code < 400) register(shaped(response.body, title))
    }
  }
  const sent: Record<string, Record<string, Json>> = {}
  for (const request of collected) {
    const title = entityOf(request.path)?.title
    if (title === undefined || !isPlainObject(request.body) || !["post", "put", "patch"].includes(request.method)) continue
    const schema = shaped(request.body, title)
    const known = sent[title]
    // The first body sent keeps its fields and their order; later ones only add what it lacks.
    const properties = known === undefined ? undefined : (known["properties"] as JsonObject)
    sent[title] =
      known === undefined || properties === undefined
        ? schema
        : { ...known, properties: { ...properties, ...Object.fromEntries(Object.entries(schema["properties"] as JsonObject).filter(([key]) => !(key in properties))) } }
  }

  /** The resource a request without example answers with: seen in an example, else what is sent to it, plus its id. */
  const resourceOf = (title: string): JsonObject => {
    if (schemas[title] !== undefined) return { $ref: `#/components/schemas/${title}` }
    const body = sent[title]
    if (body !== undefined) {
      const properties = body["properties"] as JsonObject
      return register({ ...body, properties: "id" in properties ? properties : { id: { type: "string" }, ...properties } })
    }
    return register({ type: "object", title, properties: { id: { type: "string" } } })
  }

  let requests = 0
  for (const request of collected) {
    const item: Record<string, Json> = paths[request.path] ?? {}
    if (item[request.method] !== undefined) continue
    const entity = entityOf(request.path)
    const title = entity?.title
    const responses: Record<string, Json> = {}
    for (const response of request.responses) {
      const key = String(response.code)
      if (responses[key] !== undefined) continue
      responses[key] =
        response.body === undefined
          ? { description: response.name ?? "OK" }
          : {
              description: response.name ?? "OK",
              // An error has its own shape (`{ error, message }`), never the resource's.
              content: { "application/json": { schema: response.code >= 400 ? inferSchema(response.body) : register(shaped(response.body, title)) } },
            }
    }
    if (Object.keys(responses).length === 0) {
      const status = defaultStatus(request.method)
      if (status === 204 || entity === undefined) {
        responses[String(status)] = status === 204 ? { description: "OK" } : { description: "OK", content: { "application/json": { schema: { type: "object" } } } }
      } else {
        const resource = resourceOf(entity.title)
        const list = request.method === "get" && entity.plural && !entity.item
        responses[String(status)] = { description: "OK", content: { "application/json": { schema: list ? { type: "array", items: resource } : resource } } }
      }
    }
    const operation: Record<string, Json> = { summary: request.name, responses }
    if (request.description !== undefined) operation["description"] = request.description
    if (request.tags.length > 0) operation["tags"] = [...request.tags]
    const parameters: Array<JsonObject> = [...request.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1]!, in: "path", required: true, schema: { type: "string" } }))
    for (const name of new Set(request.query)) parameters.push({ name, in: "query", required: false, schema: { type: "string" } })
    if (parameters.length > 0) operation["parameters"] = parameters
    if (request.body !== undefined && request.method !== "get" && request.method !== "delete") {
      operation["requestBody"] = { required: true, content: { "application/json": { schema: register(shaped(request.body, title)) } } }
    }
    item[request.method] = operation
    paths[request.path] = item
    requests++
  }
  const infoDoc: Record<string, Json> = { title: info.title, version: info.version }
  if (info.description !== undefined) infoDoc["description"] = info.description
  return { document: { openapi: "3.1.0", info: infoDoc, paths, components: { schemas } }, requests }
}
