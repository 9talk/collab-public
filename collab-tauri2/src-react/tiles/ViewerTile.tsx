import { useEffect, useState } from "react";
import { readFile, listDir } from "@/lib/tauri";

interface ViewerTileProps {
  tileId: string;
  filePath?: string;
}

export default function ViewerTile({ filePath }: ViewerTileProps) {
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isDir, setIsDir] = useState<boolean>(false);
  const [dirEntries, setDirEntries] = useState<
    Array<{ name: string; is_dir: boolean }>
  >([]);

  useEffect(() => {
    if (!filePath) {
      setError("No file selected");
      return;
    }

    readFile(filePath)
      .then((text) => {
        setContent(text);
        setIsDir(false);
        setError("");
      })
      .catch(() => {
        // Maybe it's a directory, try listing
        listDir(filePath)
          .then((entries) => {
            setDirEntries(entries.map((e) => ({ name: e.name, is_dir: e.is_dir })));
            setIsDir(true);
            setError("");
          })
          .catch(() => {
            setError(`Cannot read: ${filePath}`);
          });
      });
  }, [filePath]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-red-400">{error}</p>
      </div>
    );
  }

  if (isDir) {
    return (
      <div className="flex h-full flex-col p-4">
        <h3 className="mb-2 text-sm font-semibold">{filePath}</h3>
        <div className="flex-1 overflow-auto">
          {dirEntries.map((entry) => (
            <div
              key={entry.name}
              className="flex items-center gap-2 py-1 text-sm"
            >
              <span>{entry.is_dir ? "📁" : "📄"}</span>
              <span>{entry.name}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-700 px-4 py-1 text-xs text-gray-400">
        {filePath}
      </div>
      <pre className="flex-1 overflow-auto p-4 text-sm font-mono">
        {content}
      </pre>
    </div>
  );
}
