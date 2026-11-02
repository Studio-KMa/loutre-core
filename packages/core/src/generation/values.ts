/**
 * Semantic → concrete value. Everything goes through the context's `Rng`,
 * so the same seed always yields the same values.
 */
import type { NumberShape, StringShape } from "../model"
import type { Semantic } from "./infer"
import { tokenize } from "./infer"
import * as P from "./pools"
import type { Rng } from "./random"

export interface Person {
  readonly first: string
  readonly last: string
  readonly full: string
  readonly handle: string
  readonly email: string
}

export interface Company {
  readonly name: string
  readonly slug: string
  readonly domain: string
}

export interface Identity {
  readonly person?: Person
  readonly company?: Company
  readonly city?: P.City
}

export interface ValueContext {
  readonly rng: Rng
  readonly now: Date
  readonly name: string
  readonly parentTitle: string | undefined
  readonly status: number | undefined
  /** Position in the collection: drives sequential ids and pool rotation. */
  readonly index: number
  /** Per-collection offset so pool rotation differs from one mock to the next. */
  readonly salt: number
  readonly inCollection: boolean
  readonly identity: Identity
  /** AI-suggested values for this field, rotated by index. */
  readonly vocabulary: ReadonlyArray<string> | undefined
  /** Values of the data locale. */
  readonly pools: P.Pools
  /** The enclosing object holds someone's details of its own (email, phone, street): its bare `name` is a person's. */
  readonly personal?: boolean | undefined
}

export const slugify = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

export const capitalize = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

export const makePerson = (rng: Rng, pools: P.Pools = P.POOLS.fr): Person => {
  const first = rng.pick(pools.firstNames)
  const last = rng.pick(pools.lastNames)
  const handle = slugify(`${first} ${last}`).replace(/-/g, ".")
  const domain = rng.pick(pools.emailDomains)
  return { first, last, full: `${first} ${last}`, handle, email: `${handle}@${domain}` }
}

export const makeCompany = (rng: Rng, pools: P.Pools = P.POOLS.fr): Company => {
  const name = rng.pick(pools.companies)
  const slug = slugify(name)
  return { name, slug, domain: `${slug}.${pools.companyTld}` }
}

const rotate = <T>(pool: ReadonlyArray<T>, ctx: ValueContext): T =>
  pool[(ctx.salt + ctx.index * 7) % pool.length]!

