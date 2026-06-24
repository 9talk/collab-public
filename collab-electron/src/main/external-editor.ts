import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

export interface ExternalEditor {
  id: string;
  name: string;
  appPath: string;
  binPath: string;
}

const KNOWN_EDITORS: ExternalEditor[] = [
  {
    id: "intellij-idea",
    name: "IntelliJ IDEA",
    appPath: "/Applications/IntelliJ IDEA.app",
    binPath: "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea",
  },
  {
    id: "visual-studio-code",
    name: "Visual Studio Code",
    appPath: "/Applications/Visual Studio Code.app",
    binPath:
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  },
];

export function detectEditors(): ExternalEditor[] {
  return KNOWN_EDITORS.filter((ed) => existsSync(ed.appPath));
}

export function openFileInEditor(
  editorId: string,
  filePath: string,
  workspacePath: string,
): void {
  const editor = KNOWN_EDITORS.find((e) => e.id === editorId);
  if (!editor) return;

  let args: string[];
  if (editorId === "intellij-idea") {
    args = [workspacePath, filePath];
  } else {
    args = [filePath];
  }

  spawn(editor.binPath, args, {
    detached: true,
    stdio: "ignore",
  }).unref();
}

export function openWorkspaceInEditor(
  editorId: string,
  workspacePath: string,
): void {
  const editor = KNOWN_EDITORS.find((e) => e.id === editorId);
  if (!editor) return;

  spawn(editor.binPath, [workspacePath], {
    detached: true,
    stdio: "ignore",
  }).unref();
}
