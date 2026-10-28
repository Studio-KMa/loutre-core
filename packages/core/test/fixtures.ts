import { readFileSync } from "node:fs"

/** Lit une spec du corpus (`test/fixtures/specs/<nom>`). */
export const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/specs/${name}`, import.meta.url), "utf8")
