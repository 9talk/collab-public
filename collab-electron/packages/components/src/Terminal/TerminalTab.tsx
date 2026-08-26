import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getTheme } from "./theme";
import {
  matchesPattern,
  type FileTypeGroup,
} from "@collab/shared/external-app";
import "@xterm/xterm/css/xterm.css";
import "./TerminalTab.css";

// Matches VS Code's TerminalDataBufferer throttle interval.
// Coalesces rapid PTY data events into a single term.write()
// call, preventing partial-render artifacts from the renderer
// processing many small sequential writes.
const DATA_BUFFER_FLUSH_MS = 5;
const MAX_WEBGL_RETRIES = 3;
const IS_MAC = window.api.getPlatform() === "darwin";

// cmd+c 复制键在"无 xterm 原生选中"时（如 Claude Code 等鼠标接管 TUI）
// 需透传 ctrl+c(\x03) 让程序自身复制。但 \x03 无选中时会作为 SIGINT/关闭信号,
// 因此宿主需在发送前确认"程序当前确实有一个非空选中"。这里解析 xterm 发往
// pty 的 SGR 鼠标字节复刻 Claude Code 的选中状态机, 但采用**保守的 armed 窗口**:
// 只在刚完成一次明确的选中(拖拽建立非空选中/双击选词/三击选行)后的短时间内 armed,
// 任何可能取消选中的信号(单击按下、注入后、退出全屏)立即 disarm, 超时失效。
// 宁可漏复制, 绝不误发关闭信号。
type HostSelPoint = { col: number; row: number };
type HostSelState = {
  anchor: HostSelPoint | null;
  focus: HostSelPoint | null;
  isDragging: boolean;
  clickCount: number;
  lastClickTime: number;
  lastClickCol: number;
  lastClickRow: number;
  /** 本轮(自上次单击按下以来)是否建立过非空选中。多击选词时 focus==anchor 仍为 true,
   *  以区分"双击选词"与"单击未拖动"。 */
  didSelect: boolean;
  /** true = 允许 cmd+c 注入 \x03; 仅在明确选中后置位, 遇取消信号即清除。 */
  armed: boolean;
  /** armed 置位时刻, 超过 ARMED_WINDOW_MS 视为失效。 */
  armedAt: number;
};
const createHostSelState = (): HostSelState => ({
  anchor: null,
  focus: null,
  isDragging: false,
  clickCount: 0,
  lastClickTime: 0,
  lastClickCol: 0,
  lastClickRow: 0,
  didSelect: false,
  armed: false,
  armedAt: 0,
});
// 选中建立后允许注入 \x03 的时间窗。太短易漏复制, 太长会把"已清选中的 stale"
// 误判为可选中的风险加大。取 2s。
const ARMED_WINDOW_MS = 2000;
// SGR 鼠标事件: CSI < btn ; col ; row M(按下/移动) 或 m(松开)。col/row 1-indexed。
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// URL regex based on xterm's default strictUrlRegex, with CJK punctuation
// (U+3000-U+303F, U+FF00-U+FFEF) added to BOTH the middle and trailing
// exclusion sets. The middle [^\s"'!*(){}|\\\^<>`]* clause is greedy and
// would otherwise swallow fullwidth punctuation like ，。 (only the
// trailing clause excludes it), pulling trailing CJK punctuation and
// following ASCII chars into the URL.
// xterm default: /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/
const URL_RE =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`　-〿＀-￯]*[^\s"':,.!?{}|\\\^~\[\]`()<>　-〿＀-￯]/;

interface TerminalTabProps {
  sessionId: string;
  visible: boolean;
  restored?: boolean;
  scrollbackData?: string | null;
}

