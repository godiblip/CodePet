const { EventEmitter } = require("node:events");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const pagePrefixes = new Map([
  ["index.html", "pet:"], ["bubble.html", "bubble:"], ["chat.html", "chat:"],
  ["settings.html", "settings:"], ["usage.html", "usage-monitor:"], ["live.html", "live:"],
]);

function createWindows(wire, app) {
  const windows = new Map();
  let nextWindow = 1;

  class BrowserWindow extends EventEmitter {
    constructor(options = {}) {
      super();
      this.label = `codepet-${nextWindow++}`;
      this.options = options;
      this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 800, height: options.height ?? 600 };
      this.visible = options.show !== false;
      this.maximized = false;
      this.minimized = false;
      this.destroyed = false;
      this.created = false;
      this.pendingActions = [];
      this.webContents = new EventEmitter();
      this.webContents.id = nextWindow;
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.getURL = () => this.webContents.mainFrame?.url || "";
      this.webContents.send = (channel, ...args) => {
        if (!this.destroyed) this.sendAction("emit", { channel, args });
      };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.openDevTools = () => this.sendAction("devtools");
      this.webContents.session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} };
      windows.set(this.label, this);
    }

    static getAllWindows() { return [...windows.values()]; }
    static fromWebContents(contents) { return this.getAllWindows().find(win => win.webContents === contents) ?? null; }

    async loadFile(file, { query } = {}) {
      this.page = path.basename(file);
      this.ready = false;
      if (!pagePrefixes.has(this.page)) throw new Error("Unknown CodePet page");
      const url = pathToFileURL(file);
      for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
      this.webContents.mainFrame = { url: url.href };
      try {
        await wire.request("window-create", { label: this.label, page: this.page, query, options: this.options, bounds: this.bounds });
        this.created = true;
        for (const action of this.pendingActions.splice(0)) wire.notify("window-action", action);
      } catch (error) {
        this.pendingActions.length = 0;
        this.webContents.emit("did-fail-load", {}, -1, error.message);
        this.finishClose();
        throw error;
      }
    }

    sendAction(action, data = {}) {
      const message = { label: this.label, action, ...data };
      if (this.created) wire.notify("window-action", message);
      else this.pendingActions.push(message);
    }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; this.sendAction("bounds", { bounds }); }
    setContentSize(width, height) { this.setBounds({ ...this.bounds, width, height }); }
    setMenuBarVisibility() {}
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMaximized() { return this.maximized; }
    isMinimized() { return this.minimized; }
    focus() { this.sendAction("focus"); }
    showInactive() { this.setVisible(true); }
    show() { this.setVisible(true); this.focus(); }
    hide() { this.setVisible(false); }
    moveTop() {}
    minimize() { this.sendAction("minimize"); }
    restore() { this.sendAction("restore"); }
    maximize() { this.sendAction("maximize"); }
    unmaximize() { this.sendAction("unmaximize"); }
    close() {
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      if (!prevented) this.destroy();
    }
    destroy() { this.sendAction("destroy"); this.finishClose(); }
    setVisible(visible) {
      this.sendAction(visible ? "show" : "hide");
      if (this.visible === visible) return;
      this.visible = visible;
      this.emit(visible ? "show" : "hide");
    }
    finishClose() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      windows.delete(this.label);
      this.emit("closed");
      if (windows.size === 0) app.emit("window-all-closed");
    }
  }

  wire.on("window-event", ({ label, event, bounds, maximized, minimized }) => {
    const win = windows.get(label);
    if (!win) return;
    if (bounds) win.bounds = bounds;
    if (typeof minimized === "boolean") win.minimized = minimized;
    if (typeof maximized === "boolean" && win.maximized !== maximized) {
      win.maximized = maximized;
      win.emit(maximized ? "maximize" : "unmaximize");
    }
    if (event === "ready") {
      if (win.ready) return;
      win.ready = true;
      win.webContents.emit("did-finish-load");
      win.emit("ready-to-show");
    } else if (event === "close") win.close();
    else if (event === "destroyed") win.finishClose();
    else if (event === "blur") win.emit("blur");
  });

  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = channel => handlers.delete(channel);
  wire.on("renderer-ipc", async ({ id, label, channel, args, expectsReply }) => {
    const win = windows.get(label);
    const prefix = win && pagePrefixes.get(win.page);
    const sender = win?.webContents;
    try {
      if (!prefix || typeof channel !== "string" || !channel.startsWith(prefix) || !Array.isArray(args)) {
        throw new Error("IPC channel is unavailable in this CodePet window");
      }
      const event = { sender, senderFrame: sender.mainFrame };
      let value = null;
      if (expectsReply) {
        const handle = handlers.get(channel);
        if (!handle) throw new Error("IPC handler is unavailable");
        value = await handle(event, ...args);
      } else ipcMain.emit(channel, event, ...args);
      wire.send({ type: "ipc-result", id, value: value ?? null });
    } catch (error) {
      wire.send({ type: "ipc-result", id, error: error.message || String(error) });
    }
  });

  return { BrowserWindow, ipcMain };
}

module.exports = { createWindows };
