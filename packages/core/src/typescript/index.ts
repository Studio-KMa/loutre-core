/**
 * TypeScript types as input: a dependency-free parser for the useful subset
 * (interfaces, aliases, enums, unions, arrays, common generics) that runs in the
 * browser as well as in the worker, and emits an OpenAPI 3.1 document. Routes come
 * from a "route map" type keyed by `"GET /users"`, `"POST /orders"`…; otherwise
 * every entity (an object with an `id`, or one nothing else references) gets CRUD
 * routes on its plural: `/users`, `/users/{id}`.
 */
import type { Diagnostic } from "../diagnostic"
import type { Json, JsonObject } from "../model"
import { suggest } from "../util/suggest"
import { titleFromName } from "../util/infer-schema"
import { setOwn } from "../util/pointer"

// ─── Tokens ──────────────────────────────────────────────────────────────────

type TokenKind = "ident" | "string" | "number" | "punct" | "eof"

interface Token {
  readonly kind: TokenKind
  readonly value: string
  readonly line: number
  readonly col: number
  readonly doc?: string | undefined
}

class ParseError extends Error {
  readonly line: number
  readonly col: number
  readonly suggestions: ReadonlyArray<string>

  constructor(message: string, line: number, col: number, suggestions: ReadonlyArray<string> = []) {
    super(message)
    this.line = line
    this.col = col
    this.suggestions = suggestions
  }
}

/**
 * A construct outside the subset (a conditional type, `keyof`, a class): the declaration holding it is
 * skipped and the rest of the file read. A plain syntax error, by contrast, stops the reading.
 */
class Unsupported extends ParseError {}

const PUNCT = ["...", "=>", "{", "}", "[", "]", "(", ")", "<", ">", ",", ";", ":", "?", "|", "&", "=", ".", "!", "-", "+", "*", "/"]

const cleanDoc = (raw: string): string =>
  raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("@"))
    .join(" ")
    .trim()

const tagOf = (raw: string, tag: string): string | undefined => {
  const match = new RegExp(`@${tag}\\s+([^\\n*]+)`).exec(raw)
  return match?.[1]?.trim()
}

const tokenize = (source: string): { tokens: Array<Token>; title: string | undefined } => {
  const tokens: Array<Token> = []
  let i = 0
  let line = 1
  let col = 1
  let pendingDoc: string | undefined
  let title: string | undefined
  const advance = (n: number): void => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") {
        line++
        col = 1
      } else col++
      i++
    }
  }
  while (i < source.length) {
    const ch = source[i]!
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance(1)
      continue
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i)
      advance((end === -1 ? source.length : end) - i)
      continue
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      const stop = end === -1 ? source.length : end + 2
      const text = source.slice(i, stop)
      if (text.startsWith("/**")) {
        pendingDoc = cleanDoc(text)
        title ??= tagOf(text, "title")
      }
      advance(stop - i)
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < source.length && /[\w$]/.test(source[j]!)) j++
      tokens.push({ kind: "ident", value: source.slice(i, j), line, col, doc: pendingDoc })
      pendingDoc = undefined
      advance(j - i)
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < source.length && /[\w.]/.test(source[j]!)) j++
      tokens.push({ kind: "number", value: source.slice(i, j), line, col })
      advance(j - i)
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1
      let value = ""
      let template = false
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\" && j + 1 < source.length) {
          value += source[j + 1]
          j += 2
          continue
        }
        if (ch === "`" && source[j] === "$" && source[j + 1] === "{") {
          // A template literal type (`user_${string}`) is a string, whatever its pattern.
          let depth = 0
          while (j < source.length && !(source[j] === "`" && depth === 0)) {
            if (source[j] === "{") depth++
            else if (source[j] === "}") depth--
            j++
          }
          if (j >= source.length) throw new ParseError("Chaîne non terminée.", line, col)
          tokens.push({ kind: "ident", value: "string", line, col, doc: pendingDoc })
          pendingDoc = undefined
          advance(j + 1 - i)
          template = true
          break
        }
        value += source[j]
        j++
      }
      if (template) continue
      if (j >= source.length) throw new ParseError("Chaîne non terminée.", line, col)
      tokens.push({ kind: "string", value, line, col, doc: pendingDoc })
      pendingDoc = undefined
      advance(j + 1 - i)
      continue
    }
    const punct = PUNCT.find((p) => source.startsWith(p, i))
    if (punct !== undefined) {
      tokens.push({ kind: "punct", value: punct, line, col })
      advance(punct.length)
      continue
    }
    throw new ParseError(`Caractère inattendu « ${ch} ».`, line, col)
  }
  tokens.push({ kind: "eof", value: "", line, col })
  return { tokens, title }
}

// ─── Tree ────────────────────────────────────────────────────────────────────

type TypeNode =
  | { readonly k: "ref"; readonly name: string; readonly args: ReadonlyArray<TypeNode>; readonly line: number; readonly col: number; readonly qualified?: boolean }
  | { readonly k: "indexed"; readonly object: TypeNode; readonly index: TypeNode }
  | { readonly k: "object"; readonly members: ReadonlyArray<Member>; readonly index?: TypeNode | undefined }
  | { readonly k: "array"; readonly item: TypeNode }
  | { readonly k: "tuple"; readonly items: ReadonlyArray<TypeNode> }
  | { readonly k: "union"; readonly members: ReadonlyArray<TypeNode> }
  | { readonly k: "intersection"; readonly members: ReadonlyArray<TypeNode> }
  | { readonly k: "literal"; readonly value: string | number | boolean }
  | { readonly k: "keyword"; readonly name: string }

interface Member {
  readonly name: string
  readonly optional: boolean
  readonly type: TypeNode
  readonly doc?: string | undefined
}

interface Decl {
  readonly kind: "interface" | "alias" | "enum"
  readonly name: string
  readonly params: ReadonlyArray<string>
  readonly type: TypeNode
  readonly enumValues?: ReadonlyArray<string | number> | undefined
  readonly doc?: string | undefined
  readonly line: number
  readonly col: number
  /** A container of other types (Supabase's `Database`): read through, never a schema or a resource itself. */
  readonly wrapper?: boolean | undefined
}

const KEYWORDS = new Set(["string", "number", "boolean", "null", "undefined", "any", "unknown", "never", "void", "object", "bigint", "symbol"])

