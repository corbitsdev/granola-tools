import { describe, expect, test } from "bun:test";

import { GranolaApiError, type GranolaClient, type GranolaNote } from "../tools/client.js";
import type { GranolaBucket } from "../tools/types.js";
import type { GranolaBindingStore, GranolaWebhookPayload } from "../ingress/index.js";
import { createGranolaIngest, type GranolaTranscriptStore } from "./pipeline.js";
import type { GranolaIngestLifecycle } from "./lifecycle.js";
import type { GranolaThreadAnchor } from "./bucket-handler.js";

const BUCKETS: GranolaBucket[] = [
  { folderId: "fol_diligence", type: "diligence", channel: "C_DILIGENCE" },
  { folderId: "fol_internal", type: "internal", channel: "C_INTERNAL" },
];

function samplePayload(
  overrides: Partial<GranolaWebhookPayload> = {},
): GranolaWebhookPayload {
  return {
    event_id: "evt_1",
    event_type: "note.generated",
    note_id: "note_1",
    occurred_at: "2026-07-31T00:00:00Z",
    ...overrides,
  };
}

function noteWith(overrides: Partial<GranolaNote> = {}): GranolaNote {
  return {
    id: "note_1",
    title: "Weekly sync",
    folder_membership: { folderId: "fol_diligence" },
    transcript: [
      { speaker: { source: "microphone", attribution: "Alice" }, text: "Hello." },
    ],
    ...overrides,
  };
}

function fakeClient(notesByCall: GranolaNote[]): GranolaClient {
  let index = 0;
  return {
    async getNote() {
      const note = notesByCall[Math.min(index, notesByCall.length - 1)];
      index += 1;
      if (note === undefined) throw new Error("no note configured for this call");
      return note;
    },
    async listNotes() {
      throw new Error("not exercised in this suite");
    },
    async listFolders() {
      throw new Error("not exercised in this suite");
    },
  };
}

function failingClient(error: Error): GranolaClient {
  return {
    async getNote() {
      throw error;
    },
    async listNotes() {
      throw new Error("not exercised in this suite");
    },
    async listFolders() {
      throw new Error("not exercised in this suite");
    },
  };
}

function fakeBindingStore(buckets: GranolaBucket[] = BUCKETS): GranolaBindingStore {
  return {
    async list() {
      return buckets;
    },
    async replaceAll() {
      throw new Error("not exercised in this suite");
    },
  };
}

type TestRef = { artifactId: string };

function fakeTranscripts(existingNoteIds: string[] = []): {
  transcripts: GranolaTranscriptStore<TestRef>;
  persisted: { granolaNoteId: string; text: string; bucketType: string }[];
} {
  const persisted: { granolaNoteId: string; text: string; bucketType: string }[] = [];
  const existing = new Set(existingNoteIds);
  return {
    persisted,
    transcripts: {
      async hasTranscript(granolaNoteId) {
        return existing.has(granolaNoteId);
      },
      async persist(args) {
        persisted.push({
          granolaNoteId: args.granolaNoteId,
          text: args.text,
          bucketType: args.bucketType,
        });
        return { artifactId: `art_${args.granolaNoteId}` };
      },
    },
  };
}

type LifecycleEvent = { hook: string; args: unknown };

function recordingLifecycle(): {
  lifecycle: GranolaIngestLifecycle<GranolaThreadAnchor>;
  events: LifecycleEvent[];
} {
  const events: LifecycleEvent[] = [];
  const record =
    (hook: string) =>
    async (args: unknown): Promise<void> => {
      events.push({ hook, args });
    };
  return {
    events,
    lifecycle: {
      onDuplicateEvent: record("onDuplicateEvent"),
      onFetchFailed: record("onFetchFailed"),
      onNoteNotGenerated: record("onNoteNotGenerated"),
      onAlreadyProcessed: record("onAlreadyProcessed"),
      async onProcessingStarted(args) {
        events.push({ hook: "onProcessingStarted", args });
        return { channel: args.bucketChannel, ts: "1700000000.000100" };
      },
      onNoteNotReady: record("onNoteNotReady"),
      onTranscriptReady: record("onTranscriptReady"),
      onPersistFailed: record("onPersistFailed"),
      onHandlerDispatching: record("onHandlerDispatching"),
      onHandlerFailed: record("onHandlerFailed"),
    },
  };
}

