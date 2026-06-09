import { useCallback, useEffect, useRef, useState } from "react";
import {
  GearSix,
  Keyboard,
  Palette,
  PuzzlePiece,
  Sun,
  Moon,
  Monitor,
  Terminal,
  ArrowClockwise,
} from "@phosphor-icons/react";
import { useTranslation } from "./translations";
import type { SupportedLocale, TranslationKey } from "./translations";

type ThemeMode = "light" | "dark" | "system";

interface SettingsApi {
  getPref: (key: string) => Promise<unknown>;
  setPref: (key: string, value: unknown) => Promise<void>;
  listTerminalTargets: () => Promise<Array<{
    id: string;
    label: string;
    isDefault?: boolean;
  }>>;
  setTheme: (mode: string) => Promise<void>;
  getAppVersion: () => Promise<string>;
  getAgents: () => Promise<AgentStatus[]>;
  installSkill: (agentId: string) => Promise<{ ok: boolean }>;
  uninstallSkill: (agentId: string) => Promise<{ ok: boolean }>;
  close: () => void;
}

const api = (window as unknown as { api: SettingsApi }).api;

const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];

const THEME_ICONS: Record<ThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

function Slider({
  value,
  min = 0,
  max = 100,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const pct = ((value - min) / (max - min)) * 100;

  const commit = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onChange(Math.round(min + ratio * (max - min)));
    },
    [min, max, onChange],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      commit(e.clientX);
    },
    [commit],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      commit(e.clientX);
    },
    [commit],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <div
      ref={trackRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="relative h-5 w-full cursor-pointer select-none flex items-center"
    >
      <div
        className="absolute h-[3px] w-full rounded-full"
        style={{
          backgroundColor:
            "color-mix(in srgb, var(--foreground) 12%, transparent)",
        }}
      />
      <div
        className="absolute h-[3px] rounded-full"
        style={{
          width: `${pct}%`,
          backgroundColor: "var(--foreground)",
          opacity: 0.45,
        }}
      />
      <div
        className="absolute h-3.5 w-3.5 rounded-full border-2 shadow-sm"
        style={{
          left: `calc(${pct}% - 7px)`,
          backgroundColor: "var(--background)",
          borderColor: "var(--foreground)",
          opacity: 1,
        }}
      />
    </div>
  );
}

function ThemeToggle({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  const idx = THEME_MODES.indexOf(value);

  return (
    <div
      className="relative inline-flex h-8 rounded-full p-0.5"
      style={{
        backgroundColor:
          "color-mix(in srgb, var(--foreground) 10%, transparent)",
      }}
    >
      {/* sliding pill */}
      <div
        className="absolute top-0.5 h-7 w-9 rounded-full transition-transform duration-150"
        style={{
          backgroundColor: "var(--accent)",
          transform: `translateX(${idx * 36}px)`,
        }}
      />
      {THEME_MODES.map((mode) => {
        const Icon = THEME_ICONS[mode];
        const active = mode === value;
        return (
          <button
            key={mode}
            type="button"
            aria-label={mode}
            onClick={() => onChange(mode)}
            className="relative z-10 flex h-7 w-9 items-center justify-center rounded-full cursor-pointer"
          >
            <Icon
              className="h-4 w-4 transition-colors duration-150"
              style={{
                color: active
                  ? "var(--foreground)"
                  : "var(--muted-foreground)",
              }}
              weight={active ? "fill" : "regular"}
            />
          </button>
        );
      })}
    </div>
  );
}

function AppearancePane({ t }: { t: (key: TranslationKey) => string }) {
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [canvasOpacity, setCanvasOpacity] = useState(0);
  const [locale, setLocale] = useState<SupportedLocale>("en");

  useEffect(() => {
    api.getPref("theme")
      .then((v) => {
        if (v === "light" || v === "dark") setTheme(v);
        else setTheme("system");
      })
      .catch(() => { });
    api.getPref("canvasOpacity")
      .then((v) => {
        if (typeof v === "number") setCanvasOpacity(v);
      })
      .catch(() => { });
    api.getPref("locale")
      .then((v) => {
        if (v === "en" || v === "zh") setLocale(v);
      })
      .catch(() => { });
  }, []);

  async function handleThemeChange(mode: ThemeMode) {
    setTheme(mode);
    await api.setTheme(mode);
  }

  async function handleOpacityChange(value: number) {
    setCanvasOpacity(value);
    await api.setPref("canvasOpacity", value);
  }

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("appearance.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("appearance.description")}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("appearance.theme")}</p>
        <ThemeToggle
          value={theme}
          onChange={(m) => { void handleThemeChange(m); }}
        />
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("language.label")}</p>
        <select
          value={locale}
          onChange={(e) => {
            const value = e.target.value as SupportedLocale;
            setLocale(value);
            void api.setPref("locale", value);
          }}
          className="rounded-md border bg-transparent px-2 py-1 text-sm cursor-pointer"
          style={{
            borderColor: "color-mix(in srgb, var(--foreground) 15%, transparent)",
            color: "var(--foreground)",
          }}
        >
          <option value="en">{t("language.english")}</option>
          <option value="zh">{t("language.chinese")}</option>
        </select>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t("appearance.canvasOpacity")}</p>
          <span className="text-xs tabular-nums text-muted-foreground">
            {canvasOpacity}%
          </span>
        </div>
        <Slider
          value={canvasOpacity}
          onChange={(v) => { void handleOpacityChange(v); }}
        />
      </div>
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-150"
      style={{
        backgroundColor: checked
          ? "#22c55e"
          : "color-mix(in srgb, var(--foreground) 20%, transparent)",
      }}
    >
      <span
        className="pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-150"
        style={{
          transform: checked ? "translateX(16px)" : "translateX(0)",
        }}
      />
    </button>
  );
}

