const URL_REGEX =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;
const URL_COLOR = "\x1b[38;2;0;150;255m";
const RESET = "\x1b[0m";

/**
 * Wrap bare http/https URLs in PTY output with ANSI color codes.
 * Each matched URL gets wrapped in: URL_COLOR + url + RESET.
 */
export function colorizeUrls(text: string): string {
  const regex = new RegExp(URL_REGEX.source, (URL_REGEX.flags || "") + "g");
  return text.replace(regex, (url) => URL_COLOR + url + RESET);
}