class Parser {
  private pos = 0
  readonly decls: Array<Decl> = []
  /** Imported names, and declarations that could not be read: what refers to them gets an opaque object. */
  readonly opaque = new Set<string>()
  /** Declarations skipped, in order: the first one explains a file where nothing could be read. */
  readonly failures: Array<ParseError> = []

  constructor(private readonly tokens: ReadonlyArray<Token>) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!
  }

  private next(): Token {
    const token = this.peek()
    if (token.kind !== "eof") this.pos++
    return token
  }

  private is(value: string, offset = 0): boolean {
    const token = this.peek(offset)
    return (token.kind === "punct" || token.kind === "ident") && token.value === value
  }

  private expect(value: string, hint?: string): Token {
    if (!this.is(value)) {
      const token = this.peek()
      throw new ParseError(`« ${value} » attendu, trouvé ${describe(token)}.${hint === undefined ? "" : ` ${hint}`}`, token.line, token.col)
    }
    return this.next()
  }

  parseProgram(): void {
    while (this.peek().kind !== "eof") this.parseStatementSafe()
  }

  /**
   * A declaration the subset does not cover (a conditional helper type, a class…) is skipped rather than
   * failing the whole file: real files mix data types with utilities that no data type needs.
   */
  private parseStatementSafe(): void {
    const start = this.pos
    try {
      this.parseStatement()
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error
      this.failures.push(error)
      const name = this.declaredName(start)
      if (name !== undefined) this.opaque.add(name)
      this.pos = start
      this.skipStatement()
      if (this.pos === start) this.next()
    }
  }

  private declaredName(start: number): string | undefined {
    for (let i = start; i < Math.min(start + 6, this.tokens.length); i++) {
      const token = this.tokens[i]!
      if (token.kind === "ident" && ["interface", "type", "enum", "class"].includes(token.value)) {
        const name = this.tokens[i + 1]
        return name?.kind === "ident" ? name.value : undefined
      }
    }
    return undefined
  }

  private parseStatement(): void {
    const start = this.peek()
    let doc = start.doc
    if (this.is("import")) {
      const from = this.pos
      this.skipStatement()
      for (let i = from; i < this.pos; i++) {
        const token = this.tokens[i]!
        if (token.kind === "ident" && !["import", "type", "from", "as", "typeof"].includes(token.value)) this.opaque.add(token.value)
      }
      return
    }
    if (this.is("export")) {
      this.next()
      if (this.is("{") || this.is("*") || this.is("default") || this.is("=")) {
        this.skipStatement()
        return
      }
      doc ??= this.peek().doc
    }
    if (this.is("declare")) this.next()
    if (this.is("const") && this.is("enum", 1)) this.next()
    const token = this.peek()
    if (this.is("interface")) return this.parseInterface(doc)
    if (this.is("type")) return this.parseAlias(doc)
    if (this.is("enum")) return this.parseEnum(doc)
    if (this.is("class")) {
      throw new Unsupported("Loutre lit les interfaces et les types, pas les classes : remplacez `class` par `interface`.", token.line, token.col)
    }
    if (this.is("namespace") || this.is("module") || this.is("global")) {
      // `declare namespace Api { … }`, `declare module "x" { … }`: their types are read as if at the top level.
      this.next()
      while (!this.is("{") && this.peek().kind !== "eof") this.next()
      this.expect("{")
      while (!this.is("}") && this.peek().kind !== "eof") this.parseStatementSafe()
      this.expect("}")
      return
    }
    if (this.is("const") || this.is("let") || this.is("var") || this.is("function") || this.is("abstract") || this.is("async")) {
      this.skipStatement()
      return
    }
    if (this.is(";")) {
      this.next()
      return
    }
    throw new ParseError(`Déclaration inattendue : ${describe(token)}. Loutre lit des déclarations \`interface\`, \`type\` et \`enum\`.`, token.line, token.col)
  }

  private skipStatement(): void {
    let depth = 0
    const startLine = this.peek().line
    while (this.peek().kind !== "eof") {
      if (depth <= 0 && this.is("}")) return
      const token = this.next()
      if (token.kind === "punct") {
        if (token.value === "{" || token.value === "(" || token.value === "[") depth++
        else if (token.value === "}" || token.value === ")" || token.value === "]") {
          depth--
          if (depth <= 0 && this.startsStatement(this.peek())) return
        } else if (token.value === ";" && depth <= 0) return
      }
      if (depth <= 0 && this.peek().line > startLine && this.startsStatement(this.peek()) && token.kind !== "punct") return
      if (depth <= 0 && this.peek().line > token.line && this.startsStatement(this.peek())) return
    }
  }

  private startsStatement(token: Token): boolean {
    return token.kind === "ident" && ["export", "import", "interface", "type", "enum", "declare", "const", "let", "var", "function", "class"].includes(token.value)
  }

  private parseName(): Token {
    const token = this.next()
    if (token.kind !== "ident") throw new ParseError(`Un nom de type est attendu, trouvé ${describe(token)}.`, token.line, token.col)
    return token
  }

  private parseTypeParams(): Array<string> {
    const params: Array<string> = []
    if (!this.is("<")) return params
    this.next()
    while (!this.is(">")) {
      params.push(this.parseName().value)
      if (this.is("extends")) {
        this.next()
        this.parseType()
      }
      if (this.is("=")) {
        this.next()
        this.parseType()
      }
      if (this.is(",")) this.next()
    }
    this.expect(">")
    return params
  }

  private parseInterface(doc: string | undefined): void {
    const keyword = this.expect("interface")
    const name = this.parseName()
    const params = this.parseTypeParams()
    const bases: Array<TypeNode> = []
    if (this.is("extends")) {
      this.next()
      bases.push(this.parseType())
      while (this.is(",")) {
        this.next()
        bases.push(this.parseType())
      }
    }
    const body = this.parseObjectType()
    const type: TypeNode = bases.length === 0 ? body : { k: "intersection", members: [...bases, body] }
    this.decls.push({ kind: "interface", name: name.value, params, type, doc, line: keyword.line, col: keyword.col })
  }

  private parseAlias(doc: string | undefined): void {
    const keyword = this.expect("type")
    const name = this.parseName()
    const params = this.parseTypeParams()
    this.expect("=", "Un alias s'écrit `type Nom = …`.")
    const type = this.parseType()
    if (this.is(";")) this.next()
    this.decls.push({ kind: "alias", name: name.value, params, type, doc, line: keyword.line, col: keyword.col })
  }

  private parseEnum(doc: string | undefined): void {
    const keyword = this.expect("enum")
    const name = this.parseName()
    this.expect("{")
    const values: Array<string | number> = []
    let counter = 0
    while (!this.is("}")) {
      const member = this.next()
      if (member.kind !== "ident" && member.kind !== "string") {
        throw new ParseError(`Membre d'enum inattendu : ${describe(member)}.`, member.line, member.col)
      }
      if (this.is("=")) {
        this.next()
        const value = this.next()
        if (value.kind === "string") values.push(value.value)
        else if (value.kind === "number") {
          counter = Number(value.value)
          values.push(counter)
          counter++
        } else if (value.kind === "punct" && value.value === "-" && this.peek().kind === "number") {
          counter = -Number(this.next().value)
          values.push(counter)
          counter++
        } else throw new ParseError(`Valeur d'enum inattendue : ${describe(value)}.`, value.line, value.col)
      } else {
        values.push(counter)
        counter++
      }
      if (this.is(",")) this.next()
    }
    this.expect("}")
    const numeric = values.every((v) => typeof v === "number")
    this.decls.push({
      kind: "enum",
      name: name.value,
      params: [],
      type: { k: "keyword", name: numeric ? "number" : "string" },
      enumValues: values,
      doc,
      line: keyword.line,
      col: keyword.col,
    })
  }

  private parseObjectType(): TypeNode {
    this.expect("{")
    const members: Array<Member> = []
    let index: TypeNode | undefined
    while (!this.is("}")) {
      const start = this.peek()
      if (start.kind === "eof") throw new ParseError("Accolade fermante manquante.", start.line, start.col)
      if (this.is("readonly")) this.next()
      if (this.is("[")) {
        this.next()
        this.next()
        if (this.is("in")) {
          // A mapped type (`[K in Keys]: T`, Supabase's `[_ in never]: never`): read as a map of T, which is what it serves.
          this.next()
          this.parseType()
          if (this.is("as")) {
            this.next()
            this.parseType()
          }
          this.expect("]")
          if (this.is("-") || this.is("+")) this.next()
          if (this.is("?")) this.next()
          this.expect(":")
          index = this.parseType()
          this.endMember()
          continue
        }
        this.expect(":")
        this.parseType()
        this.expect("]")
        this.expect(":")
        index = this.parseType()
        this.endMember()
        continue
      }
      if (this.is("(") || this.is("<") || (this.is("new") && (this.is("(", 1) || this.is("<", 1)))) {
        // A call or construct signature (`(id: string): User`): no data in it.
        if (this.is("new")) this.next()
        this.skipBalanced()
        if (this.is(":")) {
          this.next()
          this.parseType()
        }
        this.endMember()
        continue
      }
      const nameToken = this.next()
      if (nameToken.kind !== "ident" && nameToken.kind !== "string" && nameToken.kind !== "number") {
        throw new ParseError(`Propriété inattendue : ${describe(nameToken)}.`, nameToken.line, nameToken.col)
      }
      let optional = false
      if (this.is("?")) {
        this.next()
        optional = true
      }
      if (this.is("(") || this.is("<")) {
        // A method has no place in a data schema: skip it.
        this.skipBalanced()
        if (this.is(":")) {
          this.next()
          this.parseType()
        }
        this.endMember()
        continue
      }
      this.expect(":", `La propriété « ${nameToken.value} » attend un type.`)
      const type = this.parseType()
      members.push({ name: nameToken.value, optional, type, doc: nameToken.doc })
      this.endMember()
    }
    this.expect("}")
    return { k: "object", members, index }
  }

  private endMember(): void {
    if (this.is(";") || this.is(",")) this.next()
  }

  private skipBalanced(): void {
    let depth = 0
    do {
      const token = this.next()
      if (token.kind === "eof") return
      if (token.kind === "punct") {
        if (token.value === "(" || token.value === "<" || token.value === "{" || token.value === "[") depth++
        if (token.value === ")" || token.value === ">" || token.value === "}" || token.value === "]") depth--
      }
    } while (depth > 0)
  }

  parseType(): TypeNode {
    if (this.is("|")) this.next()
    const first = this.parseIntersection()
    if (!this.is("|")) return first
    const members = [first]
    while (this.is("|")) {
      this.next()
      members.push(this.parseIntersection())
    }
    return { k: "union", members }
  }

  private parseIntersection(): TypeNode {
    if (this.is("&")) this.next()
    const first = this.parsePostfix()
    if (!this.is("&")) return first
    const members = [first]
    while (this.is("&")) {
      this.next()
      members.push(this.parsePostfix())
    }
    return { k: "intersection", members }
  }

  private parsePostfix(): TypeNode {
    let node = this.parsePrimary()
    while (this.is("[")) {
      const open = this.next()
      if (this.is("]")) {
        this.next()
        node = { k: "array", item: node }
      } else {
        const index = this.parseType()
        this.expect("]", `Accès indexé ouvert ligne ${open.line}.`)
        node = { k: "indexed", object: node, index }
      }
    }
    if (this.is("extends")) {
      const token = this.peek()
      throw new Unsupported("Les types conditionnels (`A extends B ? X : Y`) ne sont pas lus.", token.line, token.col)
    }
    return node
  }

  private parsePrimary(): TypeNode {
    const token = this.next()
    if (token.kind === "punct") {
      if (token.value === "(") {
        if (this.is(")") || ((this.peek().kind === "ident" || this.is("...")) && (this.is(":", 1) || this.is("?", 1) || this.is(",", 1)))) {
          // A function type (`onClick: () => void`) carries no data: the property is left out of the schema.
          this.pos--
          this.skipBalanced()
          this.expect("=>", "Un type fonction s'écrit `(…) => Type`.")
          this.parseType()
          return { k: "keyword", name: "undefined" }
        }
        const inner = this.parseType()
        this.expect(")")
        return inner
      }
      if (token.value === "{") {
        this.pos--
        return this.parseObjectType()
      }
      if (token.value === "[") {
        const items: Array<TypeNode> = []
        while (!this.is("]")) {
          if (this.is("...")) this.next()
          if (this.peek().kind === "ident" && this.is(":", 1)) {
            this.next()
            this.next()
          }
          items.push(this.parseType())
          if (this.is("?")) this.next()
          if (this.is(",")) this.next()
        }
        this.expect("]")
        return { k: "tuple", items }
      }
      if (token.value === "-" && this.peek().kind === "number") return { k: "literal", value: -Number(this.next().value) }
      throw new ParseError(`Type inattendu : ${describe(token)}.`, token.line, token.col)
    }
    if (token.kind === "string") return { k: "literal", value: token.value }
    if (token.kind === "number") return { k: "literal", value: Number(token.value) }
    if (token.kind === "eof") throw new ParseError("Fin de fichier inattendue : un type manque.", token.line, token.col)
    if (token.value === "true" || token.value === "false") return { k: "literal", value: token.value === "true" }
    if (KEYWORDS.has(token.value)) return { k: "keyword", name: token.value }
    if (token.value === "keyof" || token.value === "typeof" || token.value === "infer") {
      throw new Unsupported(`\`${token.value}\` n'est pas lu : écrivez le type résultant explicitement.`, token.line, token.col)
    }
    let name = token.value
    let qualified = false
    while (this.is(".")) {
      this.next()
      name = this.parseName().value
      qualified = true
    }
    const args: Array<TypeNode> = []
    if (this.is("<")) {
      this.next()
      while (!this.is(">")) {
        args.push(this.parseType())
        if (this.is(",")) this.next()
      }
      this.expect(">")
    }
    return qualified ? { k: "ref", name, args, line: token.line, col: token.col, qualified } : { k: "ref", name, args, line: token.line, col: token.col }
  }
}

