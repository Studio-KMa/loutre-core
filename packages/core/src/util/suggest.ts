/**
 * "Did you mean…?" suggestions: Damerau-Levenshtein distance (transpositions
 * included), case-insensitive, filtered by a tolerance proportional to length.
 */
export const editDistance = (a: string, b: string): number => {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let previous2: Array<number> = []
  let previous: Array<number> = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const current: Array<number> = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (previous2[j - 2] ?? 0) + 1)
      }
      current[j] = value
    }
    previous2 = previous
    previous = current
  }
  return previous[n] ?? 0
}

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "")

/** Names longer than this, or candidates past this count, get no suggestion: the distance is quadratic. */
const MAX_SUGGEST_LENGTH = 64
const MAX_SUGGEST_CANDIDATES = 500

/**
 * Up to `max` candidates close to `needle`, closest first. A candidate that
 * contains `needle` (or the reverse) counts as close.
 */
export const suggest = (
  needle: string,
  candidates: Iterable<string>,
  max = 3,
): Array<string> => {
  const target = normalise(needle)
  if (target.length === 0 || target.length > MAX_SUGGEST_LENGTH) return []
  const tolerance = Math.max(2, Math.floor(target.length / 3))
  const scored: Array<{ candidate: string; score: number }> = []
  let examined = 0
  for (const candidate of candidates) {
    if (++examined > MAX_SUGGEST_CANDIDATES) break
    if (candidate === needle || candidate.length > MAX_SUGGEST_LENGTH * 2) continue
    const other = normalise(candidate)
    if (other.length > MAX_SUGGEST_LENGTH) continue
    const contains = other.includes(target) || target.includes(other)
    // The distance is at least the length gap: too far apart, no need to compute it.
    if (!contains && Math.abs(other.length - target.length) > tolerance) continue
    const distance = editDistance(target, other)
    if (contains || distance <= tolerance) {
      scored.push({ candidate, score: contains ? Math.min(distance, 1) : distance })
    }
  }
  return scored
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, max)
    .map((s) => s.candidate)
}
