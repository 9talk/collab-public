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
  Broadcast,
} from "@phosphor-icons/react";
import { ResponsiveTreeMap } from "@nivo/treemap";
import { useTranslation } from "./translations";
import type { SupportedLocale, TranslationKey } from "./translations";
import {
  getDefaultFileTypeGroups,
  type FileTypeGroup,
} from "@collab/shared/external-app";
import {
  DEFAULT_IGNORE_PATTERNS,
  filterIgnorePatterns,
} from "@collab/shared/ignore-patterns";
import { CLAUDE_SOUND_EVENTS } from "@collab/shared/claude-sounds";

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
  setDeepIntegration: (
    enabled: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;
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
  getRemoteStatus: () => Promise<Record<string, unknown> | null>;
  onRemoteStatus: (cb: (s: Record<string, unknown>) => void) => () => void;
  setRemoteHostEnabled: (enabled: boolean) => Promise<{ ok?: boolean }>;
  testRemoteHost: (
    relayUrl: string,
    deviceToken: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  hostApplyPairRefresh: () => Promise<{ ok?: boolean }>;
  hostRefreshPairNow: () => Promise<{ ok?: boolean }>;
  disconnectRemoteClient: () => Promise<{ ok?: boolean }>;
  onOpenPane: (cb: (pane: string) => void) => () => void;
  getAppFlavor: () => string;
}

const api = (window as unknown as { api: SettingsApi }).api;
// "full" = Collaborator + Host；"remote" = 独立 Client（镜像显示遵循 Host，
// 设置窗口只保留本地项：语言/自动更新）。
const APP_FLAVOR = api.getAppFlavor();

// 各 flavor 可见 pane：remote 独立版只保留本地项（语言/自动更新/连接信息），
// 其余 pane 依赖 Host 功能或被控端角色；connection pane 仅 remote 独立版展示。
function isPaneVisible(id: Pane): boolean {
  if (APP_FLAVOR === "remote") {
    return id === "appearance" || id === "connection" || id === "updates";
  }
  return id !== "connection";
}

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
    if (APP_FLAVOR === "remote") {
      // 独立版视觉配置遵循 Host,不在本地设置界面读写;
      // locale 属本地项, 照常读取。
      api
        .getPref("locale")
        .then((v) => {
          if (v === "en" || v === "zh") setLocale(v);
        })
        .catch(() => {});
      return;
    }
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

      {APP_FLAVOR !== "remote" && (
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t("appearance.theme")}</p>
          <ThemeToggle
            value={theme}
            onChange={(m) => {
              void handleThemeChange(m);
            }}
          />
        </div>
      )}

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

      {APP_FLAVOR !== "remote" && (
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
      )}

      {APP_FLAVOR !== "remote" && (
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
      )}
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

const PRESET_TILE_SIZES: Array<{
  width: number;
  height: number;
  desc: TranslationKey;
}> = [{ width: 1200, height: 700, desc: "terminal.presets.common" }];