const IS_MAC = window.api.getPlatform() === "darwin";

const MOD = IS_MAC ? "⌘" : "Ctrl+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";
const CTRL = IS_MAC ? "⌃" : "Ctrl+";
const ALT = IS_MAC ? "⌥" : "Alt+";

function Kbd({ children }: { children: string }) {
  return (
    <kbd
      className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono"
      style={{
        backgroundColor:
          "color-mix(in srgb, var(--foreground) 8%, transparent)",
        color: "var(--foreground)",
      }}
    >
      {children}
    </kbd>
  );
}

function ShortcutList({ items }: { items: { label: string; keys: string }[] }) {
  return (
    <div className="space-y-0">
      {items.map(({ label, keys }, i) => (
        <div
          key={`${label}-${i}`}
          className="flex items-center justify-between py-2"
          style={{
            borderBottom:
              "1px solid color-mix(in srgb, var(--foreground) 6%, transparent)",
          }}
        >
          <span className="text-sm">{label}</span>
          <Kbd>{keys}</Kbd>
        </div>
      ))}
    </div>
  );
}

function ControlsPane({ t }: { t: (key: TranslationKey) => string }) {
  const shortcuts: { label: string; keys: string }[] = [
    { label: t("shortcut.settings"), keys: `${MOD} ,` },
    { label: t("shortcut.find"), keys: `${MOD} K` },
    { label: t("shortcut.toggleNavigator"), keys: `${MOD} \\` },
    { label: t("shortcut.toggleTerminalList"), keys: `${MOD} \`` },
    { label: t("shortcut.openWorkspace"), keys: `${SHIFT} ${MOD} O` },
    { label: t("shortcut.zoomIn"), keys: `${MOD} =` },
    { label: t("shortcut.zoomOut"), keys: `${MOD} -` },
    { label: t("shortcut.actualSize"), keys: `${MOD} 0` },
    {
      label: t("shortcut.toggleFullScreen"),
      keys: IS_MAC ? "⌃ ⌘ F" : "F11",
    },
    { label: t("shortcut.focusTileLeft"), keys: `${MOD} ←` },
    { label: t("shortcut.focusTileRight"), keys: `${MOD} →` },
    { label: t("shortcut.focusTileUp"), keys: `${MOD} ↑` },
    { label: t("shortcut.focusTileDown"), keys: `${MOD} ↓` },
    { label: t("shortcut.dismissNotification"), keys: "F1" },
  ];

  const mouseInputs: { label: string; keys: string }[] = [
    { label: t("mouse.panCanvas"), keys: t("mouse.twoFingerSwipe") },
    { label: t("mouse.panCanvas"), keys: t("mouse.middleClickDrag") },
    { label: t("mouse.panCanvas"), keys: t("mouse.spaceDrag") },
    { label: t("mouse.scrollVertically"), keys: t("mouse.scroll") },
    { label: t("mouse.scrollHorizontally"), keys: `${SHIFT} ${t("mouse.scroll")}` },
    { label: t("mouse.zoom"), keys: `${CTRL} ${t("mouse.scroll")}` },
    ...(IS_MAC
      ? [{ label: t("mouse.zoom"), keys: `${MOD} ${t("mouse.scroll")}` }]
      : []),
  ];

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("controls.shortcuts")}</h2>
      </div>
      <ShortcutList items={shortcuts} />

      <div className="space-y-1 pt-2">
        <h2 className="text-base font-semibold">{t("controls.mouse")}</h2>
      </div>
      <ShortcutList items={mouseInputs} />
    </div>
  );
}

