import type { CarrierAdapter, CarrierCode, CarrierRegistry } from "./types";

/**
 * Реєстр адаптерів перевізників.
 * Кидає помилку при дублікаті коду. getDefault() — адаптер з defaultCode або undefined.
 */
export function createCarrierRegistry(adapters: CarrierAdapter[], defaultCode?: string): CarrierRegistry {
  const byCode = new Map<CarrierCode, CarrierAdapter>();
  for (const adapter of adapters) {
    if (byCode.has(adapter.code)) throw new Error(`Duplicate carrier adapter code: ${adapter.code}`);
    byCode.set(adapter.code, adapter);
  }
  const ordered = [...byCode.values()];

  return {
    get: (code) => byCode.get(code),
    list: () => [...ordered],
    getDefault: () => (defaultCode === undefined ? undefined : byCode.get(defaultCode)),
  };
}
