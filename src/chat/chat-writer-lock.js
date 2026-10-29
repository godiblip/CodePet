const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const owned = new Set();
process.once("exit", () => { for (const release of owned) release(); });

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function acquire(file, depth = 0) {
  if (depth > 8) throw new Error("저장소 잠금 복구가 필요합니다.");
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, token, { flag: "wx", mode: 0o600 });
  try {
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = fs.readFileSync(file, "utf8");
      const owner = JSON.parse(previous);
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || alive(owner.pid)) {
        throw new Error("다른 writer가 이 저장소를 사용 중입니다.");
      }
      // Serialize stale-owner recovery. New writers can only claim the main
      // file after unlink; no reclaimer removes a replacement owner's file.
      const releaseRecovery = acquire(`${file}.recovery`, depth + 1);
      try {
        if (fs.readFileSync(file, "utf8") !== previous) throw new Error("저장소 writer가 변경되었습니다.");
        fs.unlinkSync(file);
        fs.linkSync(temporary, file);
      } finally { releaseRecovery(); }
    }
  } finally { fs.unlinkSync(temporary); }
  const release = () => {
    try { if (fs.readFileSync(file, "utf8") === token) fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    owned.delete(release);
  };
  owned.add(release);
  return release;
}

function acquireWriter(root) {
  fs.mkdirSync(root, { recursive: true });
  return acquire(path.join(fs.realpathSync(root), ".writer-lock"));
}
module.exports = { acquireWriter };
