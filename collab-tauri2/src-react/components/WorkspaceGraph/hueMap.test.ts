import { describe, test, expect } from "bun:test";
import { buildHueMap, hueToColor } from "./hueMap";

describe("buildHueMap", () => {
  test("assigns hues to files in different folders", () => {
    const map = buildHueMap(["src/a.ts", "lib/b.ts"]);
    expect(map.size).toBe(2);
    const hueA = map.get("src/a.ts")!;
    const hueB = map.get("lib/b.ts")!;
    // Different folders should get different hues
    expect(hueA).not.toBe(hueB);
  });

  test("assigns same hue to files in same folder", () => {
    const map = buildHueMap(["src/a.ts", "src/b.ts"]);
    expect(map.get("src/a.ts")).toBe(map.get("src/b.ts"));
  });

  test("handles root-level files", () => {
    const map = buildHueMap(["README.md", "src/index.ts"]);
    expect(map.has("README.md")).toBe(true);
    expect(map.has("src/index.ts")).toBe(true);
  });

  test("returns empty map for empty input", () => {
    const map = buildHueMap([]);
    expect(map.size).toBe(0);
  });

  test("distributes hues across 0-360 range", () => {
    const map = buildHueMap(["a/x.ts", "b/y.ts", "c/z.ts"]);
    const hues = [...map.values()];
    for (const h of hues) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(360);
    }
  });

  test("handles nested folders", () => {
    const map = buildHueMap([
      "src/components/Button.tsx",
      "src/utils/helpers.ts",
    ]);
    expect(map.size).toBe(2);
    // Both under src/ but in different subfolders
    expect(map.get("src/components/Button.tsx")).not.toBe(
      map.get("src/utils/helpers.ts"),
    );
  });
});

describe("hueToColor", () => {
  test("returns gray for negative hue (dark mode)", () => {
    expect(hueToColor(-1, true)).toBe("hsl(0, 0%, 60%)");
  });

  test("returns gray for negative hue (light mode)", () => {
    expect(hueToColor(-1, false)).toBe("hsl(0, 0%, 55%)");
  });

  test("returns HSL for valid hue (dark mode)", () => {
    expect(hueToColor(180, true)).toBe("hsl(180, 60%, 65%)");
  });

  test("returns HSL for valid hue (light mode)", () => {
    expect(hueToColor(180, false)).toBe("hsl(180, 70%, 45%)");
  });

  test("rounds hue to integer", () => {
    expect(hueToColor(179.7, false)).toBe("hsl(180, 70%, 45%)");
  });
});
