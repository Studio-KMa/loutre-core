/**
 * `loutre serve <schema>`: a local mock API with the same data and headers as loutre.run.
 * `loutre push <schema>`: the same schema, hosted, with its URL in ten seconds.
 */
import { readdir, readFile, stat } from "node:fs/promises"
import { watch } from "node:fs"
import { join } from "node:path"
import { analyseToResult, generateCompact, randomSeed, sanitizeSpec, type MockDefinition } from "@loutre-run/core"
import { createMockServer } from "./server"

const USAGE = `loutre : une API mock depuis un schéma OpenAPI 3.x, Swagger 2.0, des types TypeScript, une collection Postman, Insomnia ou Bruno, un fichier HAR, un db.json, des commandes curl ou un schéma GraphQL

  loutre serve <schéma> [--port 4000] [--host 127.0.0.1] [--seed <seed>] [--watch] [--no-state]
  loutre push  <schéma> [--seed <seed>] [--token la_…] [--api https://api.loutre.app]

<schéma> est un fichier, ou le dossier d'une collection Bruno (ses fichiers .bru).
Le mock n'écoute que cette machine ; --host 0.0.0.0 l'ouvre au réseau local.

Par requête : x-loutre-status, x-loutre-delay, x-loutre-count, x-loutre-message, x-loutre-seed.
Le jeton de compte vient de --token ou de la variable LOUTRE_TOKEN.`

interface Args {
  readonly command: string | undefined
  readonly file: string | undefined
  readonly flags: Readonly<Record<string, string | true>>
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
  const positional: Array<string> = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2)
      const next = argv[i + 1]
      if (inline !== undefined) flags[name!] = inline
      else if (next !== undefined && !next.startsWith("--")) {
        flags[name!] = next
        i++
      } else flags[name!] = true
    } else positional.push(arg)
  }
  return { command: positional[0], file: positional[1], flags }
}

const flagText = (flags: Args["flags"], name: string): string | undefined => {
  const value = flags[name]
  return typeof value === "string" ? value : undefined
}

const fatal = (message: string): never => {
  console.error(message)
  process.exit(1)
}

const SKIPPED = new Set(["environments", "node_modules", ".git"])

/** The `.bru` files of a Bruno collection folder, in path order, environments left out. */
const bruFiles = async (directory: string): Promise<Array<string>> => {
  const found: Array<string> = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && !SKIPPED.has(entry.name)) found.push(...(await bruFiles(path)))
    else if (entry.isFile() && entry.name.endsWith(".bru")) found.push(path)
  }
  return found.sort()
}

/** The name in `bruno.json`, as the `meta` block of type `collection` that names the mock. */
const collectionMeta = (config: string): string => {
  try {
    const name = (JSON.parse(config) as { name?: unknown }).name
    return typeof name === "string" && name.trim().length > 0 ? `meta {\n  name: ${name.trim()}\n  type: collection\n}` : ""
  } catch {
    return ""
  }
}

/** A file as is, or a Bruno collection folder as its `.bru` files one after the other. */
const readSpec = async (file: string): Promise<string> => {
  const info = await stat(file).catch(() => fatal(`Impossible de lire ${file}.`))
  if (!info.isDirectory()) return readFile(file, "utf8").catch(() => fatal(`Impossible de lire ${file}.`))
  const files = await bruFiles(file)
  if (files.length === 0) return fatal(`Aucun fichier .bru dans ${file} : donnez un fichier de schéma, ou le dossier d'une collection Bruno.`)
  const texts = await Promise.all(files.map((path) => readFile(path, "utf8")))
  return [collectionMeta(await readFile(join(file, "bruno.json"), "utf8").catch(() => "")), ...texts].join("\n\n")
}

const compile = async (file: string, seed: string): Promise<MockDefinition> => {
  const spec = await readSpec(file)
  const analysed = await analyseToResult(spec)
  if (!analysed.ok) {
    const lines = analysed.errors.map(
      (e) => `  - ${e.pointer === undefined ? "" : `${e.pointer} : `}${e.message}${e.suggestions.length === 0 ? "" : ` (vouliez-vous dire ${e.suggestions.join(", ")} ?)`}`,
    )
    return fatal(`Le schéma n'a pas pu être lu :\n${lines.join("\n")}`)
  }
  return { version: 1, table: analysed.table, data: generateCompact(analysed.table, { seed }) }
}

