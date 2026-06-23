const EXTERNAL_APP_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".pages",
  ".numbers",
  ".key",
  ".rtf",
]);

export function isExternalAppFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return EXTERNAL_APP_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}
