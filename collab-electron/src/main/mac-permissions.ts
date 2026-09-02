import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shell, systemPreferences } from "electron";

export type PermissionKind =
  | "fullDiskAccess"
  | "filesAndFolders"
  | "accessibility";

export type PermissionStatus = "granted" | "denied" | "unknown";

const FDA_PROBE_PATHS = [
  join(homedir(), "Library", "Safari", "Bookmarks.plist"),
  join(homedir(), "Library", "Messages", "chat.db"),
];

const USER_DIRS = ["Desktop", "Documents", "Downloads"].map((d) =>
  join(homedir(), d),
);

const SETTINGS_URLS: Record<PermissionKind, string> = {
  fullDiskAccess:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  filesAndFolders:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

const GENERIC_PRIVACY_URL =
  "x-apple.systempreferences:com.apple.preference.security";

export function classifyProbeError(err: unknown): PermissionStatus {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EPERM" || code === "EACCES") return "denied";
  return "unknown";
}

function probeReadable(filePath: string): PermissionStatus {
  try {
    readFileSync(filePath);
    return "granted";
  } catch (err) {
    return classifyProbeError(err);
  }
}

function probeReaddir(dirPath: string): PermissionStatus {
  try {
    readdirSync(dirPath);
    return "granted";
  } catch (err) {
    return classifyProbeError(err);
  }
}

function checkFullDiskAccess(): PermissionStatus {
  let sawUnknown = false;
  for (const probe of FDA_PROBE_PATHS) {
    const status = probeReadable(probe);
    if (status === "granted") return "granted";
    if (status === "unknown") sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "denied";
}

function checkFilesAndFolders(): PermissionStatus {
  let sawAnyDir = false;
  let denied = false;
  for (const dir of USER_DIRS) {
    const status = probeReaddir(dir);
    if (status === "granted" || status === "unknown") {
      if (status === "granted") sawAnyDir = true;
      continue;
    }
    denied = true;
  }
  if (denied) return "denied";
  return sawAnyDir ? "granted" : "unknown";
}

export function checkPermissions(): Record<PermissionKind, PermissionStatus> {
  return {
    fullDiskAccess: checkFullDiskAccess(),
    filesAndFolders: checkFilesAndFolders(),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false)
      ? "granted"
      : "denied",
  };
}

export function openPermissionSettings(kind: PermissionKind): void {
  shell.openExternal(SETTINGS_URLS[kind]).catch(() => {
    shell.openExternal(GENERIC_PRIVACY_URL);
  });
}
