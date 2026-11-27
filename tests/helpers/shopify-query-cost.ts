/**
 * Консервативна оцінка ЗАПИТУВАНОЇ вартості документа GraphQL Admin API (тести; без мережі).
 *
 * shopify.dev, «GraphQL Admin API rate limits»:
 * - «A single query may not exceed a cost of 1,000 points, regardless of plan limits. This limit is enforced before a
 *   query is executed based on the query's requested cost.»
 * - «By default, a field's cost is based on what the field returns: Scalar 0, Enum 0, Object 1, Interface — Maximum of
 *   possible selections, Union — Maximum of possible selections, Connection — Sized by `first` and `last` arguments,
 *   Mutation 10.» Приклад документації: products(first: 1) { edges { node { title } } } = 3.
 *
 * Правила оцінки (завжди не менші за типові вартості документації):
 * - з'єднання (є nodes/edges) з first/last: 2 + розмір × max(1, вартість вмісту); УСЕ всередині множиться (і pageInfo);
 *   вузол nodes / edges.node — об'єкт (1 + поля); edges — прозора обгортка;
 * - список із розміром без nodes/edges (напр. fulfillments(first:), trackingInfo(first:)) або з аргументом-масивом
 *   (nodes(ids:) — розмір за кількістю id, quantities(names:) — за кількістю назв): 2 + розмір × (1 + поля елемента);
 * - інтерфейс/об'єднання: спільні поля + максимум серед фрагментів `... on Тип` (фрагменти одного типу додаються);
 * - мутація: 10 + вартість вибраних полів результату;
 * - аліаси не впливають (рахується поле), директиви (@idempotent тощо) пропускаються, коментарі `#…` ігноруються;
 * - змінні ($first, $ids…) підставляються з `variables` (або значення за замовчуванням); розмір зі змінною без значення —
 *   помилка: тест мусить передати фактичні розміри сторінок, з якими застосунок викликає запит.
 * Іменовані фрагменти (`...Name`) не підтримуються — помилка (у застосунку їх немає).
 */

type Value =
  | { kind: "var"; name: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: Value[] }
  | { kind: "object"; fields: Record<string, Value> };

interface FieldNode {
  kind: "field";
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selections: Selection[] | null;
}
interface InlineFragmentNode {
  kind: "fragment";
  typeCondition: string | null;
  selections: Selection[];
}
type Selection = FieldNode | InlineFragmentNode;

interface Operation {
  type: "query" | "mutation" | "subscription";
  name: string | null;
  defaults: Record<string, Value>;
  selections: Selection[];
}

