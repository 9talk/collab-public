import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface PersistedSnapshot {
  version: 1;
  rooms: { deviceId: string; hasClient: boolean }[];
}

const FILE_NAME = "rooms.json";

export function loadState(dir: string): PersistedSnapshot | null {
  const file = join(dir, FILE_NAME);
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as PersistedSnapshot;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveState(
  dir: string,
  state: { rooms: { deviceId: string; hasClient: boolean }[] },
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, FILE_NAME);
    const tmp = join(dir, `${FILE_NAME}.tmp`);
    const payload = JSON.stringify({ version: 1, ...state });
    writeFileSync(tmp, payload);
    // rename is atomic on the same filesystem; replace then remove the tmp
    writeFileSync(file, payload);
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may already be gone
    }
  } catch {
    // Persistence is best-effort; never crash the relay over disk errors.
  }
}