const describe = (token: Token): string =>
  token.kind === "eof" ? "la fin du fichier" : token.kind === "string" ? `la chaîne « ${token.value} »` : `« ${token.value} »`

// ─── JSON Schema conversion ──────────────────────────────────────────────────

interface Converted {
  readonly schema: JsonObject | undefined
  readonly optional: boolean
}

type Env = ReadonlyMap<string, TypeNode>

const NONE: Converted = { schema: undefined, optional: true }
const ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/i
const ID_FIELD = /^(id|_id|uuid|[a-z]+Id)$/
const BODY_PREFIX = /^(Create|New|Update|Patch|Upsert)/
const BODY_SUFFIX = /(Input|Dto|DTO|Payload|Request|Body|Params|Create|Update|Patch)$/

/** Generic instantiations inlined inside one another, at most. */
const MAX_INSTANTIATION_DEPTH = 8

class Converter {
  private instantiating = 0
  private readonly decls = new Map<string, Decl>()
  private readonly referenced = new Set<string>()
  readonly schemas: Record<string, Record<string, Json>> = {}
  readonly paths: Record<string, Record<string, Json>> = {}
  private routeMaps: Array<Decl> = []

  constructor(
    decls: ReadonlyArray<Decl>,
    private readonly opaque: ReadonlySet<string> = new Set(),
  ) {
    for (const decl of decls) {
      const known = this.decls.get(decl.name)
      if (known === undefined) this.decls.set(decl.name, decl)
      // Two interfaces of the same name merge, as in TypeScript; any other duplicate keeps the first.
      else if (known.kind === "interface" && decl.kind === "interface") this.decls.set(decl.name, { ...known, type: { k: "intersection", members: [known.type, decl.type] } })
    }
  }

