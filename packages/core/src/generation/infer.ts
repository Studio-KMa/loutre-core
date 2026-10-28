/**
 * Semantic inference: a field name (plus its schema) tells us what to generate.
 * `email` → a real email, `created_at` → a past date, `siret` → a valid SIRET,
 * `name` → a person, product or pet name depending on the parent component.
 */
import type { DataShape } from "../model"

export type Semantic =
  | "id"
  | "uuid"
  | "foreign-id"
  | "email"
  | "first-name"
  | "last-name"
  | "full-name"
  | "username"
  | "phone"
  | "avatar"
  | "image"
  | "url"
  | "hostname"
  | "slug"
  | "title"
  | "sentence"
  | "paragraph"
  | "street"
  | "city"
  | "zip"
  | "country"
  | "country-code"
  | "region"
  | "latitude"
  | "longitude"
  | "company"
  | "product-name"
  | "pet-name"
  | "money"
  | "currency"
  | "quantity"
  | "age"
  | "rating"
  | "percent"
  | "year"
  | "status"
  | "role"
  | "plan"
  | "category"
  | "tag"
  | "color"
  | "locale"
  | "timezone"
  | "iban"
  | "bic"
  | "siret"
  | "siren"
  | "vat"
  | "card"
  | "ip"
  | "user-agent"
  | "sku"
  | "version"
  | "token"
  | "password"
  | "date-past"
  | "date-future"
  | "date-birth"
  | "datetime-created"
  | "datetime-updated"
  | "datetime-deleted"
  | "datetime-past"
  | "datetime-future"
  | "time"
  | "timestamp"
  | "duration"
  | "count"
  | "flag"
  | "error-message"
  | "error-code"
  | "error-status"
  | "base64"
  | "word"
  | "generic"

export interface InferContext {
  /** Title of the enclosing component ("User", "product"). */
  readonly parentTitle?: string | undefined
  /** HTTP status of the response being generated; 4xx/5xx switch to error vocabulary. */
  readonly status?: number | undefined
}

/** Field names are read on their first characters only: the camel-case split below backtracks on long capitals. */
const MAX_NAME_LENGTH = 128

export const tokenize = (name: string): Array<string> =>
  name
    .slice(0, MAX_NAME_LENGTH)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)

const PERSON = /(user|customer|client|member|author|owner|employee|contact|person|people|profile|account|assignee|reviewer|creator|buyer|seller|patient|student|teacher|driver|passenger|guest|host|actor|committer|sender|recipient|participant|attendee|candidate|applicant|friend|follower|subscriber|player)/
const COMPANY = /(company|compan|organi[sz]ation|org\b|team|store|shop|vendor|supplier|merchant|brand|business|enterprise|partner|agency|studio|publisher|manufacturer|employer|tenant|workspace)/
const PRODUCT = /(product|item|article|sku|offer|listing|good|price|plan|variant|catalog|menu|dish|book|course)/
const PET = /(pet|animal|dog|cat|horse)/
const POST = /(post|issue|ticket|task|story|page|blog|news|comment|document|doc|note|event|project|repo|repository|lesson|episode|video|recipe|thread|message|announcement|campaign|survey|form|template)/

/** What a component stands for, when its fields' names depend on it (`Commune.nom`, `Etablissement.nom_commercial`). */
const placeKindOf = (title: string | undefined): "city" | "area" | "company" | undefined => {
  const t = (title ?? "").toLowerCase().replace(/[^a-z]/g, "")
  if (/^(commune|ville|city|cities|town|municipalit|localit|arrondissement)/.test(t)) return "city"
  if (/^(region|departement|department|province|county|epci|collectivite)/.test(t)) return "area"
  if (/(entreprise|societe|etablissement|siege|company|companies|organi[sz]ation|business|unitelegale|employer|dirigeantpm)/.test(t)) return "company"
  return undefined
}

const kindOfTitle = (title: string | undefined): "person" | "company" | "product" | "pet" | "post" | "other" => {
  const t = (title ?? "").toLowerCase()
  if (t.length === 0) return "other"
  if (PET.test(t)) return "pet"
  if (PERSON.test(t)) return "person"
  if (COMPANY.test(t)) return "company"
  if (PRODUCT.test(t)) return "product"
  if (POST.test(t)) return "post"
  return "other"
}

const DATE_WORDS = [
  "at", "date", "time", "timestamp", "on", "when", "ts", "created", "updated", "modified", "deleted", "published",
  "expires", "expiry", "expiration", "due", "start", "starts", "started", "end", "ends", "ended", "since", "until",
  "last", "next", "scheduled", "sent", "received", "opened", "closed", "merged", "pushed", "archived", "cancelled",
  "canceled", "completed", "paid", "shipped", "delivered", "joined", "seen", "login", "activity", "epoch", "datetime",
] as const

