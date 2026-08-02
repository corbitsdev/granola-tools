import { describe, expect, test } from "bun:test";
import type { GranolaBindingsPort } from "./bindings-port.js";

type FakeBinding = { folderId: string };

function fakePort(): {
  port: GranolaBindingsPort<FakeBinding>;
  saved: { tenantId: string; principalId: string; bindings: FakeBinding[] }[];
} {
  const saved: { tenantId: string; principalId: string; bindings: FakeBinding[] }[] = [];
  let stored: { bindings: FakeBinding[]; version: number } | undefined;

  const port: GranolaBindingsPort<FakeBinding> = {
    async load({ tenantId: _tenantId }) {
      return stored;
    },
    async save({ tenantId, principalId, bindings }) {
      saved.push({ tenantId, principalId, bindings });
      stored = { bindings, version: (stored?.version ?? 0) + 1 };
    },
  };

  return { port, saved };
}

describe("GranolaBindingsPort", () => {
  test("load returns undefined when nothing has ever been saved", async () => {
    const { port } = fakePort();
    expect(await port.load({ tenantId: "t1" })).toBeUndefined();
  });

  test("save then load round-trips the bindings and bumps the version", async () => {
    const { port, saved } = fakePort();
    const bindings: FakeBinding[] = [{ folderId: "fol_1" }];

    await port.save({ tenantId: "t1", principalId: "p1", bindings });
    const loaded = await port.load({ tenantId: "t1" });

    expect(loaded).toEqual({ bindings, version: 1 });
    expect(saved).toEqual([{ tenantId: "t1", principalId: "p1", bindings }]);
  });
});