  run(): { types: number; routes: number } {
    this.routeMaps = [...this.decls.values()].filter((d) => isRouteMap(d))
    for (const decl of this.decls.values()) {
      if (this.routeMaps.includes(decl) || decl.params.length > 0 || decl.wrapper === true) continue
      this.schemas[decl.name] = { title: decl.name, ...this.convertDecl(decl) }
    }
    if (this.routeMaps.length > 0) {
      for (const map of this.routeMaps) this.routesFromMap(map)
    } else {
      this.routesFromEntities()
    }
    return { types: Object.keys(this.schemas).length, routes: Object.values(this.paths).reduce((n, item) => n + Object.keys(item).length, 0) }
  }

  private convertDecl(decl: Decl, env: Env = new Map()): JsonObject {
    if (decl.kind === "enum") {
      const numeric = decl.enumValues?.every((v) => typeof v === "number") ?? false
      const schema: Record<string, Json> = { type: numeric ? "integer" : "string", enum: [...(decl.enumValues ?? [])] }
      if (decl.doc !== undefined) schema["description"] = decl.doc
      return schema
    }
    const converted = this.convert(decl.type, env)
    const schema: JsonObject = converted.schema ?? {}
    if (decl.doc !== undefined && schema["description"] === undefined) return { ...schema, description: decl.doc }
    return schema
  }

  convert(node: TypeNode, env: Env): Converted {
    switch (node.k) {
      case "keyword":
        return this.keyword(node.name)
      case "literal":
        return {
          schema:
            typeof node.value === "boolean"
              ? { type: "boolean" }
              : typeof node.value === "number"
                ? { type: Number.isInteger(node.value) ? "integer" : "number", enum: [node.value] }
                : { type: "string", enum: [node.value] },
          optional: false,
        }
      case "array": {
        const item = this.convert(node.item, env)
        return { schema: { type: "array", items: item.schema ?? {} }, optional: false }
      }
      case "tuple": {
        const items = node.items.map((i) => this.convert(i, env).schema ?? {})
        return { schema: { type: "array", items: items.length === 1 ? items[0]! : { anyOf: items }, minItems: items.length, maxItems: items.length }, optional: false }
      }
      case "object":
        return { schema: this.object(node, env), optional: false }
      case "union":
        return this.union(node.members, env)
      case "intersection":
        return { schema: this.intersection(node.members, env), optional: false }
      case "ref":
        return this.reference(node, env)
      case "indexed":
        return { schema: this.indexed(node, env), optional: false }
    }
  }

  /** `User["address"]`, `Item[number]`: the member or element type when it can be found, anything otherwise. */
  private indexed(node: Extract<TypeNode, { k: "indexed" }>, env: Env): JsonObject {
    const target = this.indexTarget(node, env, 0)
    return target === undefined ? {} : (this.convert(target, env).schema ?? {})
  }

