import { useState, useEffect } from "react";
import { FileImage } from "@phosphor-icons/react";
import { toCollabFileUrl } from "@collab/shared/collab-file-url";
import { displayBasename } from "@collab/shared/path-utils";

const NATIVE_IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
]);

function nativeImageUrl(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  if (!NATIVE_IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())) {
    return null;
  }
  return toCollabFileUrl(path);
}

interface ImageViewProps {
  filePath: string;
  fileStats: { ctime: string; mtime: string } | null;
  theme: "light" | "dark";
  className?: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ImageView({
  filePath,
  fileStats,
  theme,
  className,
}: ImageViewProps) {
  const nativeUrl = nativeImageUrl(filePath);

  const [imageData, setImageData] = useState<{
    url: string;
    width: number;
    height: number;
  } | null>(nativeUrl ? { url: nativeUrl, width: 0, height: 0 } : null);
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(!nativeUrl);

  const filename = displayBasename(filePath) || filePath;

  useEffect(() => {
    const url = nativeImageUrl(filePath);
    if (url) {
      setImageData({ url, width: 0, height: 0 });
      setLoading(false);
      setError(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(false);
    setDimensions(null);

    window.api
      .getImageFull(filePath)
      .then((data) => {
        if (!cancelled) {
          setImageData(data);
          if (data.width > 0 && data.height > 0) {
            setDimensions({ width: data.width, height: data.height });
          }
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (loading) {
    return (
      <div className={`image-view${className ? ` ${className}` : ""}`}>
        <div className="image-view-loading">
          <div className="loading-spinner" />
        </div>
      </div>
    );
  }

  if (error || !imageData) {
    return (
      <div className={`image-view${className ? ` ${className}` : ""}`}>
        <div className="image-view-error">
          <FileImage size={48} weight="thin" />
          <span>Preview unavailable</span>
        </div>
      </div>
    );
  }

  const hasMeta = !!dimensions || !!fileStats;

  return (
    <div className={`image-view${className ? ` ${className}` : ""}`}>
      <div className="image-view-container">
        <img
          src={imageData.url}
          alt={filename}
          draggable={false}
          style={dimensions ? {
            width: dimensions.width / window.devicePixelRatio,
            height: dimensions.height / window.devicePixelRatio,
          } : { visibility: "hidden" }}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth > 0) {
              setDimensions({
                width: img.naturalWidth,
                height: img.naturalHeight,
              });
            }
          }}
        />
      </div>
      {hasMeta && (
        <div className="image-view-banner">
          {dimensions && (
            <span className="image-view-banner-item">
              {dimensions.width} {"\u00d7"} {dimensions.height}
            </span>
          )}
          {fileStats && (
            <span className="image-view-banner-item">
              <span className="image-view-banner-key">Created</span>
              {formatDate(fileStats.ctime)}
            </span>
          )}
          {fileStats && (
            <span className="image-view-banner-item">
              <span className="image-view-banner-key">Modified</span>
              {formatDate(fileStats.mtime)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
