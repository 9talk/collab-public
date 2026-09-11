// 运行时直连包内 ESM 产物: 包 main 为 CJS 且用动态拷贝导出(Node ESM 静态
// 分析识别不到具名导出, tsx/Node 下 import 失败), module 字段又指向不存在的
// 旧路径; .mjs 子路径即打包器解析的同一份 ESM 文件, Node 与 electron-vite
// 两端一致可用。类型经 xterm-esm.d.ts 转发包根 typings。
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import { SerializeAddon } from "@xterm/addon-serialize/lib/addon-serialize.mjs";

/**
 * 会话终端状态的常驻镜像(不渲染, 只解析): 把 pty 原始输出实时喂入
 * headless xterm, 恢复/镜像 attach 时用 serialize 输出"终帧 + alt 缓冲 +
 * 模式"快照, 取代回放字节历史(全屏应用的历史是逐帧录像, 回放要重演
 * 每一帧才能收敛到终帧; 快照解析渲染量 O(1 帧))。
 *
 * 不挂 onData: 解析器对历史查询(DSR/DA/DECRQM 等)的自动应答没有去向,
 * 自然丢弃——查询被消化为控制事件、不落屏面, 快照只含画面与模式,
 * 恢复内容从构造上不含历史查询(应答泄漏不复存在)。
 */

/** 快照保留的 scrollback 行数: ≥ 现状实际恢复的 500 行, 且控住常驻内存 */
const SERIALIZE_SCROLLBACK = 1000;

export interface SessionSnapshot {
  snapshot: string;
  cols: number;
  rows: number;
}

export class SessionEmulator {
  private readonly term: Terminal;
  private readonly addon: SerializeAddon;
  private pendingWrites = 0;
  private drainWaiters: (() => void)[] = [];
  /**
   * reset/serialize 的有序队列: xterm 的 write 为异步分片解析, 与 reset
   * 之间没有顺序保证——reset 时若还有排队未解析的字节, 它们会在 reset 后
   * 解析、把已清内容"复活"。reset 先排空再清; serialize 排在 reset 之后,
   * 保证两次 RPC 紧邻调用时读到的是清空后的状态。
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: SERIALIZE_SCROLLBACK,
      allowProposedApi: true,
    });
    this.addon = new SerializeAddon();
    this.term.loadAddon(this.addon);
  }

  write(data: Uint8Array): void {
    this.pendingWrites++;
    this.term.write(data, () => {
      this.pendingWrites--;
      if (this.pendingWrites === 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const w of waiters) w();
      }
    });
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** 清空历史(clearBuffer 语义): 先解析完已入队输出, 再整体 reset */
  reset(): Promise<void> {
    return this.enqueue(async () => {
      await this.drain();
      this.term.reset();
    });
  }

  serialize(): Promise<SessionSnapshot> {
    return this.enqueue(async () => {
      await this.drain();
      return {
        snapshot: this.addon.serialize({ scrollback: SERIALIZE_SCROLLBACK }),
        cols: this.term.cols,
        rows: this.term.rows,
      };
    });
  }

  private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 等待已入队输出全部解析完成(headless write 为异步分片解析) */
  private drain(): Promise<void> {
    if (this.pendingWrites === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }
}
