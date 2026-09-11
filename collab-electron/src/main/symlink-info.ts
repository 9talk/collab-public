import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TEMPLATES_DIR } from "./paths";

export interface SymlinkDescription {
  /** 链接指向模板库内时，来源模板名（TEMPLATES_DIR 下第一层目录名） */
  templateName?: string;
  /** 链接目标不存在（悬空链接） */
  broken: boolean;
}

/**
 * 解析软链接的展示信息：是否悬空、是否来自模板库。供 nav 树渲染
 * 🔗 徽标与断链 ⚠ 标识使用（files.ts / ipc-workspace.ts 共用）。
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
  const broken = !existsSync(resolved);

  let templateName: string | undefined;
  const rel = relative(TEMPLATES_DIR, resolved);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
    templateName = rel.split(sep)[0];
  }
  return templateName === undefined ? { broken } : { templateName, broken };
}
