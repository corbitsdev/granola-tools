// Tool definitions an agent calls directly. Plain data + a handler — no hub,
// mounting, extension or webhook machinery. Implementations land later; this
// is the shape the tools will fill in.
import type { GranolaClient } from "./client.js";

export interface GranolaToolDefinition<Args = unknown, Result = unknown> {
  name: string;
  description: string;
  handler: (client: GranolaClient, args: Args) => Promise<Result>;
}

/** Fetch a single note by id. Placeholder — implementation lands separately. */
export const fetchNoteTool: GranolaToolDefinition<{ noteId: string }, unknown> = {
  name: "granola_fetch_note",
  description: "Fetch a Granola meeting note by id.",
  async handler(_client, _args) {
    throw new Error("not implemented");
  },
};

/** Search notes by query. Placeholder — implementation lands separately. */
export const searchNotesTool: GranolaToolDefinition<{ query: string }, unknown> = {
  name: "granola_search_notes",
  description: "Search Granola meeting notes.",
  async handler(_client, _args) {
    throw new Error("not implemented");
  },
};

// `never` erases each tool's specific Args here — callers dispatch on `name`,
// not on this array's element type.
export const GRANOLA_TOOL_DEFINITIONS: GranolaToolDefinition<never, unknown>[] = [
  fetchNoteTool,
  searchNotesTool,
];