const serve = async (file: string, flags: Args["flags"]): Promise<void> => {
  const port = Number(flagText(flags, "port") ?? "4000")
  // Cette machine seulement par défaut : un db.json servi tel quel n'a pas à être lisible depuis le wifi du café.
  const host = flagText(flags, "host") ?? "127.0.0.1"
  const seed = flagText(flags, "seed") ?? randomSeed()
  const stateful = flags["no-state"] !== true
  const mock = await compile(file, seed)
  const instance = createMockServer(mock, { stateful, log: (line) => console.log(`  ${line}`) })
  instance.server.listen(port, host, () => {
    console.log(`\nloutre · ${mock.table.info.title} · seed ${seed}${stateful ? "" : " · écritures non conservées"}\n`)
    if (mock.table.graphql !== undefined) {
      const operations = mock.table.routes.filter((route) => route.path.startsWith("/__graphql/")).map((route) => route.path.replace("/__graphql/", "").replace("/", " "))
      console.log(`  POST   http://localhost:${port}${mock.table.graphql.path}   (GraphQL : ${operations.length} opérations)`)
      for (const operation of operations) console.log(`         ${operation}`)
    } else {
      for (const route of mock.table.routes) console.log(`  ${route.method.toUpperCase().padEnd(6)} http://localhost:${port}${route.path}`)
    }
    console.log(`\n  x-loutre-status · x-loutre-delay · x-loutre-count · x-loutre-message · x-loutre-seed\n`)
  })
  if (flags["watch"] === true) {
    let timer: NodeJS.Timeout | undefined
    const recursive = (await stat(file)).isDirectory()
    watch(file, { recursive }, () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        void compile(file, seed).then((next) => {
          instance.replace(next)
          console.log("  schéma rechargé")
        })
      }, 150)
    })
  }
}

const push = async (file: string, flags: Args["flags"]): Promise<void> => {
  const api = (flagText(flags, "api") ?? "https://api.loutre.app").replace(/\/$/, "")
  const token = flagText(flags, "token") ?? process.env["LOUTRE_TOKEN"]
  // A HAR leaves the machine without its headers, cookies or tokens.
  const spec = sanitizeSpec(await readSpec(file))
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" }
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`
  const body: Record<string, unknown> = { spec }
  const seed = flagText(flags, "seed")
  if (seed !== undefined) body["seed"] = seed
  const response = await fetch(`${api}/mocks`, { method: "POST", headers, body: JSON.stringify(body) }).catch(() => fatal(`Impossible de joindre ${api}.`))
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string
    errors?: ReadonlyArray<{ message: string; pointer?: string; suggestions?: ReadonlyArray<string> }>
    mock?: { url: string; slug: string; expiresAt: string | null; routes: ReadonlyArray<{ method: string; path: string }> }
    ownerToken?: string
  }
  if (!response.ok || payload.mock === undefined) {
    const lines = (payload.errors ?? []).map((e) => `  - ${e.pointer === undefined ? "" : `${e.pointer} : `}${e.message}`)
    return fatal(`${payload.message ?? `L'API a répondu ${response.status}.`}${lines.length > 0 ? `\n${lines.join("\n")}` : ""}`)
  }
  console.log(`\n${payload.mock.url}\n`)
  for (const route of payload.mock.routes) console.log(`  ${route.method.toUpperCase().padEnd(6)} ${payload.mock.url}${route.path}`)
  console.log(`\n  ${payload.mock.expiresAt === null ? "sans expiration" : `expire le ${new Date(payload.mock.expiresAt).toLocaleDateString("fr-FR")}`}${token === undefined ? " · sans compte" : ""}`)
  if (token === undefined) console.log(`  jeton de propriété : ${payload.ownerToken ?? ""}  (à garder pour modifier le mock, ou LOUTRE_TOKEN pour le rattacher à un compte)`)
  console.log(`  dashboard : https://loutre.app/m/${payload.mock.slug}\n`)
}

const main = async (): Promise<void> => {
  const { command, file, flags } = parseArgs(process.argv.slice(2))
  if (command === undefined || flags["help"] === true || command === "help") {
    console.log(USAGE)
    return
  }
  if (file === undefined) return fatal(`Il manque le chemin du schéma.\n\n${USAGE}`)
  if (command === "serve") return serve(file, flags)
  if (command === "push") return push(file, flags)
  return fatal(`Commande inconnue : ${command}.\n\n${USAGE}`)
}

void main()
