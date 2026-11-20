const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");

test("the Tauri pipe starts the existing CodePet backend and isolates IPC by window", { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-tauri-test-"));
  const codePetHome = path.join(root, "store");
  const data = path.join(codePetHome, "runtime", "electron");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({ codexProxyMode: false, taskbarUsageVisible: false, manualPaused: true }));
  const launch = `
    require('node:os').homedir = () => process.env.CODEPET_TEST_HOME;
    require('./src/antigravity-credential').createAntigravityCredentialStore = () => ({
      read() { throw Object.assign(new Error('No fixture credential'), {code:'ENOENT'}); }
    });
    process.argv.push('--chat', '--settings', '--live', '--usage');
    require('./src/main.js');
  `;
  const child = spawn(process.execPath, ["-e", launch], {
    cwd: path.join(__dirname, ".."), windowsHide: true,
    env: { PATH: "", SystemRoot: process.env.SystemRoot, CODEPET_TAURI_BACKEND: "1",
      CODEPET_TEST_HOME: root, CODE_PET_HOME: codePetHome, APPDATA: root, LOCALAPPDATA: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { diagnostics += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const messages = [];
  const output = createInterface({ input: child.stdout });
  output.on("line", line => messages.push(JSON.parse(line)));
  const write = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const event = (name, data) => write({ type: "host-event", event: name, data });
  const find = async predicate => {
    for (let i = 0; i < 300; i++) {
      const message = messages.find(predicate);
      if (message) return message;
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`Expected backend message. ${diagnostics}`);
  };
  const area = { x: 0, y: 0, width: 1920, height: 1000 };
  event("initialize", { displays: [{ id: 1, primary: true, scaleFactor: 1, workArea: area, bounds: area }] });
  const pages = {};
  for (const page of ["index.html", "chat.html", "settings.html", "live.html", "usage.html"]) {
    const request = await find(message => message.operation === "window-create" && message.data.page === page);
    pages[page] = request.data.label;
    write({ type: "desktop-result", id: request.id, value: null });
    event("window-event", { label: request.data.label, event: "ready" });
  }
  let nextIpc = 0;
  async function invoke(page, channel, args = []) {
    const id = ++nextIpc;
    event("renderer-ipc", { id, label: pages[page], channel, args, expectsReply: true });
    return find(message => message.type === "ipc-result" && message.id === id);
  }
  assert.match((await invoke("index.html", "pet:get-app-config")).value.spriteUrl, /^data:image\/webp;base64,/);
  const settings = (await invoke("settings.html", "settings:get")).value;
  assert.equal(settings.ok, true);
  assert.equal(settings.data.autoStartAvailable, false);
  assert.equal((await invoke("settings.html", "settings:check-update")).value.status, "unsupported");
  assert.equal((await invoke("live.html", "live:window", ["minimize"])).value.ok, true);
  assert.ok(Array.isArray((await invoke("usage.html", "usage-monitor:get")).value.providers));
  assert.equal((await invoke("chat.html", "chat:sessions:create")).value.ok, true);
  assert.match((await invoke("index.html", "chat:sessions:create")).error, /unavailable in this CodePet window/);
  await find(message => message.operation === "tray-menu");
  const done = once(child, "close");
  event("quit", null);
  assert.equal((await done)[0], 0, diagnostics);
});
