import { describe, expect, test } from "bun:test";

import { createGranolaClient, GranolaApiError, transcriptText } from "./client";

describe("createGranolaClient", () => {
  test("fetches a note with transcript by id", async () => {
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const href = String(input);
      expect(href).toContain("/notes/not_abc12345678901");
      expect(href).toContain("include=transcript");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
      return new Response(
        JSON.stringify({
          id: "not_abc12345678901",
          title: "Diligence call",
          // Real live shape: object speakers with source/attribution and
          // segment timestamps; a legacy string speaker stays accepted.
          transcript: [
            {
              speaker: { source: "microphone", attribution: "Alice" },
              text: "Let's start.",
              start_time: "2026-08-01T14:40:50.831Z",
              end_time: "2026-08-01T14:41:04.431Z",
            },
            { speaker: { source: "system" }, text: "Sounds good." },
            { speaker: "Bob", text: "Wrapping up." },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = createGranolaClient({ apiKey: "test-key", fetchImpl });
    const note = await client.getNote("not_abc12345678901", {
      includeTranscript: true,
    });

    expect(note.id).toBe("not_abc12345678901");
    expect(transcriptText(note)).toBe(
      "Alice: Let's start.\nsystem: Sounds good.\nBob: Wrapping up.",
    );
  });

  test("lists notes in a folder", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const href = String(input);
      expect(href).toContain("/notes?");
      expect(href).toContain("folder_id=fol_abc12345678901");
      expect(href).toContain("page_size=30");
      return new Response(
        JSON.stringify({
          notes: [{ id: "not_abc12345678901", title: "Call 1" }],
          hasMore: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = createGranolaClient({ apiKey: "test-key", fetchImpl });
    const result = await client.listNotes({ folderId: "fol_abc12345678901" });

    expect(result.hasMore).toBe(false);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]?.id).toBe("not_abc12345678901");
  });

  test("lists folders, paginated, mapping the API's real shape (name, not title)", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const href = String(input);
      const url = new URL(href);
      expect(href).toContain("/folders?");
      const pageSize = Number(url.searchParams.get("page_size"));
      expect(pageSize).toBeLessThanOrEqual(30);
      // Real Granola response shape: `folders[].name` (not `title`), and a
      // `cursor` field present as `null` (not absent) when there's no more.
      return new Response(
        JSON.stringify({
          folders: [
            {
              object: "folder",
              id: "fol_abc12345678901",
              name: "Scout: Diligence #dd-acme",
              parent_folder_id: null,
              space_id: "spa_abc12345678901",
            },
            { object: "folder", id: "fol_def12345678901", name: "Unrelated notes" },
          ],
          hasMore: false,
          cursor: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = createGranolaClient({ apiKey: "test-key", fetchImpl });
    const result = await client.listFolders();

    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeUndefined();
    expect(result.folders).toHaveLength(2);
    expect(result.folders[0]?.id).toBe("fol_abc12345678901");
    expect(result.folders[0]?.title).toBe("Scout: Diligence #dd-acme");
  });

  test("terminates listFolders pagination on a null cursor", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ folders: [], hasMore: false, cursor: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const client = createGranolaClient({ apiKey: "test-key", fetchImpl });
    const result = await client.listFolders();

    expect(result.cursor).toBeUndefined();
    expect(result.hasMore).toBe(false);
  });

  test("keeps a string cursor for continued pagination", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ folders: [], hasMore: true, cursor: "next-page" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const client = createGranolaClient({ apiKey: "test-key", fetchImpl });
    const result = await client.listFolders();

    expect(result.cursor).toBe("next-page");
    expect(result.hasMore).toBe(true);
  });

  test("surfaces non-2xx responses as a typed error carrying status and body", async () => {
    const fetchImpl = (async () =>
      new Response("unauthorized", {
        status: 401,
        statusText: "Unauthorized",
      })) as unknown as typeof fetch;

    const client = createGranolaClient({ apiKey: "bad-key", fetchImpl });

    await expect(client.getNote("not_abc12345678901")).rejects.toThrow(
      GranolaApiError,
    );
    try {
      await client.getNote("not_abc12345678901");
      throw new Error("expected getNote to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GranolaApiError);
      const apiErr = err as GranolaApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.body).toBe("unauthorized");
    }
  });

  test("rejects a malformed response shape", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ notTheRightShape: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const client = createGranolaClient({ apiKey: "test-key", fetchImpl });
    await expect(client.getNote("not_abc12345678901")).rejects.toThrow(
      /malformed/,
    );
  });

  test("transcriptText returns empty string when no transcript is present", () => {
    expect(
      transcriptText({
        id: "not_abc12345678901",
        title: "No transcript",
      }),
    ).toBe("");
  });
});
