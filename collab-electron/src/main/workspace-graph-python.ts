import { readdir, readFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { SyntaxNodeRef } from "@lezer/common";
import { parser as pythonParser } from "@lezer/python";
import { isPathWithinDirectory, type CollectedFile } from "./workspace-graph";

export const PYTHON_CODE_EXTENSIONS = new Set([".py", ".pyi"]);

const PYTHON_SEARCH_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "__pycache__",
  ".venv",
  "venv",
  "site-packages",
]);

const PYTHON_CONFIG_FILE_NAMES = new Set([
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
]);

interface PythonRootCandidate {
  path: string;
  priority: number;
}

interface PythonModuleEntry {
  fileId: string;
  filePath: string;
  rootPath: string;
  moduleName: string;
  isPackageInit: boolean;
  isStub: boolean;
}

interface PythonFileInfo extends PythonModuleEntry {
  packageName: string;
}

interface PythonImportContext {
  fileInfoById: Map<string, PythonFileInfo>;
  moduleEntriesByName: Map<string, PythonModuleEntry[]>;
}

interface PythonImportStatement {
  kind: "import" | "from";
  moduleNames?: string[];
  moduleName?: string;
  relativeLevel?: number;
  importedNames?: string[];
}

export async function buildPythonImportLinks(
  pythonFiles: Array<
    CollectedFile & {
      analysisType: "code";
    }
  >,
  workspacePath: string,
  nodeIds: Set<string>,
): Promise<Array<{ source: string; target: string }>> {
  if (pythonFiles.length === 0) {
    return [];
  }

  const context = await buildPythonImportContext(pythonFiles, workspacePath);
  const links: Array<{
    source: string;
    target: string;
  }> = [];
  const seenLinks = new Set<string>();

  for (const file of pythonFiles) {
    const fileInfo = context.fileInfoById.get(file.id);
    if (!fileInfo) {
      continue;
    }

    let content: string;
    try {
      content = await readFile(file.path, "utf-8");
    } catch {
      continue;
    }

    const statements = extractPythonImportStatements(content);
    for (const statement of statements) {
      const targets = resolvePythonImportTargets(statement, fileInfo, context);
      for (const target of targets) {
        if (!nodeIds.has(target) || target === file.id) {
          continue;
        }

        const key = `${file.id}->${target}`;
        if (seenLinks.has(key)) {
          continue;
        }
        seenLinks.add(key);
        links.push({
          source: file.id,
          target,
        });
      }
    }
  }

  return links;
}

async function buildPythonImportContext(
  pythonFiles: Array<
    CollectedFile & {
      analysisType: "code";
    }
  >,
  workspacePath: string,
): Promise<PythonImportContext> {
  const roots = await listPythonRoots(workspacePath, pythonFiles);
  const fileInfoById = new Map<string, PythonFileInfo>();
  const moduleEntriesByName = new Map<string, PythonModuleEntry[]>();

  for (const file of pythonFiles) {
    const fileInfo = createPythonFileInfo(file, roots);
    if (!fileInfo) {
      continue;
    }

    fileInfoById.set(file.id, fileInfo);
    if (!fileInfo.moduleName) {
      continue;
    }

    const entries = moduleEntriesByName.get(fileInfo.moduleName) ?? [];
    entries.push(fileInfo);
    moduleEntriesByName.set(fileInfo.moduleName, entries);
  }

  return {
    fileInfoById,
    moduleEntriesByName,
  };
}

async function listPythonRoots(
  workspacePath: string,
  pythonFiles: Array<
    CollectedFile & {
      analysisType: "code";
    }
  >,
): Promise<PythonRootCandidate[]> {
  const roots = new Map<string, number>();
  addPythonRootCandidate(roots, workspacePath, 0);

  for (const file of pythonFiles) {
    for (const dirPath of listAncestorPaths(file.path, workspacePath)) {
      if (basename(dirPath) === "src") {
        addPythonRootCandidate(roots, dirPath, 50);
      }
    }
  }

  const configPaths = await listPythonConfigPaths(workspacePath);
  for (const configPath of configPaths) {
    const configDir = dirname(configPath);
    addPythonRootCandidate(roots, configDir, 100);

    try {
      const content = await readFile(configPath, "utf-8");
      for (const rootPath of extractPythonPackageRoots(configDir, content)) {
        addPythonRootCandidate(roots, rootPath, 200);
      }
    } catch {
      // Ignore unreadable package configs and fall back to workspace/src heuristics.
    }

    const srcPath = join(configDir, "src");
    if (pythonFiles.some((file) => isPathWithinDirectory(file.path, srcPath))) {
      addPythonRootCandidate(roots, srcPath, 150);
    }
  }

  return Array.from(roots.entries())
    .map(([path, priority]) => ({
      path,
      priority,
    }))
    .sort(comparePythonRoots);
}

