const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "src");
const output = path.join(root, "dist", "tauri");
const pages = {
  "index.html": "preload.js",
  "bubble.html": "bubble-preload.js",
  "chat.html": "chat-preload.js",
  "settings.html": "settings-preload.js",
  "usage.html": "usage-preload.js",
  "live.html": "live-preload.js",
};

fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(source, "tauri", "renderer-bridge.js"), path.join(output, "tauri-bridge.js"));
fs.cpSync(path.join(source, "chat-icon"), path.join(output, "chat-icon"), { recursive: true });
for (const [page, preload] of Object.entries(pages)) {
  const html = fs.readFileSync(path.join(source, page), "utf8");
  for (const [, asset] of html.matchAll(/\b(?:src|href)="(?:\.\/)?([\w.-]+\.(?:js|css))"/g)) {
    fs.copyFileSync(path.join(source, asset), path.join(output, asset));
  }
  const preloadName = `tauri-${preload}`;
  const script = fs.readFileSync(path.join(source, preload), "utf8")
    .replace(/require\((?:'|")electron(?:'|")\)/g, "globalThis.codePetTauriBridge");
  fs.writeFileSync(path.join(output, preloadName), `(() => {\n${script}\n})();\n`);
  fs.writeFileSync(path.join(output, page), html
    .replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, "")
    .replace(/<script\b/i, `<script src="tauri-bridge.js"></script>\n    <script src="${preloadName}"></script>\n    <script`));
}
