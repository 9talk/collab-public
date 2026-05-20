interface FolderNode {
  name: string;
  children: Map<string, FolderNode>;
  hue: number;
}

const ROOT_FILES_KEY = "\0root";

export function buildHueMap(filePaths: string[]): Map<string, number> {
  const root: FolderNode = { name: "", children: new Map(), hue: 0 };
  let hasRootFiles = false;

  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    if (parts.length === 1) {
      hasRootFiles = true;
    } else {
      let current = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const segment = parts[i];
        if (!current.children.has(segment)) {
          current.children.set(segment, {
            name: segment,
            children: new Map(),
            hue: 0,
          });
        }
        current = current.children.get(segment)!;
      }
    }
  }

  if (hasRootFiles) {
    root.children.set(ROOT_FILES_KEY, {
      name: ROOT_FILES_KEY,
      children: new Map(),
      hue: 0,
    });
  }

  assignHues(root, 0, 360);

  const rootHue = root.children.get(ROOT_FILES_KEY)?.hue ?? -1;
  const hueMap = new Map<string, number>();
  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    if (parts.length === 1) {
      hueMap.set(filePath, rootHue);
      continue;
    }
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      current = current.children.get(parts[i])!;
    }
    hueMap.set(filePath, current.hue);
  }

  return hueMap;
}

function assignHues(
  node: FolderNode,
  rangeStart: number,
  rangeEnd: number,
): void {
  const children = Array.from(node.children.values());
  if (children.length === 0) return;

  const sliceSize = (rangeEnd - rangeStart) / children.length;
  for (let i = 0; i < children.length; i++) {
    const childStart = rangeStart + i * sliceSize;
    const childEnd = childStart + sliceSize;
    children[i].hue = (childStart + childEnd) / 2;
    assignHues(children[i], childStart, childEnd);
  }
}

export function hueToColor(hue: number, isDark: boolean): string {
  if (hue < 0) {
    return isDark ? "hsl(0, 0%, 60%)" : "hsl(0, 0%, 55%)";
  }
  const saturation = isDark ? 60 : 70;
  const lightness = isDark ? 65 : 45;
  return `hsl(${Math.round(hue)}, ${saturation}%, ${lightness}%)`;
}
