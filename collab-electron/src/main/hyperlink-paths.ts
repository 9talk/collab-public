const OSC8_START = "\x1b]8;;";
const OSC8_ST = "\x1b\\";
const OSC8_END = "\x1b]8;;\x1b\\";

/**
 * Match absolute Unix file paths: requires at least two directory segments
 * and the final component must have a file extension (contain a dot).
 * This reduces false positives from flags, directory-only paths, etc.
 */
const ABSOLUTE_PATH = /(?:\/[^\s"'!(){}|\\^<>`*$]+){2,}\.[\w]+/g;

/**
 * Match relative file paths: ./foo/bar.ext or ../baz/qux.ext.
 * Requires a file extension to avoid matching command names, flags, etc.
 */
const RELATIVE_PATH = /(?:\.\.?\/[\w.\-]+(?:\/[\w.\-]+)*\.[\w]+)/g;

const ALL_PATHS = new RegExp(
  `${ABSOLUTE_PATH.source}|${RELATIVE_PATH.source}`,
  "g",
);

function wrapPath(match: string): string {
  const uri = `file://${encodeURI(match)}`;
  return `${OSC8_START}${uri}${OSC8_ST}${match}${OSC8_END}`;
}

/**
 * Wrap file paths in PTY output with OSC 8 hyperlink escape sequences.
 *
 * Safely handles ANSI escape sequences by splitting on \x1b (ESC) boundaries:
 *   - Segments starting with \x1b are escape sequences — left untouched
 *   - Other segments are plain text — path regex applied here
 *
 * This prevents corrupting OSC 7 (CWD reporting), existing OSC 8 links,
 * SGR color codes, and any other ANSI escape sequences in the terminal output.
 */
export function hyperlinkFilePaths(text: string): string {
  let result = "";
  let i = 0;

  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1b) {
      // Escape sequence: find the boundary — next \x1b or end of string.
      // Escape sequences like \x1b]7;...\x07 (OSC 7 with BEL terminator)
      // or \x1b[31m (SGR) are preserved verbatim.
      const nextEsc = text.indexOf("\x1b", i + 1);
      const end = nextEsc === -1 ? text.length : nextEsc;
      result += text.slice(i, end);
      i = end;
    } else {
      // Plain text segment: apply path matching.
      const nextEsc = text.indexOf("\x1b", i);
      const end = nextEsc === -1 ? text.length : nextEsc;
      result += text.slice(i, end).replace(ALL_PATHS, wrapPath);
      i = end;
    }
  }

  return result;
}