/** "User" → "usr", "product" → "prd", "order" → "ord". */
export const idPrefix = (title: string | undefined): string => {
  const base = slugify(title ?? "").replace(/-/g, "")
  if (base.length === 0) return "obj"
  const consonants = base.slice(1).replace(/[aeiouy]/g, "")
  return (base[0] + consonants + base.slice(1)).slice(0, 3).padEnd(3, "x")
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"
export const shortId = (rng: Rng, length = 6): string =>
  Array.from({ length }, () => BASE36[rng.int(0, 35)]).join("")

const HEX = "0123456789abcdef"
export const hex = (rng: Rng, length: number): string =>
  Array.from({ length }, () => HEX[rng.int(0, 15)]).join("")

export const uuid = (rng: Rng): string =>
  `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-${"89ab"[rng.int(0, 3)]}${hex(rng, 3)}-${hex(rng, 12)}`

const digits = (rng: Rng, length: number): string => Array.from({ length }, () => String(rng.int(0, 9))).join("")

const luhnCheckDigit = (partial: string): number => {
  let sum = 0
  let double = true
  for (let i = partial.length - 1; i >= 0; i--) {
    let d = Number(partial[i])
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return (10 - (sum % 10)) % 10
}

export const luhnValid = (value: string): boolean => {
  let sum = 0
  let double = false
  for (let i = value.length - 1; i >= 0; i--) {
    let d = Number(value[i])
    if (Number.isNaN(d)) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

export const siren = (rng: Rng): string => {
  const partial = String(rng.int(1, 9)) + digits(rng, 7)
  return partial + luhnCheckDigit(partial)
}

export const siret = (rng: Rng, base: string = siren(rng)): string => {
  const partial = base + digits(rng, 4)
  return partial + luhnCheckDigit(partial)
}

export const vatNumber = (base: string): string => {
  const key = (12 + 3 * (Number(base) % 97)) % 97
  return `FR${String(key).padStart(2, "0")}${base}`
}

const mod97 = (numeric: string): number => {
  let remainder = 0
  for (const char of numeric) remainder = (remainder * 10 + Number(char)) % 97
  return remainder
}

export const iban = (rng: Rng): string => {
  const bban = digits(rng, 5) + digits(rng, 5) + digits(rng, 11) + digits(rng, 2)
  // Check digits: 98 - (BBAN + "FR00" as digits) mod 97, where F=15 and R=27.
  const check = 98 - mod97(`${bban}152700`)
  return `FR${String(check).padStart(2, "0")}${bban}`
}

export const ibanValid = (value: string): boolean => {
  const rearranged = value.slice(4) + value.slice(0, 4)
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  return mod97(numeric) === 1
}

const BICS = ["BNPAFRPP", "SOGEFRPP", "CRLYFRPP", "AGRIFRPP", "CEPAFRPP", "CMCIFRPP", "BOUSFRPP", "QNTOFRP1"] as const
const BICS_EN = ["CHASUS33", "BOFAUS3N", "CITIUS33", "WFBIUS6S", "BARCGB22", "HSBCGB2L", "NWBKGB2L", "DEUTDEFF"] as const

const HOUR = 3_600_000
const DAY = 24 * HOUR

const clampDate = (d: Date, min: Date, max: Date): Date => new Date(Math.min(Math.max(d.getTime(), min.getTime()), max.getTime()))

export const pastDateTime = (rng: Rng, now: Date, maxDays = 730): Date =>
  new Date(now.getTime() - rng.int(1, maxDays * 24) * HOUR - rng.int(0, 59) * 60_000)

export const futureDateTime = (rng: Rng, now: Date, maxDays = 365): Date =>
  new Date(now.getTime() + rng.int(1, maxDays * 24) * HOUR + rng.int(0, 59) * 60_000)

/** A date after `after`, capped at `now`. */
export const laterDateTime = (rng: Rng, after: Date, now: Date): Date =>
  clampDate(new Date(after.getTime() + rng.int(1, 60) * DAY + rng.int(0, 23) * HOUR), after, now)

/** ISO 8601 without milliseconds: "2026-03-12T09:41:00Z". */
export const isoDateTime = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z")
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10)

const humanize = (name: string, pools: P.Pools): string => capitalize(tokenize(name).join(" ") || pools.value)

/** US numbers stay in 555-0100…0199, the range reserved for fiction. */
const AREA_CODES = [415, 212, 512, 206, 312, 617, 303, 503, 404, 305] as const
const phoneNumber = (rng: Rng, mobile: boolean, locale: P.DataLocale): string =>
  locale === "en"
    ? `+1 ${rng.pick(AREA_CODES)} 555 01${digits(rng, 2)}`
    : `+33 ${mobile ? rng.pick([6, 7]) : rng.int(1, 5)} ${digits(rng, 2)} ${digits(rng, 2)} ${digits(rng, 2)} ${digits(rng, 2)}`

const skuFor = (tokens: ReadonlyArray<string>, rng: Rng, locale: P.DataLocale): string => {
  const has = (...words: ReadonlyArray<string>): boolean => tokens.some((t) => words.includes(t))
  if (has("isbn")) return `978${digits(rng, 10)}`
  if (has("ean", "barcode", "gtin")) return `3${digits(rng, 12)}`
  if (has("plate", "immatriculation")) return locale === "en" ? `${digits(rng, 1)}${letters(rng, 3)}${digits(rng, 3)}` : `${letters(rng, 2)}-${digits(rng, 3)}-${letters(rng, 2)}`
  if (has("serial")) return `SN-${letters(rng, 2)}${digits(rng, 8)}`
  if (has("tracking")) return `${letters(rng, 2)}${digits(rng, 9)}${locale === "en" ? "US" : "FR"}`
  if (has("order", "commande")) return `ORD-${digits(rng, 6)}`
  if (has("invoice", "facture")) return `F-2026-${digits(rng, 4)}`
  const prefix = (tokens.find((t) => t.length >= 3) ?? "ref").slice(0, 3).toUpperCase()
  return `${prefix}-${digits(rng, 4)}`
}

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"
const letters = (rng: Rng, length: number): string => Array.from({ length }, () => UPPER[rng.int(0, UPPER.length - 1)]).join("")

const personOf = (ctx: ValueContext): Person => ctx.identity.person ?? makePerson(ctx.rng, ctx.pools)
const companyOf = (ctx: ValueContext): Company => ctx.identity.company ?? makeCompany(ctx.rng, ctx.pools)
const cityOf = (ctx: ValueContext): P.City => ctx.identity.city ?? ctx.rng.pick(ctx.pools.cities)

/** A common field name's own vocabulary (`environment`, `branch`, `commit`…), whole name first, then its last word. */
const namedValue = (tokens: ReadonlyArray<string>, ctx: ValueContext): string | undefined => {
  const calendar = tokens.find((t) => Object.hasOwn(P.CALENDAR_VALUES, t))
  if (calendar !== undefined) return rotate(P.CALENDAR_VALUES[calendar]!, ctx)
  // `codesDepartements` reads as `codeDepartement`: every word of the name in the singular.
  const singularTokens = tokens.map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t))
  const named = (word: string): ReadonlyArray<string> | undefined => (Object.hasOwn(ctx.pools.named, word) ? ctx.pools.named[word] : undefined)
  const plural = named(singularTokens.join("")) ?? named(singularTokens[singularTokens.length - 1] ?? "")
  const whole = tokens.join("")
  const last = tokens[tokens.length - 1] ?? ""
  const length = Object.hasOwn(P.FINGERPRINTS, whole) ? P.FINGERPRINTS[whole] : Object.hasOwn(P.FINGERPRINTS, last) ? P.FINGERPRINTS[last] : undefined
  if (length !== undefined) return hex(ctx.rng, length)
  const pool = named(whole) ?? named(last) ?? plural
  return pool === undefined ? undefined : rotate(pool, ctx)
}

export const stringValue = (semantic: Semantic, shape: StringShape, ctx: ValueContext): string => {
  const raw = rawString(semantic, shape, ctx)
  return enforceLength(raw, shape, ctx)
}

/** A generated string is never padded beyond this, whatever `minLength` says. */
export const MAX_GENERATED_LENGTH = 4096

const enforceLength = (value: string, shape: StringShape, ctx: ValueContext): string => {
  let out = value
  if (shape.maxLength !== undefined && out.length > shape.maxLength) out = out.slice(0, shape.maxLength)
  const minLength = Math.min(shape.minLength ?? 0, MAX_GENERATED_LENGTH)
  if (out.length < minLength) out = out + shortId(ctx.rng, minLength - out.length)
  return out
}

const rawString = (semantic: Semantic, shape: StringShape, ctx: ValueContext): string => {
  const { rng, now } = ctx
  const tokens = tokenize(ctx.name)
  if (ctx.vocabulary !== undefined && ctx.vocabulary.length > 0) {
    return ctx.vocabulary[(ctx.salt + ctx.index) % ctx.vocabulary.length]!
  }
  switch (semantic) {
    case "id":
      return `${idPrefix(ctx.parentTitle)}_${shortId(rng)}`
    case "foreign-id":
      return `${idPrefix(tokens.slice(0, -1).join(" "))}_${shortId(rng)}`
    case "uuid":
      return uuid(rng)
    case "email": {
      if (tokens.some((t) => ["support", "contact", "billing", "sales", "admin", "noreply", "info"].includes(t))) {
        return `${tokens.find((t) => t !== "email" && t !== "mail") ?? "contact"}@${companyOf(ctx).domain}`
      }
      return personOf(ctx).email
    }
    case "first-name":
      return personOf(ctx).first
    case "last-name":
      return personOf(ctx).last
    case "full-name":
      return personOf(ctx).full
    case "username":
      return personOf(ctx).handle
    case "phone":
      return phoneNumber(rng, !tokens.includes("fax") && !tokens.includes("landline"), ctx.pools.locale)
    case "avatar":
      return `https://i.pravatar.cc/150?u=${personOf(ctx).handle}`
    case "image":
      return `https://picsum.photos/seed/${shortId(rng, 8)}/640/480`
    case "url": {
      // URL examples in specs are usually realistic: keep them.
      if (typeof shape.example === "string" && /^https?:\/\//.test(shape.example)) return shape.example
      const company = companyOf(ctx)
      if (tokens.some((t) => ["website", "homepage", "site"].includes(t))) return `https://${company.domain}`
      return `https://${company.domain}/${slugify(rotate(ctx.pools.words, ctx))}/${shortId(rng, 4)}`
    }
    case "hostname":
      if (typeof shape.example === "string" && shape.example.includes(".")) return shape.example
      return tokens.includes("api") ? `api.${companyOf(ctx).domain}` : companyOf(ctx).domain
    case "slug":
      return `${slugify(rotate(ctx.pools.words, ctx))}-${shortId(rng, 4)}`
    case "title":
      return rotate(ctx.pools.titles, ctx)
    case "sentence":
      return rng.pick(ctx.pools.sentences)
    case "paragraph":
      return rng.sample(ctx.pools.sentences, rng.int(2, 3)).join(" ")
    case "failure-reason":
      return rng.pick(/charge|payment|paiement|refund|rembours|payout|transfer|card|carte|invoice|facture|subscription|abonnement/i.test(ctx.parentTitle ?? "") ? ctx.pools.paymentFailures : ctx.pools.failures)
    case "street":
      if (!tokens.includes("line2")) return rng.pick(ctx.pools.streets)
      return ctx.pools.locale === "en" ? rng.pick([`Suite ${rng.int(1, 9)}00`, `Apt ${rng.int(1, 12)}${letters(rng, 1)}`, `Floor ${rng.int(2, 12)}`]) : `Bâtiment ${letters(rng, 1)}, ${rng.int(1, 5)}e étage`
    case "city":
      return cityOf(ctx).name
    case "zip":
      return cityOf(ctx).zip
    case "region":
      return cityOf(ctx).region
    case "country":
      return ctx.pools.homeCountry
    case "country-code": {
      const code = tokens.includes("code") || tokens.includes("iso") || shape.maxLength === 2
      // An address's country is its city's.
      if (ctx.identity.city !== undefined) return code ? ctx.pools.homeCountryCode : ctx.pools.homeCountry
      const country = rng.pick(ctx.pools.countries)
      return code ? country.code : country.name
    }
    case "latitude":
      return String(cityOf(ctx).lat)
    case "longitude":
      return String(cityOf(ctx).lng)
    case "company":
      return companyOf(ctx).name
    case "product-name":
      return rotate(ctx.pools.products, ctx)
    case "pet-name":
      return rotate(ctx.pools.pets, ctx)
    case "money":
      return rng.float(4.9, 499).toFixed(2)
    case "currency":
      return rng.pick(ctx.pools.currencies)
    case "quantity":
    case "count":
      return String(rng.int(1, 12))
    case "age":
      return String(rng.int(18, 80))
    case "rating":
      return String(rng.float(1, 5, 1))
    case "percent":
      return String(rng.int(0, 100))
    case "year":
      return String(rng.int(1995, now.getUTCFullYear()))
    case "status":
      return rotate(/order|commande|invoice|shipment|delivery|payment/i.test(ctx.parentTitle ?? "") ? P.ORDER_STATUSES : P.STATUSES, ctx)
    case "role":
      return rotate(P.ROLES, ctx)
    case "plan":
      return rotate(P.PLANS, ctx)
    case "category":
      return rotate(ctx.pools.categories, ctx)
    case "tag":
      return rotate(ctx.pools.tags, ctx)
    case "color":
      return rng.pick(P.COLORS)
    case "locale":
      return rng.pick(ctx.pools.locales)
    case "timezone":
      return rng.pick(ctx.pools.timezones)
    case "iban":
      return iban(rng)
    case "bic":
      return rng.pick(ctx.pools.locale === "en" ? BICS_EN : BICS)
    case "siret":
      return siret(rng)
    case "siren":
      return siren(rng)
    case "vat":
      return vatNumber(siren(rng))
    case "card":
      return `4242 4242 4242 ${digits(rng, 4)}`
    case "ip":
      return `${rng.int(11, 223)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`
    case "user-agent":
      return rng.pick(P.USER_AGENTS)
    case "sku":
      return skuFor(tokens, rng, ctx.pools.locale)
    case "version":
      return `${rng.int(0, 4)}.${rng.int(0, 12)}.${rng.int(0, 9)}`
    case "token":
      return hex(rng, 32)
    case "password":
      return `${rng.pick(ctx.pools.words)}-${rng.pick(ctx.pools.words)}-${digits(rng, 4)}`
    case "date-past":
      return isoDate(pastDateTime(rng, now))
    case "date-future":
      return isoDate(futureDateTime(rng, now))
    case "date-birth":
      return isoDate(new Date(Date.UTC(rng.int(1955, 2005), rng.int(0, 11), rng.int(1, 28))))
    case "datetime-created":
      return isoDateTime(pastDateTime(rng, now))
    case "datetime-updated":
      return isoDateTime(pastDateTime(rng, now, 90))
    case "datetime-deleted":
      return isoDateTime(pastDateTime(rng, now, 30))
    case "datetime-past":
      return isoDateTime(pastDateTime(rng, now))
    case "datetime-future":
      return isoDateTime(futureDateTime(rng, now))
    case "time":
      return `${String(rng.int(7, 21)).padStart(2, "0")}:${String(rng.int(0, 59)).padStart(2, "0")}:00`
    case "timestamp":
      return String(Math.floor(pastDateTime(rng, now).getTime() / 1000))
    case "duration":
      return `PT${rng.int(1, 120)}M`
    case "error-message":
      return P.errorTextFor(ctx.status ?? 500, ctx.pools.locale).message
    case "error-code":
      return P.errorTextFor(ctx.status ?? 500, ctx.pools.locale).code
    case "error-status":
      return String(ctx.status ?? 500)
    case "base64":
      return btoa(hex(rng, 12))
    case "flag":
      return String(rng.chance(0.7))
    case "word": {
      const named = namedValue(tokens, ctx)
      if (named !== undefined) return named
      // A bare name with nothing else to go on: the object's kind reads better than the field's
      // ("Restaurant Dune", not "Name Dune").
      const bare = /^(name|nom|title|titre|libelle|label|denomination)$/.test(tokenize(ctx.name).join(""))
      if (ctx.personal === true && /^(name|nom)$/.test(tokenize(ctx.name).join(""))) return personOf(ctx).full
      return `${humanize(bare && ctx.parentTitle !== undefined ? ctx.parentTitle : ctx.name, ctx.pools)} ${rotate(ctx.pools.words, ctx)}`
    }
    case "generic": {
      if (typeof shape.example === "string") return shape.example
      if (typeof shape.default === "string") return shape.default
      return namedValue(tokens, ctx) ?? `${humanize(ctx.name, ctx.pools)} ${rotate(ctx.pools.words, ctx)}`
    }
  }
}

export const numberValue = (semantic: Semantic, shape: NumberShape, ctx: ValueContext): number => {
  let raw = rawNumber(semantic, shape, ctx)
  // Declared bounds win over what the name suggests: `pages` between 64 and 900 is not a page number,
  // and a fine capped at 12 € should not sit on 12 € every time.
  const { minimum, maximum } = shape
  if (minimum !== undefined && maximum !== undefined && minimum <= maximum && (raw < minimum || raw > maximum)) {
    raw = shape.integer ? ctx.rng.int(minimum, maximum) : ctx.rng.float(minimum, maximum)
  }
  return enforceRange(raw, shape)
}

const enforceRange = (value: number, shape: NumberShape): number => {
  let out = value
  if (shape.multipleOf !== undefined) out = Math.round(out / shape.multipleOf) * shape.multipleOf
  if (shape.minimum !== undefined && out < shape.minimum) out = shape.minimum
  if (shape.maximum !== undefined && out > shape.maximum) out = shape.maximum
  if (shape.integer) out = Math.round(out)
  else out = Math.round(out * 100) / 100
  return out
}

const rawNumber = (semantic: Semantic, shape: NumberShape, ctx: ValueContext): number => {
  const { rng, now } = ctx
  const tokens = tokenize(ctx.name)
  const has = (...words: ReadonlyArray<string>): boolean => tokens.some((t) => words.includes(t))
  switch (semantic) {
    case "id":
      return ctx.inCollection ? ctx.index + 1 : rng.int(1, 9999)
    case "foreign-id":
      return rng.int(1, 200)
    case "money":
      if (shape.integer) return has("cents", "amount", "minor") ? rng.int(490, 49900) : rng.int(5, 500)
      return rng.float(4.9, 499)
    case "quantity":
      return rng.int(1, 12)
    case "count":
      if (has("stock", "inventory", "views", "hits", "downloads", "followers")) return rng.int(0, 5000)
      return rng.int(0, 120)
    case "age":
      return rng.int(18, 80)
    case "rating":
      return shape.integer ? rng.int(1, 5) : rng.float(1, 5, 1)
    case "percent":
      return shape.integer ? rng.int(0, 100) : rng.float(0, 100, 1)
    case "year":
      return rng.int(1995, now.getUTCFullYear())
    case "duration":
      return has("ms", "millis", "milliseconds", "latency") ? rng.int(40, 2400) : rng.int(1, 3600)
    case "timestamp": {
      const past = pastDateTime(rng, now).getTime()
      return has("ms", "millis") ? past : Math.floor(past / 1000)
    }
    case "latitude":
      return Math.round((cityOf(ctx).lat + rng.float(-0.05, 0.05, 4)) * 10000) / 10000
    case "longitude":
      return Math.round((cityOf(ctx).lng + rng.float(-0.05, 0.05, 4)) * 10000) / 10000
    case "version":
      return rng.int(1, 12)
    case "error-status":
      return ctx.status ?? 500
    case "flag":
      return rng.chance(0.7) ? 1 : 0
    case "zip":
      return Number(cityOf(ctx).zip)
    case "siren":
      return Number(siren(rng))
    case "siret":
      return Number(siret(rng))
    default: {
      if (typeof shape.example === "number") return shape.example
      if (typeof shape.default === "number") return shape.default
      if (shape.minimum !== undefined && shape.maximum !== undefined) {
        return shape.integer ? rng.int(shape.minimum, shape.maximum) : rng.float(shape.minimum, shape.maximum)
      }
      if (shape.minimum !== undefined) return shape.integer ? rng.int(shape.minimum, shape.minimum + 100) : rng.float(shape.minimum, shape.minimum + 100)
      if (shape.maximum !== undefined) return shape.integer ? rng.int(Math.min(0, shape.maximum), shape.maximum) : rng.float(0, shape.maximum)
      return shape.integer ? rng.int(1, 1000) : rng.float(0, 100)
    }
  }
}

const TRUE_LEANING = /^(is)?(active|enabled|verified|visible|published|available|instock|public|valid|confirmed|approved|success|ok|accepted|subscribed|online|open|allowed|notifications|default|required)$/
const FALSE_LEANING = /^(is)?(deleted|archived|banned|locked|blocked|disabled|hidden|suspended|admin|private|draft|hasmore|beta|internal|test|paused|expired|flagged|spam|readonly|restricted|error|failed|cancelled|canceled|closed|deprecated|hasnext|hasprevious|hasprev)$/

export const booleanValue = (ctx: ValueContext): boolean => {
  const joined = tokenize(ctx.name).join("")
  if (joined === "hasmore" || joined === "hasnext" || joined === "hasnextpage") return false
  if (TRUE_LEANING.test(joined)) return ctx.rng.chance(0.85)
  if (FALSE_LEANING.test(joined)) return ctx.rng.chance(0.15)
  return ctx.rng.chance(0.5)
}
