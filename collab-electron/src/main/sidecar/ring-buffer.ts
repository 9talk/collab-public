import { buildRebuildQueryRe } from "@collab/shared/terminal-queries";

/**
 * Fixed-capacity circular byte buffer. Oldest data is silently
 * overwritten when the buffer is full. Snapshot returns a copy
 * of the live contents in write order.
 *
 * 写入时剥离终端查询序列(DSR/DA/DECRQM 等, 清单见 @collab/shared/terminal-queries):
 * 本缓冲只服务于历史回放, 查询留在历史里会让全新 xterm 对过期查询重复应答,
 * 应答写回 pty 被空闲 shell 回显成 "24;3R"/"1;2c" 文本泄漏。剥离放在唯一
 * 写入口, 任何导出点(重连快照/capture/远端中继)拿到的历史天然干净; 被
 * chunk 切断的查询前缀由 carry 扣住, 拼齐后整体剥离或按普通数据放行。
 */

/** 查询参数允许出现的字节: 0-9 与 ; ? > = $(DECRQM 前缀) */
function isQueryParamByte(b: number): boolean {
  return (
    (b >= 0x30 && b <= 0x39) ||
    b === 0x3b || // ;
    b === 0x3f || // ?
    b === 0x3e || // >
    b === 0x3d || // =
    b === 0x24 // $
  );
}

/** carry 扣留上限(字节): 查询序列实际都很短, 超限即按普通数据放行(导出点剥离兜底) */
const MAX_QUERY_HOLD = 32;

/**
 * 拆出尾部"可能构成查询前缀"的字节(如跨 chunk 被切断的 "\x1b[?20"):
 * 反向走过尾部的查询参数字节, 若能接到 "\x1b[" 且不超上限, 则该后缀由
 * carry 扣住, 等下一段拼齐后再判; 其余照常写出。
 */
function splitQueryPrefixTail(buf: Buffer): { emit: Buffer; hold: Buffer } {
  let i = buf.length;
  while (i > 0 && isQueryParamByte(buf[i - 1]!)) i--;
  if (
    i >= 2 &&
    buf[i - 1] === 0x5b && // [
    buf[i - 2] === 0x1b &&
    buf.length - (i - 2) <= MAX_QUERY_HOLD
  ) {
    // hold 取自调用方缓冲, 复制后长持, 防调用方复用底层内存
    return {
      emit: buf.subarray(0, i - 2),
      hold: Buffer.from(buf.subarray(i - 2)),
    };
  }
  return { emit: buf, hold: Buffer.alloc(0) };
}

/**
 * 剥离完整的查询序列。走 latin1 往返: 每个字节映射一个码点, 多字节 UTF-8
 * 字符(≥0x80 的字节)不参与 ASCII 正则匹配, 编解码字节无损。
 */
function stripKnownQueries(buf: Buffer): Buffer {
  const s = buf.toString("latin1");
  const cleaned = s.replace(buildRebuildQueryRe(), "");
  return cleaned.length === s.length ? buf : Buffer.from(cleaned, "latin1");
}

export class RingBuffer {
  private buf: Buffer;
  private head = 0; // next write position
  private filled = 0; // bytes currently stored (up to capacity)
  private total = 0; // lifetime bytes written
  /** 上次 write 尾部被切断的查询前缀, 与下一段拼接后再判 */
  private carry: Buffer = Buffer.alloc(0);

  constructor(private readonly capacity: number) {
    this.buf = Buffer.alloc(capacity);
  }

  get bytesWritten(): number {
    return this.total;
  }

  write(data: Uint8Array): void {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.total += chunk.length;

    const merged =
      this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const { emit, hold } = splitQueryPrefixTail(merged);
    this.carry = hold;
    if (emit.length === 0) return;
    this.store(stripKnownQueries(emit));
  }

  private store(chunk: Buffer): void {
    const len = chunk.length;

    if (len >= this.capacity) {
      // Data larger than buffer — keep only the tail
      chunk.copy(this.buf, 0, len - this.capacity, len);
      this.head = 0;
      this.filled = this.capacity;
      return;
    }

    const spaceToEnd = this.capacity - this.head;

    if (len <= spaceToEnd) {
      chunk.copy(this.buf, this.head);
    } else {
      chunk.copy(this.buf, this.head, 0, spaceToEnd);
      chunk.copy(this.buf, 0, spaceToEnd);
    }

    this.head = (this.head + len) % this.capacity;
    this.filled = Math.min(this.filled + len, this.capacity);
  }

  /** Return a copy of buffered data in write order. */
  snapshot(): Buffer {
    if (this.filled === 0) return Buffer.alloc(0);

    if (this.filled < this.capacity) {
      // Haven't wrapped yet — data starts at 0
      return Buffer.from(this.buf.subarray(0, this.filled));
    }

    // Wrapped: oldest data starts at head, newest ends just before head
    const result = Buffer.alloc(this.capacity);
    const tailLen = this.capacity - this.head;
    this.buf.copy(result, 0, this.head, this.head + tailLen);
    this.buf.copy(result, tailLen, 0, this.head);
    return result;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
    this.carry = Buffer.alloc(0);
  }
}
