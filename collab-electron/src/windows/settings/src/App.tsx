import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  FolderOpen,
  Gauge,
  Robot,
} from "@phosphor-icons/react";
import { ResponsiveTreeMap } from "@nivo/treemap";
import { useTranslation } from "./translations";
import type { SupportedLocale, TranslationKey } from "./translations";
import {
  getDefaultFileTypeGroups,
  DEFAULT_IGNORED_PATTERNS,
  type FileTypeGroup,
} from "@collab/shared/external-app";

type ThemeMode = "light" | "dark" | "system";

interface SettingsApi {
  getPref: (key: string) => Promise<unknown>;
  setPref: (key: string, value: unknown) => Promise<void>;
  listTerminalTargets: () => Promise<
    Array<{
      id: string;
      label: string;
      isDefault?: boolean;
    }>
  >;
  setTheme: (mode: string) => Promise<void>;
  getAppVersion: () => Promise<string>;
  getAgents: () => Promise<AgentStatus[]>;
  installSkill: (agentId: string) => Promise<{ ok: boolean }>;
  uninstallSkill: (agentId: string) => Promise<{ ok: boolean }>;
  getClaudeSounds: () => Promise<Record<string, unknown>>;
  setClaudeSounds: (
    sounds: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string }>;
  selectSoundFile: () => Promise<string | null>;
  listExternalEditors: () => Promise<
    Array<{ id: string; name: string; appPath: string }>
  >;
  getMemoryStats: () => Promise<{
    groups: Array<{
      type: string;
      label: string;
      rss: number;
      count: number;
      processes: Array<{
        pid: number;
        label: string;
        rss: number;
      }>;
    }>;
    total: number;
    processCount: number;
  }>;
  close: () => void;
  openExternal: (url: string) => void;
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
      const ratio = Math.max(
        0,
        Math.min(1, (clientX - rect.left) / rect.width),
      );
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
                color: active ? "var(--foreground)" : "var(--muted-foreground)",
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
  const [rememberExpandedDirs, setRememberExpandedDirs] = useState(true);

  useEffect(() => {
    api
      .getPref("theme")
      .then((v) => {
        if (v === "light" || v === "dark") setTheme(v);
        else setTheme("system");
      })
      .catch(() => {});
    api
      .getPref("canvasOpacity")
      .then((v) => {
        if (typeof v === "number") setCanvasOpacity(v);
      })
      .catch(() => {});
    api
      .getPref("locale")
      .then((v) => {
        if (v === "en" || v === "zh") setLocale(v);
      })
      .catch(() => {});
    api
      .getPref("rememberExpandedDirs")
      .then((v) => {
        if (typeof v === "boolean") setRememberExpandedDirs(v);
      })
      .catch(() => {});
  }, []);

  async function handleThemeChange(mode: ThemeMode) {
    setTheme(mode);
    await api.setTheme(mode);
  }

  async function handleOpacityChange(value: number) {
    setCanvasOpacity(value);
    await api.setPref("canvasOpacity", value);
  }