function TerminalTab({
  sessionId,
  visible,
  restored,
  scrollbackData,
}: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const dataBufferRef = useRef<Uint8Array[]>([]);
  const flushTimerRef = useRef<number | undefined>(undefined);
  const webglRetriesRef = useRef(0);
  const createWebglRef = useRef<(() => void) | null>(null);
  const flushDataRef = useRef<(() => void) | null>(null);
  const refreshingRef = useRef(false);
  const pendingDuringRefreshRef = useRef<Uint8Array[]>([]);
  const isComposingRef = useRef(false);
  // OSC 9;4 上报的终端运行状态(running/idle),供主进程更新 tile 状态。
  const runningRef = useRef(false);
  // 记录上一次 alternate screen 状态,仅在翻转时打日志(避免 flushData 高频刷屏)。
  const lastAltScreenRef = useRef<boolean | null>(null);
  // 宿主侧"程序是否有选中"检测(复刻 Claude Code selection.ts 的 anchor/focus 状态机)。
  // 在 onData 拦截 xterm 发往 pty 的 SGR 鼠标字节来更新; mouseBufRef 缓存跨 chunk 的半截序列。
  const hostSelRef = useRef(createHostSelState());
  const mouseBufRef = useRef("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    console.log("[TerminalTab] useEffect mounted, sessionId:", sessionId);

    // 创建时即使用用户配置的回滚行数（设置面板），无配置时默认 200000
    let scrollback = 200000;
    try {
      const v = window.api.getPrefSync("terminalScrollback");
      if (typeof v === "number" && v > 0) scrollback = v;
    } catch {
      /* 同步读取失败时使用默认 */
    }
    const term = new Terminal({
      theme: getTheme(),
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 12,
      fontWeight: "400",
      fontWeightBold: "500",
      cursorBlink: true,
      scrollback,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    termRef.current = term;

    const offPrefChanged = window.api.onPrefChanged((key, value) => {
      if (
        key === "terminalScrollback" &&
        typeof value === "number" &&
        value > 0
      ) {
        term.options.scrollback = value;
      }
    });

    const showEditorPicker = async (filePath: string): Promise<void> => {
      try {
        const editors = await window.api.listExternalEditors();
        if (editors.length === 0) {
          window.api.openPath(filePath);
          return;
        }
        const items: Array<{ id: string; label: string }> = [
          { id: "system-app", label: "系统应用" },
          ...editors.map((e) => ({ id: e.id, label: e.name })),
        ];
        const selectedId = await window.api.showContextMenu(items);
        if (!selectedId) return;
        if (selectedId === "system-app") {
          window.api.openPath(filePath);
        } else {
          window.api.openFileInExternalEditor(filePath, selectedId);
        }
      } catch {
        window.api.openPath(filePath);
      }
    };

    const linkHandler = {
      allowNonHttpProtocols: true,
      activate: async (event: MouseEvent, text: string) => {
        console.log("[link-activate] text:", text, "meta:", event.metaKey);
        // Determine if the link is a file path (OSC 8 URI or bare absolute path)
        let filePath: string | null = null;
        if (text.startsWith("file://")) {
          filePath = decodeURIComponent(text.slice(7));
        } else if (text.startsWith("/") || text.startsWith("~/")) {
          filePath = text;
        }

        if (!filePath) {
          console.log("[link-activate] not a file path, openExternal");
          window.api.openExternal(text);
          return;
        }

        // Cmd+Click (macOS) / Ctrl+Click (other platforms): show editor picker
        if (IS_MAC ? event.metaKey : event.ctrlKey) {
          console.log("[link-activate] metaKey, showEditorPicker:", filePath);
          await showEditorPicker(filePath);
          return;
        }

        // Resolve editor: match extension against file type groups,
        // then fall back to the global default editor preference.
        // This mirrors the logic in nav/App.tsx (selectFile).
        let matchedEditor: string | null = null;
        try {
          const groups = (await window.api.getPref(
            "externalEditorFileTypes",
          )) as FileTypeGroup[] | null;
          if (groups) {
            const dot = filePath.lastIndexOf(".");
            const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
            for (const group of groups) {
              if (group.patterns.some((p) => matchesPattern(ext, p))) {
                matchedEditor = group.editorId || null;
                break;
              }
            }
          }
        } catch {
          // Preference unavailable — fall through
        }

        if (matchedEditor) {
          console.log("[link-activate] matched group editor:", matchedEditor);
          if (matchedEditor === "system-app") {
            window.api.openPath(filePath);
          } else {
            window.api.openFileInExternalEditor(filePath, matchedEditor);
          }
          return;
        }

        // No file-type match: use global editor preference
        try {
          const useExt = await window.api.getPref("useExternalEditor");
          if (useExt) {
            console.log("[link-activate] global editor (useExternalEditor)");
            window.api.openFileInExternalEditor(filePath);
            return;
          }
        } catch {
          // Preference unavailable — fall through
        }

        console.log("[link-activate] fallback openPath");
        // Fallback: open with system default application
        window.api.openPath(filePath);
      },
    };
    // Override the default confirm()+window.open() handler for OSC 8 links.
    term.options.linkHandler = linkHandler;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fitRef.current = fit;

    // 调试入口: 供自动化测试(debug.terminalClick RPC)在页面内定位 cell 与构造
    // 合成鼠标事件; 无特权 API, 仅暴露 xterm 实例供坐标换算。
    (window as unknown as Record<string, unknown>).__collabTerm = term;

    // IME composition handling: suppress onData during composition
    // to prevent partial/composed text from being sent to PTY multiple
    // times, which causes character duplication with CJK input.
    const textarea = term.textarea;
    if (textarea) {
      textarea.addEventListener("compositionstart", () => {
        isComposingRef.current = true;
      });

      textarea.addEventListener("compositionend", () => {
        isComposingRef.current = false;
      });

      // Reset composition state on blur to recover from stuck
      // composition (IME crash / window switch during IME input).
      textarea.addEventListener("blur", () => {
        isComposingRef.current = false;
      });
    }

    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    const webLinks = new WebLinksAddon(
      (_event: MouseEvent, uri: string) => {
        window.api.openExternal(uri);
      },
      { urlRegex: URL_RE },
    );
    term.loadAddon(webLinks);

    // WebGL retry counter: tracks consecutive context losses.
    // Reset to 0 on successful creation; incremented on each loss.
    // After MAX_WEBGL_RETRIES, falls back to DOM renderer.
    webglRetriesRef.current = 0;

    /**
     * Create a WebglAddon with automatic recovery on GPU context loss.
     * On context loss the addon is disposed and a fresh one is created
     * on the next animation frame (giving the GPU time to settle).
     * After MAX_WEBGL_RETRIES consecutive failures, gives up and falls
     * back to the DOM renderer permanently.
     */
    function createWebglRenderer(): void {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          webglRetriesRef.current++;
          console.warn(
            `[TerminalTab] WebGL context lost (retry ${webglRetriesRef.current}/${MAX_WEBGL_RETRIES})`,
          );
          if (webglRetriesRef.current <= MAX_WEBGL_RETRIES) {
            requestAnimationFrame(() => {
              createWebglRenderer();
              fitRef.current?.fit();
            });
          } else {
            console.warn(
              "[TerminalTab] WebGL retries exhausted, falling back to DOM renderer",
            );
          }
        });
        term.loadAddon(webgl);
        webglRetriesRef.current = 0;
      } catch {
        console.warn("[TerminalTab] WebGL unavailable, using DOM renderer");
      }
    }

    createWebglRenderer();
    createWebglRef.current = createWebglRenderer;

    // Delay initial fit: the webview may not have its final
    // dimensions when the page first loads. Double-rAF ensures
    // the layout pass has finished before we measure.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => fit.fit());
    });

    // Auto-focus xterm when the webview already has focus (e.g.
    // tile created via Cmd+N or double-click where focusCanvasTile
    // ran before xterm mounted).
    if (document.hasFocus()) {
      term.focus();
    }

    // Keep xterm focused whenever the webview window gains focus,
    // so typing works immediately after clicking a tile title bar
    // or programmatic webview.focus() calls.
    const onWindowFocus = () => term.focus();
    window.addEventListener("focus", onWindowFocus);

    if (restored && scrollbackData) {
      term.write(scrollbackData);
    }

    // Force a fresh prompt to absorb zsh PROMPT_SP % marker
    // that may appear during shell initialization.
    if (!restored) {
      setTimeout(() => {
        window.api.ptyWrite(sessionId, "\x0c");
      }, 600);
    }

    // Shift+Enter: inject a CSI u escape sequence directly into the
    // PTY so TUI apps like Claude Code can detect the shift modifier.
    // Block both keydown AND keypress to prevent xterm from also
    // sending \r through the normal onData path.
    const copySelectionToClipboard = () => {
      const selection = term.getSelection();
      if (!selection) return false;
      void navigator.clipboard.writeText(selection).catch(() => {});
      return true;
    };

    let suppressPasteEvent = false;

    const pasteFromShortcut = () => {
      suppressPasteEvent = true;
      void pasteClipboardText();
    };

    const pasteClipboardText = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          window.api.ptyWrite(sessionId, text);
        }
      } catch {
        // Clipboard access can fail outside a user gesture.
      }
    };

    // --- 复刻 Claude Code selection.ts / handleMouseEvent 的 SGR 鼠标选中状态机 ---
    // xterm 在程序开启 DEC mouse modes (1000/1002/1003/1006) 后, 把鼠标事件编码成
    // "\x1b[<btn;col;row M|m" 发往 pty。据此维护 anchor/focus 与 armed 窗口。
    //  - 拖拽建立"非空选中"(focus != anchor) 在松开时 arm
    //  - 双击/三击(选词/选行) 在按下时 arm
    //  - 单击按下 / 注入 \x03 后 / 退出全屏 → disarm
    //  - 滚轮不参与选中, 也不 disarm(选中后滚动查看仍视为有选中)
    const resetHostSel = () => {
      hostSelRef.current = createHostSelState();
    };
    const markArmed = () => {
      const sel = hostSelRef.current;
      sel.armed = true;
      sel.armedAt = Date.now();
    };
    const disarm = () => {
      hostSelRef.current.armed = false;
    };
    const hostArmed = () => {
      const sel = hostSelRef.current;
      return sel.armed && Date.now() - sel.armedAt < ARMED_WINDOW_MS;
    };
    const onSgrMouse = (
      button: number,
      col: number,
      row: number,
      terminator: "M" | "m",
    ) => {
      const sel = hostSelRef.current;
      // 滚轮(bit 0x40): 不参与选中, 只在 Claude Code 侧滚动; 忽略并保持 armed。
      if ((button & 0x40) !== 0) return;
      const c = col - 1; // 终端 1-indexed → 屏幕 0-indexed
      const r = row - 1;
      const baseButton = button & 0x03;
      if (terminator === "M") {
        // --- 按下 / 移动 ---
        if ((button & 0x20) !== 0 && baseButton === 3) {
          // 1003 无按键移动(hover)。丢失释放恢复: 若正拖着说明松开在窗口外,
          // 结束当前拖动; 若本轮已建立选中则 arm。
          if (sel.isDragging) {
            sel.isDragging = false;
            if (sel.didSelect) markArmed();
          }
          return;
        }
        if (baseButton !== 0) {
          sel.clickCount = 0; // 非左键按下打断多击链
          return;
        }
        if ((button & 0x20) !== 0) {
          // 拖动移动: 更新 focus。首格与 anchor 同格(子像素抖动)不动, 否则
          // 会把裸单击误当成 1 格选中。didSelect 实时反映 focus!=anchor。
          if (
            !sel.focus &&
            sel.anchor &&
            sel.anchor.col === c &&
            sel.anchor.row === r
          )
            return;
          sel.focus = { col: c, row: r };
          sel.didSelect =
            sel.anchor !== null &&
            sel.focus !== null &&
            (sel.focus.col !== sel.anchor.col ||
              sel.focus.row !== sel.anchor.row);
          return;
        }
        if (sel.isDragging) sel.isDragging = false; // 丢失释放回退
        // 新左键按下: 多击检测 (500ms / 1 格, 与 Claude Code 相同)
        const now = Date.now();
        const nearLast =
          now - sel.lastClickTime < 500 &&
          Math.abs(c - sel.lastClickCol) <= 1 &&
          Math.abs(r - sel.lastClickRow) <= 1;
        sel.clickCount = nearLast ? sel.clickCount + 1 : 1;
        sel.lastClickTime = now;
        sel.lastClickCol = c;
        sel.lastClickRow = r;
        if (sel.clickCount >= 2) {
          // 双击选词 / 三击选行: Claude Code 立即选中该词/行(宿主无需展开,
          // 只需知道"有选中")。didSelect=true 使松开不误 disarm。
          sel.anchor = { col: c, row: r };
          sel.focus = { col: c, row: r };
          sel.isDragging = true;
          sel.didSelect = true;
          markArmed();
          return;
        }
        // 单击按下: 可能是放置光标/取消选中, 先清本轮, 拖动再重 arm。
        disarm();
        sel.anchor = { col: c, row: r };
        sel.focus = null;
        sel.isDragging = true;
        sel.didSelect = false;
        return;
      }
      // --- 松开 (m) ---
      if (baseButton !== 0) {
        if (!sel.isDragging) return;
        sel.isDragging = false;
        return;
      }
      sel.isDragging = false;
      // 本轮建立了非空选中(拖动或多击选词) → arm; 单击未拖动 → 保持 disarm。
      if (sel.didSelect) markArmed();
      else disarm();
    };
    // 点击的 SGR 视口坐标(col/row 1-based)处是否为 OSC 8 链接 cell:
    // 直接实时查询 buffer — 与 OscLinkProvider 读 cell.extended.urlId、TUI
    // 程序(Claude Code getHyperlinkAt)的判定依据完全一致。不用 hover 快照:
    // Claude Code 等 TUI 全屏重绘会让链接的 buffer 绝对行漂移, 快照换算不可靠。
    const isLinkCell = (col: number, row: number): boolean => {
      try {
        const buffer = term.buffer.active;
        const line = buffer.getLine(row - 1 + buffer.viewportY);
        if (!line) return false;
        const cell = line.getCell(col - 1);
        return !!(cell && cell.hasExtendedAttrs() && cell.extended.urlId > 0);
      } catch {
        return false;
      }
    };
    // 解析 SGR 鼠标序列并返回"应转发给 pty 的数据"。
    // 命中链接 cell 的左键按下/松开(非滚轮/非拖拽移动)会被剥离 — 该点击已由
    // linkHandler.activate 消费(打开编辑器), 再转发给 TUI 会导致其自行打开链接
    // (双重打开)。被剥离的序列同样跳过宿主选中状态机, 与程序端状态保持一致。
    const processSgrMouse = (data: string): string => {
      let s = mouseBufRef.current + data;
      mouseBufRef.current = "";
      // 跨 chunk 的半截 SGR 前缀在上一个 chunk 已原样转发, 无法回收, 故只剥离
      // 完整落在本 chunk 内的序列。
      const cachedLen = s.length - data.length;
      SGR_MOUSE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      let matched = false;
      const suppressed: Array<[number, number]> = [];
      while ((m = SGR_MOUSE_RE.exec(s)) !== null) {
        matched = true;
        const button = parseInt(m[1]!, 10);
        const col = parseInt(m[2]!, 10);
        const row = parseInt(m[3]!, 10);
        const terminator = m[4] === "M" ? "M" : "m";
        if (
          (button & 0x40) === 0 &&
          (button & 0x03) === 0 &&
          (button & 0x20) === 0
        ) {
          console.log(
            `[sgr-click] btn=${button} col=${col} row=${row} ${terminator} viewportY=${term.buffer.active.viewportY} inLink=${isLinkCell(col, row)}`,
          );
        }
        if (
          m.index >= cachedLen &&
          (button & 0x40) === 0 &&
          (button & 0x03) === 0 &&
          (button & 0x20) === 0 &&
          isLinkCell(col, row)
        ) {
          suppressed.push([m.index, m.index + m[0].length]);
          continue;
        }
        onSgrMouse(button, col, row, terminator);
      }
      // 无完整序列但尾部像是半截 SGR 前缀(跨 chunk 拆分)时缓存, 下一段补齐。
      if (!matched) {
        const i = s.lastIndexOf("\x1b[<");
        if (i >= 0 && !/[Mm]$/.test(s)) {
          mouseBufRef.current = s.slice(i);
        }
      }
      if (suppressed.length === 0) return s;
      console.log(`[link-intercept] suppressed ${suppressed.length} SGR click`);
      let out = "";
      let pos = 0;
      for (const [start, end] of suppressed) {
        out += s.slice(pos, start);
        pos = end;
      }
      return out + s.slice(pos);
    };

    term.attachCustomKeyEventHandler((e) => {
      // Esc 在 Claude Code 里会 clear 其文本选中 → 宿主同步清除, 避免后续
      // cmd+c 误判为"有选中"。不消费事件, 让 Esc 正常透传给终端。
      if (e.type === "keydown" && e.key === "Escape") {
        resetHostSel();
      }
      if (e.key === "Enter" && e.shiftKey) {
        if (e.type === "keydown") {
          window.api.ptySendRawKeys(sessionId, "\x1b[13;2u");
        }
        return false;
      }
      const primaryModifier = IS_MAC ? e.metaKey : e.ctrlKey;
      if (e.type === "keydown" && primaryModifier) {
        const key = e.key.toLowerCase();
        if (key === "c") {
          // mac: cmd+c 是复制键; 非 mac 仅 ctrl+shift+c 是复制键
          // (纯 ctrl+c = SIGINT 键, 需交还终端发送 \x03)
          const isCopyKey = IS_MAC || e.shiftKey;
          if (!isCopyKey) {
            // 非 mac 纯 ctrl+c: 有原生选中才复制, 否则交还 xterm 发送 \x03 作为中断
            if (copySelectionToClipboard()) return false;
            return true;
          }
          // 复制键(mac cmd+c / 非 mac ctrl+shift+c):
          // 有 xterm 原生选中 → 宿主直接复制; 无选中(如 Claude Code 等鼠标接管 TUI)
          // → 仅当宿主处于 armed(刚完成一次明确的选中) 且未超时才透传 ctrl+c(\x03)
          //   让 Claude Code 命中其 selection:copy 回退(ScrollKeybindingHandler:602)。
          //   注入成功后 disarm, 避免连续 cmd+c 二次注入(Claude Code 复制后已清选中,
          //   再注入无选中下会被当成 ctrl+c/关闭信号)。无选中时返回 false, 不发送任何字节。
          if (copySelectionToClipboard()) return false;
          if (hostArmed()) {
            window.api.ptyWrite(sessionId, "\x03");
            // 注入后 Claude Code 的 selection:copy 会清掉自身选中, 宿主同步清除,
            // 避免连续 cmd+c 二次注入(无选中下被当成 ctrl+c/关闭信号)。
            resetHostSel();
          }
          return false;
        }
        if (key === "v") {
          pasteFromShortcut();
          return false;
        }
      }
      if (e.type === "keydown" && e.shiftKey && e.key === "Insert") {
        pasteFromShortcut();
        return false;
      }
      if (e.type === "keydown" && e.metaKey) {
        if (e.key === "t" || (e.key >= "1" && e.key <= "9")) {
          return false;
        }
      }
      return true;
    });

    // OSC 7: shell reports current working directory
    // Format: file://hostname/path or file:///path
    term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data);
        if (url.protocol === "file:") {
          const cwd = decodeURIComponent(url.pathname);
          if (cwd) window.api.notifyCwdChanged(sessionId, cwd);
        }
      } catch {
        // Malformed URL — ignore
      }
      return true;
    });

    // OSC 9;4: terminal progress indicator (Claude Code etc.)
    // 0 = CLEAR, 1 = SET, 2 = ERROR, 3 = INDETERMINATE
    term.parser.registerOscHandler(9, (data) => {
      const semi = data.indexOf(";");
      const kind = semi >= 0 ? data.slice(0, semi) : data;
      const rest = semi >= 0 ? data.slice(semi + 1) : "";
      if (kind === "4") {
        const semi2 = rest.indexOf(";");
        const state = semi2 >= 0 ? rest.slice(0, semi2) : rest;
        if (state === "1" || state === "2" || state === "3") {
          runningRef.current = true;
          window.api.notifyTerminalStatus(sessionId, "running");
        } else {
          runningRef.current = false;
          window.api.notifyTerminalStatus(sessionId, "idle");
        }
      }
      return true;
    });

    // Listen for clear-screen requests from the shell (via collab-canvas terminal clear)
    const offTerminalClear = window.api.onTerminalClear(() => {
      term.clear();
    });

    term.onData((data: string) => {
      // SGR 鼠标事件在转发给 pty 前先解析, 还原程序自身的选中状态(见上)。
      // 命中 hovered 链接的点击序列被剥离(链接已由 linkHandler.activate 消费),
      // 其余字节原样透传。
      const forwarded = processSgrMouse(data);

      // Suppress sending data to PTY during IME composition; the
      // completed text is sent once via compositionend instead.
      if (isComposingRef.current) {
        return;
      }

      if (forwarded.length === 0) {
        return;
      }

      window.api.sendToHost("term:user-input", sessionId);
      window.api.ptyWrite(sessionId, forwarded);
    });

    const flushData = () => {
      if (dataBufferRef.current.length === 0) {
        flushTimerRef.current = undefined;
        return;
      }
      const chunks = dataBufferRef.current;
      dataBufferRef.current = [];
      flushTimerRef.current = undefined;
      // Merge all chunks into a single term.write() to avoid
      // triggering multiple WebGL frames, which can cause
      // ghosting when the renderer can't keep up.
      let merged: string;
      if (chunks.length === 1) {
        merged =
          typeof chunks[0] === "string"
            ? chunks[0]
            : new TextDecoder().decode(chunks[0]);
      } else {
        // Build a single Uint8Array and decode once. Handles
        // both Uint8Array and string chunks (IPC sends strings
        // but the type says Uint8Array for API stability).
        const encoder = new TextEncoder();
        let totalLen = 0;
        for (const c of chunks) {
          totalLen +=
            typeof c === "string" ? encoder.encode(c).length : c.length;
        }
        const buf = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
          if (typeof c === "string") {
            const encoded = encoder.encode(c);
            buf.set(encoded, off);
            off += encoded.length;
          } else {
            buf.set(c, off);
            off += c.length;
          }
        }
        merged = new TextDecoder().decode(buf);
      }

      // Diagnostic: detect U+FFFD in data sent to xterm
      if (merged.includes("�")) {
        const idx = merged.indexOf("�");
        console.error(
          "[term:utf8] session=" +
            sessionId +
            " U+FFFD at char " +
            idx +
            ' ctx="' +
            merged.substring(Math.max(0, idx - 20), idx + 20) +
            '"',
        );
      }

      term.write(merged);
      // Claude Code 全屏(alternate screen)时跳过全量重绘:其滚动由 Claude Code
      // 的 DECSTBM 补丁驱动,走 WebGL 增量渲染即可;全量重绘在大视口下反而放大
      // 滚动卡顿。normal 主屏仍清纹理以防高刷屏 ghosting。
      const isAlt = term.buffer.active === term.buffer.alternate;
      if (lastAltScreenRef.current !== isAlt) {
        lastAltScreenRef.current = isAlt;
        console.log(`[alt-debug] alternate screen=${isAlt ? "ON" : "OFF"}`);
      }
      if (!isAlt) {
        term.clearTextureAtlas();
      }
    };
    flushDataRef.current = flushData;

    const handleData = (payload: { sessionId: string; data: Uint8Array }) => {
      if (payload.sessionId !== sessionId) return;
      // 程序关闭鼠标追踪(如退出全屏 / 清选中)→ 宿主还原的选中状态一并复位,
      // 避免 stale 状态下 cmd+c 误发 \x03。抓 DISABLE_MOUSE_TRACKING 里的 \x1b[?1000l。
      try {
        // 主进程经 IPC 发来的是 string（pty.ts forwardPtyData 用 data: enriched），
        // 但类型声明为 Uint8Array；TextDecoder.decode(string) 会抛 TypeError，
        // 导致 \x1b[?1000l 复位检测从未生效。按实际类型分支处理。
        const chunk =
          typeof payload.data === "string"
            ? payload.data
            : new TextDecoder().decode(payload.data);
        if (chunk.includes("\x1b[?1000l")) {
          resetHostSel();
        }
      } catch {
        /* 字节解码失败,忽略 */
      }
      // During a WebGL refresh, buffer data separately to avoid
      // losing it if flushData races with dataBufferRef.current = [].
      if (refreshingRef.current) {
        pendingDuringRefreshRef.current.push(payload.data);
        return;
      }
      dataBufferRef.current.push(payload.data);
      if (flushTimerRef.current === undefined) {
        flushTimerRef.current = window.setTimeout(
          flushData,
          DATA_BUFFER_FLUSH_MS,
        );
      }
    };
    window.api.onPtyData(sessionId, handleData);

    term.onResize(({ cols, rows }) => {
      window.api.ptyResize(sessionId, cols, rows);
    });

    const handleCopy = (event: ClipboardEvent) => {
      const selection = term.getSelection();
      if (!selection) return;
      event.clipboardData?.setData("text/plain", selection);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (suppressPasteEvent) {
        suppressPasteEvent = false;
        // Only suppress if clipboard has text (already sent via
        // pasteClipboardText). If it only has images, let the
        // event propagate so downstream handlers can process it.
        if (event.clipboardData?.getData("text/plain")) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      window.api.ptyWrite(sessionId, text);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleDragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    };

    const handleDrop = async (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.dataTransfer?.files?.length) return;

      // Extract paths synchronously before any await
      const rawPaths: string[] = [];
      for (let i = 0; i < event.dataTransfer.files.length; i++) {
        try {
          const p = window.api.getPathForFile(event.dataTransfer.files[i]);
          if (p) rawPaths.push(p);
        } catch {
          /* skip non-file items */
        }
      }
      if (rawPaths.length === 0) return;

      // Filter out directories
      const checks = rawPaths.map(async (p) => {
        const isDir = await window.api.isDirectory(p);
        return isDir ? null : p;
      });
      const paths = (await Promise.all(checks)).filter(
        (p): p is string => p !== null,
      );
      if (paths.length === 0) return;

      const escaped = paths.map((p) => "'" + p.replace(/'/g, "'\\''") + "'");
      try {
        await window.api.ptyWrite(sessionId, escaped.join(" "));
      } catch {
        /* PTY may have exited */
      }
      term.focus();
    };

    container.addEventListener("copy", handleCopy, true);
    container.addEventListener("paste", handlePaste, true);
    container.addEventListener("dragover", handleDragOver);
    container.addEventListener("drop", handleDrop);

    // Right-click → request context menu (screenshot / line stats) via shell
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const b = term.buffer.active;
      window.api.sendToHost("term:context-menu", {
        bufferLines: b.length,
        scrollbackLines: b.baseY,
        viewportRows: term.rows,
      });
    };
    container.addEventListener("contextmenu", handleContextMenu);

    const offShellBlur = window.api.onShellBlur(() => {
      term.blur();
      const active = document.activeElement as HTMLElement | null;
      active?.blur();
    });

    // Debounce resize via rAF to coalesce rapid events
    let rafId = 0;
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => fit.fit());
      }
    });
    resizeObserver.observe(containerRef.current);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onThemeChange = (e: MediaQueryListEvent) => {
      term.options.theme = getTheme();
    };
    mediaQuery.addEventListener("change", onThemeChange);

    return () => {
      if (flushTimerRef.current !== undefined) {
        clearTimeout(flushTimerRef.current);
        flushData();
      }
      cancelAnimationFrame(rafId);
      window.removeEventListener("focus", onWindowFocus);
      mediaQuery.removeEventListener("change", onThemeChange);
      resizeObserver.disconnect();
      container.removeEventListener("copy", handleCopy, true);
      container.removeEventListener("paste", handlePaste, true);
      container.removeEventListener("dragover", handleDragOver);
      container.removeEventListener("drop", handleDrop);
      window.api.offPtyData(sessionId, handleData);
      offPrefChanged();
      offShellBlur();
      offTerminalClear();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      createWebglRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (visible && fitRef.current) {
      requestAnimationFrame(() => fitRef.current?.fit());
    }
  }, [visible]);

  useEffect(() => {
    const unsub = window.api.onTerminalRefresh(() => {
      const t = termRef.current;
      if (!t) return;
      // Redirect incoming PTY data to a safe buffer while we
      // swap the WebGL addon, so no data is lost to the race
      // between flushData and dataBufferRef.current = [].
      refreshingRef.current = true;
      if (flushTimerRef.current !== undefined) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = undefined;
      }
      dataBufferRef.current = [];
      webglRetriesRef.current = 0;
      createWebglRef.current?.();
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        // Replay data that arrived during the refresh.
        const pending = pendingDuringRefreshRef.current;
        pendingDuringRefreshRef.current = [];
        if (pending.length > 0) {
          dataBufferRef.current.push(...pending);
          flushTimerRef.current = window.setTimeout(
            flushDataRef.current,
            DATA_BUFFER_FLUSH_MS,
          );
        }
        refreshingRef.current = false;
        window.api.sendToHost("term:refreshed", sessionId);
      });
    });
    return unsub;
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      className="terminal-tab"
      style={{ display: visible ? "block" : "none" }}
    ></div>
  );
}

export default TerminalTab;
