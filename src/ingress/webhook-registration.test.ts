import { describe, expect, test } from "bun:test";

import {
  ensureGranolaWebhook,
  reconcileGranolaWebhookFolders,
} from "./webhook-registration";
import type { GranolaBindingStore } from "./binding-store";
import type { GranolaBucket } from "../tools/types";

const BASE_URL = "https://api.granola.ai/v1";
const PUBLIC_URL = "https://hub.example.com";
const TARGET_URL = "https://hub.example.com/api/granola/webhook";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeBindingStore(folderIds: string[]): GranolaBindingStore {
  const bindings: GranolaBucket[] = folderIds.map((folderId) => ({
    folderId,
    type: "diligence",
    channel: "C_TEST",
  }));
  return {
    async list() {
      return bindings;
    },
    async replaceAll() {
      throw new Error("not exercised in this suite");
    },
  };
}

describe("ensureGranolaWebhook", () => {
  test("returns undefined immediately when no public URL is configured", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return jsonResponse({ webhook_endpoints: [] });
    }) as unknown as typeof fetch;

    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: undefined,
      bindingStore: fakeBindingStore(["fol_a"]),
      envSecret: undefined,
      fetchImpl,
    });

    expect(secret).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("falls back to envSecret when no public URL is configured but a static secret exists", async () => {
    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: undefined,
      bindingStore: fakeBindingStore(["fol_a"]),
      envSecret: "static-secret",
    });

    expect(secret).toBe("static-secret");
  });

  const ALL_EVENTS = [
    "note.generated",
    "note.regenerated",
    "note.edited",
    "note.access_granted",
  ];

  test("matching endpoint with env secret and same folder_ids/events reuses the secret without updating", async () => {
    let patchCalled = false;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const href = String(input);
      if (init?.method === "PATCH") {
        patchCalled = true;
        return jsonResponse({});
      }
      expect(href).toContain("/webhook-endpoints");
      return jsonResponse({
        webhook_endpoints: [
          {
            id: "whe_1",
            url: TARGET_URL,
            folder_ids: ["fol_a"],
            events: ALL_EVENTS,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      bindingStore: fakeBindingStore(["fol_a"]),
      envSecret: "existing-secret",
      fetchImpl,
    });

    expect(secret).toBe("existing-secret");
    expect(patchCalled).toBe(false);
  });

  test("matching endpoint with env secret and drifted folder_ids updates then reuses the secret", async () => {
    let patchBody: unknown;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body));
        return jsonResponse({});
      }
      return jsonResponse({
        webhook_endpoints: [
          {
            id: "whe_1",
            url: TARGET_URL,
            folder_ids: ["fol_old"],
            events: ALL_EVENTS,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      bindingStore: fakeBindingStore(["fol_new"]),
      envSecret: "existing-secret",
      fetchImpl,
    });

    expect(secret).toBe("existing-secret");
    expect(patchBody).toEqual({ folder_ids: ["fol_new"] });
  });

  test("matching endpoint with env secret and drifted events updates the events list", async () => {
    let patchBody: unknown;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body));
        return jsonResponse({});
      }
      return jsonResponse({
        webhook_endpoints: [
          {
            id: "whe_1",
            url: TARGET_URL,
            folder_ids: ["fol_a"],
            events: ["note.generated"],
          },
        ],
      });
    }) as unknown as typeof fetch;

    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      bindingStore: fakeBindingStore(["fol_a"]),
      envSecret: "existing-secret",
      fetchImpl,
    });

    expect(secret).toBe("existing-secret");
    expect(patchBody).toEqual({ events: ALL_EVENTS });
  });

  test("matching endpoint but no env secret does NOT delete/recreate — logs an error and returns undefined", async () => {
    let deleteCalled = false;
    let createCalled = false;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "DELETE") {
        deleteCalled = true;
        return jsonResponse({});
      }
      if (init?.method === "POST") {
        createCalled = true;
        return jsonResponse({
          id: "whe_2",
          url: TARGET_URL,
          folder_ids: ["fol_a"],
          signing_secret: "fresh-secret",
        });
      }
      return jsonResponse({
        webhook_endpoints: [
          { id: "whe_1", url: TARGET_URL, folder_ids: ["fol_a"] },
        ],
      });
    }) as unknown as typeof fetch;

    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      bindingStore: fakeBindingStore(["fol_a"]),
      envSecret: undefined,
      fetchImpl,
    });

    expect(secret).toBeUndefined();
    expect(deleteCalled).toBe(false);
    expect(createCalled).toBe(false);
  });

  test("a url_redacted endpoint with no exact match blocks creation and falls back to envSecret", async () => {
    let createCalled = false;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "POST") {
        createCalled = true;
        return jsonResponse({
          id: "whe_new",
          url: TARGET_URL,
          folder_ids: ["fol_a"],
          signing_secret: "brand-new-secret",
        });
      }
      return jsonResponse({
        webhook_endpoints: [
          {
            id: "whe_other",
            url: "redacted",
            url_redacted: true,
            folder_ids: ["fol_a"],
          },
        ],
      });
    }) as unknown as typeof fetch;

    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      bindingStore: fakeBindingStore(["fol_a"]),
      envSecret: "fallback-secret",
      fetchImpl,
    });

    expect(secret).toBe("fallback-secret");
    expect(createCalled).toBe(false);
  });

  test("a url_redacted endpoint with no exact match and no envSecret returns undefined without creating", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        webhook_endpoints: [
          {
            id: "whe_other",
            url: "redacted",
            url_redacted: true,
            folder_ids: [],
          },
        ],
      })) as unknown as typeof fetch;

    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      bindingStore: fakeBindingStore(["fol_a"]),
      envSecret: undefined,
      fetchImpl,
    });

    expect(secret).toBeUndefined();
  });

  test("passes an AbortSignal with a timeout on every request", async () => {
    let sawSignal = false;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.signal instanceof AbortSignal) sawSignal = true;
      return jsonResponse({ webhook_endpoints: [] });
    }) as unknown as typeof fetch;

    await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      bindingStore: fakeBindingStore(["fol_a"]),
      envSecret: "some-secret",
      fetchImpl,
    });

    expect(sawSignal).toBe(true);
  });

  test("tolerates a 204/empty-body response instead of throwing", async () => {
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "PATCH") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({
        webhook_endpoints: [
          {
            id: "whe_1",
            url: TARGET_URL,
            folder_ids: ["fol_old"],
            events: ALL_EVENTS,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      bindingStore: fakeBindingStore(["fol_new"]),
      envSecret: "existing-secret",
      fetchImpl,
    });

    expect(secret).toBe("existing-secret");
  });

  test("no matching endpoint creates one and returns the fresh secret", async () => {
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "POST") {
        return jsonResponse({
          id: "whe_new",
          url: TARGET_URL,
          folder_ids: ["fol_a"],
          signing_secret: "brand-new-secret",
        });
      }
      return jsonResponse({ webhook_endpoints: [] });
    }) as unknown as typeof fetch;

    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      bindingStore: fakeBindingStore(["fol_a"]),
      envSecret: "existing-secret-but-no-match",
      fetchImpl,
    });

    expect(secret).toBe("brand-new-secret");
  });

  test("falls back to envSecret when the Granola API call fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      bindingStore: fakeBindingStore(["fol_a"]),
      envSecret: "fallback-secret",
      fetchImpl,
    });

    expect(secret).toBe("fallback-secret");
  });

  test("returns undefined when the Granola API call fails and there is no envSecret", async () => {
    const fetchImpl = (async () =>
      jsonResponse({}, 500)) as unknown as typeof fetch;

    const secret = await ensureGranolaWebhook({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      bindingStore: fakeBindingStore(["fol_a"]),
      envSecret: undefined,
      fetchImpl,
    });

    expect(secret).toBeUndefined();
  });
});

