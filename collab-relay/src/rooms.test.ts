import { describe, expect, test } from "bun:test";
import type { WebSocket } from "ws";
import { Rooms } from "./rooms";

function makeRooms(): Rooms {
  return new Rooms({ maxClients: 1 });
}

function openWs(): WebSocket {
  // ws 库把 OPEN=1 同时暴露在类与实例上,代码按 ws.readyState === ws.OPEN 判活
  return { readyState: 1, OPEN: 1, send: () => {} } as WebSocket;
}

describe("joinHost", () => {
  test("host 在线且房间空 → 配对成功,双向 peerOf", () => {
    const rooms = makeRooms();
    const hostWs = openWs();
    rooms.registerHost({ ws: hostWs, deviceId: "host1", role: "host" });
    const clientWs = openWs();
    const res = rooms.joinHost("host1", {
      ws: clientWs,
      deviceId: "c1",
      role: "client",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.host.ws).toBe(hostWs);
    expect(rooms.peerOf(clientWs)).toBe(hostWs);
    expect(rooms.peerOf(hostWs)).toBe(clientWs);
  });

  test("host 离线 → host-unavailable(暂态,客户端应重试)", () => {
    const rooms = makeRooms();
    const res = rooms.joinHost("ghost", {
      ws: openWs(),
      deviceId: "c1",
      role: "client",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("host-unavailable");
  });

  test("房间被占用 → in-use", () => {
    const rooms = makeRooms();
    const hostWs = openWs();
    rooms.registerHost({ ws: hostWs, deviceId: "host1", role: "host" });
    const first = rooms.joinHost("host1", {
      ws: openWs(),
      deviceId: "c1",
      role: "client",
    });
    expect(first.ok).toBe(true);
    const res = rooms.joinHost("host1", {
      ws: openWs(),
      deviceId: "c2",
      role: "client",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("in-use");
  });

  test("client 断线后房间释放,新 client 可加入", () => {
    const rooms = makeRooms();
    const hostWs = openWs();
    rooms.registerHost({ ws: hostWs, deviceId: "host1", role: "host" });
    const clientWs = openWs();
    rooms.joinHost("host1", { ws: clientWs, deviceId: "c1", role: "client" });
    // 旧 client 断线 → host 收到 peer-disconnected,房间置空
    const sent: string[] = [];
    hostWs.send = (d) => {
      sent.push(String(d));
    };
    rooms.drop(clientWs, "peer-close");
    expect(sent).toContain(
      JSON.stringify({ v: 1, type: "peer-disconnected", reason: "peer-close" }),
    );
    const res = rooms.joinHost("host1", {
      ws: openWs(),
      deviceId: "c2",
      role: "client",
    });
    expect(res.ok).toBe(true);
  });

  test("host 断线后 client 收到 peer-disconnected;host 重连 → 自动恢复配对", () => {
    const rooms = makeRooms();
    const hostWs = openWs();
    rooms.registerHost({ ws: hostWs, deviceId: "host1", role: "host" });
    const clientWs = openWs();
    rooms.joinHost("host1", { ws: clientWs, deviceId: "c1", role: "client" });
    const seen: string[] = [];
    clientWs.send = (d) => {
      seen.push(String(d));
    };
    rooms.drop(hostWs, "timeout");
    expect(seen).toContain(
      JSON.stringify({ v: 1, type: "peer-disconnected", reason: "timeout" }),
    );
    // host 重连:client 仍在等待 → registerHost 主动重配对
    const host2 = openWs();
    rooms.registerHost({ ws: host2, deviceId: "host1", role: "host" });
    expect(rooms.peerOf(clientWs)).toBe(host2);
    expect(rooms.peerOf(host2)).toBe(clientWs);
  });
});

describe("snapshot/restore", () => {
  test("房间占用状态跨重启保留(hasClient→null 占位)", () => {
    const rooms = makeRooms();
    const hostWs = openWs();
    rooms.registerHost({ ws: hostWs, deviceId: "host1", role: "host" });
    rooms.joinHost("host1", { ws: openWs(), deviceId: "c1", role: "client" });
    const snap = rooms.snapshot();
    expect(snap.rooms).toEqual([{ deviceId: "host1", hasClient: true }]);

    const rooms2 = makeRooms();
    rooms2.restore(snap);
    // 房间保留占位(null):host 不在线时 client 拨号仍判 host-unavailable
    const res = rooms2.joinHost("host1", {
      ws: openWs(),
      deviceId: "c2",
      role: "client",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("host-unavailable");
  });
});
