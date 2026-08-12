import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// On Windows, node-pty's build files need two patches:
// 1. winpty.gyp uses bare .bat filenames in cmd /c calls. Modern Windows may
//    not resolve them without a .\ prefix.
// 2. Both binding.gyp and winpty.gyp require Spectre-mitigated libraries
//    which may not be installed in VS Build Tools.
if (process.platform === "win32") {
  const winptyGyp = join(
    "node_modules",
    "node-pty",
    "deps",
    "winpty",
    "src",
    "winpty.gyp",
  );
  if (existsSync(winptyGyp)) {
    let content = readFileSync(winptyGyp, "utf8");
    content = content.replace(
      /&& GetCommitHash\.bat/g,
      "&& .\\\\GetCommitHash.bat",
    );
    content = content.replace(
      /&& UpdateGenVersion\.bat/g,
      "&& .\\\\UpdateGenVersion.bat",
    );
    content = content.replace(
      /'SpectreMitigation': 'Spectre'/g,
      "'SpectreMitigation': 'false'",
    );
    writeFileSync(winptyGyp, content);
    console.log("Patched winpty.gyp");
  }

  const bindingGyp = join("node_modules", "node-pty", "binding.gyp");
  if (existsSync(bindingGyp)) {
    let content = readFileSync(bindingGyp, "utf8");
    content = content.replace(
      /'SpectreMitigation': 'Spectre'/g,
      "'SpectreMitigation': 'false'",
    );
    writeFileSync(bindingGyp, content);
    console.log("Patched binding.gyp");
  }

  const conptyAgentTs = join(
    "node_modules",
    "node-pty",
    "src",
    "conpty_console_list_agent.ts",
  );
  if (existsSync(conptyAgentTs)) {
    let content = readFileSync(conptyAgentTs, "utf8");
    content = content.replace(
      [
        "const consoleProcessList = getConsoleProcessList(shellPid);",
        "process.send!({ consoleProcessList });",
        "process.exit(0);",
      ].join("\n"),
      [
        "let consoleProcessList: number[];",
        "try {",
        "  consoleProcessList = getConsoleProcessList(shellPid);",
        "} catch {",
        "  // AttachConsole can fail during teardown races; fall back",
        "  // to the shell pid so the parent can continue cleanup.",
        "  consoleProcessList = [shellPid];",
        "}",
        "process.send!({ consoleProcessList });",
        "process.exit(0);",
      ].join("\n"),
    );
    writeFileSync(conptyAgentTs, content);
    console.log("Patched conpty_console_list_agent.ts");
  }

  const conptyAgentJs = join(
    "node_modules",
    "node-pty",
    "lib",
    "conpty_console_list_agent.js",
  );
  if (existsSync(conptyAgentJs)) {
    let content = readFileSync(conptyAgentJs, "utf8");
    content = content.replace(
      [
        "var consoleProcessList = getConsoleProcessList(shellPid);",
        "process.send({ consoleProcessList: consoleProcessList });",
        "process.exit(0);",
      ].join("\n"),
      [
        "var consoleProcessList;",
        "try {",
        "    consoleProcessList = getConsoleProcessList(shellPid);",
        "}",
        "catch (_a) {",
        "    // AttachConsole can fail during teardown races; fall back",
        "    // to the shell pid so the parent can continue cleanup.",
        "    consoleProcessList = [shellPid];",
        "}",
        "process.send({ consoleProcessList: consoleProcessList });",
        "process.exit(0);",
      ].join("\n"),
    );
    writeFileSync(conptyAgentJs, content);
    console.log("Patched conpty_console_list_agent.js");
  }
}

// Patch @xterm/addon-search: _findInLine recurses through wrapped lines.
// A single logical line wrapped across tens of thousands of physical rows
// (e.g. one enormous no-newline output) overflows the call stack on any
// search, and the incremental auto-search then re-triggers it on every
// PTY write (onWriteParsed -> _updateMatches -> findPrevious), spamming
// "Maximum call stack size exceeded" and ballooning memory via the line
// cache. Rewrite the recursion as a loop. Keep in sync with the addon
// version pinned in package.json.
const searchAddonDir = join("node_modules", "@xterm", "addon-search", "lib");
if (existsSync(searchAddonDir)) {
  for (const file of ["addon-search.mjs", "addon-search.js"]) {
    const path = join(searchAddonDir, file);
    if (!existsSync(path)) continue;
    let code = readFileSync(path, "utf8");
    let changed = false;
    if (file.endsWith(".mjs")) {
      const from =
        "_findInLine(e,t,n={},i=!1){let s=t.startRow,a=t.startCol;if(this._terminal.buffer.active.getLine(s)?.isWrapped){if(i){t.startCol+=this._terminal.cols;return}return t.startRow--,t.startCol+=this._terminal.cols,this._findInLine(e,t,n)}";
      const to =
        "_findInLine(e,t,n={},i=!1){let s=t.startRow,a=t.startCol;while(this._terminal.buffer.active.getLine(s)?.isWrapped){if(i){t.startCol+=this._terminal.cols;return}t.startRow--,t.startCol+=this._terminal.cols,s=t.startRow}";
      if (code.includes(from)) {
        code = code.replace(from, to);
        changed = true;
      }
    } else {
      const from =
        "_findInLine(e,t,s={},i=!1){const r=t.startRow,n=t.startCol,o=this._terminal.buffer.active.getLine(r);if(o?.isWrapped)return i?void(t.startCol+=this._terminal.cols):(t.startRow--,t.startCol+=this._terminal.cols,this._findInLine(e,t,s));";
      const to =
        "_findInLine(e,t,s={},i=!1){let r=t.startRow,n=t.startCol,o=this._terminal.buffer.active.getLine(r);while(o?.isWrapped){if(i){t.startCol+=this._terminal.cols;return}t.startRow--,t.startCol+=this._terminal.cols,r=t.startRow,o=this._terminal.buffer.active.getLine(r)}";
      if (code.includes(from)) {
        code = code.replace(from, to);
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(path, code);
      console.log("Patched @xterm/addon-search " + file);
    } else {
      console.warn("addon-search patch pattern not found in " + file);
    }
  }
}

execSync("bun x electron-rebuild -f -w node-pty", { stdio: "inherit" });
