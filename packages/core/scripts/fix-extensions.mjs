// tsc emits the extensionless relative imports we write in TypeScript. Node's ESM
// loader wants explicit ones, so this appends ".js" (or "/index.js") after the build.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const dist = resolve("dist")
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : [path]
})
const SPECIFIER = /((?:import|export)\s+(?:[^'";]*?\s+from\s+)?|import\()\s*(["'])(\.{1,2}\/[^"']+)\2/g
const RE_EXPORT_ALL = /(export\s+\*\s+from\s+)(["'])(\.{1,2}\/[^"']+)\2/g

let touched = 0
for (const file of walk(dist)) {
  if (!/\.(js|d\.ts)$/.test(file)) continue
  const original = readFileSync(file, "utf8")
  const fix = (specifier) => {
    if (/\.(js|json|mjs|cjs)$/.test(specifier)) return specifier
    const target = resolve(dirname(file), specifier)
    try {
      if (statSync(target).isDirectory()) return `${specifier}/index.js`
    } catch {
      // not a directory: a file without extension
    }
    return `${specifier}.js`
  }
  const updated = original
    .replace(SPECIFIER, (_, head, quote, specifier) => `${head}${quote}${fix(specifier)}${quote}`)
    .replace(RE_EXPORT_ALL, (_, head, quote, specifier) => `${head}${quote}${fix(specifier)}${quote}`)
  if (updated !== original) {
    writeFileSync(file, updated)
    touched++
  }
}
console.log(`extensions ajoutées dans ${touched} fichiers`)