  async function handleRememberExpandedDirsChange(value: boolean) {
    setRememberExpandedDirs(value);
    await api.setPref("rememberExpandedDirs", value);
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
          onChange={(m) => {
            void handleThemeChange(m);
          }}
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
            borderColor:
              "color-mix(in srgb, var(--foreground) 15%, transparent)",
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
          onChange={(v) => {
            void handleOpacityChange(v);
          }}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">
              {t("appearance.rememberExpandedDirs")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("appearance.rememberExpandedDirsDesc")}
            </p>
          </div>
          <ToggleSwitch
            checked={rememberExpandedDirs}
            onChange={(v) => {
              void handleRememberExpandedDirsChange(v);
            }}
          />
        </div>
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
    {
      label: t("mouse.scrollHorizontally"),
      keys: `${SHIFT} ${t("mouse.scroll")}`,
    },
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
        border: `1px solid ${
          selected
            ? "var(--foreground)"
            : "color-mix(in srgb, var(--foreground) 15%, transparent)"
        }`,
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
  const [tileWidth, setTileWidth] = useState(1196);
  const [tileHeight, setTileHeight] = useState(739);

  useEffect(() => {
    api
      .getPref("tileSize")
      .then((v) => {
        if (v && typeof v === "object") {
          const val = v as { width?: number; height?: number };
          if (typeof val.width === "number") setTileWidth(val.width);
          if (typeof val.height === "number") setTileHeight(val.height);
        }
      })
      .catch(() => {});
  }, []);

  async function saveTileSize(width: number, height: number) {
    setTileWidth(width);
    setTileHeight(height);
    await api.setPref("tileSize", { width, height });
  }

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("terminal.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("terminal.description")}
        </p>
      </div>

      {/* Tile size */}
      <div className="space-y-2">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{t("terminal.tileSize")}</p>
          <p className="text-xs text-muted-foreground">
            {t("terminal.tileSizeDesc")}
          </p>
        </div>
        <div className="flex gap-4">
          <div className="flex items-center gap-2">
            <label
              className="text-xs text-muted-foreground"
              style={{ minWidth: 14 }}
            >
              {t("terminal.tileWidth")}
            </label>
            <input
              type="number"
              min={200}
              max={4000}
              step={20}
              value={tileWidth}
              onChange={(e) => {
                const w = parseInt(e.target.value, 10) || 1196;
                void saveTileSize(w, tileHeight);
              }}
              className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm text-right"
              style={{ color: "var(--foreground)" }}
            />
          </div>
          <div className="flex items-center gap-2">
            <label
              className="text-xs text-muted-foreground"
              style={{ minWidth: 14 }}
            >
              {t("terminal.tileHeight")}
            </label>
            <input
              type="number"
              min={200}
              max={3000}
              step={20}
              value={tileHeight}
              onChange={(e) => {
                const h = parseInt(e.target.value, 10) || 739;
                void saveTileSize(tileWidth, h);
              }}
              className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm text-right"
              style={{ color: "var(--foreground)" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function TerminalPane(props: { t: (key: TranslationKey) => string }) {
  return IS_MAC ? (
    <MacTerminalPane {...props} />
  ) : (
    <WindowsTerminalPane {...props} />
  );
}

function WindowsTerminalPane({ t }: { t: (key: TranslationKey) => string }) {
  const [target, setTarget] = useState<TerminalTarget>("auto");
  const [options, setOptions] = useState<TerminalTargetOption[]>([]);

  useEffect(() => {
    api
      .getPref("terminalTarget")
      .then((v) => {
        if (typeof v === "string") setTarget(v);
      })
      .catch(() => {});
    api
      .listTerminalTargets()
      .then((items) => setOptions(items))
      .catch(() => {});
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
              onClick={() => {
                void handleTargetChange(id);
              }}
              label={label}
              description={
                isDefault
                  ? t("terminal.target.default")
                  : t("terminal.target.available")
              }
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
    api
      .getAgents()
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
        setError(
          `${agent.name}: ${(result as { error?: string }).error ?? "Unknown error"}`,
        );
      }
    } catch (err) {
      setError(
        `${agent.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
        <p className="text-xs" style={{ color: "#ef4444" }}>
          {error}
        </p>
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
                {agent.detected
                  ? t("integrations.detected")
                  : t("integrations.notFound")}
              </p>
            </div>
            <button
              type="button"
              disabled={busy.has(agent.id)}
              onClick={() => {
                void toggle(agent);
              }}
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
              {agent.installed
                ? t("integrations.uninstall")
                : t("integrations.install")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

type Pane =
  | "appearance"
  | "memory"
  | "terminal"
  | "integrations"
  | "controls"
  | "updates"
  | "files"
  | "claude";

function MemoryPane({ t }: { t: (key: TranslationKey) => string }) {
  const [stats, setStats] = useState<{
    groups: Array<{
      type: string;
      label: string;
      rss: number;
      count: number;
      processes: Array<{ pid: number; label: string; rss: number }>;
    }>;
    total: number;
    processCount: number;
  } | null>(null);
  const [saveMemMode, setSaveMemMode] = useState(true);
  const [maxTiles, setMaxTiles] = useState(2);
  const [destroyDelay, setDestroyDelay] = useState(5);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [tooltipNode, setTooltipNode] = useState<{
    x: number;
    y: number;
    group: (typeof stats)["groups"][number] | null;
  } | null>(null);

  useEffect(() => {
    api
      .getPref("saveMemMode")
      .then((v) => {
        if (typeof v === "boolean") setSaveMemMode(v);
      })
      .catch(() => {});
    api
      .getPref("saveMemMaxTiles")
      .then((v) => {
        if (typeof v === "number") setMaxTiles(v);
      })
      .catch(() => {});
    api
      .getPref("saveMemDestroyDelay")
      .then((v) => {
        if (typeof v === "number") setDestroyDelay(v);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const fetchStats = () => {
      api
        .getMemoryStats()
        .then(setStats)
        .catch(() => {});
    };
    fetchStats();
    intervalRef.current = setInterval(fetchStats, 2000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const formatMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

  const TYPE_COLORS: Record<string, string> = {
    main: "#3B82F6",
    gpu: "#8B5CF6",
    utility: "#10B981",
    pty: "#F59E0B",
    shell: "#6B7280",
    renderer: "#EF4444",
    unknown: "#9CA3AF",
  };

  const TYPE_LABELS: Record<string, string> = {
    main: t("memory.mainProcess"),
    gpu: "GPU",
    utility: t("memory.utility"),
    pty: t("memory.ptyService"),
    shell: t("memory.shell"),
    renderer: t("memory.renderer"),
  };

  // Convert groups to nivo flat treemap data
  const nivoData = useMemo(() => {
    if (!stats) return null;
    return {
      id: "root",
      children: stats.groups.map((g, i) => ({
        id: `${g.type}-${i}`,
        value: g.rss,
        type: g.type,
        labelText: g.count > 1 ? `${g.label} (${g.count})` : g.label,
        rss: g.rss,
        count: g.count,
        groupIndex: i,
      })),
    };
  }, [stats]);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t("memory.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("memory.description")}
          </p>
        </div>
        {stats && (
          <div className="flex items-center gap-2 text-xs tabular-nums">
            <span
              className="rounded-full px-2 py-0.5 font-medium"
              style={{
                backgroundColor:
                  "color-mix(in srgb, var(--foreground) 8%, transparent)",
              }}
            >
              {formatMB(stats.total)}
            </span>
            <span style={{ color: "var(--muted-foreground)" }}>
              {stats.processCount} {t("memory.processCount")}
            </span>
          </div>
        )}
      </div>

      {/* Treemap */}
      {nivoData && stats ? (
        <div
          className="rounded-lg"
          style={{
            border:
              "1px solid color-mix(in srgb, var(--foreground) 8%, transparent)",
          }}
        >
          <div
            style={{ height: 400, width: "100%", position: "relative" }}
            onMouseLeave={() => setTooltipNode(null)}
          >
            <ResponsiveTreeMap
              data={nivoData}
              identity="id"
              value="value"
              tile="squarify"
              innerPadding={3}
              outerPadding={3}
              enableLabel={true}
              label="labelText"
              orientLabel={false}
              enableParentLabel={false}
              colors={(node) =>
                TYPE_COLORS[
                  String((node.data as Record<string, unknown>).type)
                ] ?? TYPE_COLORS.unknown
              }
              nodeOpacity={1}
              borderWidth={1}
              borderColor="rgba(255,255,255,0.25)"
              labelTextColor="#ffffff"
              isInteractive={true}
              tooltip={() => null}
              onMouseEnter={(node, event) => {
                const d = node.data as Record<string, unknown>;
                const idx = d.groupIndex as number;
                const group = stats.groups[idx];
                if (group) {
                  setTooltipNode({ x: event.clientX, y: event.clientY, group });
                }
              }}
              onMouseMove={(_node, event) => {
                setTooltipNode((prev) =>
                  prev ? { ...prev, x: event.clientX, y: event.clientY } : prev,
                );
              }}
              onMouseLeave={() => {
                setTooltipNode(null);
              }}
              theme={{
                labels: {
                  text: { fontSize: 10, fontWeight: 600, fill: "#ffffff" },
                },
                tooltip: {
                  container: {
                    background: "transparent",
                    boxShadow: "none",
                    padding: 0,
                  },
                },
              }}
            />

            {/* Custom fixed-position tooltip */}
            {tooltipNode && tooltipNode.group && (
              <div
                className="rounded-lg px-4 py-3 shadow-xl text-xs leading-relaxed"
                style={{
                  position: "fixed",
                  left: Math.min(tooltipNode.x + 14, window.innerWidth - 320),
                  top: Math.max(tooltipNode.y - 10, 8),
                  zIndex: 9999,
                  width: 280,
                  background: "var(--background)",
                  color: "var(--foreground)",
                  border:
                    "1px solid color-mix(in srgb, var(--foreground) 10%, transparent)",
                  pointerEvents: "none",
                }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold">
                    {tooltipNode.group.label}
                  </span>
                  <span
                    className="font-medium tabular-nums"
                    style={{ color: TYPE_COLORS[tooltipNode.group.type] }}
                  >
                    {formatMB(tooltipNode.group.rss)}
                  </span>
                </div>
                <div
                  className="mb-2"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {tooltipNode.group.count} process
                  {tooltipNode.group.count > 1 ? "es" : ""} ·{" "}
                  {((tooltipNode.group.rss / stats.total) * 100).toFixed(0)}%
                </div>
                {tooltipNode.group.processes.length > 1 && (
                  <div
                    className="rounded-md overflow-hidden"
                    style={{
                      border:
                        "1px solid color-mix(in srgb, var(--foreground) 6%, transparent)",
                    }}
                  >
                    <table className="w-full">
                      <tbody>
                        {tooltipNode.group.processes.map((p, i) => (
                          <tr
                            key={p.pid}
                            style={{
                              borderBottom:
                                i < tooltipNode.group.processes.length - 1
                                  ? "1px solid color-mix(in srgb, var(--foreground) 4%, transparent)"
                                  : "none",
                            }}
                          >
                            <td className="py-1 pr-3 text-muted-foreground whitespace-nowrap">
                              {p.label}
                            </td>
                            <td className="py-1 text-right tabular-nums font-medium whitespace-nowrap">
                              {formatMB(p.rss)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Color legend */}
          <div
            className="flex flex-wrap gap-3 px-4 py-2 text-xs"
            style={{
              borderTop:
                "1px solid color-mix(in srgb, var(--foreground) 8%, transparent)",
              color: "var(--muted-foreground)",
            }}
          >
            {Object.entries(TYPE_COLORS).map(([type, color]) => {
              const label = TYPE_LABELS[type];
              if (!label) return null;
              return (
                <span key={type} className="flex items-center gap-1.5">
                  <span
                    className="inline-block rounded-sm"
                    style={{ width: 10, height: 10, backgroundColor: color }}
                  />
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          {t("memory.loading")}
        </p>
      )}

      {/* Save memory mode */}
      <div
        className="rounded-lg p-4 space-y-3"
        style={{
          border:
            "1px solid color-mix(in srgb, var(--foreground) 8%, transparent)",
          backgroundColor:
            "color-mix(in srgb, var(--foreground) 2%, transparent)",
        }}
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t("memory.saveMemMode")}</p>
          <ToggleSwitch
            checked={saveMemMode}
            onChange={(v) => {
              setSaveMemMode(v);
              void api.setPref("saveMemMode", v);
            }}
          />
        </div>
        <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
          {t("memory.saveMemModeDesc")}
        </p>

        {saveMemMode && (
          <div className="flex gap-6">
            <div>
              <label
                className="text-xs block mb-1"
                style={{ color: "var(--muted-foreground)" }}
              >
                {t("memory.maxActiveTiles")}
              </label>
              <select
                value={maxTiles}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMaxTiles(v);
                  void api.setPref("saveMemMaxTiles", v);
                }}
                className="rounded-md border bg-transparent px-2 py-1 text-sm cursor-pointer"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--foreground) 15%, transparent)",
                  color: "var(--foreground)",
                }}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </div>
            <div>
              <label
                className="text-xs block mb-1"
                style={{ color: "var(--muted-foreground)" }}
              >
                {t("memory.destroyDelay")}
              </label>
              <select
                value={destroyDelay}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDestroyDelay(v);
                  void api.setPref("saveMemDestroyDelay", v);
                }}
                className="rounded-md border bg-transparent px-2 py-1 text-sm cursor-pointer"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--foreground) 15%, transparent)",
                  color: "var(--foreground)",
                }}
              >
                <option value={3}>{t("memory.seconds3")}</option>
                <option value={5}>{t("memory.seconds5")}</option>
                <option value={10}>{t("memory.seconds10")}</option>
                <option value={15}>{t("memory.seconds15")}</option>
              </select>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FilesPane({ t }: { t: (key: TranslationKey) => string }) {
  const [useExternalEditor, setUseExternalEditor] = useState(false);
  const [defaultEditor, setDefaultEditor] = useState("intellij-idea");
  const [fileTypeGroups, setFileTypeGroups] = useState<FileTypeGroup[]>([]);
  const [editors, setEditors] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [ignoredPatterns, setIgnoredPatterns] = useState<string[]>([]);
  const [newIgnore, setNewIgnore] = useState("");
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [newPattern, setNewPattern] = useState("");
  const [newTypeName, setNewTypeName] = useState("");

  const allEditorOptions = [...editors, { id: "system-app", name: "系统应用" }];

  useEffect(() => {
    api
      .getPref("useExternalEditor")
      .then((v) => {
        if (typeof v === "boolean") setUseExternalEditor(v);
      })
      .catch(() => {});
    api
      .getPref("externalEditor")
      .then((v) => {
        if (typeof v === "string" && v) setDefaultEditor(v);
        else api.setPref("externalEditor", "intellij-idea");
      })
      .catch(() => {
        api.setPref("externalEditor", "intellij-idea");
      });
    api
      .getPref("externalEditorFileTypes")
      .then((v) => {
        if (Array.isArray(v) && (v as Array<unknown>).length > 0) {
          const arr = v as Array<Record<string, unknown>>;
          // Detect old flat format {extension, editorId} → migrate
          if (arr.length > 0 && "extension" in arr[0]!) {
            const migrated: FileTypeGroup[] = [
              {
                name: "Custom",
                editorId: defaultEditor,
                patterns: arr.map(
                  (it) => (it as { extension: string }).extension,
                ),
              },
            ];
            setFileTypeGroups(migrated);
            api.setPref("externalEditorFileTypes", migrated);
          } else {
            setFileTypeGroups(v as FileTypeGroup[]);
          }
        } else {
          const defaults = getDefaultFileTypeGroups();
          setFileTypeGroups(defaults);
          api.setPref("externalEditorFileTypes", defaults);
        }
      })
      .catch(() => {});
    api
      .getPref("ignoredFiles")
      .then((v) => {
        if (Array.isArray(v) && (v as Array<unknown>).length > 0) {
          setIgnoredPatterns(v as string[]);
        } else {
          setIgnoredPatterns(DEFAULT_IGNORED_PATTERNS);
          api.setPref("ignoredFiles", DEFAULT_IGNORED_PATTERNS);
        }
      })
      .catch(() => {});
    api
      .listExternalEditors()
      .then((list) => setEditors(list))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveUseExternalEditor(checked: boolean) {
    setUseExternalEditor(checked);
    await api.setPref("useExternalEditor", checked);
  }

  async function saveDefaultEditor(id: string) {
    setDefaultEditor(id);
    await api.setPref("externalEditor", id);
  }

  async function saveFileTypeGroups(groups: FileTypeGroup[]) {
    setFileTypeGroups(groups);
    await api.setPref("externalEditorFileTypes", groups);
  }

  async function saveIgnoredPatterns(patterns: string[]) {
    setIgnoredPatterns(patterns);
    await api.setPref("ignoredFiles", patterns);
  }

  function updateGroupEditor(name: string, editorId: string) {
    saveFileTypeGroups(
      fileTypeGroups.map((g) => (g.name === name ? { ...g, editorId } : g)),
    );
  }

  function addPatternToGroup(name: string, pattern: string) {
    const trimmed = pattern.trim();
    if (!trimmed) return;
    saveFileTypeGroups(
      fileTypeGroups.map((g) =>
        g.name === name ? { ...g, patterns: [...g.patterns, trimmed] } : g,
      ),
    );
    setNewPattern("");
  }

  function removePatternFromGroup(name: string, pattern: string) {
    saveFileTypeGroups(
      fileTypeGroups.map((g) =>
        g.name === name
          ? { ...g, patterns: g.patterns.filter((p) => p !== pattern) }
          : g,
      ),
    );
  }

  function deleteGroup(name: string) {
    saveFileTypeGroups(fileTypeGroups.filter((g) => g.name !== name));
  }

  function addGroup() {
    const name = newTypeName.trim();
    if (!name || fileTypeGroups.some((g) => g.name === name)) return;
    setNewTypeName("");
    saveFileTypeGroups([
      ...fileTypeGroups,
      { name, editorId: defaultEditor, patterns: [] },
    ]);
  }

  function addIgnoredPattern() {
    const pattern = newIgnore.trim();
    if (!pattern) return;
    setNewIgnore("");
    saveIgnoredPatterns([...ignoredPatterns, pattern]);
  }

  function deleteIgnoredPattern(idx: number) {
    saveIgnoredPatterns(ignoredPatterns.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("files.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("files.description")}
        </p>
      </div>

      {/* Ignored Files — always visible */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("files.ignoredFiles")}</p>
            <p className="text-xs text-muted-foreground">
              {t("files.ignoredFilesDesc")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              saveIgnoredPatterns([...DEFAULT_IGNORED_PATTERNS]);
            }}
            className="rounded-md border border-border px-3 py-1 text-sm cursor-pointer flex-shrink-0"
            style={{ color: "var(--foreground)" }}
          >
            {t("files.reset")}
          </button>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={newIgnore}
            placeholder="*.log, node_modules, ..."
            onChange={(e) => setNewIgnore(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addIgnoredPattern();
            }}
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
            style={{ color: "var(--foreground)" }}
          />
          <button
            type="button"
            onClick={addIgnoredPattern}
            className="rounded-md border border-border px-3 py-1 text-sm cursor-pointer"
            style={{ color: "var(--foreground)" }}
          >
            {t("files.addType")}
          </button>
        </div>
        {ignoredPatterns.length > 0 && (
          <div
            className="flex flex-wrap gap-1 overflow-auto"
            style={{ maxHeight: "4.5rem" }}
          >
            {ignoredPatterns.map((pat, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs"
                style={{
                  backgroundColor:
                    "color-mix(in srgb, var(--foreground) 6%, transparent)",
                  color: "var(--foreground)",
                  whiteSpace: "nowrap",
                }}
              >
                <span className="font-mono">{pat}</span>
                <button
                  type="button"
                  className="cursor-pointer"
                  style={{
                    color: "var(--muted-foreground)",
                    fontSize: "12px",
                    lineHeight: 1,
                  }}
                  onClick={() => deleteIgnoredPattern(i)}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Default external editor toggle */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {t("files.defaultExternalEditor")}
        </p>
        <ToggleSwitch
          checked={useExternalEditor}
          onChange={(v) => {
            void saveUseExternalEditor(v);
          }}
        />
      </div>

      {useExternalEditor && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{t("files.externalEditor")}</p>
            <select
              value={defaultEditor}
              onChange={(e) => {
                void saveDefaultEditor(e.target.value);
              }}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              style={{ color: "var(--foreground)" }}
            >
              {allEditorOptions.map((ed) => (
                <option key={ed.id} value={ed.id}>
                  {ed.name}
                </option>
              ))}
            </select>
          </div>

          {/* Recognized File Types — expandable list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                {t("files.recognizedFileTypes")}
              </p>
              <button
                type="button"
                onClick={() => {
                  saveFileTypeGroups(getDefaultFileTypeGroups());
                }}
                className="rounded-md border border-border px-3 py-1 text-sm cursor-pointer flex-shrink-0"
                style={{ color: "var(--foreground)" }}
              >
                {t("files.reset")}
              </button>
            </div>

            {/* Add new type */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newTypeName}
                placeholder="New type name..."
                onChange={(e) => setNewTypeName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addGroup();
                }}
                className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                style={{ color: "var(--foreground)" }}
              />
              <button
                type="button"
                onClick={addGroup}
                className="rounded-md border border-border px-3 py-1 text-sm cursor-pointer"
                style={{ color: "var(--foreground)" }}
              >
                {t("files.addType")}
              </button>
            </div>

            <div
              className="space-y-1 overflow-auto"
              style={{ maxHeight: "220px" }}
            >
              {fileTypeGroups.map((group) => {
                const isExpanded = expandedName === group.name;
                return (
                  <div key={group.name}>
                    {/* Header row */}
                    <div
                      className="flex items-center gap-2 rounded px-2 py-1 cursor-pointer select-none"
                      style={{
                        backgroundColor:
                          "color-mix(in srgb, var(--foreground) 4%, transparent)",
                      }}
                      onClick={() =>
                        setExpandedName(isExpanded ? null : group.name)
                      }
                    >
                      <span
                        className="text-xs flex-shrink-0"
                        style={{ color: "var(--muted-foreground)", width: 14 }}
                      >
                        {isExpanded ? "▼" : "▶"}
                      </span>
                      <span className="text-sm flex-1 font-medium">
                        {group.name}
                      </span>
                      <select
                        value={group.editorId}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          updateGroupEditor(group.name, e.target.value)
                        }
                        className="rounded-md border border-border bg-background px-2 py-0.5 text-xs flex-shrink-0"
                        style={{ color: "var(--foreground)", width: 140 }}
                      >
                        <option value="">{t("files.externalEditor")}</option>
                        {allEditorOptions.map((ed) => (
                          <option key={ed.id} value={ed.id}>
                            {ed.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteGroup(group.name);
                        }}
                        className="text-muted-foreground hover:text-foreground cursor-pointer flex-shrink-0"
                        style={{
                          fontSize: 16,
                          lineHeight: 1,
                          width: 20,
                          textAlign: "center",
                        }}
                      >
                        &times;
                      </button>
                    </div>

                    {/* Expanded: patterns */}
                    {isExpanded && (
                      <div
                        className="ml-6 mt-1 flex flex-wrap items-center gap-1 rounded px-2 py-1.5"
                        style={{
                          backgroundColor:
                            "color-mix(in srgb, var(--foreground) 2%, transparent)",
                        }}
                      >
                        {group.patterns.map((pat) => (
                          <span
                            key={pat}
                            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs"
                            style={{
                              backgroundColor:
                                "color-mix(in srgb, var(--foreground) 6%, transparent)",
                              color: "var(--foreground)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span className="font-mono">{pat}</span>
                            <button
                              type="button"
                              className="cursor-pointer"
                              style={{
                                color: "var(--muted-foreground)",
                                fontSize: 12,
                                lineHeight: 1,
                              }}
                              onClick={() =>
                                removePatternFromGroup(group.name, pat)
                              }
                            >
                              &times;
                            </button>
                          </span>
                        ))}
                        <div className="inline-flex items-center gap-1">
                          <input
                            type="text"
                            value={
                              expandedName === group.name ? newPattern : ""
                            }
                            placeholder="*.ext"
                            onChange={(e) => setNewPattern(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")
                                addPatternToGroup(group.name, newPattern);
                            }}
                            className="w-20 rounded-md border border-border bg-background px-1.5 py-0.5 text-xs font-mono"
                            style={{ color: "var(--foreground)" }}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              addPatternToGroup(group.name, newPattern);
                            }}
                            className="rounded border border-border px-1.5 py-0.5 text-xs cursor-pointer"
                            style={{ color: "var(--muted-foreground)" }}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function UpdatesPane({ t }: { t: (key: TranslationKey) => string }) {
  const [autoCheck, setAutoCheck] = useState(false);

  useEffect(() => {
    api
      .getPref("autoCheckUpdates")
      .then((v) => {
        if (typeof v === "boolean") setAutoCheck(v);
      })
      .catch(() => {});
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
          onChange={(v) => {
            void handleAutoCheckChange(v);
          }}
        />
      </div>
    </div>
  );
}

function ClaudePane({ t }: { t: (key: TranslationKey) => string }) {
  const [enabled, setEnabled] = useState(false);
  const [timeout, setTimeout_] = useState(7);
  const [command, setCommand] = useState("claude");

  useEffect(() => {
    Promise.all([
      api.getPref("claudeIntegration"),
      api.getPref("claudeTimeout"),
      api.getPref("claudeCommand"),
    ])
      .then(([v1, v2, v3]) => {
        if (typeof v1 === "boolean") setEnabled(v1);
        if (typeof v2 === "number") setTimeout_(v2);
        if (typeof v3 === "string") setCommand(v3);
      })
      .catch(() => {});
  }, []);

  async function handleEnabledChange(checked: boolean) {
    setEnabled(checked);
    await api.setPref("claudeIntegration", checked);
  }

  async function handleTimeoutChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = Math.max(7, Number(e.target.value) || 7);
    setTimeout_(val);
    await api.setPref("claudeTimeout", val);
  }

  async function handleCommandChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setCommand(val);
    await api.setPref("claudeCommand", val);
  }

  // -- Sound settings --

  const SOUND_EVENTS = [
    "UserPromptSubmit",
    "Stop",
    "PermissionRequest",
    "PreCompact",
    "Setup",
    "Notification",
  ] as const;

  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundPaths, setSoundPaths] = useState<Record<string, string>>({});
  const [soundBusy, setSoundBusy] = useState(false);

  useEffect(() => {
    api
      .getClaudeSounds()
      .then((sounds) => {
        if (typeof sounds.enabled === "boolean")
          setSoundEnabled(sounds.enabled);
        const paths: Record<string, string> = {};
        for (const [key, val] of Object.entries(sounds)) {
          if (key !== "enabled" && typeof val === "string" && val) {
            paths[key] = val;
          }
        }
        setSoundPaths(paths);
      })
      .catch(() => {});
  }, []);

  async function saveSoundState(
    enabled: boolean,
    paths: Record<string, string>,
  ) {
    const data: Record<string, unknown> = { enabled };
    for (const [ev, p] of Object.entries(paths)) {
      if (p) data[ev] = p;
    }
    await api.setClaudeSounds(data);
  }

  async function handleSoundToggle(checked: boolean) {
    setSoundEnabled(checked);
    await saveSoundState(checked, soundPaths);
  }

  async function handleSoundPathChange(event: string, path: string) {
    const next = { ...soundPaths, [event]: path };
    setSoundPaths(next);
    await saveSoundState(soundEnabled, next);
  }

  async function handleSoundBrowse(event: string) {
    setSoundBusy(true);
    try {
      const filePath = await api.selectSoundFile();
      if (filePath) {
        await handleSoundPathChange(event, filePath);
      }
    } finally {
      setSoundBusy(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("claude.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("claude.description")}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("claude.enable")}</p>
        <ToggleSwitch
          checked={enabled}
          onChange={(v) => {
            void handleEnabledChange(v);
          }}
        />
      </div>

      {enabled && (
        <div className="space-y-2">
          <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
            {t("claude.marketplaceDesc")}
          </p>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              api.openExternal(
                "https://github.com/9talk/collab-public/blob/main/CLAUDE-CODE-PLUGIN.md",
              );
            }}
            className="text-xs underline cursor-pointer"
            style={{ color: "var(--foreground)" }}
          >
            {t("claude.pluginGuide")}
          </a>
        </div>
      )}

      <div className="space-y-2">
        <label className="text-sm font-medium block">
          {t("claude.timeout")}
        </label>
        <input
          type="number"
          min={7}
          value={timeout}
          onChange={(e) => {
            void handleTimeoutChange(e);
          }}
          className="w-24 rounded border px-2 py-1 text-sm"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--foreground) 6%, transparent)",
            borderColor:
              "color-mix(in srgb, var(--foreground) 15%, transparent)",
            color: "var(--foreground)",
          }}
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium block">
          {t("claude.command")}
        </label>
        <input
          type="text"
          value={command}
          onChange={(e) => {
            void handleCommandChange(e);
          }}
          className="w-48 rounded border px-2 py-1 text-sm"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--foreground) 6%, transparent)",
            borderColor:
              "color-mix(in srgb, var(--foreground) 15%, transparent)",
            color: "var(--foreground)",
          }}
        />
      </div>

      {/* Sound settings */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("claude.soundEnable")}</p>
        <ToggleSwitch
          checked={soundEnabled}
          onChange={(v) => {
            void handleSoundToggle(v);
          }}
        />
      </div>

      {soundEnabled && (
        <div
          className="space-y-2 rounded-lg p-4"
          style={{
            border:
              "1px solid color-mix(in srgb, var(--foreground) 8%, transparent)",
            backgroundColor:
              "color-mix(in srgb, var(--foreground) 2%, transparent)",
          }}
        >
          {SOUND_EVENTS.map((event) => (
            <div key={event} className="flex items-center gap-2">
              <label
                className="text-xs shrink-0"
                style={{
                  minWidth: 130,
                  color: "var(--muted-foreground)",
                }}
              >
                {t(`claude.soundEvent.${event}` as any)}
              </label>
              <input
                type="text"
                value={soundPaths[event] || ""}
                onChange={(e) => {
                  void handleSoundPathChange(event, e.target.value);
                }}
                placeholder={t("claude.soundPathPlaceholder")}
                className="flex-1 rounded border px-2 py-1 text-xs"
                style={{
                  backgroundColor:
                    "color-mix(in srgb, var(--foreground) 6%, transparent)",
                  borderColor:
                    "color-mix(in srgb, var(--foreground) 15%, transparent)",
                  color: "var(--foreground)",
                }}
              />
              <button
                type="button"
                disabled={soundBusy}
                onClick={() => {
                  void handleSoundBrowse(event);
                }}
                className="rounded px-2 py-1 text-xs font-medium cursor-pointer disabled:opacity-50 shrink-0"
                style={{
                  backgroundColor:
                    "color-mix(in srgb, var(--foreground) 8%, transparent)",
                  color: "var(--foreground)",
                }}
              >
                {t("claude.soundBrowse")}
              </button>
            </div>
          ))}
        </div>
      )}
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
  const [activePane, setActivePane] = useState<Pane>("appearance");
  const [appVersion, setAppVersion] = useState("");
  const { t } = useTranslation(api);
  const paneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const focusInitialControl = () => {
      paneRef.current?.focus();
    };
    focusInitialControl();
    window.addEventListener("focus", focusInitialControl);
    return () => window.removeEventListener("focus", focusInitialControl);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        api.close();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    api
      .getAppVersion()
      .then((v) => setAppVersion(v))
      .catch(() => {});
  }, []);

  const navItems: { id: Pane; label: string; icon: typeof Palette }[] = [
    { id: "appearance", label: t("nav.appearance"), icon: Palette },
    { id: "memory", label: t("nav.memory"), icon: Gauge },
    { id: "terminal", label: t("nav.terminal"), icon: Terminal },
    { id: "integrations", label: t("nav.integrations"), icon: PuzzlePiece },
    { id: "controls", label: t("nav.controls"), icon: Keyboard },
    { id: "updates", label: t("nav.updates"), icon: ArrowClockwise },
    { id: "files", label: t("nav.files"), icon: FolderOpen },
    { id: "claude", label: t("nav.claude"), icon: Robot },
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
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium ${
                activePane === id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1 text-left">{label}</span>
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
        {activePane === "memory" && <MemoryPane t={t} />}
        {activePane === "terminal" && <TerminalPane t={t} />}
        {activePane === "integrations" && <IntegrationsPane t={t} />}
        {activePane === "controls" && <ControlsPane t={t} />}
        {activePane === "updates" && <UpdatesPane t={t} />}
        {activePane === "files" && <FilesPane t={t} />}
        {activePane === "claude" && <ClaudePane t={t} />}
      </div>
    </div>
  );
}
