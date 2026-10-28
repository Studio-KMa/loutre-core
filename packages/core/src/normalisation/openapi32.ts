/**
 * OpenAPI 3.2 → 3.1, before dereferencing. 3.2 only adds to 3.1: what a mock cannot
 * serve is left out, the rest is rewritten in 3.1 terms.
 * - `query` operations stay (the router serves QUERY, and POST where the path has no POST);
 * - `additionalOperations` (custom verbs) go;
 * - `in: querystring` parameters go;
 * - a sequential media type's `itemSchema` becomes an array `schema`;
 * - an example's `dataValue` becomes its `value`;
 * - a response `summary` stands in for a missing `description`;
 * - `$self` goes.
 */
import { isPlainObject } from "../util/pointer"

type Node = Record<string, unknown>

const pathItemsOf = (document: Node): Array<Node> => {
  const items: Array<Node> = []
  for (const key of ["paths", "webhooks"] as const) {
    const map = document[key]
    if (isPlainObject(map)) for (const item of Object.values(map)) if (isPlainObject(item)) items.push(item)
  }
  const components = document["components"]
  if (isPlainObject(components) && isPlainObject(components["pathItems"])) {
    for (const item of Object.values(components["pathItems"])) if (isPlainObject(item)) items.push(item)
  }
  return items
}

const rewriteMediaTypes = (content: Node): void => {
  for (const media of Object.values(content)) {
    if (!isPlainObject(media)) continue
    if (media["itemSchema"] !== undefined && media["schema"] === undefined) media["schema"] = { type: "array", items: media["itemSchema"] }
    delete media["itemSchema"]
    delete media["itemEncoding"]
    delete media["prefixEncoding"]
    if (isPlainObject(media["examples"])) rewriteExamples(media["examples"])
  }
}

const rewriteExamples = (examples: Node): void => {
  for (const example of Object.values(examples)) {
    if (!isPlainObject(example)) continue
    if (example["dataValue"] !== undefined && example["value"] === undefined) example["value"] = example["dataValue"]
    delete example["dataValue"]
    delete example["serializedValue"]
  }
}

export const downgradeFrom32 = (input: Node): Node => {
  const document = structuredClone(input)
  delete document["$self"]
  document["openapi"] = "3.1.1"
  for (const item of pathItemsOf(document)) delete item["additionalOperations"]
  const seen = new Set<object>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!isPlainObject(node) || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node["parameters"])) node["parameters"] = node["parameters"].filter((p) => !(isPlainObject(p) && p["in"] === "querystring"))
    if (isPlainObject(node["content"])) rewriteMediaTypes(node["content"])
    if (isPlainObject(node["responses"])) {
      for (const response of Object.values(node["responses"])) {
        if (isPlainObject(response) && typeof response["description"] !== "string") response["description"] = typeof response["summary"] === "string" ? response["summary"] : ""
      }
    }
    if (isPlainObject(node["examples"]) && (node["in"] !== undefined || node["schema"] !== undefined)) rewriteExamples(node["examples"])
    for (const value of Object.values(node)) walk(value)
  }
  walk(document)
  const components = document["components"]
  if (isPlainObject(components) && isPlainObject(components["examples"])) rewriteExamples(components["examples"])
  return document
}
