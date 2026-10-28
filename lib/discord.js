// Discord OAuth2 (implicit grant + loopback) — ไม่ต้องมี client secret
// ต้องเพิ่ม Redirect URI นี้ใน Discord Developer Portal → OAuth2: http://127.0.0.1:53682/callback
const http = require("http"), crypto = require("crypto");
const PORT = 53682, REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const PAGE = `<!doctype html><meta charset="utf-8"><title>Nexia</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#f4f4f2;font:15px system-ui;letter-spacing:.12em"><div id=m>NEXIA</div><script>
const q=new URLSearchParams(location.search.slice(1)+"&"+location.hash.slice(1));
fetch("/token?"+q).then(()=>{document.getElementById("m").textContent="เข้าสู่ระบบสำเร็จ — กลับไปที่ Nexia ได้เลย"}).catch(()=>{document.getElementById("m").textContent="เกิดข้อผิดพลาด"});
</script>`;

async function me(token) {
  const r = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("Discord token ใช้ไม่ได้ (" + r.status + ")");
  const u = await r.json();
  return { id: u.id, name: u.global_name || u.username, avatar: u.avatar };
}

function login(clientId, openUrl) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString("hex");
    let timer;
    const finish = (fn, v) => { clearTimeout(timer); srv.close(); fn(v); };
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname === "/callback") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(PAGE); }
      if (u.pathname === "/token") {
        res.writeHead(200); res.end("ok");
        const q = u.searchParams;
        if (q.get("state") !== state) return;                       // กัน request แปลกปลอม
        if (q.get("error")) return finish(reject, new Error(q.get("error") === "access_denied" ? "ยกเลิกการเข้าสู่ระบบ" : "Discord ปฏิเสธ: " + (q.get("error_description") || q.get("error"))));
        const token = q.get("access_token");
        if (!token) return;
        try { finish(resolve, { token, expiresAt: Date.now() + (+q.get("expires_in") || 604800) * 1000 - 60000, ...(await me(token)) }); }
        catch (e) { finish(reject, e); }
        return;
      }
      res.writeHead(404); res.end();
    });
    srv.on("error", (e) => reject(new Error(e.code === "EADDRINUSE" ? "พอร์ต " + PORT + " ถูกใช้อยู่ ปิดโปรแกรมที่ใช้พอร์ตนี้แล้วลองใหม่" : e.message)));
    srv.listen(PORT, "127.0.0.1", () => {
      timer = setTimeout(() => finish(reject, new Error("หมดเวลาเข้าสู่ระบบ")), 180000);
      openUrl("https://discord.com/oauth2/authorize?" + new URLSearchParams({ client_id: clientId, response_type: "token", scope: "identify", redirect_uri: REDIRECT, state }));
    });
  });
}
module.exports = { login, me };
