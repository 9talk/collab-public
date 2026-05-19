import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// PTY
export async function ptyCreate(params: {
  cwd?: string;
  cols?: number;
  rows?: number;
}): Promise<string> {
  return invoke<string>("pty_create", { params });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export async function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

export async function ptyDiscover(): Promise<Array<{ id: string; cwd: string }>> {
  return invoke("pty_discover");
}

export function onPtyData(
  handler: (payload: { id: string; data: string }) => void,
): Promise<() => void> {
  return listen("pty:data", (event) => handler(event.payload as never));
}

// File system
export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

export async function listDir(path: string): Promise<
  Array<{ path: string; name: string; is_dir: boolean; size: number }>
> {
  return invoke("list_dir", { path });
}

export async function getHomeDir(): Promise<string> {
  return invoke<string>("get_home_dir");
}

export async function pathExists(path: string): Promise<boolean> {
  return invoke("exists", { path });
}
