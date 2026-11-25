/** Значення для об'єднання CSS-класів: рядки, falsy-значення або мапа «клас → умова». */
export type ClassValue = string | number | false | null | undefined | Record<string, boolean | null | undefined>;

/** Об'єднує CSS-класи, пропускаючи порожні значення: cx("a", cond && "b", { c: true }) → "a b c". */
export function cx(...classes: ClassValue[]): string {
  const out: string[] = [];
  for (const value of classes) {
    if (value === null || value === undefined || value === false || value === "" || value === 0) continue;
    if (typeof value === "object") {
      for (const [name, enabled] of Object.entries(value)) if (enabled) out.push(name);
    } else {
      out.push(String(value));
    }
  }
  return out.join(" ");
}
