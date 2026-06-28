import { createRoot } from "react-dom/client";
import { Toaster, toast } from "sonner";
import "sonner/dist/styles.css";

let _focusTile: (tileId: string) => void = () => {};
let _getTile: any = null;

const toastTileMap = new Map<string | number, string>();

export function createCanvasNotifications({
  getTile,
  edgeIndicators,
  tileManager,
}: any) {
  _getTile = getTile;
  _focusTile = (tileId: string) => {
    const tile = _getTile(tileId);
    if (!tile) return;
    edgeIndicators.panToTile(tile);
    tileManager.focusCanvasTile(tileId);
  };

  let wrapper = document.getElementById("notif-sonner-root");
  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.id = "notif-sonner-root";
    document.body.appendChild(wrapper);
  }

  const root = createRoot(wrapper);
  root.render(
    <Toaster position="top-right" duration={Infinity} visibleToasts={3} />,
  );

  // Centralized dismiss — always keeps toastTileMap in sync
  function _dismissToast(toastId: string | number) {
    toast.dismiss(toastId);
    toastTileMap.delete(toastId);
  }

  function show(tileId: string, message?: string) {
    // Deduplicate: dismiss existing toast for the same tileId
    for (const [toastId, tid] of toastTileMap) {
      if (tid === tileId) {
        toast.dismiss(toastId);
        toastTileMap.delete(toastId);
      }
    }

    const tile = _getTile(tileId);
    if (!tile) return;

    const label = message
      ? `${tile.autoTitle || tile.userTitle || tile.filePath || tile.cwd || tile.type}`
      : undefined;

    const id = toast(
      tile.autoTitle ||
        tile.userTitle ||
        tile.filePath ||
        tile.cwd ||
        tile.type ||
        "Notification",
      {
        description: message || undefined,
        duration: Infinity,
        action: {
          label: "TODO",
          onClick: () => {
            _focusTile(tileId);
            _dismissToast(id);
          },
        },
      },
    );

    // Click the toast card → focus tile
    const el = document.querySelector(
      `[data-sonner-toast][data-id="${id}"]`,
    ) as HTMLElement | null;
    if (el) {
      el.style.cursor = "pointer";
      el.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("[data-button]")) return;
        _focusTile(tileId);
        _dismissToast(id);
      });
    } else {
      // The DOM node isn't mounted yet — wait for it
      requestAnimationFrame(() => {
        const el2 = document.querySelector(
          `[data-sonner-toast][data-id="${id}"]`,
        ) as HTMLElement | null;
        if (el2) {
          el2.style.cursor = "pointer";
          el2.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest("[data-button]")) return;
            _focusTile(tileId);
            _dismissToast(id);
          });
        }
      });
    }

    toastTileMap.set(id, tileId);
    return id;
  }

  function dismissFirst() {
    const first = toastTileMap.entries().next();
    if (first.done) return false;
    const [, tileId] = first.value;
    // Dismiss ALL toasts for the same tileId, not just the first one
    _focusTile(tileId);
    dismissByTileId(tileId);
    return true;
  }

  function dismissByTileId(tileId: string) {
    let found = false;
    for (const [toastId, tid] of toastTileMap) {
      if (tid === tileId) {
        _dismissToast(toastId);
        found = true;
      }
    }
    return found;
  }

  return { show, dismissFirst, dismissByTileId };
}
