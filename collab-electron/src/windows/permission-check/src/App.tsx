import { useEffect, useRef, useState } from "react";

type PermissionStatus = "granted" | "denied" | "unknown";
type PermissionKind = "fullDiskAccess" | "filesAndFolders" | "accessibility";

interface PermissionItem {
  kind: PermissionKind;
  icon: string;
  title: string;
  desc: string;
}

const ITEMS: PermissionItem[] = [
  {
    kind: "fullDiskAccess",
    icon: "🔒",
    title: "完全磁盘访问",
    desc: "访问受保护区域（如 ~/Library、其他应用数据），保证文件树、搜索与索引完整可用。",
  },
  {
    kind: "filesAndFolders",
    icon: "📁",
    title: "文件和文件夹",
    desc: "访问桌面、文稿、下载等目录中的工作区与文件。",
  },
  {
    kind: "accessibility",
    icon: "🖱️",
    title: "辅助功能",
    desc: "支持终端自动化和键盘事件等辅助能力。",
  },
];

const STATUS_LABEL: Record<PermissionStatus, string> = {
  granted: "已授权",
  denied: "未授权",
  unknown: "未确认",
};

type Locale = "en" | "zh";

const EN_ITEMS: Record<PermissionKind, { title: string; desc: string }> = {
  fullDiskAccess: {
    title: "Full Disk Access",
    desc: "Access protected areas (~/Library, other app data) for complete file tree, search and indexing.",
  },
  filesAndFolders: {
    title: "Files and Folders",
    desc: "Access workspaces and files under Desktop, Documents, Downloads, etc.",
  },
  accessibility: {
    title: "Accessibility",
    desc: "Enables terminal automation and keyboard event support.",
  },
};

const EN_STATUS: Record<PermissionStatus, string> = {
  granted: "Granted",
  denied: "Not granted",
  unknown: "Unconfirmed",
};

function isAllGranted(
  statuses: Record<PermissionKind, PermissionStatus>,
): boolean {
  return ITEMS.every((item) => statuses[item.kind] === "granted");
}

export default function App() {
  const [statuses, setStatuses] = useState<
    Record<PermissionKind, PermissionStatus>
  >({
    fullDiskAccess: "unknown",
    filesAndFolders: "unknown",
    accessibility: "unknown",
  });
  const [locale, setLocale] = useState<Locale>("zh");

  useEffect(() => {
    window.api
      .getPref("locale")
      .then((v) => {
        if (v === "en") setLocale("en");
      })
      .catch(() => {});
  }, []);

  const refresh = async () => {
    try {
      const result = await window.api.checkPermissions();
      setStatuses(result);
      if (isAllGranted(result)) {
        window.api.closePermissionCheck();
      }
    } catch {
      // Keep last known statuses on failure
    }
  };

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refreshRef.current();
    const interval = setInterval(() => {
      void refreshRef.current();
    }, 2000);
    const onFocus = () => void refreshRef.current();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const label = (kind: PermissionKind) =>
    locale === "en" ? EN_ITEMS[kind] : ITEMS.find((i) => i.kind === kind)!;

  return (
    <div className="perm-window">
      <div className="perm-header">
        <h1>Permissions</h1>
        <p className="perm-subtitle">
          Collaborator
          {locale === "en"
            ? " needs the following permissions. Grant them to enable full functionality."
            : " 需要以下权限，授权后即可使用完整功能。"}
        </p>
      </div>

      <div className="perm-list">
        {ITEMS.map((item) => {
          const status = statuses[item.kind];
          const t = label(item.kind);
          const granted = status === "granted";
          return (
            <div key={item.kind} className={`perm-item perm-${status}`}>
              <div className="perm-icon">{item.icon}</div>
              <div className="perm-info">
                <div className="perm-title-row">
                  <span className="perm-title">{t.title}</span>
                  <span className={`perm-badge perm-badge-${status}`}>
                    {locale === "en" ? EN_STATUS[status] : STATUS_LABEL[status]}
                  </span>
                </div>
                <p className="perm-desc">{t.desc}</p>
              </div>
              {!granted && (
                <button
                  type="button"
                  className="perm-action"
                  onClick={() =>
                    void window.api.openPermissionSettings(item.kind)
                  }
                >
                  {locale === "en" ? "Grant" : "前往授权"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="perm-footer">
        <button
          type="button"
          className="perm-skip"
          onClick={() => window.api.closePermissionCheck()}
        >
          {locale === "en" ? "Skip for now" : "跳过本次"}
        </button>
      </div>
    </div>
  );
}
