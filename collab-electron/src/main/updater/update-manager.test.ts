import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

let mockAppVersion = "0.1.0";

// Mock electron
mock.module("electron", () => ({
  app: {
    getVersion: () => mockAppVersion,
    isPackaged: false,
    on: () => {},
    quit: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: () => {} } },
    ],
  },
  ipcMain: {
    handle: () => {},
    on: () => {},
  },
  powerMonitor: {
    on: () => {},
  },
}));

mock.module("../analytics", () => ({
  trackEvent: (event: string, props: unknown) => {
    trackedEvents.push({ event, props });
  },
}));

// Capture autoUpdater event listeners so tests can fire them
const listeners = new Map<string, Function>();
let autoDownloadValue = true;
let forceDevUpdateConfigValue = false;

const mockAutoUpdater = {
  on: (event: string, cb: Function) => {
    listeners.set(event, cb);
  },
  checkForUpdates: () => {
    listeners.get("checking-for-update")?.();
    return Promise.resolve();
  },
  downloadUpdate: () => Promise.resolve(),
  quitAndInstall: () => {},
  set autoDownload(v: boolean) {
    autoDownloadValue = v;
  },
  get autoDownload() {
    return autoDownloadValue;
  },
  set autoInstallOnAppQuit(v: boolean) {},
  set forceDevUpdateConfig(v: boolean) {
    forceDevUpdateConfigValue = v;
  },
  get forceDevUpdateConfig() {
    return forceDevUpdateConfigValue;
  },
  set logger(v: unknown) {},
};

mock.module("electron-updater", () => ({
  default: { autoUpdater: mockAutoUpdater },
  autoUpdater: mockAutoUpdater,
}));

const { updateManager, isNewer } = await import("./update-manager");

const trackedEvents: Array<{ event: string; props: unknown }> = [];

function getState() {
  return updateManager.getState();
}

function fireEvent(name: string, data?: unknown) {
  listeners.get(name)?.(data);
}

function resetManager() {
  // Reset internal state by destroying and re-importing would be ideal,
  // but since it's a singleton, we work with what we have.
  // After each test the error timeout is cleared via destroy().
  updateManager.destroy();
  (updateManager as any).initialized = false;
  (updateManager as any).state = { status: "idle" };
}