async function listPythonConfigPaths(workspacePath: string): Promise<string[]> {
  const configPaths: string[] = [];

  await collectPythonConfigPaths(workspacePath, configPaths);

  return configPaths;
}

async function collectPythonConfigPaths(
  dirPath: string,
  configPaths: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, {
      withFileTypes: true,
    });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (PYTHON_SEARCH_IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await collectPythonConfigPaths(fullPath, configPaths);
      continue;
    }

    if (entry.isFile() && PYTHON_CONFIG_FILE_NAMES.has(entry.name)) {
      configPaths.push(fullPath);
    }
  }
}

function addPythonRootCandidate(
  roots: Map<string, number>,
  path: string,
  priority: number,
): void {
  const existing = roots.get(path);
  if (existing === undefined || priority > existing) {
    roots.set(path, priority);
  }
}

function comparePythonRoots(
  a: PythonRootCandidate,
  b: PythonRootCandidate,
): number {
  return b.priority - a.priority || b.path.length - a.path.length;
}

function listAncestorPaths(filePath: string, workspacePath: string): string[] {
  const ancestors: string[] = [];
  let currentPath = dirname(filePath);

  while (isPathWithinDirectory(currentPath, workspacePath)) {
    ancestors.push(currentPath);
    if (currentPath === workspacePath) {
      break;
    }
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return ancestors;
}

function extractPythonPackageRoots(
  configDir: string,
  content: string,
): string[] {
  const roots = new Set<string>();
  const addRoot = (rawPath: string | undefined): void => {
    const candidate = normalizePythonRootPath(rawPath);
    if (!candidate) {
      return;
    }
    roots.add(resolve(configDir, candidate));
  };

  for (const match of content.matchAll(/\bfrom\s*=\s*["']([^"']+)["']/g)) {
    addRoot(match[1]);
  }
  for (const match of content.matchAll(/\bwhere\s*=\s*["']([^"']+)["']/g)) {
    addRoot(match[1]);
  }
  for (const match of content.matchAll(/\bwhere\s*=\s*\[([^\]]+)\]/g)) {
    const arrayContent = match[1];
    if (!arrayContent) {
      continue;
    }
    for (const quotedPath of arrayContent.matchAll(/["']([^"']+)["']/g)) {
      addRoot(quotedPath[1]);
    }
  }
  for (const match of content.matchAll(
    /\bfind(?:_namespace)?_packages\s*\(\s*where\s*=\s*["']([^"']+)["']/g,
  )) {
    addRoot(match[1]);
  }
  for (const match of content.matchAll(
    /\bpackage[-_]dir\s*=\s*\{([\s\S]*?)\}/g,
  )) {
    const objectContent = match[1];
    if (!objectContent) {
      continue;
    }
    for (const valueMatch of objectContent.matchAll(
      /["']{0,1}\s*["']{0,1}\s*[:=]\s*["']([^"']+)["']/g,
    )) {
      addRoot(valueMatch[1]);
    }
  }
  for (const match of content.matchAll(
    /\bpackage_dir\s*=\s*(?:\r?\n[ \t]+=\s*([^\n#]+))/g,
  )) {
    addRoot(match[1]);
  }

  return Array.from(roots);
}

function normalizePythonRootPath(rawPath: string | undefined): string | null {
  if (!rawPath) {
    return null;
  }

  const candidate = rawPath.trim();
  if (candidate.length === 0 || candidate === ".") {
    return null;
  }

  return candidate;
}

function createPythonFileInfo(
  file: CollectedFile & {
    analysisType: "code";
  },
  roots: PythonRootCandidate[],
): PythonFileInfo | null {
  const root = roots.find((candidate) =>
    isPathWithinDirectory(file.path, candidate.path),
  );
  if (!root) {
    return null;
  }

  const relativePath = relative(root.path, file.path).replaceAll("\\", "/");
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    return null;
  }

  const extension = extname(relativePath);
  const pathWithoutExtension = relativePath.slice(0, -extension.length);
  const isPackageInit = basename(pathWithoutExtension) === "__init__";
  const moduleName = (
    isPackageInit ? dirname(pathWithoutExtension) : pathWithoutExtension
  )
    .replaceAll("/", ".")
    .replace(/^\.$/, "");

  return {
    fileId: file.id,
    filePath: file.path,
    rootPath: root.path,
    moduleName,
    packageName: isPackageInit ? moduleName : getParentModuleName(moduleName),
    isPackageInit,
    isStub: extension === ".pyi",
  };
}

function getParentModuleName(moduleName: string): string {
  const lastDot = moduleName.lastIndexOf(".");
  return lastDot === -1 ? "" : moduleName.slice(0, lastDot);
}

function extractPythonImportStatements(
  content: string,
): PythonImportStatement[] {
  const tree = pythonParser.parse(content);
  const statements: PythonImportStatement[] = [];

  tree.iterate({
    enter(node: SyntaxNodeRef) {
      if (node.name !== "ImportStatement") {
        return;
      }

      const statement = parsePythonImportStatement(
        content.slice(node.from, node.to),
      );
      if (statement) {
        statements.push(statement);
      }

      return false;
    },
  });

  return statements;
}

function parsePythonImportStatement(
  statementSource: string,
): PythonImportStatement | null {
  const compactSource = statementSource
    .replaceAll(/\\\r?\n/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

  if (compactSource.startsWith("import ")) {
    const moduleNames = splitImportList(compactSource.slice("import ".length));
    return moduleNames.length > 0
      ? {
          kind: "import",
          moduleNames,
        }
      : null;
  }

  if (!compactSource.startsWith("from ")) {
    return null;
  }

  const match = compactSource.match(/^from\s+(.+?)\s+import\s+(.+)$/);
  if (!match) {
    return null;
  }

  const moduleSpecifier = (match[1] ?? "").trim();
  const importedNames = splitImportList(
    (match[2] ?? "")
      .trim()
      .replace(/^\(\s*/, "")
      .replace(/\s*\)$/, ""),
  );
  const relativeLevel = moduleSpecifier.match(/^\.+/)?.[0].length ?? 0;
  const moduleName = moduleSpecifier.slice(relativeLevel);

  return {
    kind: "from",
    moduleName,
    relativeLevel,
    importedNames,
  };
}

function splitImportList(importListSource: string): string[] {
  return importListSource
    .split(",")
    .map((entry) => entry.trim().replace(/\s+as\s+.+$/, ""))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolvePythonImportTargets(
  statement: PythonImportStatement,
  fileInfo: PythonFileInfo,
  context: PythonImportContext,
): string[] {
  const targets = new Set<string>();

  if (statement.kind === "import") {
    for (const moduleName of statement.moduleNames ?? []) {
      const target = resolvePythonModuleTarget(moduleName, fileInfo, context);
      if (target) {
        targets.add(target);
      }
    }
    return Array.from(targets);
  }

  const resolvedBaseModule = resolvePythonFromBaseModule(statement, fileInfo);
  if (resolvedBaseModule === null) {
    return [];
  }

  const baseTarget =
    resolvedBaseModule.length > 0
      ? resolvePythonModuleTarget(resolvedBaseModule, fileInfo, context)
      : null;
  for (const importedName of statement.importedNames ?? []) {
    if (importedName === "*") {
      if (baseTarget) {
        targets.add(baseTarget);
      }
      continue;
    }

    const submoduleName = joinPythonModuleName(
      resolvedBaseModule,
      importedName,
    );
    const submoduleTarget =
      submoduleName.length > 0
        ? resolvePythonModuleTarget(submoduleName, fileInfo, context)
        : null;
    if (submoduleTarget) {
      targets.add(submoduleTarget);
      continue;
    }
    if (baseTarget) {
      targets.add(baseTarget);
    }
  }

  return Array.from(targets);
}

function resolvePythonFromBaseModule(
  statement: PythonImportStatement,
  fileInfo: PythonFileInfo,
): string | null {
  const relativeLevel = statement.relativeLevel ?? 0;
  const moduleParts = splitPythonModuleName(statement.moduleName ?? "");
  if (relativeLevel === 0) {
    return joinPythonModuleParts(moduleParts);
  }

  const packageParts = splitPythonModuleName(fileInfo.packageName);
  const ascendCount = relativeLevel - 1;
  if (ascendCount > packageParts.length) {
    return null;
  }

  return joinPythonModuleParts([
    ...packageParts.slice(0, packageParts.length - ascendCount),
    ...moduleParts,
  ]);
}

function splitPythonModuleName(moduleName: string): string[] {
  return moduleName
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function joinPythonModuleName(baseModuleName: string, suffix: string): string {
  return joinPythonModuleParts([
    ...splitPythonModuleName(baseModuleName),
    ...splitPythonModuleName(suffix),
  ]);
}

function joinPythonModuleParts(parts: string[]): string {
  return parts.join(".");
}

function resolvePythonModuleTarget(
  moduleName: string,
  sourceFile: PythonFileInfo,
  context: PythonImportContext,
): string | null {
  const entries = context.moduleEntriesByName.get(moduleName);
  if (!entries || entries.length === 0) {
    return null;
  }

  const bestMatch = [...entries].sort((a, b) =>
    comparePythonModuleEntries(a, b, sourceFile),
  )[0];

  return bestMatch?.fileId ?? null;
}

function comparePythonModuleEntries(
  a: PythonModuleEntry,
  b: PythonModuleEntry,
  sourceFile: PythonFileInfo,
): number {
  return (
    Number(b.rootPath === sourceFile.rootPath) -
      Number(a.rootPath === sourceFile.rootPath) ||
    Number(a.isStub) - Number(b.isStub) ||
    Number(a.isPackageInit) - Number(b.isPackageInit) ||
    a.fileId.localeCompare(b.fileId)
  );
}