type Token = { t: "punct"; v: string } | { t: "name"; v: string } | { t: "int" | "float"; v: string } | { t: "string"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "﻿" || c === "," || /\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++;
      continue;
    }
    if (src.startsWith("...", i)) {
      out.push({ t: "punct", v: "..." });
      i += 3;
      continue;
    }
    if ("!$&()=:@[]{}|".includes(c)) {
      out.push({ t: "punct", v: c });
      i++;
      continue;
    }
    if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      if (end < 0) throw new Error("unterminated block string");
      out.push({ t: "string", v: src.slice(i + 3, end) });
      i = end + 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") {
          value += src[j + 1] ?? "";
          j += 2;
        } else {
          value += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new Error("unterminated string");
      out.push({ t: "string", v: value });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: num[1] || num[2] ? "float" : "int", v: num[0] });
      i += num[0].length;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i));
    if (name) {
      out.push({ t: "name", v: name[0] });
      i += name[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return out;
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }
  private isPunct(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.t === "punct" && t.v === v;
  }
  private expectPunct(v: string): void {
    if (!this.isPunct(v)) throw new Error(`expected "${v}" at token ${this.i}, got ${JSON.stringify(this.peek())}`);
    this.i++;
  }
  private name(): string {
    const t = this.peek();
    if (t?.t !== "name") throw new Error(`expected a name at token ${this.i}, got ${JSON.stringify(t)}`);
    this.i++;
    return t.v;
  }

  document(): Operation {
    let op: Operation | null = null;
    while (this.peek()) {
      if (this.peek()?.t === "name" && this.peek()?.v === "fragment") throw new Error("named fragments are not supported");
      if (op) throw new Error("only one operation per document is supported");
      op = this.operation();
    }
    if (!op) throw new Error("empty document");
    return op;
  }

  private operation(): Operation {
    if (this.isPunct("{")) return { type: "query", name: null, defaults: {}, selections: this.selectionSet() };
    const type = this.name();
    if (type !== "query" && type !== "mutation" && type !== "subscription") throw new Error(`unknown operation type ${type}`);
    const name = this.peek()?.t === "name" ? this.name() : null;
    const defaults: Record<string, Value> = {};
    if (this.isPunct("(")) {
      this.i++;
      while (!this.isPunct(")")) {
        this.expectPunct("$");
        const variable = this.name();
        this.expectPunct(":");
        this.type();
        if (this.isPunct("=")) {
          this.i++;
          defaults[variable] = this.value();
        }
        this.directives();
      }
      this.i++;
    }
    this.directives();
    return { type, name, defaults, selections: this.selectionSet() };
  }

  private type(): void {
    if (this.isPunct("[")) {
      this.i++;
      this.type();
      this.expectPunct("]");
    } else {
      this.name();
    }
    if (this.isPunct("!")) this.i++;
  }

  private directives(): void {
    while (this.isPunct("@")) {
      this.i++;
      this.name();
      if (this.isPunct("(")) this.args();
    }
  }

  private args(): Record<string, Value> {
    const out: Record<string, Value> = {};
    this.expectPunct("(");
    while (!this.isPunct(")")) {
      const key = this.name();
      this.expectPunct(":");
      out[key] = this.value();
    }
    this.i++;
    return out;
  }

  private value(): Value {
    const t = this.peek();
    if (!t) throw new Error("unexpected end of document");
    if (t.t === "punct" && t.v === "$") {
      this.i++;
      return { kind: "var", name: this.name() };
    }
    if (t.t === "punct" && t.v === "[") {
      this.i++;
      const values: Value[] = [];
      while (!this.isPunct("]")) values.push(this.value());
      this.i++;
      return { kind: "list", values };
    }
    if (t.t === "punct" && t.v === "{") {
      this.i++;
      const fields: Record<string, Value> = {};
      while (!this.isPunct("}")) {
        const key = this.name();
        this.expectPunct(":");
        fields[key] = this.value();
      }
      this.i++;
      return { kind: "object", fields };
    }
    this.i++;
    if (t.t === "int") return { kind: "int", value: Number(t.v) };
    if (t.t === "float") return { kind: "float", value: Number(t.v) };
    if (t.t === "string") return { kind: "string", value: t.v };
    if (t.t === "name") {
      if (t.v === "true" || t.v === "false") return { kind: "boolean", value: t.v === "true" };
      if (t.v === "null") return { kind: "null" };
      return { kind: "enum", value: t.v };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }

  private selectionSet(): Selection[] {
    this.expectPunct("{");
    const out: Selection[] = [];
    while (!this.isPunct("}")) {
      if (this.isPunct("...")) {
        this.i++;
        let typeCondition: string | null = null;
        if (this.peek()?.t === "name") {
          if (this.peek()?.v !== "on") throw new Error("named fragment spreads are not supported");
          this.i++;
          typeCondition = this.name();
        }
        this.directives();
        out.push({ kind: "fragment", typeCondition, selections: this.selectionSet() });
        continue;
      }
      let name = this.name();
      let alias: string | null = null;
      if (this.isPunct(":")) {
        this.i++;
        alias = name;
        name = this.name();
      }
      const args = this.isPunct("(") ? this.args() : {};
      this.directives();
      const selections = this.isPunct("{") ? this.selectionSet() : null;
      out.push({ kind: "field", alias, name, args, selections });
    }
    this.i++;
    return out;
  }
}

/** Розбір документа (для тестів структури запитів). */
export function parseOperation(document: string): Operation {
  return new Parser(tokenize(document)).document();
}

/** Назва операції документа (`query OtOrder(...)` → "OtOrder"). */
export function operationName(document: string): string | null {
  return parseOperation(document).name;
}

function resolve(value: Value, variables: Record<string, unknown>, defaults: Record<string, Value>, path: string): unknown {
  switch (value.kind) {
    case "var": {
      if (Object.prototype.hasOwnProperty.call(variables, value.name)) return variables[value.name];
      const fallback = defaults[value.name];
      if (fallback) return resolve(fallback, variables, defaults, path);
      return undefined;
    }
    case "int":
    case "float":
      return value.value;
    case "string":
    case "enum":
      return value.value;
    case "boolean":
      return value.value;
    case "null":
      return null;
    case "list":
      return value.values.map((v) => resolve(v, variables, defaults, path));
    case "object":
      return Object.fromEntries(Object.entries(value.fields).map(([k, v]) => [k, resolve(v, variables, defaults, path)]));
  }
}

function sizeOf(field: FieldNode, variables: Record<string, unknown>, defaults: Record<string, Value>, path: string): number | undefined {
  for (const key of ["first", "last"] as const) {
    const arg = field.args[key];
    if (!arg) continue;
    const v = resolve(arg, variables, defaults, path);
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(`${path}: argument ${key} has no numeric value (${arg.kind === "var" ? `variable $${arg.name} not provided` : "literal"})`);
    }
    return v;
  }
  let size: number | undefined;
  for (const [key, arg] of Object.entries(field.args)) {
    const v = resolve(arg, variables, defaults, path);
    if (arg.kind === "var" && v === undefined && (key === "ids" || key === "names")) {
      throw new Error(`${path}: list argument ${key} ($${arg.name}) not provided`);
    }
    if (Array.isArray(v)) size = Math.max(size ?? 0, v.length);
  }
  return size;
}