const NOT_MONEY = [
  "code", "codes", "id", "number", "numero", "reference", "ref", "type", "kind", "status", "method", "mode",
  "currency", "unit", "label", "name", "description", "url", "link", "behavior", "behaviour", "display", "format",
] as const

export const infer = (name: string, shape: DataShape, ctx: InferContext): Semantic => {
  const tokens = tokenize(name)
  const last = tokens.at(-1) ?? ""
  const first = tokens[0] ?? ""
  const has = (...words: ReadonlyArray<string>): boolean => tokens.some((t) => words.includes(t))
  const endsWith = (...words: ReadonlyArray<string>): boolean => words.includes(last)
  const kind = shape.kind
  const isString = kind === "string"
  const isNumber = kind === "number"

  // An explicit format is authoritative.
  if (isString) {
    switch (shape.format) {
      case "email":
        return "email"
      case "uuid":
        return "uuid"
      case "date-time":
        return dateTimeOf(tokens)
      case "date":
        return dateOf(tokens)
      case "time":
        return "time"
      case "uri":
      case "url":
      case "uri-reference":
      case "iri":
        if (has("avatar", "portrait", "selfie")) return "avatar"
        if (has("photo", "photos", "picture", "pictures")) return kindOfTitle(ctx.parentTitle) === "person" || has("profile", "user") ? "avatar" : "image"
        return has("image", "thumbnail", "logo", "cover", "icon", "img") ? "image" : "url"
      case "hostname":
        return "hostname"
      case "ipv4":
      case "ipv6":
        return "ip"
      case "password":
        return "password"
      case "byte":
        return "base64"
      case "phone":
      case "tel":
        return "phone"
      case "color":
        return "color"
      case "int64":
      case "int32":
        break
    }
  }

  // Inside an error response, error vocabulary wins.
  if (ctx.status !== undefined && ctx.status >= 400) {
    if (isString && has("message", "msg", "detail", "details", "description", "title", "reason", "error", "errors")) {
      return "error-message"
    }
    if (isString && has("code", "type", "kind")) return "error-code"
    if (isNumber && has("code", "status", "statuscode")) return "error-status"
  }

  // The fields of a link holder (`external_urls.spotify`, `links.self`) are links.
  if (isString && !has("name", "title", "type", "rel", "method", "label") && tokenize(ctx.parentTitle ?? "").some((t) => t === "url" || t === "urls" || t === "links")) return "url"

  if (endsWith("id", "ids", "uuid", "guid")) {
    if (last === "uuid" || last === "guid") return "uuid"
    return tokens.length === 1 ? "id" : "foreign-id"
  }
  if (isString && has("uuid", "guid")) return "uuid"

  // A name inside a place or a company names that place or company, never a person: a commune's `nom` is
  // Angers, a region's is Bretagne, an establishment's `nom_commercial` is Cap Horizon.
  if (isString && has("nom", "name", "libelle", "label", "denomination", "enseigne") && !has("prenom", "first", "given", "last", "family", "user", "file", "filename", "display")) {
    const place = placeKindOf(ctx.parentTitle)
    if (place === "city") return "city"
    if (place === "area") return "region"
    if (place === "company" || has("raison", "entreprise", "societe", "commercial", "enseigne")) return "company"
  }
  // Codes of French administrative areas (`codeDepartement`, `codesRegions`): codes, read from their own vocabulary.
  if (isString && has("code", "codes") && has("departement", "departements", "department", "region", "regions", "commune", "communes", "insee", "epci")) return "generic"
  if (isString && has("annee", "year", "mois", "month", "jour", "day") && !has("date", "at", "time", "timestamp", "datetime", "days")) return "generic"

  if (has("email", "mail", "courriel")) return "email"
  if (endsWith("firstname", "prenom", "givenname", "forename") || (has("first", "given") && has("name"))) {
    return "first-name"
  }
  if (
    endsWith("lastname", "surname", "familyname", "nom") ||
    (has("last", "family") && has("name")) ||
    (has("nom") && !has("prenom"))
  ) {
    return "last-name"
  }
  if (has("username", "login", "handle", "nickname", "pseudo", "screenname")) return "username"
  // A person named by their role in the object: the review's author, the ticket's assignee.
  if (isString && endsWith("author", "auteur", "owner", "proprietaire", "customer", "client", "assignee", "reviewer", "organizer", "organiser", "sender", "recipient", "destinataire", "expediteur")) {
    return "full-name"
  }
  if (has("phone", "tel", "telephone", "mobile", "cellphone", "fax")) return "phone"
  if (has("avatar", "portrait", "selfie")) return "avatar"
  // A person's photo is a face; a flat's or a dish's photo is a picture.
  if (has("photo", "photos", "picture", "pictures")) return kindOfTitle(ctx.parentTitle) === "person" || has("profile", "user") ? "avatar" : "image"
  if (has("image", "img", "thumbnail", "thumb", "logo", "cover", "banner", "icon", "illustration")) return "image"
  if (isNumber && has("age")) return "age"
  if (has("birthday", "birthdate", "dob", "birth", "naissance")) return "date-birth"

  if (has("street", "address", "adresse", "rue", "addressline", "line1", "line2")) return "street"
  if (has("city", "town", "ville", "locality")) return "city"
  if (has("zip", "zipcode", "postcode", "postalcode", "postal", "postaux", "cp")) return "zip"
  if (has("country") && has("code")) return "country-code"
  if (has("country", "pays", "nation")) return "country-code"
  if (isString && has("region", "province", "departement", "department")) return "region"
  if (isString && has("state") && /address|location|geo|shipping|billing|place|venue/i.test(ctx.parentTitle ?? "")) return "region"
  if (has("lat", "latitude")) return "latitude"
  if (has("lng", "lon", "long", "longitude")) return "longitude"
  if (has("timezone", "tz")) return "timezone"
  if (has("locale", "language", "lang")) return "locale"

  if (has("currency", "devise", "iso4217")) return "currency"
  if (has("iban")) return "iban"
  if (has("bic", "swift")) return "bic"
  if (has("siret")) return "siret"
  if (has("siren")) return "siren"
  if (has("vat", "tva", "taxid", "taxnumber")) return "vat"
  if (has("card", "pan", "cardnumber") && has("number", "card", "pan")) return "card"
  if (
    has(
      "price", "amount", "total", "subtotal", "cost", "fee", "fees", "tax", "balance", "salary", "revenue",
      "budget", "discount", "refund", "payment", "paid", "due", "unitprice", "unitamount", "montant", "prix",
      "tarif", "shipping", "credit", "debit", "sum", "value",
    ) &&
    (isNumber || isString) &&
    !has(...NOT_MONEY)
  ) {
    if (has("total", "count", "nb", "number") && has("items", "results", "records", "entries")) return "count"
    return "money"
  }
  if (isNumber && has("quantity", "qty", "stock", "inventory", "count", "nb", "num", "number", "length", "size", "total", "views", "likes", "votes", "downloads", "followers", "comments", "stars", "forks", "hits", "retries", "attempts", "seats", "capacity", "children", "pages", "items")) {
    return has("phone", "card", "iban") ? "generic" : "count"
  }
  if (isNumber && has("rating", "score", "note", "stars", "grade")) return "rating"
  if (isNumber && has("percent", "percentage", "pct", "rate", "ratio", "progress", "completion", "share")) return "percent"
  if (isNumber && has("year", "annee")) return "year"
  if (isNumber && has("duration", "elapsed", "timeout", "ttl", "delay", "latency", "ms", "seconds", "minutes", "hours", "days")) return "duration"
  if (isNumber && has(...DATE_WORDS) && !has("count", "total", "number", "nb")) return "timestamp"
  if (isNumber && has("version", "revision", "v")) return "version"

  if (isString && has(...DATE_WORDS)) {
    if (has("date") && !has("time", "at", "timestamp", "datetime")) return dateOf(tokens)
    return dateTimeOf(tokens)
  }

  // Enum-like fields with no declared enum.
  if (isString && has("status", "state", "statut", "etat")) return "status"
  if (isString && has("role", "roles", "permission", "permissions", "scope")) return "role"
  if (isString && has("plan", "tier", "subscription", "level")) return "plan"
  if (isString && has("category", "categories", "categorie", "type", "kind", "genre", "section", "department", "group")) return "category"
  if (isString && has("tag", "tags", "label", "labels", "keyword", "keywords", "topic", "topics", "badge")) return "tag"
  if (isString && has("color", "colour", "couleur", "hex")) return "color"

  // Names: the parent component decides between person, company, product, pet or post.
  if (isString && has("name", "fullname", "displayname", "title", "libelle", "label", "denomination", "raison")) {
    if (has("company", "org", "organization", "organisation", "brand", "vendor", "store", "shop", "business", "employer", "team", "raison")) {
      return "company"
    }
    if (has("product", "item", "article", "sku")) return "product-name"
    if (has("pet", "animal")) return "pet-name"
    if (has("user", "author", "owner", "customer", "contact", "person", "display", "full", "assignee", "member")) {
      return "full-name"
    }
    if (has("title", "headline", "subject", "heading")) return "title"
    const parent = (ctx.parentTitle ?? "").toLowerCase()
    if (/^(plan|tier|subscription|level|pricing)s?$/.test(parent)) return "plan"
    if (/^(role|permission|group)s?$/.test(parent)) return "role"
    if (/^(tag|label|keyword|topic)s?$/.test(parent)) return "tag"
    if (/^(categor(y|ies)|section|department|collection)s?$/.test(parent)) return "category"
    if (/^(address|location|city|place|venue)$/.test(parent)) return "city"
    switch (kindOfTitle(ctx.parentTitle)) {
      case "person":
        return "full-name"
      case "company":
        return "company"
      case "product":
        return "product-name"
      case "pet":
        return "pet-name"
      case "post":
        return "title"
      default:
        return "word"
    }
  }
  if (isString && has("company", "organization", "organisation", "org", "employer", "vendor", "brand", "manufacturer", "publisher", "supplier", "merchant", "societe", "entreprise")) {
    return "company"
  }
  if (isString && has("slug", "permalink", "handle")) return "slug"
  if (isString && has("url", "uri", "link", "href", "website", "homepage", "site", "webhook", "callback", "endpoint", "redirect")) return "url"
  if (isString && has("host", "hostname", "domain", "fqdn")) return "hostname"
  if (isString && has("ip", "ipaddress", "ipv4", "ipv6", "remoteaddr")) return "ip"
  if (isString && has("useragent", "ua", "browser")) return "user-agent"
  if (isString && has("sku", "reference", "ref", "code", "barcode", "ean", "isbn", "serial", "tracking", "order", "invoice", "number", "numero", "matricule", "licence", "license", "plate")) {
    return "sku"
  }
  if (isString && has("version", "semver", "release")) return "version"
  if (isString && has("token", "secret", "apikey", "key", "hash", "signature", "digest", "checksum", "nonce", "jwt", "bearer", "session", "csrf", "otp", "sha", "md5", "fingerprint", "cursor", "etag")) {
    return "token"
  }
  if (isString && has("password", "passwd", "pwd", "motdepasse")) return "password"
  if (isString && has("description", "summary", "bio", "about", "content", "body", "text", "message", "comment", "note", "notes", "excerpt", "abstract", "remark", "remarks", "details", "detail", "commentaire", "resume", "caption", "reason", "explanation", "feedback", "review", "answer", "question", "alt", "transcript", "legende")) {
    return has("body", "content", "text", "description", "bio", "about", "abstract", "transcript", "explanation") ? "paragraph" : "sentence"
  }
  if (isString && has("title", "headline", "subject", "heading", "titre", "objet")) return "title"
  if (isString && has("first")) return "first-name"
  if (isString && has("last")) return "last-name"

  if (kind === "boolean") return "flag"
  if (isNumber && (first === "is" || first === "has")) return "flag"
  return "generic"
}

