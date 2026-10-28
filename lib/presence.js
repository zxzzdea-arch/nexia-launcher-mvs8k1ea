// Discord Rich Presence ผ่าน IPC ของแอป Discord บนเครื่อง (ไม่ต้องใช้ library / ไม่ต้องล็อกอินเพิ่ม)
// ถ้า Discord ไม่ได้เปิดอยู่ จะลองต่อใหม่ทุก 15 วินาทีเงียบ ๆ
const net = require("net");
let sock = null, ready = false, buf = Buffer.alloc(0), cid = null, act = null, timer = null, stopped = false, n = 0;
const start = Date.now();
const frame = (op, o) => { const j = Buffer.from(JSON.stringify(o)), h = Buffer.alloc(8); h.writeInt32LE(op, 0); h.writeInt32LE(j.length, 4); return Buffer.concat([h, j]); };
const pipe = (i) => process.platform === "win32" ? `\\\\?\\pipe\\discord-ipc-${i}` : `${process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || "/tmp"}/discord-ipc-${i}`;

function send() {
  if (!sock || !ready) return;
  try { sock.write(frame(1, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: act || undefined }, nonce: String(++n) })); } catch {}
}
function retry() { if (stopped || timer) return; timer = setTimeout(() => { timer = null; connect(0); }, 15000); }
function connect(i) {
  if (stopped || sock) return;
  if (i > 9) return retry();
  const s = net.createConnection(pipe(i));
  let ok = false;
  s.once("connect", () => { ok = true; sock = s; buf = Buffer.alloc(0); s.write(frame(0, { v: 1, client_id: cid })); });
  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
      if (buf.length < 8 + len) break;
      let m = {}; try { m = JSON.parse(buf.slice(8, 8 + len).toString()); } catch {}
      buf = buf.slice(8 + len);
      if (op === 1 && m.evt === "READY") { ready = true; send(); }
      if (op === 2) s.destroy();
    }
  });
  s.on("error", () => { if (!ok) connect(i + 1); });
  s.on("close", () => { if (sock === s) { sock = null; ready = false; retry(); } });
}
function init(clientId) { if (!/^\d{15,25}$/.test(String(clientId))) return; cid = String(clientId); connect(0); }
function set(a) {
  act = { ...a, timestamps: { start }, assets: { large_image: "nexia", large_text: "Nexia Launcher" } };   // large_image = ชื่อ Art Asset ที่อัปโหลดใน Developer Portal
  send();
}
function stop() { stopped = true; clearTimeout(timer); try { if (sock && ready) sock.write(frame(1, { cmd: "SET_ACTIVITY", args: { pid: process.pid }, nonce: "x" })); sock && sock.end(); } catch {} }
module.exports = { init, set, stop };
