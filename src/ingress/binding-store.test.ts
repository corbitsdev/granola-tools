import { describe, expect, test } from "bun:test";

import { createGranolaBindingStore } from "./binding-store";
import type { GranolaBindingsPort } from "./bindings-port";
import type { GranolaBucket } from "../tools/types";

const TENANT = "tenant_1";
const PRINCIPAL = "principal_1";

const SEED_BUCKETS: GranolaBucket[] = [
  { folderId: "fol_seed", type: "diligence", channel: "C_SEED" },
];

type StoredBindings = { bindings: GranolaBucket[]; version: number };

function fakePort(initial?: StoredBindings): {
  port: GranolaBindingsPort<GranolaBucket>;
  saveCalls: { tenantId: string; principalId: string; bindings: GranolaBucket[] }[];
  loadCalls: { tenantId: string }[];
} {
  const saveCalls: { tenantId: string; principalId: string; bindings: GranolaBucket[] }[] = [];
  const loadCalls: { tenantId: string }[] = [];
  let stored = initial;

  const port: GranolaBindingsPort<GranolaBucket> = {
    async load(args) {
      loadCalls.push(args);
      return stored;
    },
    async save(args) {
      saveCalls.push(args);
      stored = { bindings: args.bindings, version: (stored?.version ?? 0) + 1 };
    },
  };

  return { port, saveCalls, loadCalls };
}

describe("createGranolaBindingStore", () => {
  test("falls back to seed bindings, without writing, when no artifact is persisted yet", async () => {
    const { port, saveCalls, loadCalls } = fakePort();
    const store = createGranolaBindingStore({
      port,
      tenantId: TENANT,
      principalId: PRINCIPAL,
      seedBindings: SEED_BUCKETS,
    });

    const bindings = await store.list();

    expect(bindings).toEqual(SEED_BUCKETS);
    expect(loadCalls).toHaveLength(1);
    expect(saveCalls).toHaveLength(0);
  });

  test("prefers a persisted artifact's bindings over the seed once one exists", async () => {
    const persistedBucket: GranolaBucket = {
      folderId: "fol_persisted",
      type: "internal",
      channel: "C_PERSISTED",
    };
    const { port } = fakePort({
      bindings: [persistedBucket],
      version: 1,
    });
    const store = createGranolaBindingStore({
      port,
      tenantId: TENANT,
      principalId: PRINCIPAL,
      seedBindings: SEED_BUCKETS,
    });

    const bindings = await store.list();

    expect(bindings).toEqual([persistedBucket]);
  });

  test("caches list() across calls, and only hits the port once", async () => {
    const { port, loadCalls } = fakePort();
    const store = createGranolaBindingStore({
      port,
      tenantId: TENANT,
      principalId: PRINCIPAL,
      seedBindings: SEED_BUCKETS,
    });

    await store.list();
    await store.list();
    await store.list();

    expect(loadCalls).toHaveLength(1);
  });

  test("replaceAll persists the new binding set and invalidates the cache so the next list() reflects it", async () => {
    const { port, saveCalls, loadCalls } = fakePort();
    const store = createGranolaBindingStore({
      port,
      tenantId: TENANT,
      principalId: PRINCIPAL,
      seedBindings: SEED_BUCKETS,
    });

    await store.list();
    expect(loadCalls).toHaveLength(1);

    const newBindings: GranolaBucket[] = [
      { folderId: "fol_new", type: "diligence", channel: "C_NEW" },
    ];
    await store.replaceAll(newBindings);

    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]?.bindings).toEqual(newBindings);

    const listed = await store.list();
    expect(listed).toEqual(newBindings);
    // Cache was invalidated by replaceAll, so this list() had to re-query.
    expect(loadCalls).toHaveLength(2);
  });

  test("replaceAll invokes the onChange hook with the new bindings", async () => {
    const { port } = fakePort();
    const onChangeCalls: GranolaBucket[][] = [];
    const store = createGranolaBindingStore({
      port,
      tenantId: TENANT,
      principalId: PRINCIPAL,
      seedBindings: SEED_BUCKETS,
      onChange: (bindings) => {
        onChangeCalls.push(bindings);
      },
    });

    const newBindings: GranolaBucket[] = [
      { folderId: "fol_new", type: "internal", channel: "C_NEW" },
    ];
    await store.replaceAll(newBindings);

    expect(onChangeCalls).toEqual([newBindings]);
  });
});