const dateTimeOf = (tokens: ReadonlyArray<string>): Semantic => {
  const has = (...words: ReadonlyArray<string>): boolean => tokens.some((t) => words.includes(t))
  if (has("created", "creation", "inserted", "registered", "joined", "signup", "opened", "started", "start", "begin", "since", "published", "sent", "pushed", "received", "seen", "login", "activity", "first", "born", "issued")) {
    return has("updated", "modified") ? "datetime-updated" : "datetime-created"
  }
  if (has("updated", "modified", "edited", "changed", "last", "touched", "synced", "refreshed", "merged", "closed", "completed", "paid", "shipped", "delivered", "cancelled", "canceled", "archived", "resolved", "read")) {
    return "datetime-updated"
  }
  if (has("deleted", "removed", "revoked", "disabled")) return "datetime-deleted"
  if (has("expires", "expiry", "expiration", "due", "end", "ends", "until", "next", "scheduled", "deadline", "renew", "renewal", "valid", "trial", "eta", "arrival", "departure", "checkout", "checkin", "future")) {
    return "datetime-future"
  }
  return "datetime-past"
}

const dateOf = (tokens: ReadonlyArray<string>): Semantic => {
  const has = (...words: ReadonlyArray<string>): boolean => tokens.some((t) => words.includes(t))
  if (has("birth", "birthday", "birthdate", "dob", "born", "naissance")) return "date-birth"
  if (has("expires", "expiry", "expiration", "due", "end", "ends", "until", "next", "scheduled", "deadline", "renewal", "valid", "eta", "arrival", "departure", "checkout", "delivery", "future")) {
    return "date-future"
  }
  return "date-past"
}

/** Rough singular of an array name: `tags` → `tag`, `addresses` → `address`. */
export const singular = (name: string): string => {
  if (/ies$/i.test(name)) return name.replace(/ies$/i, "y")
  if (/(ses|xes|ches|shes)$/i.test(name)) return name.replace(/es$/i, "")
  if (/s$/i.test(name) && !/ss$/i.test(name)) return name.replace(/s$/i, "")
  return name
}