  /**
   * Resolved on the type tree, member by member: `Database["public"]["Enums"]["kind"]` inside `Database`
   * itself never converts the whole database again.
   */
  private indexTarget(node: Extract<TypeNode, { k: "indexed" }>, env: Env, depth: number): TypeNode | undefined {
    if (depth > 24) return undefined
    const index = node.index
    const key = index.k === "literal" ? index.value : undefined
    if (typeof key === "string") return this.memberOf(node.object, key, env, depth + 1)
    if (key === undefined && !(index.k === "keyword" && index.name === "number")) return undefined
    const list = this.typeOf(node.object, env, depth + 1)
    if (list?.k === "array") return list.item
    if (list?.k === "tuple") return list.items[0]
    if (list?.k === "ref" && (list.name === "Array" || list.name === "ReadonlyArray")) return list.args[0]
    return undefined
  }

  /** The type a node stands for, references followed (generic arguments ignored past the first level). */
  private typeOf(node: TypeNode, env: Env, depth: number): TypeNode | undefined {
    if (depth > 24) return undefined
    if (node.k === "indexed") {
      const target = this.indexTarget(node, env, depth + 1)
      return target === undefined ? undefined : this.typeOf(target, env, depth + 1)
    }
    if (node.k !== "ref") return node
    const bound = env.get(node.name)
    if (bound !== undefined && node.args.length === 0) return this.typeOf(bound, env, depth + 1)
    const decl = this.decls.get(node.name)
    return decl === undefined || decl.kind === "enum" ? node : this.typeOf(decl.type, this.bind(decl, node, env), depth + 1)
  }

  private memberOf(node: TypeNode, key: string, env: Env, depth: number): TypeNode | undefined {
    const type = this.typeOf(node, env, depth)
    if (type === undefined) return undefined
    if (type.k === "object") return type.members.find((m) => m.name === key)?.type ?? type.index
    if (type.k === "intersection") {
      for (const member of type.members) {
        const found = this.memberOf(member, key, env, depth + 1)
        if (found !== undefined) return found
      }
    }
    return undefined
  }

  private keyword(name: string): Converted {
    switch (name) {
      case "string":
        return { schema: { type: "string" }, optional: false }
      case "number":
        return { schema: { type: "number" }, optional: false }
      case "bigint":
        return { schema: { type: "integer" }, optional: false }
      case "boolean":
        return { schema: { type: "boolean" }, optional: false }
      case "null":
        return { schema: { type: "null" }, optional: false }
      case "undefined":
      case "void":
      case "never":
        return NONE
      case "symbol":
        return { schema: { type: "string" }, optional: false }
      default:
        return { schema: {}, optional: false }
    }
  }

  private object(node: Extract<TypeNode, { k: "object" }>, env: Env): JsonObject {
    const properties: Record<string, Json> = {}
    const required: Array<string> = []
    for (const member of node.members) {
      const converted = this.convert(member.type, env)
      if (converted.schema === undefined) continue
      const schema: JsonObject = member.doc === undefined ? converted.schema : { ...converted.schema, description: member.doc }
      properties[member.name] = schema
      if (!member.optional && !converted.optional) required.push(member.name)
    }
    const schema: Record<string, Json> = { type: "object", properties }
    if (required.length > 0) schema["required"] = required
    if (node.index !== undefined) schema["additionalProperties"] = this.convert(node.index, env).schema ?? {}
    return schema
  }

  private union(members: ReadonlyArray<TypeNode>, env: Env): Converted {
    const variants: Array<JsonObject> = []
    let optional = false
    let nullable = false
    for (const member of members) {
      const converted = this.convert(member, env)
      if (converted.schema === undefined) {
        optional = true
        continue
      }
      if (converted.schema["type"] === "null") {
        nullable = true
        continue
      }
      variants.push(converted.schema)
    }
    if (variants.length === 0) return nullable ? { schema: { type: "null" }, optional } : { schema: undefined, optional: true }
    const literalType = literalTypeOf(variants)
    let schema: JsonObject
    if (literalType !== undefined) {
      const values = variants.flatMap((v) => (Array.isArray(v["enum"]) ? v["enum"] : []))
      schema = { type: literalType, enum: values }
    } else if (variants.length === 1) {
      schema = variants[0]!
    } else {
      schema = { anyOf: variants }
    }
    if (nullable) schema = { anyOf: [schema, { type: "null" }] }
    return { schema, optional }
  }

  private intersection(members: ReadonlyArray<TypeNode>, env: Env): JsonObject {
    try {
      return mergeObjects(members.map((m) => this.objectSchemaOf(m, env, "&")))
    } catch (error) {
      // `Array<Post> & { meta: Pagination }` (Ghost): JSON has no list with fields of its own, the list is what is served.
      if (!(error instanceof ParseError)) throw error
      for (const member of members) {
        const resolved = this.resolvedSchema(member, env)
        if (resolved?.["type"] === "array") return resolved
      }
      throw error
    }
  }

  /** A type's schema with named references followed, generics bound. */
  private resolvedSchema(node: TypeNode, env: Env): JsonObject | undefined {
    if (node.k === "ref" && node.args.length === 0 && env.get(node.name) !== undefined) return this.resolvedSchema(env.get(node.name)!, env)
    const decl = node.k === "ref" ? this.decls.get(node.name) : undefined
    if (decl !== undefined && node.k === "ref") return this.convertDecl(decl, this.bind(decl, node, env))
    return this.convert(node, env).schema
  }

  /** A flattened object schema (references and generics resolved), for `&`, `Partial`, `Pick`, `Omit`. */
  private objectSchemaOf(node: TypeNode, env: Env, what: string): JsonObject {
    if (node.k === "ref") {
      const bound = env.get(node.name)
      if (bound !== undefined && node.args.length === 0) return this.objectSchemaOf(bound, env, what)
      const decl = this.decls.get(node.name)
      if (decl !== undefined && decl.kind !== "enum") {
        const inner = this.bind(decl, node, env)
        return this.objectSchemaOf(decl.type, inner, what)
      }
      const built = this.builtin(node, env)
      if (built !== undefined && built.schema !== undefined) return expectObject(built.schema, node, what)
    }
    const converted = this.convert(node, env)
    return expectObject(converted.schema ?? {}, node, what)
  }

  private bind(decl: Decl, node: Extract<TypeNode, { k: "ref" }>, env: Env): Env {
    if (decl.params.length === 0) return env
    const inner = new Map(env)
    decl.params.forEach((param, index) => {
      const arg = node.args[index]
      // `Tree<T>` inside `Tree`: its `T` is the caller's, resolved now, or it would stand for itself.
      if (arg !== undefined) inner.set(param, arg.k === "ref" && arg.args.length === 0 && env.has(arg.name) ? env.get(arg.name)! : arg)
    })
    return inner
  }

