import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { compile, compileToResult } from "../src"

describe("pipeline", () => {
  it.effect("échoue avec une erreur typée d'ingestion sur un document vide", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(compile(""))
      expect(error._tag).toBe("IngestionError")
    }),
  )

  it("expose un résultat discriminé avec diagnostics", async () => {
    const result = await compileToResult("")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.stage).toBe("ingestion")
    }
  })
})
