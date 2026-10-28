/**
 * Pre-check of `$ref`s before dereferencing: we want every broken reference
 * at once, with suggestions, rather than the parser's first raw error.
 */
import { suggest } from "../util/suggest"
import { formatPointer, isPlainObject, parseLocalRef, resolvePointer } from "../util/pointer"

export interface MissingRef {
  /** Where the offending `$ref` sits. */
  readonly at: string
  readonly ref: string
  /** The unresolved token, and the deepest pointer reached before it. */
  readonly token: string
  readonly reachable: string
  readonly suggestions: ReadonlyArray<string>
}

export interface RefReport {
  readonly missing: ReadonlyArray<MissingRef>
  readonly external: ReadonlyArray<{ readonly at: string; readonly ref: string }>
}

const MAX_SUGGESTED_REFS = 20

export const inspectRefs = (root: unknown): RefReport => {
  const missing: Array<MissingRef> = []
  const external: Array<{ at: string; ref: string }> = []
  const seen = new Set<object>()

  const walk = (node: unknown, path: Array<string>): void => {
    if (Array.isArray(node)) {
      if (seen.has(node)) return
      seen.add(node)
      node.forEach((item, index) => walk(item, [...path, String(index)]))
      return
    }
    if (!isPlainObject(node)) return
    if (seen.has(node)) return
    seen.add(node)
    const ref = node["$ref"]
    if (typeof ref === "string") {
      const at = formatPointer([...path, "$ref"])
      const tokens = parseLocalRef(ref)
      if (tokens === undefined) {
        external.push({ at, ref })
      } else {
        const resolution = resolvePointer(root, tokens)
        if (!resolution.found) {
          const siblings = isPlainObject(resolution.parent) ? Object.keys(resolution.parent) : []
          missing.push({
            at,
            ref,
            token: resolution.token,
            reachable: formatPointer(tokens.slice(0, resolution.depth)),
            // Suggestions for the first few only: a document full of broken refs does not deserve minutes of edit distances.
            suggestions: (missing.length < MAX_SUGGESTED_REFS ? suggest(resolution.token, siblings) : []).map((s) =>
              formatPointer([...tokens.slice(0, resolution.depth), s]),
            ),
          })
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref") continue
      walk(value, [...path, key])
    }
  }

  walk(root, [])
  return { missing, external }
}

/** One error message covering all missing references. */
export const describeMissingRefs = (missing: ReadonlyArray<MissingRef>): string => {
  const lines = missing.slice(0, 5).map((m) => {
    const hint = m.suggestions.length > 0 ? ` — vouliez-vous dire \`${m.suggestions[0]}\` ?` : ""
    return `\`${m.ref}\` n'existe pas (référencé en ${m.at})${hint}`
  })
  const more = missing.length > 5 ? `\n… et ${missing.length - 5} autre(s).` : ""
  const head =
    missing.length === 1 ? "Référence introuvable : " : `${missing.length} références introuvables :\n`
  return head + lines.join("\n") + more
}
