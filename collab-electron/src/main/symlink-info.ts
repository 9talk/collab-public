import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface SymlinkDescription {
  /** 链接目标不存在（悬空链接） */
  broken: boolean;
}

/**
 * 解析软链接的展示信息：是否悬空。供 nav 树渲染断链 ⚠ 标识使用
 * （files.ts / ipc-workspace.ts 共用）。
 *
 * 刻意不依赖 electron 模块：files.ts 被单测直接加载。
 */
export function describeSymlink(
  linkPath: string,
  rawTarget: string,
): SymlinkDescription {
  const resolved = isAbsolute(rawTarget)
    ? rawTarget
    : resolve(dirname(linkPath), rawTarget);
  return { broken: !existsSync(resolved) };
}