function MacTerminalPane({ t }: { t: (key: TranslationKey) => string }) {
  const [tileWidth, setTileWidth] = useState(1196);
  const [tileHeight, setTileHeight] = useState(739);
  const [scrollback, setScrollback] = useState(200000);
  // 输入框文本态:保存前不直接写入配置,避免中间态(清空/不完整数字)污染
  const [scrollbackText, setScrollbackText] = useState("200000");

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
    api
      .getPref("terminalScrollback")
      .then((v) => {
        if (typeof v === "number") {
          setScrollback(v);
          setScrollbackText(String(v));
        }
      })
      .catch(() => {});
  }, []);

  async function saveTileSize(width: number, height: number) {
    setTileWidth(width);
    setTileHeight(height);
    await api.setPref("tileSize", { width, height });
  }

  async function saveScrollback(value: number) {
    if (!Number.isInteger(value) || value < 1000 || value > 200000) {
      return;
    }
    setScrollback(value);
    setScrollbackText(String(value));
    await api.setPref("terminalScrollback", value);
  }

  // 失焦/回车时提交:非法输入(非数字、越界)还原为已保存值
  const commitScrollback = () => {
    const v = parseInt(scrollbackText, 10);
    if (!Number.isInteger(v) || v < 1000 || v > 200000) {
      setScrollbackText(String(scrollback));
      return;
    }
    void saveScrollback(v);
  };

  const handleScrollbackChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setScrollbackText(e.target.value.replace(/\D/g, "").slice(0, 8));
  };

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

      {/* Preset tile sizes */}
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("terminal.presets")}</p>
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-xs text-muted-foreground"
              style={{
                borderBottom:
                  "1px solid color-mix(in srgb, var(--foreground) 6%, transparent)",
              }}
            >
              <th className="py-1.5 pr-2 text-left font-normal">
                {t("terminal.presets.width")}
              </th>
              <th className="py-1.5 pr-2 text-left font-normal">
                {t("terminal.presets.height")}
              </th>
              <th className="py-1.5 pr-2 text-left font-normal">
                {t("terminal.presets.desc")}
              </th>
              <th className="py-1.5 text-left font-normal">
                {t("terminal.presets.action")}
              </th>
            </tr>
          </thead>
          <tbody>
            {PRESET_TILE_SIZES.map((preset) => (
              <tr
                key={`${preset.width}x${preset.height}`}
                style={{
                  borderBottom:
                    "1px solid color-mix(in srgb, var(--foreground) 6%, transparent)",
                }}
              >
                <td className="py-2 pr-2">{preset.width}</td>
                <td className="py-2 pr-2">{preset.height}</td>
                <td className="py-2 pr-2 text-muted-foreground">
                  {t(preset.desc)}
                </td>
                <td className="py-2">
                  <button
                    type="button"
                    onClick={() => {
                      void saveTileSize(preset.width, preset.height);
                    }}
                    className="cursor-pointer rounded-md border border-border bg-background px-2.5 py-1 text-xs"
                    style={{ color: "var(--foreground)" }}
                  >
                    {t("terminal.presets.apply")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Scrollback lines */}
      <div className="space-y-2">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{t("terminal.scrollback")}</p>
          <p className="text-xs text-muted-foreground">
            {t("terminal.scrollbackDesc")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={scrollbackText}
            onChange={handleScrollbackChange}
            onBlur={commitScrollback}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="1000-200000"
            className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm text-right"
            style={{ color: "var(--foreground)" }}
          />
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
  | "claude"
  | "remote"
  | "connection";

interface RemoteStatusView {
  state?: string;
  relayUrl?: string;
  hostInfo?: { role?: string; deviceId?: string; displayName?: string };
  lastError?: string;
}

function ConnectionPane({ t }: { t: (key: TranslationKey) => string }) {
  const [status, setStatus] = useState<RemoteStatusView | null>(null);
  const [relayPref, setRelayPref] = useState("");

  useEffect(() => {
    api
      .getPref("remote.relayUrl")
      .then((v) => {
        if (typeof v === "string") setRelayPref(v);
      })
      .catch(() => {});
    api
      .getRemoteStatus()
      .then((s) => {
        if (s) setStatus(s as RemoteStatusView);
      })
      .catch(() => {});
    return api.onRemoteStatus((s) => setStatus(s as RemoteStatusView));
  }, []);

  const connected = status?.state === "connected";
  const connecting = status?.state === "connecting";
  const hostName = status?.hostInfo?.displayName;
  const hostId = status?.hostInfo?.deviceId;

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("connection.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("connection.description")}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("connection.relay")}</p>
        <span className="text-sm tabular-nums">
          {relayPref || t("connection.none")}
        </span>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("connection.status")}</p>
        <span className="text-sm">
          {connected
            ? t("connection.status.connected")
            : connecting
              ? t("connection.status.connecting")
              : t("connection.status.idle")}
        </span>
      </div>

      {connected && (
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t("connection.host")}</p>
          <span className="text-sm">
            {hostName || hostId || t("connection.none")}
          </span>
        </div>
      )}

      {connected && (
        <button
          type="button"
          onClick={() => void api.disconnectRemoteClient()}
          className="w-full cursor-pointer rounded-md py-2 text-sm font-medium"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--foreground) 8%, transparent)",
            color: "var(--foreground)",
          }}
        >
          {t("connection.disconnect")}
        </button>
      )}

      {!connected && !connecting && (
        <p className="text-xs text-muted-foreground">
          {t("connection.notAvailable")}
        </p>
      )}
    </div>
  );
}

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
    agent: "#EC4899",
    tool: "#14B8A6",
    unknown: "#9CA3AF",
  };

  const TYPE_LABELS: Record<string, string> = {
    main: t("memory.mainProcess"),
    gpu: "GPU",
    utility: t("memory.utility"),
    pty: t("memory.ptyService"),
    shell: t("memory.shell"),
    renderer: t("memory.renderer"),
    agent: "Claude Code",
    tool: t("memory.tool"),
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
  const [ignoreFilter, setIgnoreFilter] = useState("");
  const [ignoreCase, setIgnoreCase] = useState(true);
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
          setIgnoredPatterns(DEFAULT_IGNORE_PATTERNS);
          api.setPref("ignoredFiles", DEFAULT_IGNORE_PATTERNS);
        }
      })
      .catch(() => {});
    api
      .getPref("ignoreCase")
      .then((v) => {
        if (typeof v === "boolean") setIgnoreCase(v);
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

  async function saveIgnoreCase(value: boolean) {
    setIgnoreCase(value);
    await api.setPref("ignoreCase", value);
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

  function deleteIgnoredPattern(pattern: string) {
    saveIgnoredPatterns(ignoredPatterns.filter((p) => p !== pattern));
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
              saveIgnoredPatterns([...DEFAULT_IGNORE_PATTERNS]);
            }}
            className="rounded-md border border-border px-3 py-1 text-sm cursor-pointer flex-shrink-0"
            style={{ color: "var(--foreground)" }}
          >
            {t("files.reset")}
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("files.ignoreCase")}</p>
            <p className="text-xs text-muted-foreground">
              {t("files.ignoreCaseDesc")}
            </p>
          </div>
          <ToggleSwitch
            checked={ignoreCase}
            onChange={(v) => {
              void saveIgnoreCase(v);
            }}
          />
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
          <>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={ignoreFilter}
                placeholder={t("files.searchIgnoredFiles")}
                onChange={(e) => setIgnoreFilter(e.target.value)}
                className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                style={{ color: "var(--foreground)" }}
              />
              {ignoreFilter.trim() !== "" && (
                <span
                  className="text-xs shrink-0 tabular-nums"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {filterIgnorePatterns(ignoredPatterns, ignoreFilter).length}/
                  {ignoredPatterns.length}
                </span>
              )}
            </div>
            {filterIgnorePatterns(ignoredPatterns, ignoreFilter).map(
              (pat, i) => (
                <span
                  key={`${pat}-${i}`}
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
                    onClick={() => deleteIgnoredPattern(pat)}
                  >
                    &times;
                  </button>
                </span>
              ),
            )}
            {ignoreFilter.trim() !== "" &&
              filterIgnorePatterns(ignoredPatterns, ignoreFilter).length ===
                0 && (
                <p
                  className="text-xs"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {t("files.noIgnoredMatch")}
                </p>
              )}
          </>
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
      <p className="text-xs text-muted-foreground">
        {t("files.openBehaviorDesc")}
      </p>

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

type RemoteStatus = Record<string, unknown>;

function RemotePane({ t }: { t: (key: TranslationKey) => string }) {
  const [relayUrl, setRelayUrl] = useState("");
  const [deviceToken, setDeviceToken] = useState("");
  const [hostStatus, setHostStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  // 关闭/被控二选一；初始按当前状态适配，用户手动切换后不再覆盖
  const [roleTab, setRoleTab] = useState<"off" | "host">("off");
  const [roleTouched, setRoleTouched] = useState(false);
  // 配对码自动换新周期（分钟，1~1440），默认 10
  const [refreshMinutes, setRefreshMinutes] = useState(10);
  const [refreshSaving, setRefreshSaving] = useState(false);

  useEffect(() => {
    api
      .getPref("remote.relayUrl")
      .then((v) => {
        if (typeof v === "string") setRelayUrl(v);
      })
      .catch(() => {});
    api
      .getPref("remote.deviceToken")
      .then((v) => {
        if (typeof v === "string") setDeviceToken(v);
      })
      .catch(() => {});
    api
      .getPref("remote.roleTab")
      .then((v) => {
        // client 角色已从完整版移除（独立 Client 产物承担），旧 pref 回落 off
        if (v === "host") setRoleTab(v);
      })
      .catch(() => {});
    api
      .getRemoteStatus()
      .then((s) => {
        if (!s) return;
        if (s.role !== "client") setHostStatus(s);
      })
      .catch(() => {});
    api
      .getPref("remote.pairRefreshMinutes")
      .then((v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1) {
          setRefreshMinutes(Math.min(1440, Math.round(n)));
        }
      })
      .catch(() => {});
    const unsub = api.onRemoteStatus((s) => {
      console.log("[remote-ui] status-event", JSON.stringify(s));
      if (s.role !== "client") setHostStatus(s);
    });
    return unsub;
  }, []);

  // 状态到达后自动选中当前角色（未手动切换时）
  useEffect(() => {
    if (roleTouched) return;
    if (hostStatus?.role === "host") setRoleTab("host");
  }, [hostStatus, roleTouched]);

  const hostActive =
    hostStatus?.state === "connected" || hostStatus?.state === "connecting";

  async function saveRelayUrl(v: string) {
    setRelayUrl(v);
    await api.setPref("remote.relayUrl", v);
  }

  async function saveToken(v: string) {
    setDeviceToken(v);
    await api.setPref("remote.deviceToken", v);
  }

  /** 保存换新周期（clamp 1~1440）并热重排 Host 轮询定时器 */
  async function saveRefreshMinutes(v: string) {
    const n = Math.round(Number(v));
    const clamped = Number.isFinite(n)
      ? Math.min(1440, Math.max(1, n))
      : 10;
    setRefreshMinutes(clamped);
    setRefreshSaving(true);
    try {
      await api.setPref("remote.pairRefreshMinutes", clamped);
      await api.hostApplyPairRefresh();
    } finally {
      setRefreshSaving(false);
    }
  }

  async function refreshNow() {
    setRefreshSaving(true);
    try {
      await api.hostRefreshPairNow();
    } finally {
      setRefreshSaving(false);
    }
  }

  function selectRole(r: "off" | "host") {
    setRoleTab(r);
    setRoleTouched(true);
    void api.setPref("remote.roleTab", r);
  }

  async function testHost() {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await api.testRemoteHost(relayUrl.trim(), deviceToken.trim());
      if (res && res.ok) {
        setTestResult({ ok: true, message: t("remote.testOk") });
      } else {
        const resErr = res as { error?: string; code?: string } | undefined;
        setTestResult({
          ok: false,
          message: resErr?.error
            ? remoteErrorText(resErr.code, resErr.error, t)
            : t("remote.notConfigured"),
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggleHost(checked: boolean) {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      // remote.hostEnabled 不在此预写：由主进程在连接成功（auth-ok）时置 true、
      // 断开时置 false，保证「已连接=true / 未连接=false」的持久化语义。
      const res = await api.setRemoteHostEnabled(checked);
      if (res && res.ok === false) {
        setError(t("remote.notConfigured"));
      } else {
        // 主动拉取最新状态刷新状态卡（不依赖事件推送时序）
        const s = await api.getRemoteStatus();
        if (s) setHostStatus(s);
      }
    } catch (err) {
      // IPC 异常（如 handler 内部错误）也展示出来，避免「点了没反应」
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnectHost() {
    setBusy(true);
    setDisconnecting(true);
    setError(null);
    setTestResult(null);
    try {
      await api.setPref("remote.hostEnabled", false);
      await api.setRemoteHostEnabled(false);
      // 主动拉取最新状态刷新状态卡（不依赖事件推送时序）
      const s = await api.getRemoteStatus();
      if (s) setHostStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setDisconnecting(false);
    }
  }

  function stateLabel(state: unknown): string {
    if (state === "connected") return t("remote.connected");
    if (state === "connecting") return t("remote.connecting");
    if (state === "error") return t("remote.error");
    return t("remote.notConnected");
  }

  function remoteErrorText(
    code: string | undefined,
    raw: string,
    tFn: (key: TranslationKey) => string,
  ): string {
    switch (code) {
      case "EHOSTUNREACH":
      case "ENETUNREACH":
      case "ENETDOWN":
        return tFn("remote.errUnreachable");
      case "ECONNREFUSED":
        return tFn("remote.errRefused");
      case "ETIMEDOUT":
        return tFn("remote.errTimeout");
      case "ENOTFOUND":
      case "EAI_AGAIN":
        return tFn("remote.errDns");
      case "ECONNRESET":
        return tFn("remote.errReset");
      default:
        return raw;
    }
  }

  const hostStateLabel = stateLabel(hostStatus?.state);
  const hostPeer = hostStatus?.peer as
    | { role?: string; deviceId?: string; displayName?: string }
    | undefined;
  const hostPairCode = hostStatus?.pairCode as string | undefined;
  const pairCodeExpiresAtMs = hostStatus?.pairCodeExpiresAt as
    | number
    | undefined;
  const pairExpiresLabel =
    pairCodeExpiresAtMs != null && Number.isFinite(pairCodeExpiresAtMs)
      ? new Date(pairCodeExpiresAtMs).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";

  const segBtn = (active: boolean) =>
    `flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-accent text-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("remote.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("remote.description")}
        </p>
      </div>

      {/* 关闭/被控 二选一 */}
      <div className="flex rounded-lg border border-border/50 p-0.5">
        <button
          type="button"
          className={segBtn(roleTab === "off")}
          onClick={() => selectRole("off")}
        >
          {t("remote.roleOff")}
        </button>
        <button
          type="button"
          className={segBtn(roleTab === "host")}
          onClick={() => selectRole("host")}
        >
          {t("remote.roleHost")}
        </button>
      </div>

      {roleTab === "off" && (
        <div className="rounded-md border border-border/50 p-4 text-sm text-muted-foreground">
          {t("remote.offViewDesc")}
        </div>
      )}

      {roleTab === "host" && (
        <div className="space-y-4">
          {/* Host section */}
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">{t("remote.hostSection")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("remote.hostSectionDesc")}
            </p>
          </div>

          <label className="block">
            <span className="text-sm text-muted-foreground">
              {t("remote.relayUrl")}
            </span>
            <input
              type="text"
              value={relayUrl}
              onChange={(e) => saveRelayUrl(e.target.value)}
              className="mt-1 w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-sm"
              placeholder="ws://192.168.8.57:8787"
              spellCheck={false}
            />
          </label>

          <label className="block">
            <span className="text-sm text-muted-foreground">
              {t("remote.deviceToken")}
            </span>
            <input
              type="password"
              value={deviceToken}
              onChange={(e) => saveToken(e.target.value)}
              className="mt-1 w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-sm"
              placeholder={t("remote.deviceTokenPlaceholder")}
              spellCheck={false}
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !relayUrl.trim() || !deviceToken.trim()}
              onClick={testHost}
              className="rounded-md border border-border/50 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              {busy ? t("remote.testing") : t("remote.test")}
            </button>
            <button
              type="button"
              disabled={
                busy || hostActive || !relayUrl.trim() || !deviceToken.trim()
              }
              onClick={() => void toggleHost(true)}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-background disabled:opacity-40"
              style={{ backgroundColor: "var(--foreground)" }}
            >
              {hostStatus?.state === "connected"
                ? t("remote.connected")
                : hostStatus?.state === "connecting"
                  ? t("remote.connecting")
                  : t("remote.connect")}
            </button>
            {hostActive && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void disconnectHost()}
                className="rounded-md border border-border/50 px-3 py-1.5 text-sm disabled:opacity-40"
              >
                {disconnecting
                  ? t("remote.disconnecting")
                  : t("remote.disconnect")}
              </button>
            )}
          </div>
          {testResult && (
            <p
              className="text-xs"
              style={{ color: testResult.ok ? "#16a34a" : "#ef4444" }}
            >
              {testResult.message}
            </p>
          )}

          {/* 配对码自动换新：周期(分钟) + 立即刷新 */}
          <div className="flex items-end gap-2">
            <label className="block min-w-0 flex-1">
              <span className="text-sm text-muted-foreground">
                {t("remote.pairRefreshLabel")}
              </span>
              <input
                type="number"
                min={1}
                max={1440}
                step={1}
                value={refreshMinutes}
                disabled={refreshSaving}
                onChange={(e) => setRefreshMinutes(Number(e.target.value))}
                onBlur={(e) => void saveRefreshMinutes(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className="mt-1 w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-sm disabled:opacity-40"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              disabled={
                refreshSaving || hostStatus?.state !== "connected"
              }
              onClick={() => void refreshNow()}
              className="rounded-md border border-border/50 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              {refreshSaving
                ? t("remote.refreshing")
                : t("remote.refreshNow")}
            </button>
          </div>

          <div className="space-y-1 rounded-md border border-border/50 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {t("remote.relayUrl")}
              </span>
              <span>{hostStatus?.relayUrl ?? "-"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("remote.host")}</span>
              <span>{hostStateLabel}</span>
            </div>
            {hostPairCode && (
              <div className="space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t("remote.pairCode")}
                  </span>
                  <span className="font-mono tracking-widest">
                    {hostPairCode}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {t("remote.pairValidUntil")}{" "}
                    {pairExpiresLabel || "-"}
                  </span>
                  <span>
                    {t("remote.pairRotatesEvery")} {refreshMinutes}{" "}
                    {t("remote.minutes")}
                  </span>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("remote.peer")}</span>
              <span>
                {hostPeer?.deviceId ??
                  (hostStatus?.peerConnected === false
                    ? t("remote.peerNone")
                    : "-")}
              </span>
            </div>
            {hostStatus?.lastError && (
              <p className="text-xs" style={{ color: "#ef4444" }}>
                {hostStatus.lastError as string}
              </p>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}

function ClaudePane({ t }: { t: (key: TranslationKey) => string }) {
  const [enabled, setEnabled] = useState(false);
  const [timeout, setTimeout_] = useState(7);
  const [command, setCommand] = useState("claude");
  const [clearOnClear, setClearOnClear] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getPref("claudeIntegration"),
      api.getPref("claudeTimeout"),
      api.getPref("claudeCommand"),
      api.getPref("claudeClearOnClear"),
    ])
      .then(([v1, v2, v3, v4]) => {
        if (typeof v1 === "boolean") setEnabled(v1);
        if (typeof v2 === "number") setTimeout_(v2);
        if (typeof v3 === "string") setCommand(v3);
        if (typeof v4 === "boolean") setClearOnClear(v4);
      })
      .catch(() => {});
  }, []);

  async function handleEnabledChange(checked: boolean) {
    setEnabled(checked);
    await api.setPref("claudeIntegration", checked);
    await api.setDeepIntegration(checked);
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

  async function handleClearOnClearChange(checked: boolean) {
    setClearOnClear(checked);
    await api.setPref("claudeClearOnClear", checked);
  }

  // -- Sound settings --

  const SOUND_EVENTS = CLAUDE_SOUND_EVENTS;

  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundEvents, setSoundEvents] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api
      .getClaudeSounds()
      .then((sounds) => {
        if (typeof sounds.enabled === "boolean")
          setSoundEnabled(sounds.enabled);
        const events: Record<string, boolean> = {};
        for (const key of CLAUDE_SOUND_EVENTS) {
          events[key] = sounds[key] === true;
        }
        setSoundEvents(events);
      })
      .catch(() => {});
  }, []);

  async function saveSoundState(
    enabled: boolean,
    events: Record<string, boolean>,
  ) {
    const data: Record<string, unknown> = { enabled };
    for (const key of CLAUDE_SOUND_EVENTS) {
      data[key] = events[key] === true;
    }
    await api.setClaudeSounds(data);
  }

  async function handleSoundToggle(checked: boolean) {
    setSoundEnabled(checked);
    await saveSoundState(checked, soundEvents);
  }

  async function handleSoundEventChange(event: string, checked: boolean) {
    const next = { ...soundEvents, [event]: checked };
    setSoundEvents(next);
    await saveSoundState(soundEnabled, next);
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

      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{t("claude.clearOnClear")}</p>
          <p className="text-xs text-muted-foreground">
            {t("claude.clearOnClearDesc")}
          </p>
        </div>
        <ToggleSwitch
          checked={clearOnClear}
          onChange={(v) => {
            void handleClearOnClearChange(v);
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
            <label
              key={event}
              className="flex items-center justify-between gap-2 cursor-pointer"
            >
              <span
                className="text-xs"
                style={{ color: "var(--muted-foreground)" }}
              >
                {t(`claude.soundEvent.${event}` as any)}
              </span>
              <input
                type="checkbox"
                checked={soundEvents[event] === true}
                onChange={(e) => {
                  void handleSoundEventChange(event, e.target.checked);
                }}
                className="h-4 w-4 shrink-0 cursor-pointer"
                style={{ accentColor: "#22c55e" }}
              />
            </label>
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
    const unsub = api.onOpenPane((pane) => {
      const id = pane as Pane;
      // 收到本 flavor 不可见的 pane(如 remote 下外部请求被控端设置)时回退
      setActivePane(isPaneVisible(id) ? id : "appearance");
    });
    return unsub;
  }, []);

  useEffect(() => {
    api
      .getAppVersion()
      .then((v) => setAppVersion(v))
      .catch(() => {});
  }, []);

  const navItems: { id: Pane; label: string; icon: typeof Palette }[] = (
    [
      { id: "appearance", label: t("nav.appearance"), icon: Palette },
      { id: "memory", label: t("nav.memory"), icon: Gauge },
      { id: "terminal", label: t("nav.terminal"), icon: Terminal },
      { id: "integrations", label: t("nav.integrations"), icon: PuzzlePiece },
      { id: "controls", label: t("nav.controls"), icon: Keyboard },
      { id: "updates", label: t("nav.updates"), icon: ArrowClockwise },
      { id: "files", label: t("nav.files"), icon: FolderOpen },
      { id: "claude", label: t("nav.claude"), icon: Robot },
      { id: "remote", label: t("nav.remote"), icon: Broadcast },
      { id: "connection", label: t("nav.connection"), icon: Broadcast },
    ] as { id: Pane; label: string; icon: typeof Palette }[]
  ).filter((item) => isPaneVisible(item.id));

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
        {activePane === "remote" && <RemotePane t={t} />}
        {activePane === "connection" && <ConnectionPane t={t} />}
      </div>
    </div>
  );
}
