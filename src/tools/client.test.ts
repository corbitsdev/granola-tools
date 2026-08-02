import { describe, expect, test } from "bun:test";
import { GranolaClient } from "./client.js";

describe("GranolaClient", () => {
  test("defaults baseUrl when not given", () => {
    const client = new GranolaClient({ apiKey: "test-key" });
    expect(client.baseUrl).toBe("https://api.granola.ai");
  });

  test("honors an explicit baseUrl", () => {
    const client = new GranolaClient({ apiKey: "test-key", baseUrl: "https://example.test" });
    expect(client.baseUrl).toBe("https://example.test");
  });
});
