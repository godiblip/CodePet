(() => {
  const { core, event } = window.__TAURI__;
  const listeners = new Map();
  const sendIpc = (channel, args, expectsReply) => core.invoke("desktop_ipc", { channel, args, expectsReply });
  const ipcRenderer = {
    invoke: (channel, ...args) => sendIpc(channel, args, true),
    send: (channel, ...args) => sendIpc(channel, args, false).catch(error => console.error("CodePet IPC:", error)),
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
    },
    removeListener(channel, listener) { listeners.get(channel)?.delete(listener); },
  };
  window.codePetTauriBridge = {
    contextBridge: { exposeInMainWorld: (key, api) => { window[key] = Object.freeze(api); } },
    ipcRenderer,
    webUtils: { getPathForFile: () => null },
  };
  const events = event.listen("codepet-ipc", ({ payload }) => {
    for (const listener of listeners.get(payload.channel) || []) listener({}, ...payload.args);
  });
  if (location.pathname.endsWith("/chat.html")) {
    event.listen("codepet-file-drop", ({ payload }) => window.dispatchEvent(new CustomEvent("codepet-file-drop", { detail: payload })))
      .catch(error => console.error("CodePet attachments:", error));
  }
  document.addEventListener("DOMContentLoaded", () => {
    events.then(() => core.invoke("desktop_ready")).catch(error => console.error("CodePet renderer:", error));
  }, { once: true });
})();
