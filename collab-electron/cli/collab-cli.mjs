#!/usr/bin/env node
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const VERSION = "0.1.0";
const GRID = 20;
const COLLAB_DIR = join(homedir(), ".collaborator");
const SOCKET_FILE = join(COLLAB_DIR, "socket-path");

// --- helpers --------------------------------------------------------------

function die(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function readSocketPath() {
  let raw;
  try {
    raw = readFileSync(SOCKET_FILE, "utf-8").trim();
  } catch {
    die("collaborator is not running (no socket-path file)", 2);
  }
  return raw;
}

function rpcCall(method, params = {}) {
  return new Promise((res, rej) => {
    const socketPath = readSocketPath();
    const payload =
      JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n";

    const sock = createConnection(socketPath);
    let buf = "";

    const timer = setTimeout(() => {
      sock.destroy();
      rej(new Error("timeout"));
    }, 10_000);

    sock.on("connect", () => sock.write(payload));

    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      sock.destroy();
      let resp;
      try {
        resp = JSON.parse(buf.slice(0, nl));
      } catch {
        rej(new Error("invalid response from collaborator"));
        return;
      }
      if (resp.error) {
        rej(new Error(resp.error.message ?? "unknown error"));
      } else {
        res(resp.result);
      }
    });

    sock.on("error", (err) => {
      clearTimeout(timer);
      rej(err);
    });
  });
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function tilesToGrid(result) {
  for (const t of result.tiles ?? []) {
    if (t.position) {
      t.position.x = Math.floor(t.position.x / GRID);
      t.position.y = Math.floor(t.position.y / GRID);
    }
    if (t.size) {
      t.size.width = Math.floor(t.size.width / GRID);
      t.size.height = Math.floor(t.size.height / GRID);
    }
    // Strip undefined/null fields for cleaner output
    for (const key of Object.keys(t)) {
      if (t[key] === undefined || t[key] === null) delete t[key];
    }
  }
  return result;
}

function parsePos(s) {
  const [xs, ys] = s.split(",");
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    die(`invalid position: ${s}`);
  }
  return { x, y };
}

function parseSize(s) {
  const [ws, hs] = s.split(",");
  const w = Number(ws);
  const h = Number(hs);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0) {
    die(`invalid size: ${s}`);
  }
  return { w, h };
}

// --- subcommands ----------------------------------------------------------

async function cmdTileList() {
  const result = await rpcCall("canvas.tileList");
  console.log(pretty(tilesToGrid(result)));
}

async function cmdTileCreate(args) {
  if (args.length === 0) {
    die("tile create requires a type (term, note, code, image, graph, browser, pdf)");
  }
  const tileType = args.shift();
  const valid = ["term", "note", "code", "image", "graph", "browser", "pdf"];
  if (!valid.includes(tileType)) {
    die(`unknown tile type: ${tileType} (expected: ${valid.join(", ")})`);
  }

  const params = { tileType };
  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "--file": {
        if (args.length === 0) die("--file requires a path");
        params.filePath = resolve(args.shift());
        break;
      }
      case "--url": {
        if (args.length === 0) die("--url requires a URL");
        params.url = args.shift();
        break;
      }
      case "--pos": {
        if (args.length === 0) die("--pos requires x,y");
        const { x, y } = parsePos(args.shift());
        params.position = { x: x * GRID, y: y * GRID };
        break;
      }
      case "--size": {
        if (args.length === 0) die("--size requires w,h");
        const { w, h } = parseSize(args.shift());
        params.size = { width: w * GRID, height: h * GRID };
        break;
      }
      default:
        die(`unknown option: ${flag}`);
    }
  }

  const result = await rpcCall("canvas.tileCreate", params);
  console.log(result.tileId);
}

async function cmdTileRm(args) {
  if (args.length === 0) die("tile rm requires a tile id");
  const tileId = args[0];
  await rpcCall("canvas.tileRemove", { tileId });
  console.log(`removed ${tileId}`);
}

async function cmdTileMove(args) {
  if (args.length === 0) die("tile move requires a tile id");
  const tileId = args.shift();
  let pos = null;

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--pos") {
      if (args.length === 0) die("--pos requires x,y");
      pos = parsePos(args.shift());
    } else {
      die(`unknown option: ${flag}`);
    }
  }
  if (!pos) die("tile move requires --pos x,y");

  await rpcCall("canvas.tileMove", {
    tileId,
    position: { x: pos.x * GRID, y: pos.y * GRID },
  });
  console.log(`moved ${tileId} to ${pos.x},${pos.y}`);
}

