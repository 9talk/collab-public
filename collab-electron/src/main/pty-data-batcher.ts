/**
 * 每会话 PTY 数据批处理。定时器从首块开始计时，后续 chunk 不重置
 * （throttle 而非 debounce），持续输出不会饿死 flush。
 */

export interface PtyDataBatcherScheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PtyDataBatcherOptions {
  flushMs?: number;
  maxBytes?: number;
  onFlush: (sessionId: string, data: Buffer) => void;
  scheduler?: PtyDataBatcherScheduler;
}

interface Batch {
  chunks: Buffer[];
  bytes: number;
  timer: unknown;
  flushing: boolean;
}

const DEFAULT_FLUSH_MS = 5;
const DEFAULT_MAX_BYTES = 32 * 1024;

const defaultScheduler: PtyDataBatcherScheduler = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PtyDataBatcher {
  private readonly flushMs: number;
  private readonly maxBytes: number;
  private readonly onFlush: (sessionId: string, data: Buffer) => void;
  private readonly scheduler: PtyDataBatcherScheduler;
  private readonly batches = new Map<string, Batch>();
  private readonly fastPath = new Set<string>();
  private disposed = false;

  constructor(options: PtyDataBatcherOptions) {
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.onFlush = options.onFlush;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  push(sessionId: string, chunk: Buffer, flushMs?: number): void {
    if (this.disposed || chunk.length === 0) return;

    let batch = this.batches.get(sessionId);
    if (!batch) {
      batch = { chunks: [], bytes: 0, timer: null, flushing: false };
      this.batches.set(sessionId, batch);
    }

    batch.chunks.push(chunk);
    batch.bytes += chunk.length;

    if (this.fastPath.delete(sessionId) || batch.bytes >= this.maxBytes) {
      this.flush(sessionId);
      return;
    }

    if (batch.timer === null) {
      const timer = this.scheduler.setTimeout(() => {
        if (batch!.timer === timer) batch!.timer = null;
        this.flush(sessionId);
      }, flushMs ?? this.flushMs);
      batch.timer = timer;
    }
  }

  flush(sessionId: string): void {
    const batch = this.batches.get(sessionId);
    if (!batch || batch.flushing) return;

    batch.flushing = true;
    try {
      while (batch.chunks.length > 0) {
        if (batch.timer !== null) {
          this.scheduler.clearTimeout(batch.timer);
          batch.timer = null;
        }
        const data =
          batch.chunks.length === 1
            ? batch.chunks[0]!
            : Buffer.concat(batch.chunks, batch.bytes);
        batch.chunks = [];
        batch.bytes = 0;
        this.onFlush(sessionId, data);
      }
    } finally {
      batch.flushing = false;
      if (
        batch.chunks.length === 0 &&
        batch.timer === null &&
        this.batches.get(sessionId) === batch
      ) {
        this.batches.delete(sessionId);
      }
    }
  }

  clear(sessionId: string): void {
    const batch = this.batches.get(sessionId);
    if (batch && batch.timer !== null) {
      this.scheduler.clearTimeout(batch.timer);
    }
    this.batches.delete(sessionId);
    this.fastPath.delete(sessionId);
  }

  markFastPath(sessionId: string): void {
    if (this.disposed) return;
    this.fastPath.add(sessionId);
  }

  flushAll(): void {
    for (const sessionId of [...this.batches.keys()]) {
      this.flush(sessionId);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const batch of this.batches.values()) {
      if (batch.timer !== null) this.scheduler.clearTimeout(batch.timer);
    }
    this.batches.clear();
    this.fastPath.clear();
  }
}
