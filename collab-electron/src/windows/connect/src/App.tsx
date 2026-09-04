import { useEffect, useRef, useState } from "react";

type Locale = "en" | "zh";

interface RemoteStatus {
  role?: string;
  state: "idle" | "connecting" | "connected" | "error";
  relayUrl?: string;
  hostInfo?: { role?: string; deviceId?: string; displayName?: string };
  lastError?: string;
}

interface ConnectApi {
  getPref: (key: string) => Promise<unknown>;
  getRemoteStatus: () => Promise<RemoteStatus>;
  onRemoteStatus: (cb: (s: RemoteStatus) => void) => () => void;
  connectRemoteClient: (
    relayUrl: string,
    pairCode: string,
  ) => Promise<{ ok?: boolean; error?: string }>;
  disconnectRemoteClient: () => Promise<{ ok?: boolean }>;
}

const api = (window as unknown as { api: ConnectApi }).api;

const STRINGS: Record<Locale, Record<string, string>> = {
  en: {
    title: "Connect to Host",
    subtitle: "Enter the relay URL and the pairing code shown on your Host",
    relayUrl: "Relay URL",
    relayUrlPlaceholder: "ws://host.example.com:8787",
    pairCode: "Pairing code",
    pairCodePlaceholder: "e.g. 8 4 2 6",
    connect: "Connect",
    connecting: "Connecting…",
    connectingLast: "Connecting to last host…",
    cancel: "Cancel",
    authError:
      "Pairing failed. The code may have expired — refresh it on the Host and try again.",
    pairHelp:
      "Pairing codes are shown in Host settings and refresh automatically.",
  },
  zh: {
    title: "连接到主机",
    subtitle: "输入中继地址与被控端设置界面显示的配对码",
    relayUrl: "中继地址",
    relayUrlPlaceholder: "ws://host.example.com:8787",
    pairCode: "配对码",
    pairCodePlaceholder: "例如 8 4 2 6",
    connect: "连接",
    connecting: "正在连接…",
    connectingLast: "正在连接上次主机…",
    cancel: "取消",
    authError: "配对失败：配对码可能已过期，请在被控端重新获取后再试。",
    pairHelp: "配对码显示在被控端的设置界面中，会自动刷新。",
  },
};

export default function App() {
  const [locale, setLocale] = useState<Locale>("en");
  const [relayUrl, setRelayUrl] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [lastError, setLastError] = useState("");
  const [autoStarted, setAutoStarted] = useState(false);
  // 用户在表单点击过「连接」→ 后续 connecting 均视为手动连接
  const submittedRef = useRef(false);

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
        setAutoStarted(!submittedRef.current);
        return;
      }
      if (s.state === "idle") {
        setAutoStarted(false);
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

  async function handleConnect() {
    const url = relayUrl.trim();
    const code = pairCode.trim();
    if (!url || !code || connecting) return;
    submittedRef.current = true;
    setLastError("");
    const res = await api.connectRemoteClient(url, code);
    if (res && res.ok === false && res.error) {
      setLastError(res.error);
    }
  }

  function handleCancel() {
    submittedRef.current = false;
    setAutoStarted(false);
    setLastError("");
    void api.disconnectRemoteClient();
  }

  return (
    <div className="connect-root">
      <div className="connect-card">
        <h1>{t("title")}</h1>
        <p className="subtitle">{t("subtitle")}</p>

        {lastError && status?.state !== "connecting" && (
          <div className="error-banner">{t("authError")}</div>
        )}

        <div className="field">
          <label htmlFor="relay-url">{t("relayUrl")}</label>
          <input
            id="relay-url"
            value={relayUrl}
            disabled={connecting}
            placeholder={t("relayUrlPlaceholder")}
            spellCheck={false}
            onChange={(e) => setRelayUrl(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="pair-code">{t("pairCode")}</label>
          <input
            id="pair-code"
            value={pairCode}
            disabled={connecting}
            placeholder={t("pairCodePlaceholder")}
            spellCheck={false}
            autoCapitalize="none"
            onChange={(e) => setPairCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleConnect();
            }}
          />
        </div>

        {connecting ? (
          <div className="connecting-box">
            <span className="spinner" aria-hidden="true" />
            <span>{autoStarted ? t("connectingLast") : t("connecting")}</span>
            <button type="button" className="link-btn" onClick={handleCancel}>
              {t("cancel")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="primary-btn"
            disabled={!relayUrl.trim() || !pairCode.trim()}
            onClick={() => void handleConnect()}
          >
            {t("connect")}
          </button>
        )}

        <p className="help">{t("pairHelp")}</p>
      </div>
    </div>
  );
}