async function cmdTileResize(args) {
  if (args.length === 0) die("tile resize requires a tile id");
  const tileId = args.shift();
  let size = null;

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--size") {
      if (args.length === 0) die("--size requires w,h");
      size = parseSize(args.shift());
    } else {
      die(`unknown option: ${flag}`);
    }
  }
  if (!size) die("tile resize requires --size w,h");

  await rpcCall("canvas.tileResize", {
    tileId,
    size: { width: size.w * GRID, height: size.h * GRID },
  });
  console.log(`resized ${tileId} to ${size.w},${size.h}`);
}

async function cmdTileFocus(args) {
  if (args.length === 0) die("tile focus requires at least one tile id");
  await rpcCall("canvas.tileFocus", { tileIds: args });
  console.log(`focused ${args.join(" ")}`);
}

async function cmdTileNotify(args) {
  if (args.length === 0) die("tile notify requires a tile id");
  const tileId = args.shift();
  const message = args.length > 0 ? args.join(" ") : undefined;
  await rpcCall("canvas.tileNotify", { tileId, message });
  console.log(`notified ${tileId}`);
}

async function cmdTerminalWrite(args) {
  if (args.length < 2) die("terminal write requires <id> <input>");
  const tileId = args[0];
  const input = args[1];
  await rpcCall("canvas.terminalWrite", { tileId, input });
  console.log(`wrote to ${tileId}`);
}

async function cmdTerminalRead(args) {
  if (args.length === 0) die("terminal read requires a tile id");
  const tileId = args.shift();
  let lines = 50;

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--lines") {
      if (args.length === 0) die("--lines requires a number");
      lines = Number(args.shift());
      if (!Number.isInteger(lines) || lines <= 0) die("--lines must be a positive integer");
    } else {
      die(`unknown option: ${flag}`);
    }
  }

  const result = await rpcCall("canvas.terminalRead", { tileId, lines });
  console.log(pretty(result));
}

// --- browser subcommands --------------------------------------------------

async function cmdBrowserNavigate(args) {
  if (args.length < 2) die("browser navigate requires <id> <url>");
  const tileId = args[0];
  const url = args[1];
  const result = await rpcCall("canvas.browserNavigate", { tileId, url });
  console.log(`navigated ${tileId} to ${result.url}`);
}

async function cmdBrowserScreenshot(args) {
  if (args.length === 0) die("browser screenshot requires a tile id");
  const tileId = args.shift();
  let outFile = null;

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--out") {
      if (args.length === 0) die("--out requires a file path");
      outFile = resolve(args.shift());
    } else {
      die(`unknown option: ${flag}`);
    }
  }

  const result = await rpcCall("canvas.browserScreenshot", { tileId });
  if (outFile) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outFile, Buffer.from(result.data, "base64"));
    console.log(`screenshot saved to ${outFile}`);
  } else {
    console.log(result.data);
  }
}

async function cmdBrowserSnapshot(args) {
  if (args.length === 0) die("browser snapshot requires a tile id");
  const tileId = args[0];
  const result = await rpcCall("canvas.browserSnapshot", { tileId });
  console.log(pretty(result));
}

async function cmdBrowserClick(args) {
  if (args.length < 2) die("browser click requires <id> <selector>");
  const tileId = args[0];
  const selector = args[1];
  await rpcCall("canvas.browserClick", { tileId, selector });
  console.log(`clicked ${selector} in ${tileId}`);
}

async function cmdBrowserType(args) {
  if (args.length < 3) die("browser type requires <id> <selector> <text>");
  const tileId = args[0];
  const selector = args[1];
  const text = args[2];
  await rpcCall("canvas.browserType", { tileId, selector, text });
  console.log(`typed into ${selector} in ${tileId}`);
}

async function cmdBrowserScroll(args) {
  if (args.length < 2) die("browser scroll requires <id> <deltaX,deltaY>");
  const tileId = args[0];
  const [xs, ys] = args[1].split(",");
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    die(`invalid scroll delta: ${args[1]}`);
  }
  await rpcCall("canvas.browserScroll", { tileId, x, y });
  console.log(`scrolled ${tileId} by ${x},${y}`);
}

async function cmdBrowserEvaluate(args) {
  if (args.length < 2) die("browser eval requires <id> <expression>");
  const tileId = args[0];
  const expression = args[1];
  const result = await rpcCall("canvas.browserEvaluate", {
    tileId, expression,
  });
  console.log(pretty(result));
}

async function cmdBrowserWait(args) {
  if (args.length === 0) die("browser wait requires a tile id");
  const tileId = args.shift();
  let timeout;

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--timeout") {
      if (args.length === 0) die("--timeout requires ms");
      timeout = Number(args.shift());
      if (!Number.isFinite(timeout) || timeout <= 0) {
        die("--timeout must be a positive number");
      }
    } else {
      die(`unknown option: ${flag}`);
    }
  }

  const params = { tileId };
  if (timeout) params.timeout = timeout;
  const result = await rpcCall("canvas.browserWait", params);
  console.log(result.status);
}

