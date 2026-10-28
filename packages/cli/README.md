# loutre

Loutre in your terminal: serve an OpenAPI 3.x or Swagger 2.0 document, TypeScript types, a Postman or
Insomnia collection, a Bruno collection folder, a HAR file, a json-server `db.json`, curl commands or a GraphQL schema as a mock API, with realistic data, or push it to [loutre.run](https://loutre.app) and get a
hosted URL.

```sh
npx loutre serve openapi.yaml                       # http://localhost:4000
npx loutre serve types.ts --port 5000 --seed demo --watch
npx loutre serve openapi.yaml --host 0.0.0.0         # reachable from the local network (this machine only by default)
npx loutre serve ./my-bruno-collection              # a Bruno folder: its .bru files
npx loutre serve db.json                            # json-server's file, records served as they are
npx loutre push recording.har                       # headers and cookies are dropped before sending
npx loutre serve schema.graphql                     # POST /graphql: queries, mutations, introspection
npx loutre push openapi.yaml                        # hosted mock, URL printed
LOUTRE_TOKEN=la_… npx loutre push openapi.yaml      # attached to your account
```

`serve` answers exactly like a hosted mock: same data, same per-request headers (`x-loutre-status`,
`x-loutre-delay`, `x-loutre-count`, `x-loutre-message`, `x-loutre-seed`), writes kept in memory for the
session. No account, no network, no AI call. The server listens on 127.0.0.1 unless `--host` says otherwise.

Requires Node 20 or newer. Licence MIT.
