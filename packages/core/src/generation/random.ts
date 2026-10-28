/**
 * Deterministic PRNG: xmur3 hashes the seed, mulberry32 drives the sequence.
 * Same seed → same sequence on every runtime.
 */
export interface Rng {
  readonly seed: string
  next(): number
  /** Integer in [min, max], both ends inclusive. */
  int(min: number, max: number): number
  /** Float in [min, max], rounded to `decimals` places (default 2). */
  float(min: number, max: number, decimals?: number): number
  pick<T>(items: ReadonlyArray<T>): T
  /** `count` distinct items, in a deterministic order. */
  sample<T>(items: ReadonlyArray<T>, count: number): Array<T>
  chance(probability: number): boolean
  /** Independent child generator, stable for a given label. */
  fork(label: string): Rng
}

const hash = (input: string): number => {
  let h = 1779033703 ^ input.length
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

export const makeRng = (seed: string): Rng => {
  let state = hash(seed)
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rng: Rng = {
    seed,
    next,
    int: (min, max) => {
      const lo = Math.ceil(Math.min(min, max))
      const hi = Math.floor(Math.max(min, max))
      return lo + Math.floor(next() * (hi - lo + 1))
    },
    float: (min, max, decimals = 2) => {
      const factor = 10 ** decimals
      return Math.round((min + next() * (max - min)) * factor) / factor
    },
    pick: (items) => {
      if (items.length === 0) throw new Error("pick sur une liste vide")
      return items[Math.floor(next() * items.length)]!
    },
    sample: (items, count) => {
      const pool = [...items]
      const out: Array<(typeof items)[number]> = []
      while (out.length < count && pool.length > 0) {
        out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]!)
      }
      return out
    },
    chance: (probability) => next() < probability,
    fork: (label) => makeRng(`${seed}/${label}`),
  }
  return rng
}

/** Fresh random seed (8 base-36 characters). */
export const randomSeed = (): string => Math.random().toString(36).slice(2, 10)
