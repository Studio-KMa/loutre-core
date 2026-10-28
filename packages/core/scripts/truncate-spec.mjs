#!/usr/bin/env node
/**
 * Tronque une grosse spec OpenAPI (JSON) à quelques chemins, en ne gardant
 * que les composants atteignables par `$ref` depuis ces chemins.
 *
 *   node scripts/truncate-spec.mjs <entrée.json> <sortie.json> </chemin> [</chemin>…]
 */
import { readFileSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const dropDefault = args.includes("--drop-default-responses")
const [input, output, ...keepPaths] = args.filter((a) => a !== "--drop-default-responses")
if (!input || !output || keepPaths.length === 0) {
  console.error("usage : truncate-spec.mjs [--drop-default-responses] <entrée.json> <sortie.json> </chemin> [</chemin>…]")
  process.exit(1)
}

const spec = JSON.parse(readFileSync(input, "utf8"))
const paths = {}
for (const p of keepPaths) {
  if (!(p in spec.paths)) {
    console.error(`chemin absent : ${p}`)
    process.exit(1)
  }
  paths[p] = structuredClone(spec.paths[p])
  if (dropDefault) {
    // Chez Stripe, la réponse `default` (erreur) référence tout le graphe.
    for (const operation of Object.values(paths[p])) {
      if (operation && typeof operation === "object" && operation.responses) delete operation.responses.default
    }
  }
}

// Fermeture transitive des $ref locaux (#/components/<kind>/<name>).
const kept = new Map() // "kind/name" → true
const queue = []
const collect = (node) => {
  if (Array.isArray(node)) {
    for (const item of node) collect(item)
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/components/")) {
        const [, , kind, ...rest] = value.split("/")
        const name = rest.join("/").replace(/~1/g, "/").replace(/~0/g, "~")
        const id = `${kind}/${name}`
        if (!kept.has(id)) {
          kept.set(id, true)
          queue.push([kind, name])
        }
      } else {
        collect(value)
      }
    }
  }
}
collect(paths)
while (queue.length > 0) {
  const [kind, name] = queue.shift()
  const component = spec.components?.[kind]?.[name]
  if (component === undefined) {
    console.error(`composant introuvable : ${kind}/${name}`)
    continue
  }
  collect(component)
}

const components = {}
for (const id of kept.keys()) {
  const [kind, ...rest] = id.split("/")
  const name = rest.join("/")
  components[kind] ??= {}
  components[kind][name] = spec.components[kind][name]
}
for (const kind of Object.keys(components)) {
  components[kind] = Object.fromEntries(Object.entries(components[kind]).sort(([a], [b]) => a.localeCompare(b)))
}

const out = {
  openapi: spec.openapi,
  info: { ...spec.info, description: `${spec.info?.title ?? "spec"} — extrait tronqué pour les tests de Loutre.` },
  ...(spec.servers ? { servers: spec.servers } : {}),
  paths,
  components,
}
const json = JSON.stringify(out, null, 2)
writeFileSync(output, json)
const counts = Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Object.keys(v).length]))
console.log(`${output} : ${(json.length / 1024).toFixed(0)} Ko, chemins=${keepPaths.length}, composants=${JSON.stringify(counts)}`)