async function cmdBrowserInfo(args) {
  if (args.length === 0) die("browser info requires a tile id");
  const tileId = args[0];
  const result = await rpcCall("canvas.browserInfo", { tileId });
  console.log(pretty(result));
}

// --- usage ----------------------------------------------------------------

function usage() {
  console.log(`collab-canvas — control the Collaborator canvas from the command line

USAGE
  collab-canvas <command> [options]

COMMANDS
  tile list                          List all tiles on the canvas
  tile create <type> [options]       Create a new tile
  tile rm <id>                       Remove a tile
  tile move <id> --pos x,y           Move a tile
  tile resize <id> --size w,h        Resize a tile
  tile focus <id> [<id>...]          Bring tiles into view
  tile notify <id>                   Show notification for a tile
  terminal write <id> <input>        Send input to a terminal tile
  terminal read <id> [--lines N]     Read output from a terminal tile
  browser navigate <id> <url>        Navigate browser tile to URL
  browser screenshot <id> [--out f]  Capture screenshot (base64 or file)
  browser snapshot <id>              Get DOM tree of browser tile
  browser click <id> <selector>      Click element in browser tile
  browser type <id> <sel> <text>     Type text into element
  browser scroll <id> <dx,dy>       Scroll by delta (pixels)
  browser eval <id> <expression>    Run JS and return result
  browser wait <id> [--timeout ms]  Wait for page load
  browser info <id>                 Get URL, title, load state
  help, --help                       Show this help

TILE CREATE OPTIONS
  <type>          Tile type: term, note, code, image, graph, browser, pdf
  --file <path>   File to open in the tile
  --url <url>     URL to open in a browser tile
  --pos x,y       Position in grid units (default: auto)
  --size w,h      Size in grid units (default: type-dependent)

TILE MOVE OPTIONS
  --pos x,y       New position in grid units

TILE RESIZE OPTIONS
  --size w,h      New size in grid units

TERMINAL READ OPTIONS
  --lines N       Number of lines to capture (default: 50)

BROWSER SCREENSHOT OPTIONS
  --out <path>    Save screenshot to file instead of printing base64

COORDINATES
  All coordinates are in grid units.
  One grid unit = 20 pixels on the canvas.

EXIT CODES
  0   Success
  1   RPC error
  2   Connection failure

VERSION
  collab-canvas v${VERSION}`);
  process.exit(0);
}

// --- main dispatch --------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.length === 0) usage();

try {
  const cmd = argv[0];
  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    case "--version":
    case "-v":
      console.log(`collab-canvas v${VERSION}`);
      break;
    case "tile": {
      if (argv.length < 2) {
        die("tile requires a subcommand (list, create, rm, move, resize, focus, notify)");
      }
      const sub = argv[1];
      const rest = argv.slice(2);
      switch (sub) {
        case "list":   await cmdTileList(); break;
        case "create": await cmdTileCreate(rest); break;
        case "rm":     await cmdTileRm(rest); break;
        case "move":   await cmdTileMove(rest); break;
        case "resize": await cmdTileResize(rest); break;
        case "focus":  await cmdTileFocus(rest); break;
        case "notify": await cmdTileNotify(rest); break;
        default: die(`unknown tile subcommand: ${sub}`);
      }
      break;
    }
    case "terminal": {
      if (argv.length < 2) {
        die("terminal requires a subcommand (write, read)");
      }
      const sub = argv[1];
      const rest = argv.slice(2);
      switch (sub) {
        case "write": await cmdTerminalWrite(rest); break;
        case "read":  await cmdTerminalRead(rest); break;
        default: die(`unknown terminal subcommand: ${sub}`);
      }
      break;
    }
    case "browser": {
      if (argv.length < 2) {
        die("browser requires a subcommand (navigate, screenshot, snapshot, click, type, scroll, eval, wait, info)");
      }
      const sub = argv[1];
      const rest = argv.slice(2);
      switch (sub) {
        case "navigate":   await cmdBrowserNavigate(rest); break;
        case "screenshot": await cmdBrowserScreenshot(rest); break;
        case "snapshot":   await cmdBrowserSnapshot(rest); break;
        case "click":      await cmdBrowserClick(rest); break;
        case "type":       await cmdBrowserType(rest); break;
        case "scroll":     await cmdBrowserScroll(rest); break;
        case "eval":       await cmdBrowserEvaluate(rest); break;
        case "wait":       await cmdBrowserWait(rest); break;
        case "info":       await cmdBrowserInfo(rest); break;
        default: die(`unknown browser subcommand: ${sub}`);
      }
      break;
    }
    default:
      die(`unknown command: ${cmd} (try: collab-canvas --help)`);
  }
} catch (err) {
  die(err.message);
}
