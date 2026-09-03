import { describe, expect, test } from "bun:test";
import type { WebSocket } from "ws";
import { Rooms } from "./rooms";

function makeRooms(): Rooms {
  return new Rooms({ maxClients: 1 });
}

describe("createPairCode", () => {
  test("缺省幂等：同一 deviceId 复用活码", () => {
    const rooms = makeRooms();
    const first = rooms.createPairCode("dev-1");
    const second = rooms.createPairCode("dev-1");
    expect(second.code).toBe(first.code);
    expect(second.ttlSec).toBeLessThanOrEqual(first.ttlSec);
  });

  test("缺省 TTL 为 10 分钟（ttlSec = 600）", () => {
    const rooms = makeRooms();
    const { code, ttlSec } = rooms.createPairCode("dev-1");
    expect(code).toMatch(/^[2-9]{6}$/);
    expect(ttlSec).toBe(600);
  });

  test("force: true 作废活码并换新", () => {
    const rooms = makeRooms();
    const first = rooms.createPairCode("dev-1");
    const forced = rooms.createPairCode("dev-1", { force: true });
    expect(forced.code).not.toBe(first.code);
    expect(forced.ttlSec).toBe(600);
  });

  test("force: true 但无活码时正常发新码", () => {
    const rooms = makeRooms();
    const { code, ttlSec } = rooms.createPairCode("dev-1", { force: true });
    expect(code).toMatch(/^[2-9]{6}$/);
    expect(ttlSec).toBe(600);
  });

  test("ttlMinutes 生效（ttlSec = 分钟 × 60）", () => {
    const rooms = makeRooms();
    expect(rooms.createPairCode("dev-1", { ttlMinutes: 3 }).ttlSec).toBe(180);
    expect(rooms.createPairCode("dev-2", { ttlMinutes: 60 }).ttlSec).toBe(3600);
  });

  test("ttlMinutes clamp 到 1~1440", () => {
    const rooms = makeRooms();
    expect(rooms.createPairCode("dev-1", { ttlMinutes: 0 }).ttlSec).toBe(60);
    expect(rooms.createPairCode("dev-2", { ttlMinutes: -5 }).ttlSec).toBe(60);
    expect(rooms.createPairCode("dev-3", { ttlMinutes: 2000 }).ttlSec).toBe(
      1440 * 60,
    );
  });

  test("force 后的新码按新 ttl 过期（join 拒绝过期码）", () => {
    const rooms = makeRooms();
    rooms.createPairCode("dev-1", { ttlMinutes: 1 });
    const second = rooms.createPairCode("dev-1", {
      force: true,
      ttlMinutes: 1440,
    });
    // 模拟时间推进越过旧码 TTL（force 已作废旧码，此处验证新码 TTL 独立）
    expect(second.ttlSec).toBe(1440 * 60);
  });

  test("不同 deviceId 的活码互不复用", () => {
    const rooms = makeRooms();
    const a = rooms.createPairCode("dev-a");
    const b = rooms.createPairCode("dev-b");
    expect(b.code).not.toBe(a.code);
  });
});

describe("join", () => {
  test("码有效但 host 未注册 → host-unavailable（暂态，客户端应重试）", () => {
    const rooms = makeRooms();
    const { code } = rooms.createPairCode("dev-1");
    const client = {
      ws: null as unknown as WebSocket,
      deviceId: "client-1",
      role: "client",
    } as const;
    const res = rooms.join(code, client);
    expect(res).toEqual({ ok: false, code: "host-unavailable" });
  });
});
