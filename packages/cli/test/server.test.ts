import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { analyseToResult, generateSync, type MockDefinition } from "@loutre-run/core"
import { createMockServer } from "../src/server"

const SPEC = readFileSync(new URL("../../core/test/fixtures/specs/petstore-expanded-3.0.yaml", import.meta.url), "utf8")

const compile = async (): Promise<MockDefinition> => {
  const analysed = await analyseToResult(SPEC)
  if (!analysed.ok) throw new Error("fixture illisible")
  return { version: 1, table: analysed.table, data: generateSync(analysed.table, { seed: "cli" }) }
}

describe("serveur local", () => {
  it("sert, force par en-tête, conserve les écritures en mémoire", async () => {
    const instance = createMockServer(await compile())
    await new Promise<void>((r) => instance.server.listen(0, r))
    const address = instance.server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    const base = `http://127.0.0.1:${port}`
    try {
      const list = await fetch(`${base}/pets`)
      expect(list.status).toBe(200)
      expect(list.headers.get("x-loutre-route")).toBe("get:/pets")
      const pets = (await list.json()) as Array<{ id: number }>
      expect(pets.length).toBeGreaterThan(0)

      const forced = await fetch(`${base}/pets`, { headers: { "x-loutre-status": "503" } })
      expect(forced.status).toBe(503)

      const posted = await fetch(`${base}/pets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Rex" }) })
      expect(posted.headers.get("x-loutre-state")).toBe("saved")
      const created = (await posted.json()) as { id: number; name: string }
      expect(created.name).toBe("Rex")
      const detail = (await (await fetch(`${base}/pets/${created.id}`)).json()) as { name: string }
      expect(detail.name).toBe("Rex")
      expect((await fetch(`${base}/pets`)).headers.get("x-loutre-kind")).toBe("ok")
      expect(((await (await fetch(`${base}/pets`)).json()) as Array<unknown>).length).toBe(pets.length + 1)

      instance.reset()
      expect(((await (await fetch(`${base}/pets`)).json()) as Array<unknown>).length).toBe(pets.length)
      expect((await fetch(`${base}/nope`)).status).toBe(404)
      expect((await fetch(`${base}/`)).status).toBe(200)
    } finally {
      await new Promise<void>((r) => instance.server.close(() => r()))
    }
  })
})