type TerminalTarget = string;

type TerminalTargetOption = {
  id: string;
  label: string;
  isDefault?: boolean;
};

function RadioOption({
  selected,
  onClick,
  label,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left cursor-pointer"
      style={{
        border: `1px solid ${selected
          ? "var(--foreground)"
          : "color-mix(in srgb, var(--foreground) 15%, transparent)"}`,
        backgroundColor: selected
          ? "color-mix(in srgb, var(--foreground) 6%, transparent)"
          : "transparent",
      }}
    >
      <div
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
        style={{
          borderColor: selected
            ? "var(--foreground)"
            : "var(--muted-foreground)",
        }}
      >
        {selected && (
          <div
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: "var(--foreground)" }}
          />
        )}
      </div>
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}

function MacTerminalPane({ t }: { t: (key: TranslationKey) => string }) {
  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("terminal.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("terminal.description")}
        </p>
      </div>
    </div>
  );
}

function TerminalPane(props: { t: (key: TranslationKey) => string }) {
  return IS_MAC ? <MacTerminalPane {...props} /> : <WindowsTerminalPane {...props} />;
}

function WindowsTerminalPane({ t }: { t: (key: TranslationKey) => string }) {
  const [target, setTarget] = useState<TerminalTarget>("auto");
  const [options, setOptions] = useState<TerminalTargetOption[]>([]);

  useEffect(() => {
    api.getPref("terminalTarget")
      .then((v) => {
        if (typeof v === "string") setTarget(v);
      })
      .catch(() => { });
    api.listTerminalTargets()
      .then((items) => setOptions(items))
      .catch(() => { });
  }, []);

  async function handleTargetChange(value: TerminalTarget) {
    setTarget(value);
    await api.setPref("terminalTarget", value);
  }

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("terminal.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("terminal.description")}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("terminal.target")}</p>
        <div className="space-y-1.5">
          {options.map(({ id, label, isDefault }) => (
            <RadioOption
              key={id}
              selected={target === id}
              onClick={() => { void handleTargetChange(id); }}
              label={label}
              description={isDefault
                ? t("terminal.target.default")
                : t("terminal.target.available")}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface AgentStatus {
  id: string;
  name: string;
  detected: boolean;
  installed: boolean;
}

function IntegrationsPane({ t }: { t: (key: TranslationKey) => string }) {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getAgents()
      .then((a) => setAgents(a))
      .catch(() => {});
  }, []);

  async function toggle(agent: AgentStatus) {
    setBusy((s) => new Set(s).add(agent.id));
    setError(null);
    try {
      const result = agent.installed
        ? await api.uninstallSkill(agent.id)
        : await api.installSkill(agent.id);
      if (result && !result.ok) {
        setError(`${agent.name}: ${(result as { error?: string }).error ?? "Unknown error"}`);
      }
    } catch (err) {
      setError(`${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const updated = await api.getAgents();
    setAgents(updated);
    setBusy((s) => {
      const next = new Set(s);
      next.delete(agent.id);
      return next;
    });
  }

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("integrations.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("integrations.description")}
        </p>
      </div>

      {error && (
        <p className="text-xs" style={{ color: "#ef4444" }}>{error}</p>
      )}

      <div className="space-y-1.5">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center justify-between rounded-md px-3 py-2.5"
            style={{
              border:
                "1px solid color-mix(in srgb, var(--foreground) 15%, transparent)",
            }}
          >
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{agent.name}</p>
              <p className="text-xs text-muted-foreground">
                {agent.detected ? t("integrations.detected") : t("integrations.notFound")}
              </p>
            </div>
            <button
              type="button"
              disabled={busy.has(agent.id)}
              onClick={() => { void toggle(agent); }}
              className="rounded-md px-3 py-1.5 text-xs font-medium cursor-pointer disabled:opacity-50"
              style={{
                backgroundColor: agent.installed
                  ? "color-mix(in srgb, var(--foreground) 8%, transparent)"
                  : "var(--foreground)",
                color: agent.installed
                  ? "var(--foreground)"
                  : "var(--background)",
              }}
            >
              {agent.installed ? t("integrations.uninstall") : t("integrations.install")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

type Pane = "appearance" | "terminal" | "integrations" | "controls" | "updates";

function UpdatesPane({ t }: { t: (key: TranslationKey) => string }) {
  const [autoCheck, setAutoCheck] = useState(false);

  useEffect(() => {
    api.getPref("autoCheckUpdates")
      .then((v) => {
        if (typeof v === "boolean") setAutoCheck(v);
      })
      .catch(() => { });
  }, []);

  async function handleAutoCheckChange(checked: boolean) {
    setAutoCheck(checked);
    await api.setPref("autoCheckUpdates", checked);
  }

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("updates.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("updates.description")}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("updates.autoCheck")}</p>
        <ToggleSwitch
          checked={autoCheck}
          onChange={(v) => { void handleAutoCheckChange(v); }}
        />
      </div>
    </div>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <button
        type="button"
        onClick={onClick}
        aria-label="Close"
        className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-foreground/25 bg-transparent p-0 text-foreground/25 transition-opacity duration-150 hover:text-foreground/60 hover:border-foreground/60 cursor-pointer"
      >
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M3 3L9 9M9 3L3 9"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <span className="text-[11px] tracking-[0.05em] text-foreground/25 select-none pointer-events-none font-mono">
        esc
      </span>
    </div>
  );
}

export default function App() {
  const [activePane, setActivePane] =
    useState<Pane>("appearance");
  const [appVersion, setAppVersion] = useState("");
  const { t } = useTranslation(api);
  const paneRef =
    useRef<HTMLDivElement>(null);

  useEffect(() => {
    const focusInitialControl = () => {
      paneRef.current?.focus();
    };
    focusInitialControl();
    window.addEventListener("focus", focusInitialControl);
    return () =>
      window.removeEventListener("focus", focusInitialControl);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        api.close();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () =>
      window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    api.getAppVersion()
      .then((v) => setAppVersion(v))
      .catch(() => { });
  }, []);

  const navItems: { id: Pane; label: string; icon: typeof Palette }[] = [
    { id: "appearance", label: t("nav.appearance"), icon: Palette },
    { id: "terminal", label: t("nav.terminal"), icon: Terminal },
    { id: "integrations", label: t("nav.integrations"), icon: PuzzlePiece },
    { id: "controls", label: t("nav.controls"), icon: Keyboard },
    { id: "updates", label: t("nav.updates"), icon: ArrowClockwise },
  ];

  return (
    <div
      ref={paneRef}
      tabIndex={-1}
      className="flex h-full w-full bg-background text-foreground focus:outline-none"
    >
      {/* Sidebar */}
      <div className="flex w-48 flex-col border-r border-border/50 bg-background p-3 pt-4">
        <div className="flex items-start gap-2 px-2">
          <CloseButton onClick={() => api.close()} />
        </div>

        <div className="px-2 mt-4">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <GearSix className="h-5 w-5" />
            {t("settings.title")}
          </h1>
        </div>

        <nav className="mt-3 space-y-0.5">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActivePane(id)}
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium ${activePane === id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
                }`}
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1 text-left">
                {label}
              </span>
            </button>
          ))}
        </nav>

        <div className="flex-1" />

        {appVersion && (
          <div className="px-2">
            <span className="text-[11px] font-mono text-muted-foreground">
              v{appVersion}
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activePane === "appearance" && <AppearancePane t={t} />}
        {activePane === "terminal" && <TerminalPane t={t} />}
        {activePane === "integrations" && <IntegrationsPane t={t} />}
        {activePane === "controls" && <ControlsPane t={t} />}
        {activePane === "updates" && <UpdatesPane t={t} />}
      </div>
    </div>
  );
}
