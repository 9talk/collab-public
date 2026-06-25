import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

export interface ExternalEditor {
  id: string;
  name: string;
  appPath: string;
}

const KNOWN_EDITORS: ExternalEditor[] = [
  {
    id: "intellij-idea",
    name: "IntelliJ IDEA",
    appPath: "/Applications/IntelliJ IDEA.app",
  },
  {
    id: "visual-studio-code",
    name: "Visual Studio Code",
    appPath: "/Applications/Visual Studio Code.app",
  },
  {
    id: "typora",
    name: "Typora",
    appPath: "/Applications/Typora.app",
  },
  {
    id: "cursor",
    name: "Cursor",
    appPath: "/Applications/Cursor.app",
  },
  {
    id: "trae",
    name: "Trae",
    appPath: "/Applications/Trae.app",
  },
  {
    id: "zed",
    name: "Zed",
    appPath: "/Applications/Zed.app",
  },
  {
    id: "qoder",
    name: "Qoder",
    appPath: "/Applications/Qoder.app",
  },
];

/** Always-available virtual editors (not detected from disk). */
export const VIRTUAL_EDITORS: ExternalEditor[] = [
  {
    id: "system-app",
    name: "系统应用",
    appPath: "",
  },
];

export function detectEditors(): ExternalEditor[] {
  return KNOWN_EDITORS.filter((ed) => existsSync(ed.appPath));
}

function spawnEditor(bin: string, args: string[]): void {
  console.log("[external-editor] spawning:", bin, args);
  spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
}

function openWithCodeFork(
  appPath: string,
  filePath: string,
  workspacePath: string,
): void {
  const codeBin = `${appPath}/Contents/Resources/app/bin/code`;
  spawnEditor(codeBin, [filePath]);
}

function openWorkspaceWithCodeFork(
  appPath: string,
  workspacePath: string,
): void {
  const codeBin = `${appPath}/Contents/Resources/app/bin/code`;
  spawnEditor(codeBin, [workspacePath]);
}

export function openFileInEditor(
  editorId: string,
  filePath: string,
  workspacePath: string,
): void {
  if (editorId === "intellij-idea") {
    spawnEditor("/Applications/IntelliJ IDEA.app/Contents/MacOS/idea", [
      workspacePath,
      filePath,
    ]);
  } else if (editorId === "visual-studio-code") {
    spawnEditor(
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      [filePath],
    );
  } else if (editorId === "typora") {
    spawnEditor("open", ["-a", "Typora", filePath]);
  } else if (editorId === "cursor") {
    openWithCodeFork("/Applications/Cursor.app", filePath, workspacePath);
  } else if (editorId === "trae") {
    openWithCodeFork("/Applications/Trae.app", filePath, workspacePath);
  } else if (editorId === "qoder") {
    openWithCodeFork("/Applications/Qoder.app", filePath, workspacePath);
  } else if (editorId === "zed") {
    spawnEditor("/Applications/Zed.app/Contents/MacOS/cli", [filePath]);
  }
}

export function openWorkspaceInEditor(
  editorId: string,
  workspacePath: string,
): void {
  if (editorId === "intellij-idea") {
    spawnEditor("/Applications/IntelliJ IDEA.app/Contents/MacOS/idea", [
      workspacePath,
    ]);
  } else if (editorId === "visual-studio-code") {
    spawnEditor(
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      [workspacePath],
    );
  } else if (editorId === "typora") {
    spawnEditor("open", ["-a", "Typora", workspacePath]);
  } else if (editorId === "cursor") {
    openWorkspaceWithCodeFork("/Applications/Cursor.app", workspacePath);
  } else if (editorId === "trae") {
    openWorkspaceWithCodeFork("/Applications/Trae.app", workspacePath);
  } else if (editorId === "qoder") {
    openWorkspaceWithCodeFork("/Applications/Qoder.app", workspacePath);
  } else if (editorId === "zed") {
    spawnEditor("/Applications/Zed.app/Contents/MacOS/cli", [workspacePath]);
  }
}
