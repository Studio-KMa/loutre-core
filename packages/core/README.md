# @loutre-run/core

The engine behind [Loutre](https://loutre.app): turn an OpenAPI 3.x or Swagger 2.0 document, a set of
TypeScript types, a Postman, Insomnia or Bruno collection, a HAR file, a json-server `db.json`, curl commands or a GraphQL schema into a typed route table and a realistic, coherent data set,
then answer requests against it. No network, no AI call: the same deterministic generator that runs on
loutre.run.

```sh
npm install @loutre-run/core
```

```ts
import { compileToResult, resolve } from "@loutre-run/core"

const compiled = await compileToResult(openApiYaml, { seed: "demo" })
if (!compiled.ok) throw new Error(compiled.errors.map((e) => e.message).join("\n"))

const reply = resolve(compiled.mock, {}, { method: "GET", pathname: "/users/42", headers: {} })
console.log(reply.status, reply.body)
```

What you get:

- `compileToResult(input, options)` and `analyseToResult(input)`: ingestion, normalisation (Swagger 2.0 converted,
  `$ref` resolved, OpenAPI 3.0 upgraded to 3.1), interpretation into a route table, generation of the data.
  Errors come back as diagnostics with a JSON pointer and, when possible, a suggestion.
- `resolve(mock, behavior, request)`: the pure resolver. It honours the per-request headers `x-loutre-status`,
  `x-loutre-delay`, `x-loutre-count`, `x-loutre-message` and `x-loutre-seed`, per-route behaviour (status, latency,
  error rate, hand-written bodies, conditional rules) and an optional overlay of persisted collections.
- `typescriptToOpenApi(source)`, `postmanToOpenApi(collection)`, `insomniaToOpenApi(export)`, `brunoToOpenApi(collection)`
  `bruToOpenApi(text)`, `harToOpenApi(har)`, `jsonServerToOpenApi(db)` and `curlToOpenApi(text)`: the converters used
  at ingestion. `sanitizeSpec(text)` reduces a HAR to its API calls, without headers or cookies, before it is sent or kept.
- `answerGraphql(mock, behavior, request)` and `executeGraphql(mock, request)`: a GraphQL mock's endpoint. The schema
  (SDL or introspection) is read by graphql-js, the only extra dependency, kept out of `@loutre-run/core/detect`;
  queries, mutations (written as state operations), fragments, variables and introspection are answered from the
  generated collections, with consistent links and Relay connections.
- `detect(input)` (also exported as `@loutre-run/core/detect`, dependency free): format detection for a browser.
- `generateSync(table, { seed })`: realistic data by field name and format (French identities, valid SIRET and
  IBAN, `created_at` before `updated_at`, totals that add up), stable for a given seed.

Input formats: OpenAPI 3.0 / 3.1 / 3.2 (YAML or JSON; 3.2 is read as 3.1), Swagger 2.0, TypeScript `interface` / `type` / `enum`
declarations (CRUD routes derived per entity, or an explicit route map type), Postman collections v2.0 / v2.1,
Insomnia exports (v4 JSON, v5 YAML; a design document is read through its OpenAPI spec), Bruno collections (JSON
export, or `.bru` files one after the other), HAR files (shapes only, data generated), json-server `db.json`
(records served as they are, through `x-loutre-fixtures`) and curl commands. Requests without a response example
answer with the shape the collection sends to the same resource.

Diagnostics and generated error messages are in French, on purpose: Loutre is built for French-speaking
teams first. Everything else is language neutral.

This package serves Loutre first. The public API is what the hosted service uses; breaking changes are
listed in the [changelog](https://loutre.app/changelog). Licence MIT.
