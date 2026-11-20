const { EventEmitter } = require("node:events");
const { createInterface } = require("node:readline");

class DesktopWire extends EventEmitter {
  constructor(input, output) {
    super();
    this.output = output;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    const lines = createInterface({ input });
    lines.on("line", line => this.accept(line));
    lines.once("close", () => this.disconnect());
    output.on("error", () => this.disconnect());
  }

  send(message) {
    if (!this.closed) this.output.write(`${JSON.stringify(message)}\n`);
  }

  notify(operation, data = {}) { this.send({ type: "desktop", operation, data }); }

  request(operation, data = {}) {
    if (this.closed) return Promise.reject(new Error("Tauri host is disconnected"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.send({ type: "desktop", id, operation, data });
    });
  }

  accept(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === "desktop-result") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.value);
    } else if (message.type === "host-event") {
      this.emit(message.event, message.data);
    }
  }

  disconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error("Tauri host is disconnected"));
    this.pending.clear();
    this.emit("disconnect");
  }
}

module.exports = { DesktopWire };
