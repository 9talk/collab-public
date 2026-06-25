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

export const EXTERNAL_APP_EXTENSIONS_LIST = [...EXTERNAL_APP_EXTENSIONS];

export function isExternalAppFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return EXTERNAL_APP_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

const CODE_FILE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".htm",
  ".svg",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".proto",
]);

export function isCodeFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return CODE_FILE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

// --- Data model ---

export interface FileTypeGroup {
  name: string;
  editorId: string;
  patterns: string[];
}

export const DEFAULT_IGNORED_PATTERNS = [
  "node_modules",
  ".git",
  "dist",
  "*.log",
  ".DS_Store",
  "__pycache__",
  ".next",
  "build",
  "out",
  ".cache",
  ".idea",
  ".vscode",
  ".collaborator",
];

const SYSTEM_APP_PATTERNS = EXTERNAL_APP_EXTENSIONS_LIST.map(
  (ext) => `*${ext}`,
);

export function getDefaultFileTypeGroups(): FileTypeGroup[] {
  return [
    {
      name: "Markdown",
      editorId: "",
      patterns: ["*.md", "*.markdown", "*.mdx"],
    },
    {
      name: "JSON",
      editorId: "",
      patterns: ["*.json"],
    },
    {
      name: "YAML",
      editorId: "",
      patterns: ["*.yaml", "*.yml"],
    },
    {
      name: "TOML",
      editorId: "",
      patterns: ["*.toml"],
    },
    {
      name: "XML",
      editorId: "",
      patterns: ["*.xml", "*.svg"],
    },
    {
      name: "JavaScript",
      editorId: "",
      patterns: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
    },
    {
      name: "TypeScript",
      editorId: "",
      patterns: ["*.ts", "*.tsx"],
    },
    {
      name: "Python",
      editorId: "",
      patterns: ["*.py"],
    },
    {
      name: "Go",
      editorId: "",
      patterns: ["*.go"],
    },
    {
      name: "Rust",
      editorId: "",
      patterns: ["*.rs"],
    },
    {
      name: "Java / Kotlin",
      editorId: "",
      patterns: ["*.java", "*.kt"],
    },
    {
      name: "Swift",
      editorId: "",
      patterns: ["*.swift"],
    },
    {
      name: "C / C++",
      editorId: "",
      patterns: ["*.c", "*.cpp", "*.h", "*.hpp"],
    },
    {
      name: "C#",
      editorId: "",
      patterns: ["*.cs"],
    },
    {
      name: "CSS",
      editorId: "",
      patterns: ["*.css", "*.scss", ".less"],
    },
    {
      name: "HTML",
      editorId: "",
      patterns: ["*.html", "*.htm"],
    },
    {
      name: "Shell",
      editorId: "",
      patterns: ["*.sh", "*.bash", "*.zsh"],
    },
    {
      name: "SQL",
      editorId: "",
      patterns: ["*.sql"],
    },
    {
      name: "GraphQL",
      editorId: "",
      patterns: ["*.graphql"],
    },
    {
      name: "Protobuf",
      editorId: "",
      patterns: ["*.proto"],
    },
    {
      name: "Plain Text",
      editorId: "",
      patterns: ["*.txt"],
    },
    {
      name: "Ruby",
      editorId: "",
      patterns: ["*.rb"],
    },
    {
      name: "Office",
      editorId: "system-app",
      patterns: SYSTEM_APP_PATTERNS,
    },
  ];
}

/**
 * Match a file extension against a pattern string.
 * Handles patterns like "*.md", ".md", "Makefile", etc.
 */
export function matchesPattern(ext: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) return ext === p.slice(1);
  if (p.startsWith(".")) return ext === p;
  return false;
}
