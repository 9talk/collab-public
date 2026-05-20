interface EditorConflictBannerProps {
  onReload: () => void;
  onOverwrite: () => void;
}

export function EditorConflictBanner({
  onReload,
  onOverwrite,
}: EditorConflictBannerProps) {
  return (
    <div className="editor-conflict-banner">
      <span>File changed on disk</span>
      <div className="editor-conflict-banner-actions">
        <button type="button" onClick={onReload}>
          Reload
        </button>
        <button type="button" onClick={onOverwrite}>
          Keep mine
        </button>
      </div>
    </div>
  );
}
