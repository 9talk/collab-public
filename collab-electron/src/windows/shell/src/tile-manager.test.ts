/**
 * renameTile / applyTileTitle 语义测试。
 *
 * 同步链路的关键不变量：本地用户提交（renameTile）触发 onTileTitleCommitted
 * 上报；对端应用的静默路径（applyTileTitle）不触发回调 —— 否则镜像应用会
 * 回推形成回声。renameTile/applyTileTitle 均需经 updateTileTitle 更新 DOM
 * 并经 saveCanvasImmediate 落存档（含 userTitle）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createTileManager } from "./tile-manager.js";
import { getTile, removeTile } from "./canvas-state.js";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

type Manager = ReturnType<typeof createTileManager>;
type SavedState = { tiles: Array<{ id: string; userTitle?: string }> };

let commitCalls: unknown[] = [];
let savedStates: SavedState[] = [];
let focusWindowCalls: number[] = [];
let prevShellApi: unknown;

function makeManager(): Manager {
  // tileLayer 须挂进文档树：detached 元素的 focus() 不产生聚焦
  // （happy-dom 与浏览器一致），blur 语义测试依赖真实焦点翻转。
  const tileLayer = document.createElement("div");
  document.body.appendChild(tileLayer);
  return createTileManager(
    /** @type {any} */ {
      tileLayer,
      viewportState: { panX: 0, panY: 0, zoom: 1 },
      configs: {},
      getAllWebviews: () => [],
      isSpaceHeld: () => false,
      onSaveDebounced: () => {},
      onSaveImmediate: (state: SavedState) => {
        savedStates.push(state);
      },
      onTileTitleCommitted: (tile: unknown) => {
        commitCalls.push(tile);
      },
    },
  );
}

function makeTile(manager: Manager, id: string) {
  return manager.createCanvasTile("term", 0, 0, {
    id,
    cwd: "/tmp/proj",
  });
}

function titleTextOf(manager: Manager, id: string): string {
  return manager.getTileDOMs().get(id)?.titleText.textContent ?? "";
}

beforeEach(() => {
  commitCalls = [];
  savedStates = [];
  focusWindowCalls = [];
  prevShellApi = /** @type {any} */ window.shellApi;
  /** @type {any} */ window.shellApi = {
    trackEvent: () => {},
    focusWindow: () => focusWindowCalls.push(performance.now()),
  };
});

// 测试进程内 window 全局共享，stub 必须还原，避免污染其他测试文件。
afterEach(() => {
  if (prevShellApi === undefined) {
    delete (/** @type {any} */ window.shellApi);
  } else {
    /** @type {any} */ window.shellApi = prevShellApi;
  }
});

describe("applyTileTitle (静默应用)", () => {
  test("sets userTitle, updates DOM and saves — without commit callback", () => {
    const manager = makeManager();
    const tile = makeTile(manager, "t-quiet-set");
    manager.applyTileTitle("t-quiet-set", "My Name");

    expect(tile.userTitle).toBe("My Name");
    expect(commitCalls).toEqual([]);
    expect(titleTextOf(manager, "t-quiet-set")).toBe("My Name");
    expect(savedStates.at(-1)?.tiles[0]?.userTitle).toBe("My Name");
    removeTile("t-quiet-set");
  });

  test("empty string deletes userTitle and falls back to cwd label", () => {
    const manager = makeManager();
    const tile = makeTile(manager, "t-quiet-reset");
    manager.applyTileTitle("t-quiet-reset", "Temp");
    manager.applyTileTitle("t-quiet-reset", "");

    expect(tile.userTitle).toBeUndefined();
    expect(commitCalls).toEqual([]);
    expect(titleTextOf(manager, "t-quiet-reset")).toBe("/tmp/proj");
    expect(savedStates.at(-1)?.tiles[0]?.userTitle).toBeUndefined();
    removeTile("t-quiet-reset");
  });
});

describe("renameTile (用户提交)", () => {
  test("reports commit once with the updated tile", () => {
    const manager = makeManager();
    const tile = makeTile(manager, "t-rename-set");
    manager.renameTile("t-rename-set", "Server A");

    expect(tile.userTitle).toBe("Server A");
    expect(commitCalls).toEqual([tile]);
    expect((commitCalls[0] as { userTitle?: string }).userTitle).toBe(
      "Server A",
    );
    expect(savedStates.at(-1)?.tiles[0]?.userTitle).toBe("Server A");
    removeTile("t-rename-set");
  });

  test("empty string reset also reports commit", () => {
    const manager = makeManager();
    const tile = makeTile(manager, "t-rename-reset");
    manager.applyTileTitle("t-rename-reset", "Temp");
    manager.renameTile("t-rename-reset", "");

    expect(tile.userTitle).toBeUndefined();
    expect(commitCalls).toEqual([tile]);
    removeTile("t-rename-reset");
  });

  test("unknown tile id is a no-op", () => {
    const manager = makeManager();
    manager.renameTile("t-missing", "X");
    expect(commitCalls).toEqual([]);
    expect(getTile("t-missing")).toBeNull();
  });
});

