# Contributing

Thanks for taking a look.

- **Bugs**: open an issue with the smallest schema that reproduces it (a few lines of OpenAPI, a type, a request).
  A failing schema is the best gift: the engine is tested against a corpus of real-world specs, and yours can join it.
- **Pull requests**: fixes are welcome as they are. For anything larger, open an issue first: this code serves
  Loutre first, so its direction follows the product.
- **Before pushing**: `pnpm check` (typecheck and tests) must pass.

The engine is written in TypeScript with Effect; errors are typed at each stage (ingestion, normalisation,
interpretation, generation) and come back to users as diagnostics with a location and a suggestion.
