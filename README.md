# Loutre engine and CLI

The open-source part of [Loutre](https://loutre.app): the engine that turns an API description into a mock API with
realistic, coherent data, and the command line that serves it on your machine.

```sh
npx loutre serve openapi.yaml
```

```
loutre · Petstore · seed 81f3pnv6

  GET    http://localhost:4000/pets
  POST   http://localhost:4000/pets
  GET    http://localhost:4000/pets/{petId}

  x-loutre-status · x-loutre-delay · x-loutre-count · x-loutre-message · x-loutre-seed
```

| Package | What it is |
| --- | --- |
| [`loutre`](packages/cli) | The CLI: `loutre serve <schema>` runs a local mock, `loutre push <schema>` publishes it to loutre.run. |
| [`@loutre-run/core`](packages/core) | The engine, as a library: parse, normalise, interpret, generate, resolve requests. |

## What it reads

OpenAPI 3.0, 3.1 and 3.2 (YAML or JSON), Swagger 2.0, TypeScript types (Supabase generated types included), Postman v2
collections, Insomnia v4 and v5 exports, Bruno collections (JSON export or `.bru` files), HAR files, a json-server
`db.json`, curl commands and GraphQL schemas (SDL or introspection). Everything is converted to OpenAPI 3.1 first,
then read by the same code.

## What you get

- **Data that looks real**: names, emails, addresses, dates in order, totals that add up, valid French company
  numbers, inferred from field names, formats and examples. Deterministic: the same seed gives the same data.
- **Errors and latency on demand**, per request: `x-loutre-status: 500`, `x-loutre-delay: 2000`, `x-loutre-count: 0`.
- **Writes that stick**: POST, PUT, PATCH and DELETE change the collections served afterwards, like a real backend.
- **Readable errors**: a wrong `$ref` or a typo in a type comes back with its location and a suggestion.

```ts
import { compileToResult, resolve } from "@loutre-run/core"

const compiled = await compileToResult(openApiYaml, { seed: "demo" })
if (!compiled.ok) throw new Error(compiled.errors.map((e) => e.message).join("\n"))

const reply = resolve(compiled.mock, {}, { method: "GET", pathname: "/pets/42", headers: {} })
console.log(reply.status, reply.body)
```

No network, no AI call: the engine is pure and runs in Node, in the browser and in Cloudflare Workers.

## The hosted version

[loutre.app](https://loutre.app) runs this engine behind a shareable URL (`https://brisk-otter.loutre.run`), with
nothing to install, an AI pass that tailors free-text values to your domain, a request journal, rules and scenarios,
and an [MCP server](https://loutre.app/docs#mcp) so coding agents can create and drive mocks. A
[gallery](https://loutre.app/apis) serves well-known APIs (Stripe, GitHub, OpenAI, Slack…) ready to call.

## Scope

This code serves Loutre first: the engine evolves with the product. Issues and bug reports are very welcome; for a
pull request beyond a fix, open an issue first so we can agree on the direction. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```sh
pnpm install
pnpm check      # typecheck and tests
pnpm build      # packages/core/dist and packages/cli/dist
```

Node 22.12 or later, pnpm 8 or later.

## License

[MIT](LICENSE) © KMA
