import { ipcMain, webContents, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

/**
 * 集中式 IPC 通道注册表。所有「远程模式可转发」的通道一律经 bindIpc
 * 注册：本地实现保存在 registry 里，远程模式激活时临时替换为转发
 * 实现，退出时恢复本地实现。未参与转发的通道（markForward 未调用）
 * 在远程模式下保持本地注册不变。
 *
 * 同一 channel 允许 handle 与 on 两种 kind 并存（如 pty:write），
 * 各自独立注册、独立转发。
 */

export type IpcKind = "handle" | "on";

export type IpcImpl = (
  event: IpcMainEvent | IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown;

interface IpcRegistration {
  channel: string;
  kind: IpcKind;
  /** 本地实现，切换转发后保留，用于恢复 */
  impl: IpcImpl;
  /** 当前实际注册的 listener（removeListener 需要原引用） */
  wrapper: IpcImpl;
  bound: boolean;
}

/** key = `${kind}:${channel}` */
const registry = new Map<string, IpcRegistration>();
const forwardChannels = new Set<string>();

export type RemoteCallFn = (
  channel: string,
  kind: IpcKind,
  args: unknown[],
  senderId: number,
) => Promise<unknown> | unknown;

let remoteCall: RemoteCallFn | null = null;

/** 远程模式激活前由 remote-client 注入转发实现 */
export function setRemoteCallHandler(fn: RemoteCallFn | null): void {
  remoteCall = fn;
}

function keyOf(channel: string, kind: IpcKind): string {
  return `${kind}:${channel}`;
}

function detachRec(rec: IpcRegistration): void {
  if (!rec.bound) return;
  if (rec.kind === "handle") {
    ipcMain.removeHandler(rec.channel);
  } else {
    ipcMain.removeListener(rec.channel, rec.wrapper);
  }
  rec.bound = false;
}

function attachRec(rec: IpcRegistration, impl: IpcImpl): void {
  if (rec.bound) return;
  const wrapper: IpcImpl = (event, ...args) => impl(event, ...args);
  if (rec.kind === "handle") {
    ipcMain.handle(rec.channel, wrapper);
  } else {
    ipcMain.on(rec.channel, wrapper);
  }
  rec.wrapper = wrapper;
  rec.bound = true;
}

export function bindIpc(channel: string, kind: IpcKind, impl: IpcImpl): void {
  const key = keyOf(channel, kind);
  const existing = registry.get(key);
  if (existing) detachRec(existing);
  const rec: IpcRegistration = {
    channel,
    kind,
    impl,
    wrapper: (() => {}) as IpcImpl,
    bound: false,
  };
  registry.set(key, rec);
  attachRec(rec, impl);
}

/** 标记该通道参与远程转发（invoke 或 send 一并对等转发） */
export function markForward(channel: string): void {
  forwardChannels.add(channel);
}

export function unbindAllIpc(): void {
  for (const rec of registry.values()) detachRec(rec);
}

/** 远程模式激活：forward 通道全部替换为转发实现 */
export function activateRemoteForwarding(): void {
  if (!remoteCall) {
    throw new Error("remote call handler not set");
  }
  for (const channel of forwardChannels) {
    for (const kind of ["handle", "on"] as const) {
      const rec = registry.get(keyOf(channel, kind));
      if (!rec) continue;
      detachRec(rec);
      const wrapper: IpcImpl = (event, ...args) => {
        // 本地设置/连接窗口的调用不转发（local 项：locale、连接存档等），
        // 直接执行本地实现 —— 避免 locale 读到 Host、pref:set 误写 Host 配置
        if (isLocalSender(event.sender.id)) {
          return rec.impl(event, ...args);
        }
        return remoteCall!(rec.channel, rec.kind, args, event.sender.id);
      };
      rec.wrapper = wrapper;
      rec.bound = true;
      if (rec.kind === "handle") {
        ipcMain.handle(rec.channel, wrapper);
      } else {
        ipcMain.on(rec.channel, wrapper);
      }
    }
  }
}

/** 豁免转发的本地窗口：按渲染页面 URL 判定 */
function isLocalSender(senderId: number): boolean {
  const wc = webContents.fromId(senderId);
  if (!wc || wc.isDestroyed()) return false;
  const url = wc.getURL();
  return url.includes("/settings/") || url.includes("/connect/");
}

/** 退出远程模式：恢复本地实现 */
export function deactivateRemoteForwarding(): void {
  for (const channel of forwardChannels) {
    for (const kind of ["handle", "on"] as const) {
      const rec = registry.get(keyOf(channel, kind));
      if (!rec) continue;
      detachRec(rec);
      attachRec(rec, rec.impl);
    }
  }
}
