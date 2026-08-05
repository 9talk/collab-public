import log from "electron-log/main.js";
import { join } from "node:path";
import { readdirSync, renameSync, unlinkSync } from "node:fs";
import { COLLAB_DIR } from "./paths";

const LOG_DIR = join(COLLAB_DIR, "logs");
// 按天归档:main-2026-08-04.log。同一天多次启动追加(append),保留 7 天。
const LOG_RETENTION_DAYS = 7;

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function pruneOldLogs(): void {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
    for (const name of readdirSync(LOG_DIR)) {
      const match = /^main-\d{4}-\d{2}-\d{2}\.log$/.exec(name);
      if (!match) continue;
      const ts = new Date(`${match[1]}T00:00:00Z`).getTime();
      if (!Number.isNaN(ts) && ts < cutoff) {
        unlinkSync(join(LOG_DIR, name));
      }
    }
  } catch {
    // Log dir may not exist yet — ignore
  }
}

pruneOldLogs();

log.transports.file.resolvePathFn = () =>
  join(LOG_DIR, `main-${dateStamp()}.log`);

log.initialize();

// Route console.* to electron-log so main-process output
// goes to both stdout and the log file.
Object.assign(console, {
  log: log.info,
  info: log.info,
  warn: log.warn,
  error: log.error,
  debug: log.debug,
});

export default log;
