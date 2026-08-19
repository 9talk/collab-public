// 文件树/搜索/计数的默认忽略规则（单一事实来源）。
// 设置面板 Files 页可编辑，消费方：file-filter、git-replay-worker、settings UI。
const VCS_AND_APP_PATTERNS = [".git", ".collaborator", ".idea", ".vscode"];

const DEPENDENCY_PATTERNS = [
  "node_modules",
  "bower_components",
  ".venv",
  "venv",
  "site-packages",
];

const BUILD_OUTPUT_PATTERNS = [
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  "__pycache__",
];

const OS_JUNK_PATTERNS = [".DS_Store", "Thumbs.db", "~*"];

const COMPILED_JS_PATTERNS = ["*.min.js", "*.min.css", "*.map"];

const LOCK_AND_LOG_PATTERNS = [
  "*.lock",
  "*.log",
  "package-lock.json",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
];

// Binary / compiled files
const BINARY_PATTERNS = [
  "*.dylib",
  "*.so",
  "*.dll",
  "*.exe",
  "*.o",
  "*.a",
  "*.lib",
  "*.class",
  "*.pyc",
  "*.pyo",
  "*.node",
  "*.wasm",
];

// Images (only non-workspace icon formats)
const IMAGE_PATTERNS = ["*.svg", "*.ico", "*.icns"];

// Audio / video
const MEDIA_PATTERNS = ["*.mp3", "*.mp4", "*.wav", "*.mov", "*.webm"];

// Unity / C#
const UNITY_PATTERNS = [
  "*.meta",
  "*.unity",
  "*.prefab",
  "*.mat",
  "*.asset",
  "*.shader",
  "*.cginc",
  "*.asmdef",
  "*.asmref",
  "*.physicMaterial",
  "*.physicsMaterial2D",
  "*.controller",
  "*.overrideController",
  "*.mask",
  "*.lighting",
  "*.terrainlayer",
  "Library",
  "Temp",
  "Obj",
  "Logs",
  "UserSettings",
  "*.pdb",
];

// Fonts
const FONT_PATTERNS = ["*.ttf", "*.otf", "*.woff", "*.woff2"];

// Design files
const DESIGN_PATTERNS = ["*.psd", "*.psb"];

// 3D models
const MODEL_PATTERNS = ["*.fbx", "*.obj", "*.blend"];

// Locale / resource packs
const RESOURCE_PATTERNS = ["*.pak"];

// Bundled frameworks (e.g. Vuplex Chromium)
const BUNDLE_PATTERNS = ["*.bundle", "*.framework"];

// Archives
const ARCHIVE_PATTERNS = ["*.zip", "*.tar", "*.gz", "*.rar", "*.7z"];

// Java / Android
const JAVA_ANDROID_PATTERNS = ["*.jar", "*.aar"];

export const DEFAULT_IGNORE_PATTERNS: string[] = [
  ...VCS_AND_APP_PATTERNS,
  ...DEPENDENCY_PATTERNS,
  ...BUILD_OUTPUT_PATTERNS,
  ...OS_JUNK_PATTERNS,
  ...COMPILED_JS_PATTERNS,
  ...LOCK_AND_LOG_PATTERNS,
  ...BINARY_PATTERNS,
  ...IMAGE_PATTERNS,
  ...MEDIA_PATTERNS,
  ...UNITY_PATTERNS,
  ...FONT_PATTERNS,
  ...DESIGN_PATTERNS,
  ...MODEL_PATTERNS,
  ...RESOURCE_PATTERNS,
  ...BUNDLE_PATTERNS,
  ...ARCHIVE_PATTERNS,
  ...JAVA_ANDROID_PATTERNS,
];

export function filterIgnorePatterns(
  patterns: string[],
  query: string,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return patterns;
  return patterns.filter((p) => p.toLowerCase().includes(q));
}
