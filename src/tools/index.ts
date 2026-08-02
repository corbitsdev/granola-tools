// @corbits/granola — Granola client and agent tools.
//
// Zero dependency on any hub, mounting, extension or webhook machinery: this
// entry point can be imported and its tools granted like any other
// Interchange tool, standalone, with nothing hub-shaped attached. The
// webhook extension lives at @corbits/granola/ingress and depends on this
// module — never the reverse. See ARCHITECTURE.md.
export { GranolaClient } from "./client.js";
export type { GranolaClientOptions } from "./client.js";

export { fetchNoteTool, searchNotesTool, GRANOLA_TOOL_DEFINITIONS } from "./tools.js";
export type { GranolaToolDefinition } from "./tools.js";
