import { describe, expect, test, mock } from "bun:test";

mock.module("electron", () => ({
  shell: { openExternal: async () => {} },
  systemPreferences: { isTrustedAccessibilityClient: () => true },
}));

const { classifyProbeError } = await import("./mac-permissions");

describe("mac-permissions probe error classification", () => {
  test("EPERM maps to denied (TCC refusal)", () => {
    const err = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });
    expect(classifyProbeError(err)).toBe("denied");
  });

  test("EACCES maps to denied", () => {
    const err = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    expect(classifyProbeError(err)).toBe("denied");
  });

  test("ENOENT maps to unknown (path absent, not a permission issue)", () => {
    const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
    expect(classifyProbeError(err)).toBe("unknown");
  });

  test("missing error code maps to unknown", () => {
    expect(classifyProbeError(new Error("boom"))).toBe("unknown");
  });
});