  private reference(node: Extract<TypeNode, { k: "ref" }>, env: Env): Converted {
    const bound = env.get(node.name)
    if (bound !== undefined && node.args.length === 0) return this.convert(bound, env)
    const decl = this.decls.get(node.name)
    if (decl !== undefined) {
      if (this.routeMaps.includes(decl)) {
        throw new ParseError(`« ${decl.name} » est une carte des routes, pas un type de données.`, node.line, node.col)
      }
      this.referenced.add(decl.name)
      if (decl.params.length === 0 && node.args.length === 0) return { schema: { $ref: `#/components/schemas/${decl.name}` }, optional: false }
      // Instantiated generic: inline the body with its arguments instead of a $ref. A recursive one
      // (`type Tree<T> = { children: Tree<T>[] }`) stops a few levels down, as an opaque object.
      if (this.instantiating >= MAX_INSTANTIATION_DEPTH) return { schema: { type: "object" }, optional: false }
      this.instantiating++
      try {
        return { schema: this.convertDecl(decl, this.bind(decl, node, env)), optional: false }
      } finally {
        this.instantiating--
      }
    }
    const built = this.builtin(node, env)
    if (built !== undefined) return built
    // Imported, skipped, or reached through a namespace from elsewhere (`Api.User`): an object we cannot see into.
    if (this.opaque.has(node.name) || node.qualified === true) return { schema: { type: "object" }, optional: false }
    const candidates = [...this.decls.keys(), "string", "number", "boolean", "Date", "Array", "Record", "Partial", "Pick", "Omit"]
    const suggestions = suggest(node.name, candidates).map((c) => `Vouliez-vous dire \`${c}\` ?`)
    throw new ParseError(`Le type « ${node.name} » n'existe pas dans ce fichier.`, node.line, node.col, suggestions.length > 0 ? suggestions : ["Déclarez-le dans le même texte : Loutre ne suit pas les imports."])
  }