function selectionCost(selections: Selection[], variables: Record<string, unknown>, defaults: Record<string, Value>, path: string): number {
  let common = 0;
  const byType = new Map<string, number>();
  for (const s of selections) {
    if (s.kind === "field") {
      common += fieldCost(s, variables, defaults, `${path}.${s.alias ?? s.name}`);
    } else if (s.typeCondition === null) {
      common += selectionCost(s.selections, variables, defaults, path);
    } else {
      byType.set(s.typeCondition, (byType.get(s.typeCondition) ?? 0) + selectionCost(s.selections, variables, defaults, `${path}<${s.typeCondition}>`));
    }
  }
  return common + Math.max(0, ...byType.values());
}

function fieldCost(field: FieldNode, variables: Record<string, unknown>, defaults: Record<string, Value>, path: string): number {
  // Скаляр, enum або список скалярів — 0 (вибору полів немає). Аргументи все одно перевіряються (змінні розміру).
  if (!field.selections) return 0;
  const children = field.selections;
  if (field.name === "edges") return selectionCost(children, variables, defaults, path);
  const size = sizeOf(field, variables, defaults, path);
  const inner = selectionCost(children, variables, defaults, path);
  if (size === undefined) return 1 + inner;
  const isConnection = children.some((c) => c.kind === "field" && (c.name === "nodes" || c.name === "edges") && sizeOf(c, variables, defaults, path) === undefined);
  // З'єднання: вміст уже містить вузол nodes / edges.node (1 + поля); простий список — елемент-об'єкт (1 + поля).
  const element = isConnection ? Math.max(1, inner) : 1 + inner;
  return 2 + size * element;
}

/**
 * Запитувана вартість документа (консервативно, див. правила вгорі). variables — фактичні значення, з якими застосунок
 * виконує запит (розміри сторінок, масиви id).
 */
export function requestedQueryCost(document: string, variables: Record<string, unknown> = {}): number {
  const op = parseOperation(document);
  const cost = selectionCost(op.selections, variables, op.defaults, op.name ?? "<anonymous>");
  return op.type === "mutation" ? 10 + cost : cost;
}

/** Ліміт одного запиту (shopify.dev: «A single query may not exceed a cost of 1,000 points»). */
export const SHOPIFY_SINGLE_QUERY_LIMIT = 1000;
/** Запас для тестів застосунку: оцінка кожного запиту не перевищує цього значення. */
export const QUERY_COST_BUDGET = 950;

type AdminLike = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

/**
 * Обгортка імітації Admin API для інтеграційних тестів: КОЖЕН виклик застосунку — з тими змінними, з якими його
 * насправді зроблено (розміри сторінок, курсори, масиви id) — оцінюється й не може перевищувати budget (інакше
 * виклик відхиляється помилкою, як Shopify відхилив би запит). costs — оцінки викликів (назва операції, бали).
 */
export function costCheckedAdmin<A extends AdminLike>(admin: A, budget = QUERY_COST_BUDGET): A & { costs: Array<{ operation: string | null; cost: number }> } {
  const costs: Array<{ operation: string | null; cost: number }> = [];
  const wrapped = (async (query: string, variables?: Record<string, unknown>) => {
    const cost = requestedQueryCost(query, variables ?? {});
    const operation = operationName(query);
    costs.push({ operation, cost });
    if (cost > budget) throw new Error(`${operation}: requested cost ${cost} exceeds the test budget ${budget}`);
    return admin(query, variables);
  }) as A & { costs: typeof costs };
  wrapped.costs = costs;
  return wrapped;
}
