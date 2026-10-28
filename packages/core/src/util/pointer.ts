/** JSON Pointer helpers (RFC 6901), as used by local `$ref`s. */

export const escapeToken = (token: string): string => token.replace(/~/g, "~0").replace(/\//g, "~1")
export const unescapeToken = (token: string): string => token.replace(/~1/g, "/").replace(/~0/g, "~")

/** `#/components/schemas/User` → `["components", "schemas", "User"]`; `#` → `[]`. */
export const parseLocalRef = (ref: string): Array<string> | undefined => {
  if (ref === "#") return []
  if (!ref.startsWith("#/")) return undefined
  return ref
    .slice(2)
    .split("/")
    .map((token) => unescapeToken(decodeURIComponentSafe(token)))
}

const decodeURIComponentSafe = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export const formatPointer = (tokens: ReadonlyArray<string>): string =>
  tokens.length === 0 ? "#" : `#/${tokens.map(escapeToken).join("/")}`

export type Resolution =
  | { readonly found: true; readonly value: unknown }
  | {
      readonly found: false
      /** Last container reached, and the token missing from it. */
      readonly parent: unknown
      readonly token: string
      readonly depth: number
    }

export const resolvePointer = (root: unknown, tokens: ReadonlyArray<string>): Resolution => {
  let current: unknown = root
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ""
    if (Array.isArray(current)) {
      const index = Number(token)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, parent: current, token, depth: i }
      }
      current = current[index]
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token]
    } else {
      return { found: false, parent: current, token, depth: i }
    }
  }
  return { found: true, value: current }
}

export const isPlainObject = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u)

/** `record[key]` for a name that comes from a spec or a request: `constructor` or `toString` never reach the prototype. */
export const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined

/** `record[key] = value`, `__proto__` included: a field of that name stays a field instead of replacing the prototype. */
export const setOwn = <T>(record: Record<string, T>, key: string, value: T): void => {
  if (key === "__proto__") Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true })
  else record[key] = value
}
