const { Console } = require("node:console");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DesktopWire } = require("./wire");
const { createWindows } = require("./windows");

const wire = new DesktopWire(process.stdin, process.stdout);
global.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const app = new EventEmitter();
const root = path.resolve(__dirname, "../..");
const home = os.homedir();
const appData = process.platform === "win32"
  ? process.env.APPDATA || path.join(home, "AppData", "Roaming")
  : process.platform === "darwin" ? path.join(home, "Library", "Application Support") : process.env.XDG_CONFIG_HOME || path.join(home, ".config");
const packageInfo = require("../../package.json");
const legacyPaths = ["CodePet", packageInfo.name].map(name => path.join(appData, name));
const paths = { home, appData, userData: legacyPaths.find(dir => fs.existsSync(path.join(dir, "settings.json"))) || legacyPaths[1], temp: os.tmpdir(), downloads: path.join(home, "Downloads") };
const ready = new Promise(resolve => wire.once("initialize", resolve));
app.tauri = true;
app.isPackaged = process.env.CODEPET_TAURI_PACKAGED === "1";
app.getAppPath = () => root;
app.getVersion = () => packageInfo.version;
app.getPath = name => paths[name];
app.setPath = (name, value) => { paths[name] = value; };
app.commandLine = { appendSwitch() {} };
app.getLoginItemSettings = () => ({ openAtLogin: false });
app.setLoginItemSettings = () => { throw new Error("Tauri 로그인 시 자동 실행은 아직 지원하지 않습니다."); };
app.whenReady = () => ready.then(() => { fs.mkdirSync(paths.userData, { recursive: true }); });
app.requestSingleInstanceLock = () => true;
let exiting = false;
app.exit = (code = 0) => {
  if (exiting) return;
  exiting = true;
  if (wire.closed) process.exit(code);
  wire.notify("quit", { code });
  process.stdout.write("", () => process.exit(code));
};
app.quit = () => {
  if (exiting) return;
  let prevented = false;
  app.emit("before-quit", { preventDefault() { prevented = true; } });
  if (!prevented) app.exit();
};
wire.on("second-instance", argv => app.emit("second-instance", {}, argv));
wire.on("quit", app.quit);
wire.on("disconnect", app.quit);

const { BrowserWindow, ipcMain } = createWindows(wire, app);
const screen = new EventEmitter();
let displays = [];
wire.on("initialize", data => { displays = data.displays; });
wire.on("displays", data => { displays = data; screen.emit("display-metrics-changed"); });
screen.getAllDisplays = () => displays;
screen.getPrimaryDisplay = () => displays.find(display => display.primary) || displays[0];
screen.getDisplayNearestPoint = ({ x, y }) => {
  const distance = ({ bounds }) =>
    Math.max(bounds.x - x, x - bounds.x - bounds.width, 0) ** 2 + Math.max(bounds.y - y, y - bounds.y - bounds.height, 0) ** 2;
  return displays.reduce((closest, display) => distance(display) < distance(closest) ? display : closest, screen.getPrimaryDisplay());
};
screen.getDisplayMatching = ({ x, y, width, height }) => screen.getDisplayNearestPoint({ x: x + width / 2, y: y + height / 2 });
screen.screenToDipRect = (_window, rect) => {
  const scale = screen.getDisplayMatching(rect)?.scaleFactor || 1;
  return Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, value / scale]));
};
const powerMonitor = new EventEmitter();
wire.on("resume", () => powerMonitor.emit("resume"));

let nextMenu = 1;
function createMenu(template) {
  const callbacks = new Map();
  const convert = items => items.filter(item => item.visible !== false).map(item => {
    const id = `codepet-menu-${nextMenu++}`;
    if (item.click) callbacks.set(id, item.click);
    return { id, label: item.label, type: item.type, enabled: item.enabled !== false, checked: Boolean(item.checked),
      submenu: Array.isArray(item.submenu) ? convert(item.submenu) : null };
  });
  return { items: convert(template), callbacks };
}
let trayMenu;
let popupMenu;
const Menu = { buildFromTemplate: template => ({
  popup({ window } = {}) {
    popupMenu = createMenu(template);
    wire.notify("menu-popup", { label: window?.label, items: popupMenu.items });
  },
  template,
}) };
wire.on("menu-event", id => (popupMenu?.callbacks.get(id) || trayMenu?.callbacks.get(id))?.());
class Tray extends EventEmitter {
  constructor(icon) {
    super();
    wire.notify("tray-create", { image: icon.data });
    this.onClick = ({ event, bounds }) => { this.bounds = bounds; this.emit(event); };
    wire.on("tray-event", this.onClick);
  }
  setToolTip(text) { wire.notify("tray-tooltip", { text }); }
  setContextMenu(menu) { trayMenu = createMenu(menu.template); wire.notify("tray-menu", { items: trayMenu.items }); }
  getBounds() { return this.bounds; }
  destroy() { wire.removeListener("tray-event", this.onClick); wire.notify("tray-destroy"); }
}

function imageSize(bytes) {
  if (bytes.length < 24) return {};
  if (bytes.toString("ascii", 12, 16) === "IHDR") return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.length < 30) return {};
  const format = bytes.toString("ascii", 12, 16);
  if (format === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  if (format === "VP8L") { const size = bytes.readUInt32LE(21); return { width: (size & 0x3fff) + 1, height: ((size >>> 14) & 0x3fff) + 1 }; }
  return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
}
function image(bytes) {
  return { data: bytes.toString("base64"), isEmpty: () => bytes.length === 0, getSize: () => imageSize(bytes), resize: () => image(bytes) };
}
const nativeImage = {
  createFromPath(file) { try { return image(fs.readFileSync(file)); } catch { return image(Buffer.alloc(0)); } },
  createFromDataURL(url) { return image(Buffer.from(url.split(",").pop(), "base64")); },
};
const shell = {
  openExternal: url => wire.request("open-external", { url }),
  openPath: file => wire.request("open-path", { file }).catch(error => error.message),
};
function showDialog(kind, window, options) {
  return wire.request("dialog", { kind, label: window?.label, options: options ?? window ?? {} });
}
const dialog = {
  showOpenDialog: (window, options) => showDialog("open", window, options),
  showSaveDialog: (window, options) => showDialog("save", window, options),
  showMessageBox: (window, options) => showDialog("message", window, options),
  showErrorBox: (title, message) => wire.notify("dialog", { kind: "error", options: { title, message } }),
};

module.exports = { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, shell, dialog, powerMonitor };