  private builtin(node: Extract<TypeNode, { k: "ref" }>, env: Env): Converted | undefined {
    const arg = (index: number): TypeNode => {
      const found = node.args[index]
      if (found === undefined) throw new ParseError(`\`${node.name}\` attend ${index + 1} argument${index > 0 ? "s" : ""} de type.`, node.line, node.col)
      return found
    }
    switch (node.name) {
      case "Array":
      case "ReadonlyArray":
      case "Set":
      case "ReadonlySet":
        return { schema: { type: "array", items: this.convert(arg(0), env).schema ?? {} }, optional: false }
      case "Record":
      case "Map":
      case "ReadonlyMap":
        return { schema: { type: "object", additionalProperties: this.convert(arg(1), env).schema ?? {} }, optional: false }
      case "Date":
        return { schema: { type: "string", format: "date-time" }, optional: false }
      case "Object":
        return { schema: { type: "object" }, optional: false }
      case "URL":
        return { schema: { type: "string", format: "uri" }, optional: false }
      case "RegExp":
        return { schema: { type: "string" }, optional: false }
      case "Blob":
      case "File":
      case "Buffer":
      case "ArrayBuffer":
      case "Uint8Array":
        return { schema: { type: "string", format: "binary" }, optional: false }
      case "Error":
        return { schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }, optional: false }
      case "Promise":
      case "Readonly":
      case "Awaited":
        return this.convert(arg(0), env)
      case "NonNullable": {
        const converted = this.convert(arg(0), env)
        const schema = converted.schema
        if (schema !== undefined && Array.isArray(schema["anyOf"])) {
          const rest = (schema["anyOf"] as Array<JsonObject>).filter((v) => v["type"] !== "null")
          return { schema: rest.length === 1 ? rest[0]! : { anyOf: rest }, optional: false }
        }
        return { schema, optional: false }
      }
      case "Partial": {
        const object = this.objectSchemaOf(arg(0), env, "Partial")
        const { required: _required, ...rest } = object
        return { schema: rest, optional: false }
      }
      case "Required": {
        const object = this.objectSchemaOf(arg(0), env, "Required")
        return { schema: { ...object, required: Object.keys((object["properties"] as JsonObject | undefined) ?? {}) }, optional: false }
      }
      case "Pick":
      case "Omit": {
        const object = this.objectSchemaOf(arg(0), env, node.name)
        const keys = literalKeys(arg(1), node)
        const properties = (object["properties"] as JsonObject | undefined) ?? {}
        const keep = Object.keys(properties).filter((k) => (node.name === "Pick" ? keys.includes(k) : !keys.includes(k)))
        const picked: Record<string, Json> = {}
        for (const key of keep) setOwn(picked, key, properties[key]!)
        const required = (Array.isArray(object["required"]) ? (object["required"] as Array<string>) : []).filter((k) => keep.includes(k))
        const schema: Record<string, Json> = { ...object, properties: picked }
        if (required.length > 0) schema["required"] = required
        else delete schema["required"]
        return { schema, optional: false }
      }
      default:
        return undefined
    }
  }

  // ─── Routes ────────────────────────────────────────────────────────────────

  private routesFromMap(map: Decl): void {
    if (map.type.k !== "object") return
    for (const member of map.type.members) {
      const match = ROUTE_KEY.exec(member.name)
      if (match === null) continue
      const method = match[1]!.toLowerCase()
      const path = normalisePath(match[2]!)
      const spec = this.routeSpec(member.type, method)
      const operation: Record<string, Json> = { responses: spec.responses }
      if (member.doc !== undefined) operation["summary"] = member.doc
      if (spec.body !== undefined) operation["requestBody"] = { required: true, content: { "application/json": { schema: spec.body } } }
      const parameters = [...pathParameters(path), ...spec.query]
      if (parameters.length > 0) operation["parameters"] = parameters
      this.addOperation(path, method, operation)
    }
  }

  private routeSpec(node: TypeNode, method: string): { responses: Record<string, Json>; body: JsonObject | undefined; query: Array<JsonObject> } {
    let response: TypeNode = node
    let body: TypeNode | undefined
    let query: TypeNode | undefined
    let status: number | undefined
    if (node.k === "object" && node.members.some((m) => m.name === "response")) {
      for (const member of node.members) {
        if (member.name === "response") response = member.type
        else if (member.name === "body") body = member.type
        else if (member.name === "query") query = member.type
        else if (member.name === "status" && member.type.k === "literal" && typeof member.type.value === "number") status = member.type.value
      }
    }
    const converted = this.convert(response, new Map())
    const code = status ?? (converted.schema === undefined ? 204 : method === "post" ? 201 : 200)
    const responses: Record<string, Json> = {}
    responses[String(code)] = converted.schema === undefined ? { description: "OK" } : { description: "OK", content: { "application/json": { schema: converted.schema } } }
    const queryParameters: Array<JsonObject> = []
    if (query !== undefined) {
      const schema = this.objectSchemaOf(query, new Map(), "query")
      const properties = (schema["properties"] as JsonObject | undefined) ?? {}
      const required = Array.isArray(schema["required"]) ? (schema["required"] as Array<string>) : []
      for (const [name, propertySchema] of Object.entries(properties)) {
        queryParameters.push({ name, in: "query", required: required.includes(name), schema: propertySchema })
      }
    }
    return { responses, body: body === undefined ? undefined : this.convert(body, new Map()).schema, query: queryParameters }
  }

  private routesFromEntities(): void {
    const bodies = new Map<string, { create?: string; update?: string }>()
    const names = [...this.decls.keys()]
    const entityNames = new Set(names.filter((n) => this.isObjectDecl(n)))
    // `CreateUser`, `UserInput`, `UpdateUser`… are write bodies for `User`, not entities.
    for (const name of entityNames) {
      const base = name.replace(BODY_PREFIX, "").replace(BODY_SUFFIX, "")
      if (base === name || base.length === 0 || !entityNames.has(base)) continue
      const slot = bodies.get(base) ?? {}
      if (/^(Update|Patch)/.test(name) || /(Update|Patch)$/.test(name)) slot.update = name
      else slot.create = name
      bodies.set(base, slot)
      entityNames.delete(name)
    }
    for (const name of entityNames) {
      const decl = this.decls.get(name)!
      const hasId = this.idFieldOf(decl) !== undefined
      if (!hasId && this.referenced.has(name)) continue
      const idField = this.idFieldOf(decl) ?? "id"
      const plural = pluralPath(name)
      const ref: Record<string, Json> = { $ref: `#/components/schemas/${name}` }
      const slot = bodies.get(name) ?? {}
      const createBody: JsonObject = slot.create === undefined ? ref : { $ref: `#/components/schemas/${slot.create}` }
      const updateBody: JsonObject = slot.update === undefined ? createBody : { $ref: `#/components/schemas/${slot.update}` }
      const notFound: Record<string, Json> = { description: "Introuvable", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
      const okItem = (description: string): JsonObject => ({ description, content: { "application/json": { schema: ref } } })
      this.addOperation(`/${plural}`, "get", {
        summary: `Liste des ${plural}`,
        tags: [name],
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "array", items: ref } } } } },
      })
      this.addOperation(`/${plural}`, "post", {
        summary: `Créer un ${name}`,
        tags: [name],
        requestBody: { required: true, content: { "application/json": { schema: createBody } } },
        responses: { "201": okItem("Créé") },
      })
      const detail = `/${plural}/{${idField}}`
      const parameter = { name: idField, in: "path", required: true, schema: { type: "string" } }
      this.addOperation(detail, "get", { summary: `Un ${name}`, tags: [name], parameters: [parameter], responses: { "200": okItem("OK"), "404": notFound } })
      this.addOperation(detail, "put", {
        summary: `Modifier un ${name}`,
        tags: [name],
        parameters: [parameter],
        requestBody: { required: true, content: { "application/json": { schema: updateBody } } },
        responses: { "200": okItem("OK"), "404": notFound },
      })
      this.addOperation(detail, "delete", { summary: `Supprimer un ${name}`, tags: [name], parameters: [parameter], responses: { "204": { description: "Supprimé" }, "404": notFound } })
    }
    if (Object.keys(this.paths).length > 0 && this.schemas["Error"] === undefined) {
      this.schemas["Error"] = {
        title: "Error",
        type: "object",
        properties: { error: { type: "string" }, message: { type: "string" } },
        required: ["error", "message"],
      }
    }
  }

  private isObjectDecl(name: string): boolean {
    const decl = this.decls.get(name)
    if (decl === undefined || decl.kind === "enum" || decl.params.length > 0 || decl.wrapper === true || this.routeMaps.includes(decl)) return false
    const schema = this.schemas[name]
    return schema !== undefined && schema["type"] === "object" && schema["properties"] !== undefined
  }

  private idFieldOf(decl: Decl): string | undefined {
    const schema = this.schemas[decl.name]
    const properties = schema === undefined ? undefined : (schema["properties"] as JsonObject | undefined)
    if (properties === undefined) return undefined
    return Object.keys(properties).find((k) => ID_FIELD.test(k))
  }

  private addOperation(path: string, method: string, operation: Record<string, Json>): void {
    const item: Record<string, Json> = this.paths[path] ?? {}
    if (item[method] !== undefined) return
    item[method] = operation
    this.paths[path] = item
  }
}

const literalTypeOf = (variants: ReadonlyArray<JsonObject>): string | undefined => {
  if (variants.length === 0) return undefined
  const first = variants[0]!["type"]
  if (typeof first !== "string" || !variants.every((v) => Array.isArray(v["enum"]) && v["type"] === first)) return undefined
  return first
}

const literalKeys = (node: TypeNode, at: Extract<TypeNode, { k: "ref" }>): Array<string> => {
  const members = node.k === "union" ? node.members : [node]
  const keys: Array<string> = []
  for (const member of members) {
    if (member.k !== "literal" || typeof member.value !== "string") {
      throw new ParseError(`\`${at.name}\` attend des noms de propriétés littéraux (\`"a" | "b"\`).`, at.line, at.col)
    }
    keys.push(member.value)
  }
  return keys
}

const expectObject = (schema: JsonObject, node: TypeNode, what: string): JsonObject => {
  if (schema["type"] === "object" || schema["properties"] !== undefined) return schema
  const where = node.k === "ref" ? ` (« ${node.name} »)` : ""
  throw new ParseError(`\`${what}\` attend un type objet${where}.`, node.k === "ref" ? node.line : 0, node.k === "ref" ? node.col : 0)
}

