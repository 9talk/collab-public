import { useEffect, useRef, useState } from "react";

type Locale = "en" | "zh";

interface RemoteStatus {
  role?: string;
  state: "idle" | "connecting" | "connected" | "error";
  relayUrl?: string;
  hostInfo?: { role?: string; deviceId?: string; displayName?: string };
  lastError?: string;
}

interface PickedCredential {
  filePath: string;
  relayUrl: string;
  hostId: string;
  hostDisplayName?: string | null;
}

interface ConnectApi {
  getPref: (key: string) => Promise<unknown>;
  getRemoteStatus: () => Promise<RemoteStatus>;
  onRemoteStatus: (cb: (s: RemoteStatus) => void) => () => void;
  pickCredential: () => Promise<
    ({ ok: true } & PickedCredential) | { ok: false; error?: string }
  >;
  connectRemoteClient: (
    relayUrl: string,
    credentialPath: string,
  ) => Promise<{ ok?: boolean; error?: string }>;
  disconnectRemoteClient: () => Promise<{ ok?: boolean }>;
}

const api = (window as unknown as { api: ConnectApi }).api;

const STRINGS: Record<Locale, Record<string, string>> = {
  en: {
    title: "Connect to Host",
    subtitle: "Import the credential file exported from your Host",
    importCredential: "Choose credential file…",
    importing: "Importing…",
    credentialSection: "Credential",
    hostLabel: "Host",
    relayLabel: "Relay",
    chooseFirst: "Choose the credential file your Host issued to continue.",
    relayUrl: "Relay URL",
    relayUrlPlaceholder: "ws://host.example.com:8787",
    connect: "Connect",
    connecting: "Connecting…",
    connectingLast: "Connecting to last host…",
    cancel: "Cancel",
    authError:
      "Connection not authorized. The credential may have been revoked — ask your Host to issue a new one.",
    invalidFile: "The selected file is not a valid Collaborator credential.",
    pairHelp:
      "Credentials are issued in Host settings and stay valid until re-issued.",
  },
  zh: {
    title: "连接到主机",
    subtitle: "导入被控端导出的凭证文件",
    importCredential: "选择凭证文件…",
    importing: "正在导入…",
    credentialSection: "凭证",
    hostLabel: "主机",
    relayLabel: "中继",
    chooseFirst: "请选择被控端签发的凭证文件以继续。",
    relayUrl: "中继地址",
    relayUrlPlaceholder: "ws://host.example.com:8787",
    connect: "连接",
    connecting: "正在连接…",
    connectingLast: "正在连接上次主机…",
    cancel: "取消",
    authError: "连接未授权：凭证可能已被撤销，请联系被控端重新签发。",
    invalidFile: "所选文件不是有效的 Collaborator 凭证。",
    pairHelp: "凭证在被控端设置中签发，重签前长期有效。",
  },
};

export default function App() {
  const [locale, setLocale] = useState<Locale>("en");
  const [relayUrl, setRelayUrl] = useState("");
  const [picked, setPicked] = useState<PickedCredential | null>(null);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [lastError, setLastError] = useState("");
  const [busy, setBusy] = useState(false);
  // 用户在表单点击过「连接」→ 后续 connecting 均视为手动连接
  const submittedRef = useRef(false);
  // 自动连接(启动即有凭证)进行中:不做任何「未导入」提示
  const [autoConnecting, setAutoConnecting] = useState(false);

  useEffect(() => {
    api
      .getPref("locale")
      .then((v) => {
        if (v === "en" || v === "zh") setLocale(v);
      })
      .catch(() => {});
    api
      .getPref("remote.relayUrl")
      .then((v) => {
        if (typeof v === "string") setRelayUrl(v);
      })
      .catch(() => {});

    function applyStatus(s: RemoteStatus) {
      setStatus(s);
      if (s.state === "connected") {
        // 连接成功：主进程负责关闭本窗口；此处兜底避免残留
        window.close();
        return;
      }
      if (s.state === "connecting") {
        setAutoConnecting(!submittedRef.current);
        return;
      }
      if (s.state === "idle") {
        setAutoConnecting(false);
        if (s.lastError) setLastError(s.lastError);
      }
    }

    api
      .getRemoteStatus()
      .then((s) => {
        if (s) applyStatus(s);
      })
      .catch(() => {});
    return api.onRemoteStatus(applyStatus);
  }, []);

  const t = (key: keyof (typeof STRINGS)["en"]): string =>
    STRINGS[locale][key] ?? key;
  const connecting = status?.state === "connecting";

  async function handlePick() {
    setBusy(true);
    setLastError("");
    try {
      const res = await api.pickCredential();
      if (res && res.ok) {
        setPicked({
          filePath: res.filePath,
          relayUrl: res.relayUrl,
          hostId: res.hostId,
          hostDisplayName: res.hostDisplayName,
        });
        setRelayUrl(res.relayUrl);
      } else if (res && res.ok === false && res.error !== "canceled") {
        // 选择被取消(canceled)不算错误
        setLastError(t("invalidFile"));
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect() {
    const url = relayUrl.trim();
    if (!url || !picked || connecting) return;
    submittedRef.current = true;
    setLastError("");
    const res = await api.connectRemoteClient(url, picked.filePath);
    if (res && res.ok === false && res.error) {
      setLastError(t("authError"));
    }
  }

  function handleCancel() {
    submittedRef.current = false;
    setAutoConnecting(false);
    setLastError("");
    void api.disconnectRemoteClient();
  }

  const showAuthError = lastError.length > 0 && !connecting;

  return (
    <div className="connect-root">
      <div className="connect-card">
        <h1>{t("title")}</h1>
        <p className="subtitle">{t("subtitle")}</p>

        {showAuthError && <div className="error-banner">{t("authError")}</div>}

        {connecting ? (
          <div className="connecting-box">
            <span className="spinner" aria-hidden="true" />
            <span>{autoConnecting ? t("connectingLast") : t("connecting")}</span>
            <button type="button" className="link-btn" onClick={handleCancel}>
              {t("cancel")}
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="primary-btn"
              disabled={busy}
              onClick={() => void handlePick()}
            >
              {busy ? t("importing") : t("importCredential")}
            </button>

            {picked && (
              <div className="credential-info">
                <div className="info-row">
                  <span>{t("credentialSection")}</span>
                  <span className="mono">{picked.hostId}</span>
                </div>
                {picked.hostDisplayName && (
                  <div className="info-row">
                    <span>{t("hostLabel")}</span>
                    <span>{picked.hostDisplayName}</span>
                  </div>
                )}
              </div>
            )}

            {!picked && !showAuthError && (
              <p className="help">{t("chooseFirst")}</p>
            )}

            {picked && (
              <div className="field">
                <label htmlFor="relay-url">{t("relayLabel")}</label>
                <input
                  id="relay-url"
                  value={relayUrl}
                  placeholder={t("relayUrlPlaceholder")}
                  spellCheck={false}
                  onChange={(e) => setRelayUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleConnect();
                  }}
                />
              </div>
            )}

            {picked && (
              <button
                type="button"
                className="primary-btn"
                disabled={!relayUrl.trim()}
                onClick={() => void handleConnect()}
              >
                {t("connect")}
              </button>
            )}
          </>
        )}

        <p className="help">{t("pairHelp")}</p>
      </div>
    </div>
  );
}