describe("reconcileGranolaWebhookFolders", () => {
  test("updates folder_ids on the matching endpoint when they drift", async () => {
    let patchBody: unknown;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body));
        return jsonResponse({});
      }
      return jsonResponse({
        webhook_endpoints: [
          { id: "whe_1", url: TARGET_URL, folder_ids: ["fol_old"] },
        ],
      });
    }) as unknown as typeof fetch;

    await reconcileGranolaWebhookFolders({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      folderIds: ["fol_new"],
      fetchImpl,
    });

    expect(patchBody).toEqual({ folder_ids: ["fol_new"] });
  });

  test("does nothing when folder_ids already match", async () => {
    let patchCalled = false;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "PATCH") {
        patchCalled = true;
        return jsonResponse({});
      }
      return jsonResponse({
        webhook_endpoints: [
          { id: "whe_1", url: TARGET_URL, folder_ids: ["fol_a"] },
        ],
      });
    }) as unknown as typeof fetch;

    await reconcileGranolaWebhookFolders({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      folderIds: ["fol_a"],
      fetchImpl,
    });

    expect(patchCalled).toBe(false);
  });

  test("no matching endpoint does not throw and does not create one", async () => {
    let createCalled = false;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "POST") createCalled = true;
      return jsonResponse({ webhook_endpoints: [] });
    }) as unknown as typeof fetch;

    await reconcileGranolaWebhookFolders({
      apiKey: "key",
      baseUrl: BASE_URL,
      publicUrl: PUBLIC_URL,
      folderIds: ["fol_a"],
      fetchImpl,
    });

    expect(createCalled).toBe(false);
  });

  test("an API failure is caught and logged, never thrown", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(
      reconcileGranolaWebhookFolders({
        apiKey: "key",
        baseUrl: BASE_URL,
        publicUrl: PUBLIC_URL,
        folderIds: ["fol_a"],
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });
});