// -- beginRename（标题栏菜单 / 终端右键菜单共用的交互触发入口） --

describe("beginRename (内联输入触发)", () => {
  function renameInputOf(
    manager: Manager,
    id: string,
  ): HTMLInputElement | null {
    const dom = manager.getTileDOMs().get(id);
    return dom?.titleBar.querySelector(".tile-rename-input") ?? null;
  }

  test("opens inline input; Enter commits through renameTile (reports)", () => {
    const manager = makeManager();
    const tile = makeTile(manager, "t-begin-commit");
    manager.beginRename("t-begin-commit");

    const input = renameInputOf(manager, "t-begin-commit");
    expect(input).not.toBeNull();
    input!.value = "From Menu";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(tile.userTitle).toBe("From Menu");
    expect(commitCalls).toEqual([tile]);
    expect(titleTextOf(manager, "t-begin-commit")).toBe("From Menu");
    expect(renameInputOf(manager, "t-begin-commit")).toBeNull();
    removeTile("t-begin-commit");
  });

  test("Escape cancels without applying or reporting", () => {
    const manager = makeManager();
    const tile = makeTile(manager, "t-begin-cancel");
    manager.beginRename("t-begin-cancel");

    const input = renameInputOf(manager, "t-begin-cancel");
    expect(input).not.toBeNull();
    input!.value = "Discarded";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(tile.userTitle).toBeUndefined();
    expect(commitCalls).toEqual([]);
    expect(renameInputOf(manager, "t-begin-cancel")).toBeNull();
    removeTile("t-begin-cancel");
  });

  test("unknown tile id is a no-op", () => {
    const manager = makeManager();
    manager.beginRename("t-missing");
    expect(commitCalls).toEqual([]);
  });

  // -- blur 语义：blur→commit 只对「用户指针离开」生效；纯焦点翻转
  // （guest 抢焦/焦点委托）是干扰，应夺回焦点继续编辑而非闪关。 --

  test("干扰性 blur（无指针动作）→ 夺回焦点、不提交", () => {
    const manager = makeManager();
    makeTile(manager, "t-blur-grab");
    manager.beginRename("t-blur-grab");

    const input = renameInputOf(manager, "t-blur-grab")!;
    expect(input).not.toBeNull();
    input.value = "keep editing";

    input.blur(); // 模拟 guest 抢焦：input 无指针动作即失焦

    expect(commitCalls).toEqual([]);
    expect(renameInputOf(manager, "t-blur-grab")).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(focusWindowCalls.length).toBeGreaterThan(0);
    removeTile("t-blur-grab");
  });

  test("指针点击输入框以外后 blur → 提交", () => {
    const manager = makeManager();
    const tile = makeTile(manager, "t-blur-pointer");
    manager.beginRename("t-blur-pointer");

    const input = renameInputOf(manager, "t-blur-pointer")!;
    input.value = "Clicked Away";
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    input.blur();

    expect(tile.userTitle).toBe("Clicked Away");
    expect(commitCalls).toEqual([tile]);
    expect(renameInputOf(manager, "t-blur-pointer")).toBeNull();
    removeTile("t-blur-pointer");
  });

  test("点击输入框自身不算离开 → blur 仍夺回焦点", () => {
    const manager = makeManager();
    makeTile(manager, "t-blur-self");
    manager.beginRename("t-blur-self");

    const input = renameInputOf(manager, "t-blur-self")!;
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    input.blur();

    expect(commitCalls).toEqual([]);
    expect(renameInputOf(manager, "t-blur-self")).not.toBeNull();
    removeTile("t-blur-self");
  });

  test("连续干扰超过重试上限 → 停止夺焦、不提交、输入框保留", () => {
    const manager = makeManager();
    makeTile(manager, "t-blur-limit");
    manager.beginRename("t-blur-limit");
    const input = renameInputOf(manager, "t-blur-limit")!;
    const baseline = focusWindowCalls.length;

    for (let i = 0; i < 6; i++) input.blur();

    expect(commitCalls).toEqual([]);
    expect(renameInputOf(manager, "t-blur-limit")).not.toBeNull();
    // 初始 1 次 + 至多 3 次重试；无限重试会随干扰次数线性增长
    expect(focusWindowCalls.length - baseline).toBeLessThanOrEqual(4);
    removeTile("t-blur-limit");
  });
});