function hooks(events: LifecycleEvent[]): string[] {
  return events.map((event) => event.hook);
}

describe("createGranolaIngest", () => {
  test("a ready note persists, captures knowledge, and dispatches to its bucket handler", async () => {
    const { transcripts, persisted } = fakeTranscripts();
    const { lifecycle, events } = recordingLifecycle();
    const captured: { artifactId: string; title: string }[] = [];
    const handled: string[] = [];

    const onEvent = createGranolaIngest<GranolaThreadAnchor, TestRef>({
      client: fakeClient([noteWith()]),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async ({ artifactRef, noteTitle }) => {
        captured.push({ artifactId: artifactRef.artifactId, title: noteTitle });
      },
      lifecycle,
      handlers: {
        diligence: async (context) => {
          handled.push(context.artifactRef.artifactId);
          expect(context.threadAnchor).toEqual({
            channel: "C_DILIGENCE",
            ts: "1700000000.000100",
          });
        },
      },
    });

    await onEvent(samplePayload());

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.bucketType).toBe("diligence");
    expect(persisted[0]?.text).toContain("Alice: Hello.");
    expect(captured).toEqual([{ artifactId: "art_note_1", title: "Weekly sync" }]);
    expect(handled).toEqual(["art_note_1"]);
    expect(hooks(events)).toEqual([
      "onProcessingStarted",
      "onTranscriptReady",
      "onHandlerDispatching",
    ]);
  });

  test("a summary-only note persists the summary markdown, never an empty artifact", async () => {
    const summary = "## Summary\nDiscussed the pilot.";
    const { transcripts, persisted } = fakeTranscripts();
    const { lifecycle } = recordingLifecycle();

    const onEvent = createGranolaIngest({
      client: fakeClient([
        noteWith({ transcript: undefined, summary_markdown: summary }),
      ]),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async () => {},
      lifecycle,
    });

    await onEvent(samplePayload());

    expect(persisted[0]?.text).toBe(summary);
  });

  test("a note with no bound folder is ignored without lifecycle noise", async () => {
    const { transcripts, persisted } = fakeTranscripts();
    const { lifecycle, events } = recordingLifecycle();

    const onEvent = createGranolaIngest({
      client: fakeClient([noteWith({ folder_membership: { folderId: "fol_unbound" } })]),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async () => {},
      lifecycle,
    });

    await onEvent(samplePayload());

    expect(persisted).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test("a fetch failure reports onFetchFailed with every bound channel", async () => {
    const { transcripts, persisted } = fakeTranscripts();
    const { lifecycle, events } = recordingLifecycle();

    const onEvent = createGranolaIngest({
      client: failingClient(new Error("granola 500")),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async () => {},
      lifecycle,
    });

    await onEvent(samplePayload());

    expect(persisted).toHaveLength(0);
    expect(hooks(events)).toEqual(["onFetchFailed"]);
    expect(events[0]?.args).toEqual({
      noteId: "note_1",
      error: "granola 500",
      candidateChannels: ["C_DILIGENCE", "C_INTERNAL"],
    });
  });

  test("a 404 on note.access_granted reports onNoteNotGenerated instead of onFetchFailed", async () => {
    const { transcripts } = fakeTranscripts();
    const { lifecycle, events } = recordingLifecycle();

    const onEvent = createGranolaIngest({
      client: failingClient(new GranolaApiError(404, "Not Found", "")),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async () => {},
      lifecycle,
    });

    await onEvent(samplePayload({ event_type: "note.access_granted" }));

    expect(hooks(events)).toEqual(["onNoteNotGenerated"]);
    expect(events[0]?.args).toEqual({
      noteId: "note_1",
      candidateChannels: ["C_DILIGENCE", "C_INTERNAL"],
    });
  });

  test("a 404 on note.generated stays on the onFetchFailed path", async () => {
    const { transcripts } = fakeTranscripts();
    const { lifecycle, events } = recordingLifecycle();

    const onEvent = createGranolaIngest({
      client: failingClient(new GranolaApiError(404, "Not Found", "")),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async () => {},
      lifecycle,
    });

    await onEvent(samplePayload({ event_type: "note.generated" }));

    expect(hooks(events)).toEqual(["onFetchFailed"]);
  });

  test("an already-persisted note gates on onAlreadyProcessed instead of reprocessing", async () => {
    const { transcripts, persisted } = fakeTranscripts(["note_1"]);
    const { lifecycle, events } = recordingLifecycle();

    const onEvent = createGranolaIngest({
      client: fakeClient([noteWith()]),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async () => {},
      lifecycle,
    });

    await onEvent(samplePayload());

    expect(persisted).toHaveLength(0);
    expect(hooks(events)).toEqual(["onAlreadyProcessed"]);
  });

  test("reprocess bypasses the already-processed gate", async () => {
    const { transcripts, persisted } = fakeTranscripts(["note_1"]);
    const { lifecycle } = recordingLifecycle();

    const onEvent = createGranolaIngest({
      client: fakeClient([noteWith()]),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async () => {},
      lifecycle,
    });

    await onEvent.reprocess("note_1");

    expect(persisted).toHaveLength(1);
  });

  test("reprocessPinned threads pinnedCompanies through to the handler context", async () => {
    const { transcripts } = fakeTranscripts();
    const { lifecycle } = recordingLifecycle();
    const pinned: (string[] | undefined)[] = [];

    const onEvent = createGranolaIngest({
      client: fakeClient([noteWith()]),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async () => {},
      lifecycle,
      handlers: {
        diligence: async (context) => {
          pinned.push(context.pinnedCompanies);
        },
      },
    });

    await onEvent.reprocessPinned("note_1", ["Acme", "Globex"]);

    expect(pinned).toEqual([["Acme", "Globex"]]);
  });

  test("a not-ready note schedules one retry and gives up after it", async () => {
    const notReady = noteWith({ transcript: undefined });
    const { transcripts, persisted } = fakeTranscripts();
    const { lifecycle, events } = recordingLifecycle();

    const onEvent = createGranolaIngest({
      client: fakeClient([notReady, notReady]),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async () => {},
      lifecycle,
      retryDelayMs: 5,
    });

    await onEvent(samplePayload());
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(persisted).toHaveLength(0);
    expect(hooks(events)).toEqual([
      "onProcessingStarted",
      "onNoteNotReady",
      "onNoteNotReady",
    ]);
    expect(events[2]?.args).toMatchObject({ isFinalAttempt: true });
  });

  test("a concurrent event for an in-flight note reports onDuplicateEvent", async () => {
    const { transcripts } = fakeTranscripts();
    const { lifecycle, events } = recordingLifecycle();
    let releaseHandler: () => void = () => {};
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const onEvent = createGranolaIngest({
      client: fakeClient([noteWith()]),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async () => {},
      lifecycle,
      handlers: {
        diligence: async () => {
          await handlerGate;
        },
      },
    });

    const first = onEvent(samplePayload());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await onEvent(samplePayload({ event_id: "evt_2", event_type: "note.edited" }));
    releaseHandler();
    await first;

    expect(hooks(events)).toContain("onDuplicateEvent");
  });

  test("a knowledge-capture failure does not block handler dispatch", async () => {
    const { transcripts } = fakeTranscripts();
    const { lifecycle, events } = recordingLifecycle();
    let dispatched = false;

    const onEvent = createGranolaIngest({
      client: fakeClient([noteWith()]),
      bindingStore: fakeBindingStore(),
      transcripts,
      captureKnowledge: async () => {
        throw new Error("embedding service down");
      },
      lifecycle,
      handlers: {
        diligence: async () => {
          dispatched = true;
        },
      },
    });

    await onEvent(samplePayload());

    expect(dispatched).toBe(true);
    expect(hooks(events)).toContain("onHandlerDispatching");
  });

  test("a persist failure reports onPersistFailed and stops", async () => {
    const { lifecycle, events } = recordingLifecycle();
    let dispatched = false;

    const onEvent = createGranolaIngest({
      client: fakeClient([noteWith()]),
      bindingStore: fakeBindingStore(),
      transcripts: {
        async hasTranscript() {
          return false;
        },
        async persist() {
          throw new Error("disk full");
        },
      },
      captureKnowledge: async () => {},
      lifecycle,
      handlers: {
        diligence: async () => {
          dispatched = true;
        },
      },
    });

    await onEvent(samplePayload());

    expect(dispatched).toBe(false);
    expect(hooks(events)).toEqual([
      "onProcessingStarted",
      "onTranscriptReady",
      "onPersistFailed",
    ]);
  });
});
