import { describe, expect, test } from "bun:test";
import { createDisposableSlot, repaintAfterData } from "./renderer-lifecycle";

function fakeDisposable() {
  let disposed = 0;
  return {
    dispose: () => {
      disposed++;
    },
    disposedCount: () => disposed,
  };
}

type Fake = ReturnType<typeof fakeDisposable>;

describe("createDisposableSlot", () => {
  test("replace 装上实例并释放上一个", () => {
    const slot = createDisposableSlot<Fake>();
    const first = fakeDisposable();
    const second = fakeDisposable();

    expect(slot.replace(() => first)).toBe(first);
    expect(slot.replace(() => second)).toBe(second);

    expect(first.disposedCount()).toBe(1);
    expect(second.disposedCount()).toBe(0);
    expect(slot.current).toBe(second);
  });

  test("release 释放指定实例并清空槽位", () => {
    const slot = createDisposableSlot<Fake>();
    const only = fakeDisposable();
    slot.replace(() => only);

    slot.release(only);

    expect(only.disposedCount()).toBe(1);
    expect(slot.current).toBeNull();
  });

  test("release 迟到回调不误伤当前实例", () => {
    const slot = createDisposableSlot<Fake>();
    const stale = fakeDisposable();
    const active = fakeDisposable();
    slot.replace(() => stale);
    slot.replace(() => active);

    slot.release(stale);

    expect(active.disposedCount()).toBe(0);
    expect(slot.current).toBe(active);
  });

  test("clear 释放并清空槽位", () => {
    const slot = createDisposableSlot<Fake>();
    const only = fakeDisposable();
    slot.replace(() => only);

    slot.clear();

    expect(only.disposedCount()).toBe(1);
    expect(slot.current).toBeNull();
  });
});

describe("repaintAfterData", () => {
  test("主屏: 立即重绘全视口(不走 clearTextureAtlas)", () => {
    const calls: string[] = [];
    const term = {
      rows: 47,
      refresh: (start: number, end: number) =>
        calls.push(`refresh(${start},${end})`),
    };

    repaintAfterData(term, false, () => calls.push("deferred"));

    expect(calls).toEqual(["refresh(0,46)"]);
  });

  test("alt 屏: 交给空闲去抖补绘, 不在数据流现场重绘", () => {
    const calls: string[] = [];
    const term = {
      rows: 47,
      refresh: (start: number, end: number) =>
        calls.push(`refresh(${start},${end})`),
    };

    repaintAfterData(term, true, () => calls.push("deferred"));

    expect(calls).toEqual(["deferred"]);
  });
});
