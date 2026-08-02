// Granola API client. Skeleton only — no endpoints implemented yet.
//
// This module and everything else under src/tools/ must stay free of any
// hub, mounting, extension or webhook dependency: it is meant to be
// importable and grantable as a plain Interchange tool by any agent, on its
// own, with nothing hub-shaped attached.

export interface GranolaClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export class GranolaClient {
  constructor(private readonly options: GranolaClientOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl ?? "https://api.granola.ai";
  }
}
