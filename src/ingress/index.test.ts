import { describe, expect, test } from "bun:test";
import { verifyGranolaSignature } from "./index.js";

describe("verifyGranolaSignature", () => {
  test("is not implemented yet", () => {
    expect(() => verifyGranolaSignature("payload", "sig", "secret")).toThrow("not implemented");
  });
});
