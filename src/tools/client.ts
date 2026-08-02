/**
 * Granola REST API client — fetch a note (with transcript) by id, and list
 * notes in a folder. Bearer-auth, plain fetch, arktype-validated responses.
 *
 * Docs: https://docs.granola.ai (OpenAPI at
 * https://docs.granola.ai/api-reference/openapi.json). Base URL defaults to
 * `https://public-api.granola.ai/v1`; override via `baseUrl` if the exact
 * base path differs from what these docs describe.
 *
 * Never sets a User-Agent header. This module and everything else under
 * src/tools/ must stay free of any hub, mounting, extension or webhook
 * dependency: it is meant to be importable and grantable as a plain
 * Interchange tool by any agent, on its own, with nothing hub-shaped
 * attached.
 */
import { type } from "arktype";

import { GranolaNote, type GranolaTranscriptSpeaker } from "./types.js";
export { GranolaNote };

/** Flattens a segment's speaker to a readable label for transcript lines. */
export function speakerLabel(speaker: GranolaTranscriptSpeaker): string {
  if (typeof speaker === "string") return speaker;
  return speaker.attribution ?? speaker.source ?? "Speaker";
}

const GranolaNoteSummary = type({
  id: "string",
  title: "string",
  "owner?": "unknown",
  "created_at?": "string",
  "updated_at?": "string",
  "folder_membership?": "unknown",
});

export type GranolaNoteSummary = typeof GranolaNoteSummary.infer;

const GranolaListNotesResponseRaw = type({
  notes: GranolaNoteSummary.array(),
  hasMore: "boolean",
  "cursor?": "string | null",
});

export type GranolaListNotesResponse = {
  notes: GranolaNoteSummary[];
  hasMore: boolean;
  cursor?: string;
};

/** Non-2xx response from the Granola API — carries the status and raw body text. */
export class GranolaApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, statusText: string, body: string) {
    super(`Granola API request failed: ${String(status)} ${statusText}`);
    this.name = "GranolaApiError";
    this.status = status;
    this.body = body;
  }
}

export type GetNoteOptions = {
  includeTranscript?: boolean;
};

export type ListNotesOptions = {
  folderId: string;
  cursor?: string;
  pageSize?: number;
};

// The live API returns `name`, not `title`, and no `parent_folder_id`/
// `space_id` this client cares about — tolerate them rather than reject.
const GranolaFolderRaw = type({
  id: "string",
  name: "string",
});

/** Public shape — `title` here (not the API's `name`) to match `GranolaNote`/`GranolaNoteSummary`'s field naming. */
export type GranolaFolder = {
  id: string;
  title: string;
};

const GranolaListFoldersResponseRaw = type({
  folders: GranolaFolderRaw.array(),
  hasMore: "boolean",
  "cursor?": "string | null",
});

export type GranolaListFoldersResponse = {
  folders: GranolaFolder[];
  hasMore: boolean;
  cursor?: string;
};

export type ListFoldersOptions = {
  cursor?: string;
  pageSize?: number;
};

export type GranolaClient = {
  getNote(noteId: string, options?: GetNoteOptions): Promise<GranolaNote>;
  listNotes(options: ListNotesOptions): Promise<GranolaListNotesResponse>;
  /** Docs: https://docs.granola.ai/api-reference/list-folders.md. Paginated like `listNotes`. */
  listFolders(
    options?: ListFoldersOptions,
  ): Promise<GranolaListFoldersResponse>;
};

export type CreateGranolaClientOptions = {
  apiKey: string;
  /** Defaults to `https://public-api.granola.ai/v1`. */
  baseUrl?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_BASE_URL = "https://public-api.granola.ai/v1";

// A hung Granola API call must never hold the ingestion pipeline's per-note
// in-flight guard open indefinitely — bound every request the same way the
// webhook-registration client does.
const REQUEST_TIMEOUT_MS = 30_000;

async function requestJSON(
  fetchImpl: typeof fetch,
  apiKey: string,
  url: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        // The Granola API (mirrored from workbench's proven client) expects
        // this even on GET; without it some routes answer with non-JSON.
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(
      `Granola API request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GranolaApiError(response.status, response.statusText, body);
  }

  const raw = await response.text();
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    // Surface what actually came back (truncated) — a bare "invalid JSON
    // body" is undebuggable from logs alone.
    const snippet = raw.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(
      `Granola API request failed: invalid JSON body (status ${String(response.status)}, body starts: ${JSON.stringify(snippet)})`,
      { cause },
    );
  }
}

/**
 * Flattens a note's transcript segments into `Speaker: text` lines, one per
 * segment, suitable for feeding a workflow. Returns an empty string when the
 * note has no transcript (e.g. fetched without `includeTranscript`).
 */
export function transcriptText(note: GranolaNote): string {
  if (note.transcript === undefined) return "";
  return note.transcript
    .map((segment) => `${speakerLabel(segment.speaker)}: ${segment.text}`)
    .join("\n");
}

export function createGranolaClient(
  options: CreateGranolaClientOptions,
): GranolaClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey;

  return {
    async getNote(noteId, getOptions = {}) {
      const url = new URL(`${baseUrl}/notes/${encodeURIComponent(noteId)}`);
      if (getOptions.includeTranscript === true) {
        url.searchParams.set("include", "transcript");
      }

      const raw = await requestJSON(fetchImpl, apiKey, url.toString());
      const validated = GranolaNote(raw);
      if (validated instanceof type.errors) {
        throw new Error(
          `Granola API response for note ${noteId} is malformed: ${validated.summary}`,
        );
      }
      return validated;
    },

    async listNotes(listOptions) {
      const url = new URL(`${baseUrl}/notes`);
      url.searchParams.set("folder_id", listOptions.folderId);
      url.searchParams.set("page_size", String(listOptions.pageSize ?? 30));
      if (listOptions.cursor !== undefined) {
        url.searchParams.set("cursor", listOptions.cursor);
      }

      const raw = await requestJSON(fetchImpl, apiKey, url.toString());
      const validated = GranolaListNotesResponseRaw(raw);
      if (validated instanceof type.errors) {
        throw new Error(
          `Granola API response for folder ${listOptions.folderId} is malformed: ${validated.summary}`,
        );
      }
      return {
        notes: validated.notes,
        hasMore: validated.hasMore,
        // A `null` cursor (the live API's "no more pages" spelling) means
        // the same as an absent one — normalize so callers only ever check
        // for `undefined`.
        ...(validated.cursor !== undefined &&
          validated.cursor !== null && { cursor: validated.cursor }),
      };
    },

    async listFolders(listOptions = {}) {
      const url = new URL(`${baseUrl}/folders`);
      url.searchParams.set("page_size", String(listOptions.pageSize ?? 30));
      if (listOptions.cursor !== undefined) {
        url.searchParams.set("cursor", listOptions.cursor);
      }

      const raw = await requestJSON(fetchImpl, apiKey, url.toString());
      const validated = GranolaListFoldersResponseRaw(raw);
      if (validated instanceof type.errors) {
        throw new Error(
          `Granola API response for folders is malformed: ${validated.summary}`,
        );
      }
      return {
        folders: validated.folders.map((folder) => ({
          id: folder.id,
          title: folder.name,
        })),
        hasMore: validated.hasMore,
        ...(validated.cursor !== undefined &&
          validated.cursor !== null && { cursor: validated.cursor }),
      };
    },
  };
}
