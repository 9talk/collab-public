import { describe, expect, test } from "bun:test";
import { PtyFlowController } from "./pty-flow-control";

function setup(high = 10, low = 4) {
  const events: string[] = [];
  const flow = new PtyFlowController({
    highWatermark: high,
    lowWatermark: low,
    pause: (sessionId) => events.push(`pause:${sessionId}`),
    resume: (sessionId) => events.push(`resume:${sessionId}`),
  });
  return { flow, events };
}

describe("PtyFlowController", () => {
  test("未注册的 consumer 不计入水位线", () => {
    const { flow, events } = setup();
    flow.noteSent("s1", "local", 100);
    expect(events).toEqual([]);
  });

  test("超过高水位暂停，低于低水位恢复", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.noteSent("s1", "local", 10);
    expect(events).toEqual([]);
    flow.noteSent("s1", "local", 1);
    expect(events).toEqual(["pause:s1"]);
    flow.ack("s1", "local", 7);
    expect(events).toEqual(["pause:s1"]);
    flow.ack("s1", "local", 1);
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });

  test("多 consumer 取最大未确认数", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.attachConsumer("s1", "remote");
    flow.noteSent("s1", "remote", 11);
    flow.noteSent("s1", "local", 11);
    expect(events).toEqual(["pause:s1"]);
    flow.ack("s1", "local", 11);
    expect(events).toEqual(["pause:s1"]);
    flow.ack("s1", "remote", 8);
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });

  test("detach 最慢 consumer 后重新评估", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.attachConsumer("s1", "remote");
    flow.noteSent("s1", "remote", 11);
    expect(events).toEqual(["pause:s1"]);
    flow.detachConsumer("s1", "remote");
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });

  test("ack 钳制到 0，未知 consumer 忽略", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.noteSent("s1", "local", 11);
    flow.ack("s1", "local", 100);
    expect(events).toEqual(["pause:s1", "resume:s1"]);
    flow.ack("s1", "ghost", 100);
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });

  test("最后一个 consumer 移除时恢复", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.noteSent("s1", "local", 11);
    flow.detachConsumer("s1", "local");
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });

  test("clearSession 不触发 resume", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.noteSent("s1", "local", 11);
    flow.clearSession("s1");
    expect(events).toEqual(["pause:s1"]);
  });

  test("detachConsumerFromAllSessions 移除远程 consumer", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "remote");
    flow.attachConsumer("s2", "remote");
    flow.noteSent("s1", "remote", 11);
    flow.detachConsumerFromAllSessions("remote");
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });
});
