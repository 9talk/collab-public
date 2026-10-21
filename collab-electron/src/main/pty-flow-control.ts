/**
 * 每 consumer 未确认字符计数。以最慢 consumer 为准：
 * max(unacked) > high 暂停 PTY，max(unacked) < low 恢复。
 */

export interface PtyFlowControllerOptions {
  highWatermark?: number;
  lowWatermark?: number;
  pause: (sessionId: string) => void;
  resume: (sessionId: string) => void;
}

interface SessionFlowState {
  consumers: Map<string, number>;
  paused: boolean;
}

export const FLOW_CONTROL_HIGH_WATERMARK = 100_000;
export const FLOW_CONTROL_LOW_WATERMARK = 5_000;

export class PtyFlowController {
  private readonly high: number;
  private readonly low: number;
  private readonly pauseFn: (sessionId: string) => void;
  private readonly resumeFn: (sessionId: string) => void;
  private readonly sessions = new Map<string, SessionFlowState>();

  constructor(options: PtyFlowControllerOptions) {
    this.high = options.highWatermark ?? FLOW_CONTROL_HIGH_WATERMARK;
    this.low = options.lowWatermark ?? FLOW_CONTROL_LOW_WATERMARK;
    this.pauseFn = options.pause;
    this.resumeFn = options.resume;
  }

  attachConsumer(sessionId: string, consumerId: string): void {
    const state = this.ensure(sessionId);
    if (!state.consumers.has(consumerId)) {
      state.consumers.set(consumerId, 0);
    }
  }

  detachConsumer(sessionId: string, consumerId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (!state.consumers.delete(consumerId)) return;
    if (state.consumers.size === 0) {
      this.resumeIfPaused(sessionId, state);
      this.sessions.delete(sessionId);
      return;
    }
    this.evaluate(sessionId, state);
  }

  detachConsumerFromAllSessions(consumerId: string): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.detachConsumer(sessionId, consumerId);
    }
  }

  noteSent(sessionId: string, consumerId: string, charCount: number): void {
    if (!Number.isFinite(charCount) || charCount <= 0) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const current = state.consumers.get(consumerId);
    if (current === undefined) return;
    state.consumers.set(consumerId, current + charCount);
    this.evaluate(sessionId, state);
  }

  ack(sessionId: string, consumerId: string, charCount: number): void {
    if (!Number.isFinite(charCount) || charCount <= 0) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const current = state.consumers.get(consumerId);
    if (current === undefined) return;
    state.consumers.set(consumerId, Math.max(0, current - charCount));
    this.evaluate(sessionId, state);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  dispose(): void {
    this.sessions.clear();
  }

  private ensure(sessionId: string): SessionFlowState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { consumers: new Map(), paused: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private evaluate(sessionId: string, state: SessionFlowState): void {
    let max = 0;
    for (const count of state.consumers.values()) {
      if (count > max) max = count;
    }
    if (!state.paused && max > this.high) {
      state.paused = true;
      this.pauseFn(sessionId);
    } else if (state.paused && max < this.low) {
      state.paused = false;
      this.resumeFn(sessionId);
    }
  }

  private resumeIfPaused(sessionId: string, state: SessionFlowState): void {
    if (!state.paused) return;
    state.paused = false;
    this.resumeFn(sessionId);
  }
}