describe("UpdateManager", () => {
  beforeEach(() => {
    mockAppVersion = "0.1.0";
    trackedEvents.length = 0;
    updateManager.init();
  });

  afterEach(() => {
    resetManager();
  });

  test("starts in idle state", () => {
    expect(getState().status).toBe("idle");
  });

  test("transitions to checking on checkForUpdates", async () => {
    await updateManager.checkForUpdates();
    expect(getState().status).toBe("checking");
  });

  test("transitions to available on update-available event", async () => {
    await updateManager.checkForUpdates();
    fireEvent("update-available", {
      version: "2.0.0",
      releaseNotes: "New stuff",
    });
    expect(getState().status).toBe("available");
    expect(getState().version).toBe("2.0.0");
    expect(getState().releaseNotes).toBe("New stuff");
  });

  test("transitions to idle on update-not-available", async () => {
    await updateManager.checkForUpdates();
    fireEvent("update-not-available");
    expect(getState().status).toBe("idle");
  });

  test("tracks update_available analytics", async () => {
    await updateManager.checkForUpdates();
    fireEvent("update-available", { version: "2.0.0" });

    const event = trackedEvents.find((e) => e.event === "update_available");
    expect(event).toBeDefined();
    expect(event!.props).toEqual({ version: "2.0.0" });
  });

  test("skips check when already checking", async () => {
    await updateManager.checkForUpdates();
    expect(getState().status).toBe("checking");

    // Second check should be a no-op
    await updateManager.checkForUpdates();
    expect(getState().status).toBe("checking");
  });

  test("skips check when already available", async () => {
    await updateManager.checkForUpdates();
    fireEvent("update-available", { version: "2.0.0" });
    expect(getState().status).toBe("available");

    await updateManager.checkForUpdates();
    expect(getState().status).toBe("available");
  });

  test("downloadAvailableUpdate is no-op when not available", async () => {
    expect(getState().status).toBe("idle");
    await updateManager.downloadAvailableUpdate();
    expect(getState().status).toBe("idle");
  });

  test("transitions to downloading on download-progress", async () => {
    await updateManager.checkForUpdates();
    fireEvent("update-available", { version: "2.0.0" });

    await updateManager.downloadAvailableUpdate();
    fireEvent("download-progress", {
      percent: 50,
      bytesPerSecond: 1024,
      transferred: 500,
      total: 1000,
    });
    expect(getState().status).toBe("downloading");
    expect(getState().progress).toBe(50);
  });

  test("transitions to ready on update-downloaded", async () => {
    await updateManager.checkForUpdates();
    fireEvent("update-available", { version: "2.0.0" });
    await updateManager.downloadAvailableUpdate();
    fireEvent("update-downloaded", { version: "2.0.0" });

    expect(getState().status).toBe("ready");
    expect(getState().version).toBe("2.0.0");
  });

  test("tracks update_downloaded analytics", async () => {
    await updateManager.checkForUpdates();
    fireEvent("update-available", { version: "2.0.0" });
    await updateManager.downloadAvailableUpdate();
    fireEvent("update-downloaded", { version: "2.0.0" });

    const event = trackedEvents.find((e) => e.event === "update_downloaded");
    expect(event).toBeDefined();
  });

  test("transitions to error on error event", async () => {
    await updateManager.checkForUpdates();
    fireEvent("error", new Error("network failure"));
    expect(getState().status).toBe("error");
    expect(getState().error).toBe("network failure");
  });

  test("ignores missing release metadata errors", async () => {
    await updateManager.checkForUpdates();
    fireEvent(
      "error",
      new Error("Cannot find latest-linux.yml in the latest release artifacts"),
    );
    if (process.platform === "linux") {
      expect(getState().status).toBe("idle");
      expect(getState().error).toBeUndefined();
    } else {
      expect(getState().status).toBe("error");
      expect(getState().error).toBe(
        "Cannot find latest-linux.yml in the latest release artifacts",
      );
    }
  });

  test("does not ignore non-linux release metadata errors", async () => {
    await updateManager.checkForUpdates();
    fireEvent(
      "error",
      new Error("Cannot find latest-win.yml in the latest release artifacts"),
    );
    expect(getState().status).toBe("error");
    expect(getState().error).toBe(
      "Cannot find latest-win.yml in the latest release artifacts",
    );
  });

  test("install transitions to installing in dev mode", async () => {
    await updateManager.checkForUpdates();
    fireEvent("update-available", { version: "2.0.0" });
    await updateManager.downloadAvailableUpdate();
    fireEvent("update-downloaded", { version: "2.0.0" });

    await updateManager.install();
    expect(getState().status).toBe("installing");
  });

  test("install is no-op when not ready", async () => {
    await updateManager.install();
    expect(getState().status).toBe("idle");
  });

  test("allows re-check from error state", async () => {
    await updateManager.checkForUpdates();
    fireEvent("error", new Error("fail"));
    expect(getState().status).toBe("error");

    await updateManager.checkForUpdates();
    expect(getState().status).toBe("checking");
  });

  test("ignores update when offered version is lower than pre-release current", async () => {
    mockAppVersion = "0.7.0-beta.1";
    resetManager();
    updateManager.init();

    await updateManager.checkForUpdates();
    fireEvent("update-available", { version: "0.6.1" });

    expect(getState().status).toBe("idle");
    expect(
      trackedEvents.find((e) => e.event === "update_available"),
    ).toBeUndefined();
  });

  test("accepts update when offered version is higher than pre-release current", async () => {
    mockAppVersion = "0.7.0-beta.1";
    resetManager();
    updateManager.init();

    await updateManager.checkForUpdates();
    fireEvent("update-available", { version: "0.8.0" });

    expect(getState().status).toBe("available");
    expect(getState().version).toBe("0.8.0");
  });

  test("accepts stable release of same base version over pre-release", async () => {
    mockAppVersion = "0.7.0-beta.1";
    resetManager();
    updateManager.init();

    await updateManager.checkForUpdates();
    fireEvent("update-available", { version: "0.7.0" });

    expect(getState().status).toBe("available");
    expect(getState().version).toBe("0.7.0");
  });
});

describe("isNewer", () => {
  test("higher major version is newer", () => {
    expect(isNewer("2.0.0", "1.0.0")).toBe(true);
  });

  test("lower major version is not newer", () => {
    expect(isNewer("1.0.0", "2.0.0")).toBe(false);
  });

  test("higher minor version is newer", () => {
    expect(isNewer("0.8.0", "0.7.0")).toBe(true);
  });

  test("lower minor version is not newer", () => {
    expect(isNewer("0.6.1", "0.7.0-beta.1")).toBe(false);
  });

  test("higher patch version is newer", () => {
    expect(isNewer("0.7.1", "0.7.0")).toBe(true);
  });

  test("same version is not newer", () => {
    expect(isNewer("0.7.0", "0.7.0")).toBe(false);
  });

  test("stable is newer than pre-release of same base version", () => {
    expect(isNewer("0.7.0", "0.7.0-beta.1")).toBe(true);
  });

  test("pre-release is not newer than same pre-release", () => {
    expect(isNewer("0.7.0-beta.1", "0.7.0-beta.1")).toBe(false);
  });

  test("pre-release of higher base is newer than lower stable", () => {
    expect(isNewer("0.8.0-beta.1", "0.7.0")).toBe(true);
  });
});
