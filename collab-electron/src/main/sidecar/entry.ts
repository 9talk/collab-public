// src/main/sidecar/entry.ts
import { SidecarServer } from "./server";
import {
  SIDECAR_SOCKET_PATH,
  SIDECAR_PID_PATH,
  SESSION_SOCKET_DIR,
} from "./protocol";

function installParentWatchdog(server: SidecarServer): void {
  // main 以 detached + unref 方式 spawn 我们:优雅退出时它会先 RPC
  // shutdown,但 app 被强杀(SIGKILL/崩溃)时没有通知,sidecar 会带着
  // PTY 会话永久残留。父进程死亡后我们会立即被 reparent 到 launchd
  // (ppid 变为 1),轮询检测到 ppid 变化即自行收尾退出。
  const parentPid = process.ppid;
  const timer = setInterval(() => {
    if (process.ppid !== parentPid) {
      void server.shutdown().then(() => process.exit(0));
    }
  }, 2000);
  timer.unref?.();
}

function main(): void {
  const args = process.argv.slice(2);
  const tokenIdx = args.indexOf("--token");
  const token = tokenIdx !== -1 ? args[tokenIdx + 1] : "";

  if (!token) {
    process.stderr.write("Error: --token is required\n");
    process.exit(1);
  }

  const server = new SidecarServer({
    controlSocketPath: SIDECAR_SOCKET_PATH,
    sessionSocketDir: SESSION_SOCKET_DIR,
    pidFilePath: SIDECAR_PID_PATH,
    token,
  });

  process.on("SIGTERM", () => {
    void server.shutdown().then(() => process.exit(0));
  });

  process.on("SIGINT", () => {
    void server.shutdown().then(() => process.exit(0));
  });

  void server.start().then(() => {
    installParentWatchdog(server);
  });
}

main();