const mergeObjects = (objects: ReadonlyArray<JsonObject>): JsonObject => {
  const properties: Record<string, Json> = {}
  const required: Array<string> = []
  let additional: Json | undefined
  for (const object of objects) {
    Object.assign(properties, (object["properties"] as JsonObject | undefined) ?? {})
    for (const key of Array.isArray(object["required"]) ? (object["required"] as Array<string>) : []) if (!required.includes(key)) required.push(key)
    if (object["additionalProperties"] !== undefined) additional = object["additionalProperties"] as Json
  }
  const merged: Record<string, Json> = { type: "object", properties }
  if (required.length > 0) merged["required"] = required
  if (additional !== undefined) merged["additionalProperties"] = additional
  return merged
}

const isRouteMap = (decl: Decl): boolean =>
  decl.kind !== "enum" && decl.type.k === "object" && decl.type.members.length > 0 && decl.type.members.every((m) => ROUTE_KEY.test(m.name))

const normalisePath = (raw: string): string => {
  const path = raw.replace(/:([A-Za-z_][\w]*)/g, "{$1}").replace(/\/+$/, "")
  return path.length === 0 ? "/" : path
}

const pathParameters = (path: string): Array<JsonObject> =>
  [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1]!, in: "path", required: true, schema: { type: "string" } }))

/** `OrderLine` → `order-lines`, `Category` → `categories`, `Address` → `addresses`. */
export const pluralPath = (name: string): string => {
  const kebab = name
    .slice(0, 128)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
  if (/[^aeiou]y$/.test(kebab)) return `${kebab.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(kebab)) return `${kebab}es`
  return `${kebab}s`
}

// ─── Public API ──────────────────────────────────────────────────────────────

export type TypeScriptResult =
  | { readonly ok: true; readonly document: JsonObject; readonly types: number; readonly routes: number }
  | { readonly ok: false; readonly error: Diagnostic }

/** Whether the text declares TypeScript types rather than YAML or JSON. */
export const looksLikeTypeScript = (text: string): boolean => {
  const trimmed = text.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false
  return /(^|\n)\s*(export\s+)?(declare\s+)?(const\s+)?(interface|type|enum)\s+[A-Za-z_$][\w$]*\s*(<[^\n]*>)?\s*(\{|=|extends)/.test(text)
}

export const typescriptToOpenApi = (source: string): TypeScriptResult => {
  try {
    const { tokens, title } = tokenize(source)
    const parser = new Parser(tokens)
    parser.parseProgram()
    if (parser.decls.length === 0) {
      const first = parser.failures[0]
      if (first !== undefined) throw first
      return failure("Aucune déclaration `interface`, `type` ou `enum` trouvée.", ["Collez vos types de données, par exemple `interface User { id: string; email: string }`."])
    }
    const converter = new Converter(withSupabaseTables(parser.decls), parser.opaque)
    const counts = converter.run()
    if (counts.routes === 0) {
      return failure("Aucune route déduite de ces types.", [
        "Donnez un `id` à vos entités (`interface User { id: string; … }`) : elles reçoivent alors leurs routes CRUD.",
        'Ou décrivez les routes vous-même : `type Api = { "GET /users": User[]; "POST /orders": Order }`.',
      ])
    }
    const document: Record<string, Json> = {
      openapi: "3.1.0",
      info: { title: title ?? defaultTitle(converter.paths), version: "1.0.0" },
      paths: converter.paths,
      components: { schemas: converter.schemas },
    }
    return { ok: true, document, types: counts.types, routes: counts.routes }
  } catch (error) {
    if (error instanceof ParseError) {
      const where = error.line > 0 ? ` (ligne ${error.line}, colonne ${error.col})` : ""
      return failure(`${error.message}${where}`, error.suggestions)
    }
    // Pasted text reaches this parser in the browser as well as in the worker: a stack overflow is an answer, not a crash.
    if (error instanceof RangeError) return failure("Ces types s'imbriquent trop profondément pour être lus.", ["Simplifiez le type récursif ou générique le plus imbriqué."])
    throw error
  }
}

/**
 * Supabase's generated `Database` type nests every table as `<schema>.Tables.<table>.{ Row, Insert, Update }`:
 * each table becomes an entity of its own (`posts` → `Post`, with `CreatePost` and `UpdatePost` as write
 * bodies), and the `Database` wrapper itself is no resource.
 */
const withSupabaseTables = (decls: ReadonlyArray<Decl>): Array<Decl> => {
  const taken = new Set(decls.map((d) => d.name))
  const tables: Array<Decl> = []
  const wrappers = new Set<Decl>()
  const member = (node: TypeNode, name: string): TypeNode | undefined => (node.k === "object" ? node.members.find((m) => m.name === name)?.type : undefined)
  for (const decl of decls) {
    if (decl.type.k !== "object" || decl.params.length > 0) continue
    for (const schema of decl.type.members) {
      const list = member(schema.type, "Tables")
      if (list === undefined || list.k !== "object") continue
      for (const table of list.members) {
        const row = member(table.type, "Row")
        if (row === undefined) continue
        wrappers.add(decl)
        const name = titleFromName(table.name)
        if (name.length === 0 || taken.has(name)) continue
        taken.add(name)
        const at = { params: [], line: decl.line, col: decl.col }
        tables.push({ kind: "alias", name, type: row, doc: table.doc, ...at })
        const insert = member(table.type, "Insert")
        if (insert !== undefined && !taken.has(`Create${name}`)) tables.push({ kind: "alias", name: `Create${name}`, type: insert, ...at })
        const update = member(table.type, "Update")
        if (update !== undefined && !taken.has(`Update${name}`)) tables.push({ kind: "alias", name: `Update${name}`, type: update, ...at })
      }
    }
  }
  return tables.length === 0 ? [...decls] : [...decls.map((d) => (wrappers.has(d) ? { ...d, wrapper: true } : d)), ...tables]
}

const defaultTitle = (paths: Record<string, Record<string, Json>>): string => {
  const roots = [...new Set(Object.keys(paths).map((p) => p.split("/")[1]).filter((s): s is string => s !== undefined && s.length > 0 && !s.startsWith("{")))]
  return roots.length === 0 ? "api-typescript" : `${roots.slice(0, 2).join("-")}-api`
}

const failure = (message: string, suggestions: ReadonlyArray<string>): TypeScriptResult => ({
  ok: false,
  error: { stage: "ingestion", message, suggestions },
})
