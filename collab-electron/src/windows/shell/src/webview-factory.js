/**
 * Webview creation utility and shortcut detection helpers.
 */

export function normalizeShortcutKey(key) {
  if (!key) return null;
  return key.length === 1 ? key.toLowerCase() : key;
}

export function isFocusSearchShortcut(input) {
  const inputType = input?.type;
  const hasCommandModifier =
    input?.meta || input?.control || input?.metaKey || input?.ctrlKey;
  if (
    !input ||
    (inputType !== "keyDown" && inputType !== "keydown") ||
    input.isAutoRepeat ||
    input.repeat
  ) {
    return false;
  }
  if (!hasCommandModifier) return false;
  return input.code === "KeyK" || normalizeShortcutKey(input.key) === "k";
}

export function createWebview(name, config, container, onDndMessage) {
  const wv = document.createElement("webview");
  wv.setAttribute("src", config.src);
  wv.setAttribute("preload", config.preload);
  wv.setAttribute("webpreferences", "contextIsolation=yes, sandbox=yes");
  wv.style.flex = "1";

  let ready = false;
  const pendingMessages = [];
  let onBeforeInput = null;

  wv.addEventListener("dom-ready", () => {
    ready = true;
    for (const [ch, args] of pendingMessages) {
      wv.send(ch, ...args);
    }
    pendingMessages.length = 0;
    wv.addEventListener("before-input-event", (e) => {
      const detail = e.detail;
      if (!detail || detail.type !== "keyDown") return;
      if (detail.meta && detail.alt && detail.code === "KeyI") {
        wv.openDevTools();
      }
      if (onBeforeInput) onBeforeInput(e, detail);
    });
  });

  wv.addEventListener("ipc-message", (event) => {
    if (event.channel.startsWith("dnd:")) {
      onDndMessage(event.channel, event.args);
      return;
    }
    console.log(`[shell] ipc from ${name}: ${event.channel}`, ...event.args);
  });

  wv.addEventListener("console-message", (event) => {
    window.shellApi.logFromWebview(
      name,
      event.level,
      event.message,
      event.sourceId,
    );
  });

  container.appendChild(wv);

  return {
    send(channel, ...args) {
      if (ready) wv.send(channel, ...args);
      else pendingMessages.push([channel, args]);
    },
    setBeforeInput(cb) {
      onBeforeInput = cb;
    },
    webview: wv,
  };
}
