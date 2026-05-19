import { useState, useRef, useEffect } from "react";

interface BrowserTileProps {
  tileId: string;
  url?: string;
}

export default function BrowserTile({ url }: BrowserTileProps) {
  const [currentUrl, setCurrentUrl] = useState(url || "https://www.google.com");
  const [inputUrl, setInputUrl] = useState(currentUrl);
  const [isLoading, setIsLoading] = useState(false);
  const webviewRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (url) {
      setCurrentUrl(url);
      setInputUrl(url);
    }
  }, [url]);

  const navigate = () => {
    setCurrentUrl(inputUrl);
    setIsLoading(true);
  };

  const handleLoad = () => {
    setIsLoading(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-gray-700 px-2 py-1">
        <button
          onClick={() => webviewRef.current?.contentWindow?.history.back()}
          className="rounded px-2 py-1 text-sm hover:bg-gray-700"
        >
          ←
        </button>
        <button
          onClick={() => webviewRef.current?.contentWindow?.history.forward()}
          className="rounded px-2 py-1 text-sm hover:bg-gray-700"
        >
          →
        </button>
        <button
          onClick={navigate}
          className="rounded px-2 py-1 text-sm hover:bg-gray-700"
        >
          ↻
        </button>
        <input
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && navigate()}
          className="flex-1 rounded bg-gray-800 px-2 py-1 text-sm"
          placeholder="Enter URL..."
        />
        {isLoading && <span className="text-xs text-gray-400">Loading...</span>}
      </div>
      <div className="flex-1 overflow-hidden">
        <iframe
          ref={webviewRef}
          src={currentUrl}
          className="h-full w-full border-0"
          onLoad={handleLoad}
        />
      </div>
    </div>
  );
}
