// Bundle unique, exécutable partout où Node 20+ tourne. Le `require` explicite sert aux dépendances CommonJS (yaml, swagger2openapi).
import { build } from "esbuild"

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
  logLevel: "warning",
})
