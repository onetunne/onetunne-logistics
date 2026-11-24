import { describe, expect, it } from "vitest";
import {
  MemorySandboxStore,
  NovaGlobalAdapter,
  TestCarrierAdapter,
  createCarrierRegistry,
} from "~/integrations/carriers";

function adapters() {
  const test = new TestCarrierAdapter({ store: new MemorySandboxStore(), getSimulation: () => "none" });
  const nova = new NovaGlobalAdapter();
  return { test, nova };
}

describe("createCarrierRegistry", () => {
  it("gets adapters by code and lists them in registration order", () => {
    const { test, nova } = adapters();
    const registry = createCarrierRegistry([test, nova], "test");
    expect(registry.get("test")).toBe(test);
    expect(registry.get("nova_global")).toBe(nova);
    expect(registry.get("dhl")).toBeUndefined();
    expect(registry.list()).toEqual([test, nova]);
  });

  it("list() returns a copy", () => {
    const { test } = adapters();
    const registry = createCarrierRegistry([test]);
    registry.list().pop();
    expect(registry.list()).toHaveLength(1);
  });

  it("getDefault returns the default adapter or undefined", () => {
    const { test, nova } = adapters();
    expect(createCarrierRegistry([test, nova], "nova_global").getDefault()).toBe(nova);
    expect(createCarrierRegistry([test, nova]).getDefault()).toBeUndefined();
    expect(createCarrierRegistry([test, nova], "unknown").getDefault()).toBeUndefined();
  });

  it("throws on duplicate codes", () => {
    const { test } = adapters();
    const another = new TestCarrierAdapter({ store: new MemorySandboxStore(), getSimulation: () => "none" });
    expect(() => createCarrierRegistry([test, another])).toThrow(/Duplicate carrier adapter code: test/);
  });

  it("works with an empty list", () => {
    const registry = createCarrierRegistry([], "test");
    expect(registry.list()).toEqual([]);
    expect(registry.getDefault()).toBeUndefined();
  });
});
