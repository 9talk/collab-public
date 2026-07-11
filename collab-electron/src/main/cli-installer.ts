import { app } from "electron";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const IS_WIN = process.platform === "win32";
const INSTALL_DIR = IS_WIN
  ? join(
      process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local"),
      "Collaborator",
      "bin",
    )
  : join(homedir(), ".local", "bin");
const WRAPPER_PATH = join(
  INSTALL_DIR,
  IS_WIN ? "collab-canvas.cmd" : "collab-canvas",
);
const MJS_PATH = join(INSTALL_DIR, "collab-cli.mjs");

function getMjsSource(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "collab-cli.mjs");
  }
  // Try bundled version first, fall back to source
  const bundled = join(app.getAppPath(), "cli", "collab-cli.bundled.mjs");
  if (existsSync(bundled)) {
    return bundled;
  }
  return join(app.getAppPath(), "cli", "collab-cli.mjs");
}

function generateUnixWrapper(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
NODE_BIN="$(cat "$HOME/.collaborator/node-path" 2>/dev/null)" || true
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "error: collaborator is not running (no node-path file)" >&2
  exit 2
fi
ELECTRON_RUN_AS_NODE=1 exec "$NODE_BIN" "$(dirname "$0")/collab-cli.mjs" "$@"
`;
}

function generateWindowsWrapper(): string {
  return `@echo off
setlocal
set "NP_FILE=%USERPROFILE%\\.collaborator\\node-path"
if not exist "%NP_FILE%" (
  echo error: collaborator is not running ^(no node-path file^) >&2
  exit /b 2
)
set /p NODE_BIN=<"%NP_FILE%"
set ELECTRON_RUN_AS_NODE=1
"%NODE_BIN%" "%~dp0collab-cli.mjs" %*
`;
}

export function installCli(): void {
  const mjsSource = getMjsSource();
  if (!existsSync(mjsSource)) {
    console.warn("[cli-installer] CLI source not found:", mjsSource);
    return;
  }

  const legacyNames = IS_WIN
    ? ["collab.cmd", "collab.ps1", "collab-canvas.ps1"]
    : ["collab"];
  for (const name of legacyNames) {
    const legacy = join(INSTALL_DIR, name);
    if (existsSync(legacy)) {
      unlinkSync(legacy);
      console.log("[cli-installer] removed legacy CLI:", legacy);
    }
  }

  mkdirSync(INSTALL_DIR, { recursive: true });

  copyFileSync(mjsSource, MJS_PATH);

  const wrapper = IS_WIN ? generateWindowsWrapper() : generateUnixWrapper();
  writeFileSync(WRAPPER_PATH, wrapper, "utf-8");
  if (!IS_WIN) {
    chmodSync(WRAPPER_PATH, 0o755);
  }

  if (IS_WIN) {
    addToWindowsPath(INSTALL_DIR);
  }
}

/**
 * Add a directory to the user-level PATH on Windows via the registry.
 * Broadcasts WM_SETTINGCHANGE so already-open shells pick up the change.
 */
function addToWindowsPath(dir: string): void {
  let currentPath = "";
  try {
    const output = execSync('reg query "HKCU\\Environment" /v Path', {
      encoding: "utf-8",
    });
    const match = output.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    if (match) currentPath = match[1].trim();
  } catch {
    // Key doesn't exist yet — first time setup
  }

  const entries = currentPath.split(";").filter(Boolean);
  if (entries.some((e) => e.toLowerCase() === dir.toLowerCase())) return;

  const newPath = currentPath ? `${currentPath};${dir}` : dir;
  execSync(
    `reg add "HKCU\\Environment" /v Path /t REG_EXPAND_SZ /d "${newPath}" /f`,
    { encoding: "utf-8" },
  );

  // Broadcast WM_SETTINGCHANGE so open Explorer/shell windows see the update
  const ps1 = `
Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
$r = [UIntPtr]::Zero
[Win32.NativeMethods]::SendMessageTimeout(
    [IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
`;
  const encoded = Buffer.from(ps1, "utf16le").toString("base64");
  try {
    execSync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { encoding: "utf-8", timeout: 10000 },
    );
  } catch {
    // Non-critical: new terminals will still pick up the change from the registry
  }
}
