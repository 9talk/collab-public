import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "nav-store-test-"));
const stateFile = join(dataDir, "navigation-history.json");

// flavor 可在用例中途切换:remote 时 store 必须完全 no-op。
let remote = false;
mock.module("./paths", () => ({ COLLAB_DIR: dataDir }));
mock.module("./app-flavor", () => ({
  getAppFlavor: () => (remote ? "remote" : "full"),
  isRemoteFlavor: () => remote,
}));

const { loadHistory, saveHistory } = await import("./navigation-history-store");
const { pushToHistory, goBack, getSnapshot, resetHistory } =
  await import("./navigation-history");

beforeEach(() => {
  resetHistory();
  remote = false;
  rmSync(stateFile, { force: true });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("round-trip", () => {
  test("saveHistory persists stack, loadHistory restores it", async () => {
    pushToHistory("a");
    pushToHistory("b");
    pushToHistory("c");
    goBack(); // 当前位置 = b
    await saveHistory();

    resetHistory();
    await loadHistory();
    expect(getSnapshot()).toEqual({
      history: ["a", "b", "c"],
      currentIndex: 1,
    });
  });

  test("missing file keeps empty stack", async () => {
    await loadHistory();
    expect(getSnapshot()).toEqual({ history: [], currentIndex: -1 });
  });

  test("corrupt JSON is ignored", async () => {
    writeFileSync(stateFile, "{not json", "utf-8");
    await loadHistory();
    expect(getSnapshot()).toEqual({ history: [], currentIndex: -1 });
  });

  test("unknown version is ignored", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ version: 99, history: ["x"], currentIndex: 0 }),
      "utf-8",
    );
    await loadHistory();
    expect(getSnapshot()).toEqual({ history: [], currentIndex: -1 });
  });
});

describe("remote flavor", () => {
  test("saveHistory writes nothing", async () => {
    remote = true;
    pushToHistory("a");
    await saveHistory();
    expect(existsSync(stateFile)).toBe(false);
  });

  test("loadHistory restores nothing", async () => {
    pushToHistory("a");
    await saveHistory(); // Host 写入
    resetHistory();

    remote = true;
    await loadHistory();
    expect(getSnapshot()).toEqual({ history: [], currentIndex: -1 });
  });
});
