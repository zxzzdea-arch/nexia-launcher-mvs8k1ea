const { app, BrowserWindow, Menu, ipcMain, shell, safeStorage } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os");
const { spawn } = require("child_process");
app.setPath("userData", path.join(app.getPath("appData"), "Nexia"));   // คงโฟลเดอร์ข้อมูลเดิม (session/config) แม้เปลี่ยนชื่อแอปเป็น Nexia Launcher
const DEFAULT_API_BASE = "https://backoffice.elainasann.in.th";
const cfg = { ...require("./config.json"), ...(() => { try { return JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "config.json"), "utf8")); } catch { return {}; } })() };
// Migrate the old starter URL automatically; keep custom API endpoints intact.
if (!cfg.apiBase || /YOUR-SUBDOMAIN|\.workers\.dev$/i.test(String(cfg.apiBase))) cfg.apiBase = DEFAULT_API_BASE;
cfg.apiBase = String(cfg.apiBase).replace(/\/+$/, "");
const discord = require("./lib/discord");
const mc = require("./lib/mc");
const presence = require("./lib/presence");
const library = require("./lib/library");
const { Client: MinecraftClient } = require("minecraft-launcher-core");
const { Auth: MicrosoftAuth } = require("msmc");

let win, session = null, instances = [], launcherInfo = null, gameLogTimer = null, gameLogWatch = null;
const runningGames = new Map();
const dataDir = () => app.getPath("userData");
const mcDir = () => path.join(app.getPath("appData"), ".minecraft");   // โฟลเดอร์ไฟล์เกม/ไลบรารี; ไม่ต้องติดตั้ง Launcher ทางการ
const nexiaDir = () => path.join(app.getPath("appData"), ".nexia");     // Java / instance / mod ของ Nexia
const isInstalledProfile = (id) => {
  const dir = path.join(nexiaDir(), "instances", id);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, ".nexia-launch.json"), "utf8"));
    return !!(meta.versionId && meta.javaPath && fs.existsSync(path.join(mcDir(), "versions", meta.versionId, meta.versionId + ".json")));
  } catch { return false; }
};
const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };
const emit = (label, done, total) => send("progress", { label, done, total });
const okStr = (s) => typeof s === "string" && s !== "." && s !== ".." && /^[\w.+\-]{1,64}$/.test(s);
const artworkDir = () => path.join(nexiaDir(), "artwork");
const ART_KINDS = new Set(["cover", "icon", "banner"]);
const artworkStem = (id, kind = "cover") => `${id}${kind === "cover" ? "" : "-" + kind}`;
const artworkPath = (id, kind = "cover") => {
  if (!okStr(id) || !ART_KINDS.has(kind)) return null;
  for (const ext of ["jpg", "png", "webp"]) {
    const f = path.join(artworkDir(), `${artworkStem(id, kind)}.${ext}`);
    try { if (fs.existsSync(f) && fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
};
const readArtwork = (id, kind = "cover") => {
  try {
    const f = artworkPath(id, kind); if (!f) return "";
    const ext = path.extname(f).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return `data:${mime};base64,${fs.readFileSync(f).toString("base64")}`;
  } catch { return ""; }
};
const removeArtwork = (id, kind = null) => {
  if (!okStr(id)) return;
  for (const k of (kind && ART_KINDS.has(kind) ? [kind] : [...ART_KINDS])) {
    for (const ext of ["jpg", "png", "webp"]) { try { fs.rmSync(path.join(artworkDir(), `${artworkStem(id, k)}.${ext}`), { force: true }); } catch {} }
  }
};
const nameOverridesFile = () => path.join(nexiaDir(), "instance-name-overrides.json");
const readNameOverrides = () => { try { const d = JSON.parse(fs.readFileSync(nameOverridesFile(), "utf8")); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; } catch { return {}; } };
const saveNameOverrides = (value) => { fs.mkdirSync(nexiaDir(), { recursive: true }); const f = nameOverridesFile(); fs.writeFileSync(f + ".tmp", JSON.stringify(value, null, 2)); fs.renameSync(f + ".tmp", f); };
function decodeArtwork(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m || m[2].length > 12 * 1024 * 1024) throw new Error("รองรับ JPG, PNG หรือ WEBP ขนาดไม่เกิน 8 MB");
  const buffer = Buffer.from(m[2], "base64");
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error("ไฟล์รูปใหญ่เกิน 8 MB");
  const valid = m[1] === "jpeg" ? buffer[0] === 0xff && buffer[1] === 0xd8 : m[1] === "png" ? buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw new Error("ไฟล์รูปไม่ถูกต้อง");
  return { buffer, ext: m[1] === "jpeg" ? "jpg" : m[1] };
}
function saveArtworkData(id, dataUrl, kind = "cover") {
  if (!ART_KINDS.has(kind)) throw new Error("ประเภทภาพไม่ถูกต้อง");
  const { buffer, ext } = decodeArtwork(dataUrl);
  fs.mkdirSync(artworkDir(), { recursive: true });
  const target = path.join(artworkDir(), `${artworkStem(id, kind)}.${ext}`);
  fs.writeFileSync(target + ".tmp", buffer); fs.renameSync(target + ".tmp", target);
  for (const other of ["jpg", "png", "webp"]) if (other !== ext) { try { fs.rmSync(path.join(artworkDir(), `${artworkStem(id, kind)}.${other}`), { force: true }); } catch {} }
  return readArtwork(id, kind);
}
const ramFile = () => path.join(nexiaDir(), "ram-settings.json");
const maxRamMb = () => Math.max(1024, Math.min(32768, Math.floor(os.totalmem() / 1048576) - 2048));
const readRamMap = () => { try { const d = JSON.parse(fs.readFileSync(ramFile(), "utf8")); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; } catch { return {}; } };
const ramFor = (id, fallback = 4096) => {
  const n = Number(readRamMap()[id]);
  const v = Number.isFinite(n) && n >= 1024 ? n : Number(fallback) || 4096;
  return Math.min(maxRamMb(), Math.max(1024, Math.round(v / 512) * 512));
};
const saveRamFor = (id, value) => {
  if (!Number.isFinite(Number(value))) throw new Error("ค่า RAM ไม่ถูกต้อง");
  const n = Math.min(maxRamMb(), Math.max(1024, Math.round(Number(value) / 512) * 512));
  const m = readRamMap(); m[id] = n; fs.mkdirSync(nexiaDir(), { recursive: true });
  fs.writeFileSync(ramFile() + ".tmp", JSON.stringify(m, null, 2)); fs.renameSync(ramFile() + ".tmp", ramFile()); return n;
};
const idle = () => presence.set({ details: "Nexia Launcher", state: session ? "กำลังเลือก Instance" : "เปิดแอป" });
const pub = (s) => ({ id: s.id, name: s.name, avatar: s.avatar });

// ---- เก็บ session Discord แบบเข้ารหัส (Windows DPAPI) ----
const tokFile = () => path.join(dataDir(), "auth.bin");
const saveS = (s) => { try { if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(tokFile(), safeStorage.encryptString(JSON.stringify(s))); } catch {} };
const loadS = () => { try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(tokFile()))); } catch { return null; } };
const needSession = () => { if (!session || session.expiresAt < Date.now()) throw new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่"); return session; };

// Microsoft/Minecraft account is separate from Discord whitelist authentication.
// Store only MSMC's refreshable auth state, encrypted by Electron safeStorage (Windows DPAPI).
const mcAuthFile = () => path.join(dataDir(), "minecraft-auth.bin");
function savedMinecraftToken() {
  try { if (!safeStorage.isEncryptionAvailable()) return null; return safeStorage.decryptString(fs.readFileSync(mcAuthFile())); }
  catch { return null; }
}
function saveMinecraftToken(value) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.mkdirSync(dataDir(), { recursive: true });
    const target = mcAuthFile();
    fs.writeFileSync(target + ".tmp", safeStorage.encryptString(value));
    fs.renameSync(target + ".tmp", target);
    return true;
  } catch { return false; }
}
async function getMinecraftAccount() {
  const auth = new MicrosoftAuth("select_account");
  let xbox = null;
  const token = savedMinecraftToken();
  if (token) {
    try { xbox = await auth.refresh(token); }
    catch { xbox = null; }
  }
  if (!xbox) {
    try { xbox = await auth.launch("electron", { width: 520, height: 720, resizable: false }); }
    catch (e) { throw new Error("เข้าสู่ระบบ Microsoft ไม่สำเร็จหรือถูกยกเลิก: " + (e?.message || e)); }
  }
  try {
    if (!xbox.validate()) await xbox.refresh(true);
    const profile = await xbox.getMinecraft();
    const entitlements = await profile.entitlements();
    if (!entitlements.some((x) => ["game_minecraft", "product_minecraft"].includes(x))) {
      throw new Error("บัญชี Microsoft นี้ยังไม่มีสิทธิ์เล่น Minecraft: Java Edition กรุณาใช้บัญชีที่ซื้อเกมแล้ว");
    }
    saveMinecraftToken(xbox.save());
    return { authorization: profile.mclc(), username: profile.profile?.name || "Minecraft Player" };
  } catch (e) {
    const message = String(e?.message || e);
    if (/entitlement|game_minecraft|product_minecraft|own.*minecraft|minecraft.*profile/i.test(message)) {
      throw new Error("ตรวจสอบสิทธิ์ Minecraft ไม่สำเร็จ บัญชีที่ใช้ต้องมี Minecraft: Java Edition หรือสิทธิ์ที่รองรับอยู่");
    }
    throw new Error(message || "ยืนยันบัญชี Minecraft ไม่สำเร็จ");
  }
}

ipcMain.handle("auth:restore", async () => {
  const s = loadS(); if (!s || s.expiresAt < Date.now()) return null;
  try { session = { ...s, ...(await discord.me(s.token)) }; idle(); return pub(session); } catch { return null; }
});
ipcMain.handle("auth:login", async () => {
  if (!/^\d{15,25}$/.test(String(cfg.discordClientId))) throw new Error("ยังไม่ได้ใส่ discordClientId ใน config.json");
  session = await discord.login(cfg.discordClientId, (u) => shell.openExternal(u)); saveS(session); idle(); return pub(session); });
ipcMain.handle("auth:logout", async () => { session = null; idle(); instances = []; stopGameLogWatch(); try { fs.rmSync(tokFile(), { force: true }); } catch {} });

// ---- Instance: ดึงจากเว็บเท่านั้น (ต้องอยู่ใน whitelist ตาม Discord ID) ----
ipcMain.handle("instances:list", async () => {
  const s = needSession();
  let r;
  try {
    r = await fetch(cfg.apiBase + "/api/instances", { method: "POST", headers: { Authorization: "Bearer " + s.token, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(e?.name === "TimeoutError" || e?.name === "AbortError" ? "Backoffice ตอบกลับช้าเกินไป (เกิน 20 วินาที)" : "เชื่อมต่อ Backoffice ไม่ได้: " + (e?.message || e));
  }
  if (r.status === 401) throw new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  if (!r.ok) throw new Error("Backoffice API /api/instances ตอบกลับผิดพลาด (" + r.status + ")");
  let d;
  try { d = await r.json(); } catch { throw new Error("Backoffice ต้องตอบ JSON จาก POST /api/instances ไม่ใช่หน้าเว็บ HTML"); }
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("รูปแบบข้อมูลจาก Backoffice ไม่ถูกต้อง");
  const nameOverrides = readNameOverrides();
  instances = (d.instances || []).filter((i) => okStr(i.id) && !/^custom-/.test(i.id) && okStr(i.mc) && ["vanilla", "fabric", "forge"].includes(i.loader) && (!i.loaderVersion || okStr(i.loaderVersion)))
    .map((i) => ({ ...i, name: nameOverrides[i.id] || i.name }));
  if (d.launcher) checkUpdate(d.launcher);
  const out = await Promise.all(instances.map(async (i) => ({
    id: i.id, name: i.name, mc: i.mc, loader: i.loader, loaderVersion: i.loaderVersion, description: i.description, ramMb: ramFor(i.id, i.ramMb),
    iconUrl: readArtwork(i.id, "icon") || i.iconUrl || i.icon || "", bannerUrl: readArtwork(i.id, "banner") || i.bannerUrl || i.banner || "", coverUrl: i.coverUrl || i.cover || "", artworkUrl: readArtwork(i.id), gameInstalled: isInstalledProfile(i.id),
    ...(await mc.packInfo(nexiaDir(), i.id, i.packUrl)),
  })));
  return { whitelisted: !!d.whitelisted, id: s.id, name: s.name, instances: out };
});
const profIcon = () => "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "assets", "profile-icon.png")).toString("base64");
async function doInstall(i, ramMb) {
  presence.set({ details: "กำลังติดตั้ง / อัปเดต", state: i.name });
  try {
    const result = await mc.install({ mcDir: mcDir(), nexiaDir: nexiaDir(), inst: i, ramMb: ramMb || i.ramMb, icon: profIcon(), emit });
    const gameDir = path.join(nexiaDir(), "instances", i.id);
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, ".nexia-launch.json"), JSON.stringify({
      versionId: result.versionId, javaPath: result.javaPath, javaConsolePath: result.javaConsolePath,
      javaComponent: result.javaComponent, gameDir, updatedAt: new Date().toISOString()
    }, null, 2));
    presence.set({ details: "พร้อมเล่น", state: i.name });
    send("installed", { name: i.name, versionId: result.versionId });
    return { ...result, gameDir };
  } catch (e) { idle(); throw e; }
}
ipcMain.handle("instances:install", async (_e, id, ramMb) => {
  needSession();
  const c = loadC().find((x) => x.id === id);
  const i = c || instances.find((x) => x.id === id);        // ใช้เฉพาะ instance ที่ server ส่งมา หรือที่ผู้เล่นสร้างเอง
  if (!i) throw new Error("ไม่พบ instance");
  const result = await doInstall(i, ramMb);
  if (c) saveC(loadC().map((x) => x.id === id ? { ...x, installed: true, ramMb: ramMb || x.ramMb } : x));
  return { versionId: result.versionId, installed: true };
});

// ---- สร้าง Instance เอง (เก็บในเครื่อง %APPDATA%\.nexia\custom-instances.json) ----
const LOADERS = ["vanilla", "fabric", "forge"];
const custFile = () => path.join(nexiaDir(), "custom-instances.json");
const validImageUrl = (value) => !value || (typeof value === "string" && value.length <= 2048 && /^https:\/\//i.test(value));
const validC = (i) => i && /^custom-[a-f0-9]{8}$/.test(i.id) && typeof i.name === "string" && okStr(i.mc) && LOADERS.includes(i.loader) && (i.loader === "vanilla" || okStr(i.loaderVersion)) && validImageUrl(i.iconUrl) && validImageUrl(i.bannerUrl) && validImageUrl(i.coverUrl);
const loadC = () => { try { const a = JSON.parse(fs.readFileSync(custFile(), "utf8")); return Array.isArray(a) ? a.filter(validC) : []; } catch { return []; } };
const saveC = (a) => { fs.mkdirSync(nexiaDir(), { recursive: true }); fs.writeFileSync(custFile() + ".tmp", JSON.stringify(a, null, 2)); fs.renameSync(custFile() + ".tmp", custFile()); };

ipcMain.handle("custom:versions", async () => { needSession(); return mc.listMcVersions(); });
ipcMain.handle("custom:loaders", async (_e, mcv, loader) => {
  needSession();
  if (!okStr(mcv) || !LOADERS.includes(loader)) throw new Error("ข้อมูลไม่ถูกต้อง");
  return mc.listLoaderVersions(mcv, loader);
});
ipcMain.handle("custom:list", async () => loadC().map((i) => ({ id: i.id, name: i.name, mc: i.mc, loader: i.loader, loaderVersion: i.loaderVersion, ramMb: ramFor(i.id, i.ramMb), custom: true,
  description: i.description || "Instance ที่สร้างเอง — ติดตั้ง Mods ได้จาก Library", iconUrl: readArtwork(i.id, "icon") || i.iconUrl || "", bannerUrl: readArtwork(i.id, "banner") || i.bannerUrl || "", coverUrl: i.coverUrl || "", artworkUrl: readArtwork(i.id), gameInstalled: isInstalledProfile(i.id), local: i.installed ? "custom" : null, remote: null })));
ipcMain.handle("custom:create", async (_e, f) => {
  needSession();
  f = f || {};
  const name = String(f.name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  if (!name) throw new Error("กรุณาตั้งชื่อ Instance");
  if (!okStr(f.mc) || !LOADERS.includes(f.loader)) throw new Error("ข้อมูลไม่ถูกต้อง");
  if (!(await mc.listMcVersions()).includes(f.mc)) throw new Error("ไม่พบเวอร์ชัน Minecraft " + f.mc);
  let loaderVersion;
  if (f.loader !== "vanilla") {
    if (!okStr(f.loaderVersion) || !(await mc.listLoaderVersions(f.mc, f.loader)).includes(f.loaderVersion)) throw new Error("เวอร์ชันของ " + f.loader + " ไม่รองรับกับ Minecraft " + f.mc);
    loaderVersion = f.loaderVersion;
  }
  const all = loadC();
  if (all.length >= 50) throw new Error("สร้างได้สูงสุด 50 Instance");
  const id = "custom-" + require("crypto").randomBytes(4).toString("hex");
  const description = String(f.description || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 400);
  const iconUrl = String(f.iconUrl || "").trim(), bannerUrl = String(f.bannerUrl || "").trim();
  if (![iconUrl, bannerUrl].every(validImageUrl)) throw new Error("Icon / Banner URL ต้องเป็นลิงก์ HTTPS ที่ถูกต้อง หรือเว้นว่างไว้เพื่ออัปโหลดไฟล์");
  // Validate image payloads before creating the record so a bad file cannot leave a half-created Instance.
  if (f.iconData) decodeArtwork(f.iconData);
  if (f.bannerData) decodeArtwork(f.bannerData);
  const rec = { id, name, mc: f.mc, loader: f.loader, ...(loaderVersion ? { loaderVersion } : {}), ramMb: Math.min(Math.max(Math.round(+f.ramMb) || 4096, 1024), 32768), description, iconUrl, bannerUrl, coverUrl: "", installed: false };
  saveC([...all, rec]);
  try {
    if (f.iconData) saveArtworkData(id, f.iconData, "icon");
    if (f.bannerData) saveArtworkData(id, f.bannerData, "banner");
  } catch (e) {
    saveC(loadC().filter((x) => x.id !== id)); removeArtwork(id); throw e;
  }
  return id;
});
ipcMain.handle("instance:rename", async (_e, id, rawName) => {
  needSession();
  if (!knownInstance(id)) throw new Error("ไม่พบ Instance ที่ต้องการเปลี่ยนชื่อ");
  const name = String(rawName || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  if (!name) throw new Error("กรุณาใส่ชื่อ Instance");
  const custom = loadC();
  if (custom.some((x) => x.id === id)) {
    saveC(custom.map((x) => x.id === id ? { ...x, name } : x));
  } else {
    const overrides = readNameOverrides(); overrides[id] = name; saveNameOverrides(overrides);
    instances = instances.map((x) => x.id === id ? { ...x, name } : x);
  }
  return { id, name };
});
ipcMain.handle("custom:delete", async (_e, id) => {
  needSession();
  if (!loadC().some((x) => x.id === id)) throw new Error("ไม่พบ instance");
  saveC(loadC().filter((x) => x.id !== id));
  try { mc.removeProfile(mcDir(), id); } catch {}        // ลบเฉพาะโปรไฟล์/รายการ ไม่ลบโฟลเดอร์เกม (กันโลกหาย)
  removeArtwork(id);
  const nameOverrides = readNameOverrides(); delete nameOverrides[id]; try { saveNameOverrides(nameOverrides); } catch {}
  const prefs = readRamMap(); delete prefs[id];
  try { fs.writeFileSync(ramFile() + ".tmp", JSON.stringify(prefs, null, 2)); fs.renameSync(ramFile() + ".tmp", ramFile()); } catch {}
});
ipcMain.handle("custom:open", async (_e, id) => {
  if (!loadC().some((x) => x.id === id)) throw new Error("ไม่พบ instance");
  const d = path.join(nexiaDir(), "instances", id); fs.mkdirSync(d, { recursive: true });
  const err = await shell.openPath(d); if (err) throw new Error(err);
});

// Tail the latest.log file written by the Minecraft process started directly by Nexia.
function stopGameLogWatch() {
  if (gameLogTimer) clearInterval(gameLogTimer);
  gameLogTimer = null; gameLogWatch = null;
}
function startGameLogWatch(id) {
  stopGameLogWatch();
  const file = path.join(nexiaDir(), "instances", id, "logs", "latest.log");
  let position = 0;
  try { position = fs.statSync(file).size; } catch {}
  gameLogWatch = { id, file, position, partial: "" };
  gameLogTimer = setInterval(() => {
    const watch = gameLogWatch; if (!watch) return;
    let size; try { size = fs.statSync(watch.file).size; } catch { return; }
    if (size < watch.position) { watch.position = 0; watch.partial = ""; }
    if (size <= watch.position) return;
    const length = Math.min(size - watch.position, 128 * 1024);
    const buffer = Buffer.alloc(length); let fd;
    try { fd = fs.openSync(watch.file, "r"); const n = fs.readSync(fd, buffer, 0, length, watch.position); watch.position += n; }
    catch { return; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
    const pieces = (watch.partial + buffer.toString("utf8")).split(/\r?\n/); watch.partial = (pieces.pop() || "").slice(-12000);
    for (const line of pieces) if (line) send("game-log", { id: watch.id, line: String(line).slice(0, 4000) });
  }, 1200);
}

// ---- Instance artwork, file lists, RAM settings and launcher opening ----
const knownInstance = (id) => okStr(id) && (loadC().some((x) => x.id === id) || instances.some((x) => x.id === id));

ipcMain.handle("minecraft:logout", async () => {
  needSession();
  try { fs.rmSync(mcAuthFile(), { force: true }); } catch {}
  try { fs.rmSync(mcAuthFile() + ".tmp", { force: true }); } catch {}
  return { signedOut: true };
});

ipcMain.handle("minecraft:play", async (_e, id, requestedRam) => {
  needSession();
  if (!knownInstance(id)) throw new Error("ไม่พบ Instance กรุณารีเฟรชรายการแล้วลองอีกครั้ง");
  const existing = runningGames.get(id);
  if (existing && existing.exitCode == null && existing.killed !== true) throw new Error("Minecraft Instance นี้กำลังทำงานอยู่แล้ว");
  for (const [otherId, proc] of runningGames.entries()) {
    if (otherId !== id && proc && proc.exitCode == null && proc.killed !== true) {
      throw new Error("Minecraft อีก Instance กำลังทำงานอยู่ กรุณาปิดเกมเดิมก่อนเพื่อป้องกันการชนกันของทรัพยากร");
    }
  }
  const custom = loadC().find((x) => x.id === id);
  const inst = custom || instances.find((x) => x.id === id);
  if (!inst) throw new Error("ไม่พบข้อมูล Minecraft Instance");
  send("launcher-log", { id, line: "ตรวจสอบบัญชี Microsoft และสิทธิ์ Minecraft...", kind: "info" });
  const account = await getMinecraftAccount();
  send("launcher-log", { id, line: "เข้าสู่ระบบเป็น " + account.username, kind: "ok" });
  const ramMb = ramFor(id, requestedRam || inst.ramMb);
  const installed = await doInstall(inst, ramMb);
  const gameDir = path.join(nexiaDir(), "instances", id);
  const root = mcDir();
  if (!fs.existsSync(path.join(root, "versions", installed.versionId, installed.versionId + ".json"))) {
    throw new Error("ไม่พบไฟล์เวอร์ชันเกมหลังติดตั้ง กรุณากด PLAY อีกครั้งเพื่อติดตั้งใหม่");
  }
  send("launcher-log", { id, line: "กำลังตรวจสอบไฟล์เกมและดาวน์โหลด Assets / Libraries ที่ขาด...", kind: "info" });
  const launcher = new MinecraftClient();
  // Avoid logging raw JVM command lines: those can contain authentication tokens.
  launcher.on("debug", (message) => {
    const line = String(message ?? "").replace(/(--accessToken\s+)\S+/gi, "$1[REDACTED]").replace(/(access_token[\"'=:\s]+)[^\s,}]+/gi, "$1[REDACTED]");
    if (line && !/access.?token|client.?token|refresh.?token|authorization/i.test(line)) send("launcher-log", { id, line: line.slice(0, 600), kind: "info" });
  });
  let progressEvents = 0;
  launcher.on("progress", (p) => {
    progressEvents++;
    if (progressEvents !== 1 && progressEvents % 10 !== 0) return;
    const task = typeof p === "string" ? p : (p?.type || p?.task || p?.name || "กำลังดาวน์โหลดไฟล์เกม");
    send("launcher-log", { id, line: String(task).slice(0, 300), kind: "info" });
  });
  const runtime = process.platform === "win32" ? installed.javaPath : installed.javaConsolePath;
  const options = {
    authorization: account.authorization,
    root,
    version: { number: inst.mc, type: "release", custom: installed.versionId },
    memory: { max: `${ramMb}M`, min: `${Math.min(1024, ramMb)}M` },
    javaPath: runtime,
    customArgs: ["-XX:+UseG1GC"],
    overrides: { gameDirectory: gameDir, cwd: gameDir },
    timeout: 120000
  };
  let child;
  try { child = await launcher.launch(options); }
  catch (e) { throw new Error("เปิด Minecraft ไม่สำเร็จ: " + (e?.message || e)); }
  if (!child || typeof child.on !== "function") throw new Error("ตัว Launcher ไม่สามารถเริ่มโปรเซส Minecraft ได้ กรุณาดู Log แล้วลองใหม่");
  runningGames.set(id, child);
  child.once("close", (code) => {
    if (runningGames.get(id) === child) runningGames.delete(id);
    send("game-state", { id, running: false, code });
    send("launcher-log", { id, line: `Minecraft ปิดแล้ว (exit code ${code ?? "unknown"})`, kind: code === 0 ? "ok" : "warn" });
    if (gameLogWatch?.id === id) stopGameLogWatch();
  });
  child.once("error", (e) => {
    send("launcher-log", { id, line: "โปรเซส Minecraft มีข้อผิดพลาด: " + (e?.message || e), kind: "err" });
  });
  startGameLogWatch(id);
  if (custom) saveC(loadC().map((x) => x.id === id ? { ...x, installed: true, ramMb } : x));
  send("game-state", { id, running: true, pid: child.pid, username: account.username });
  send("launcher-log", { id, line: "เริ่ม Minecraft แล้ว — Nexia จะติดตาม logs/latest.log ให้อัตโนมัติ", kind: "ok" });
  return { started: true, pid: child.pid || null, username: account.username, versionId: installed.versionId };
});
ipcMain.handle("artwork:set", async (_e, id, dataUrl, kind = "cover") => {
  needSession();
  if (!knownInstance(id)) throw new Error("ไม่พบ Instance ที่ต้องการเปลี่ยนรูป");
  if (!ART_KINDS.has(kind)) throw new Error("เลือกประเภทภาพ Icon, Banner หรือ Cover ให้ถูกต้อง");
  return saveArtworkData(id, dataUrl, kind);
});
ipcMain.handle("artwork:clear", async (_e, id, kind = "cover") => {
  needSession(); if (!knownInstance(id)) throw new Error("ไม่พบ Instance");
  if (!ART_KINDS.has(kind)) throw new Error("ประเภทภาพไม่ถูกต้อง");
  removeArtwork(id, kind); return true;
});
ipcMain.handle("instance:ram:get", async (_e, id, fallback) => {
  needSession(); if (!knownInstance(id)) throw new Error("ไม่พบ Instance");
  return { ramMb: ramFor(id, fallback), totalMb: Math.floor(os.totalmem() / 1048576), maxMb: maxRamMb() };
});
ipcMain.handle("instance:ram:set", async (_e, id, value) => {
  needSession(); if (!knownInstance(id)) throw new Error("ไม่พบ Instance");
  return { ramMb: saveRamFor(id, value), totalMb: Math.floor(os.totalmem() / 1048576), maxMb: maxRamMb() };
});
ipcMain.handle("instance:files", async (_e, id) => {
  needSession(); if (!knownInstance(id)) throw new Error("ไม่พบ Instance");
  const root = path.join(nexiaDir(), "instances", id), spec = { mods: ["mods", /\.jar$/i], resourcepacks: ["resourcepacks", /\.(zip|mcpack)$/i], shaders: ["shaderpacks", /\.(zip|jar)$/i] };
  const result = {};
  for (const [key, [folder, re]] of Object.entries(spec)) {
    const dir = path.join(root, folder); let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isFile() && re.test(x.name)).map((x) => ({ name: x.name, size: (() => { try { return fs.statSync(path.join(dir, x.name)).size; } catch { return 0; } })() })).sort((a,b) => a.name.localeCompare(b.name)).slice(0, 500); } catch {}
    result[key] = items;
  }
  return result;
});
ipcMain.handle("instance:remove-local", async (_e, id) => {
  needSession(); if (!knownInstance(id)) throw new Error("ไม่พบ Instance");
  const dir = path.join(nexiaDir(), "instances", id);
  try { mc.removeProfile(mcDir(), id); } catch (e) { throw new Error("ถอดโปรไฟล์ Minecraft ไม่สำเร็จ: " + e.message); }
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 }); }
  catch (e) { throw new Error("ลบไฟล์ Instance ในเครื่องไม่สำเร็จ: " + e.message); }
  return { removed: true };
});
ipcMain.handle("instance:open-folder", async (_e, id, type = "root") => {
  needSession(); if (!knownInstance(id)) throw new Error("ไม่พบ Instance");
  const dirs = { root: "", mods: "mods", resourcepacks: "resourcepacks", shaders: "shaderpacks" };
  if (!Object.prototype.hasOwnProperty.call(dirs, type)) throw new Error("ประเภทโฟลเดอร์ไม่ถูกต้อง");
  const d = path.join(nexiaDir(), "instances", id, dirs[type]); fs.mkdirSync(d, { recursive: true });
  const err = await shell.openPath(d); if (err) throw new Error(err); return true;
});
ipcMain.handle("instance:logs:start", async (_e, id) => {
  needSession(); if (!knownInstance(id)) throw new Error("ไม่พบ Instance สำหรับ Log");
  startGameLogWatch(id); return { watching: true };
});
ipcMain.handle("instance:logs:stop", async () => { stopGameLogWatch(); return { watching: false }; });
// ---- Library: Modrinth only ----
ipcMain.handle("library:search", async (_e, options) => { needSession(); return library.search(options); });
ipcMain.handle("library:install", async (_e, payload) => {
  needSession();
  const p = payload || {};
  const id = String(p.instanceId || "");
  const custom = loadC().find((x) => x.id === id);
  const inst = custom || instances.find((x) => x.id === id);
  if (!inst) throw new Error("ไม่พบ Instance เป้าหมาย กรุณารีเฟรชรายการก่อน");
  const gameDir = path.join(nexiaDir(), "instances", id);
  let launchMeta = null;
  try { launchMeta = JSON.parse(fs.readFileSync(path.join(gameDir, ".nexia-launch.json"), "utf8")); } catch {}
  if (!fs.existsSync(gameDir) || !launchMeta?.versionId) throw new Error("ต้องติดตั้ง Instance นี้ก่อน จึงจะเพิ่มมอด / Resource Pack / Shader ได้");
  const result = await library.install({ project: p.project, instance: inst, gameDir, emit: (v) => send("progress", v) });
  if (custom) saveC(loadC().map((x) => x.id === id ? { ...x, installed: true } : x));
  return result;
});
ipcMain.handle("library:open", async (_e, url) => { await shell.openExternal(library.openableProjectUrl(String(url || ""))); });

// ---- อัปเดตตัว installer (portable exe) ----
const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
function checkUpdate(info) {
  if (!info || !/^\d+\.\d+\.\d+$/.test(String(info.version || "")) || !/^https:\/\//i.test(String(info.url || ""))) return;
  if (newer(info.version, app.getVersion())) {
    launcherInfo = { version: String(info.version), url: String(info.url), notes: String(info.notes || "").slice(0, 1200), sha256: String(info.sha256 || "").toLowerCase() };
    send("update-available", { version: launcherInfo.version, notes: launcherInfo.notes });
  }
}
ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("update:apply", async () => {
  if (!launcherInfo) throw new Error("ยังไม่มีอัปเดตใหม่ให้ติดตั้ง");
  const ctl = new AbortController(), timeout = setTimeout(() => ctl.abort(), 180000);
  try {
    const r = await fetch(launcherInfo.url, { signal: ctl.signal, headers: { "User-Agent": "NexiaLauncher/" + app.getVersion() } });
    if (!r.ok) throw new Error("โหลดอัปเดตไม่ได้ (" + r.status + ")");
    if (!/^https:\/\//i.test(r.url || launcherInfo.url)) throw new Error("ลิงก์อัปเดตต้องเป็น HTTPS");
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length < 1024 || bytes.length > 500 * 1024 * 1024) throw new Error("ไฟล์อัปเดตว่างหรือมีขนาดเกิน 500 MB");
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error("ไฟล์ที่ดาวน์โหลดไม่ใช่ Windows installer (.exe)");
    if (launcherInfo.sha256) {
      if (!/^[a-f0-9]{64}$/.test(launcherInfo.sha256)) throw new Error("ค่า SHA-256 ในข้อมูลอัปเดตไม่ถูกต้อง");
      const actual = require("crypto").createHash("sha256").update(bytes).digest("hex");
      if (actual !== launcherInfo.sha256) throw new Error("ตรวจสอบ SHA-256 ของไฟล์อัปเดตไม่ผ่าน");
    }
    const tmp = path.join(os.tmpdir(), `Nexia-setup-${launcherInfo.version}.exe`);
    fs.writeFileSync(tmp + ".tmp", bytes); fs.renameSync(tmp + ".tmp", tmp);
    await new Promise((resolve, reject) => {
      const proc = spawn(tmp, [], { detached: true, stdio: "ignore", windowsHide: false });
      proc.once("error", reject); proc.once("spawn", () => { proc.unref(); resolve(); });
    });
    app.quit();
  } catch (e) {
    throw new Error("อัปเดต Nexia ไม่สำเร็จ: " + (e?.name === "AbortError" ? "หมดเวลาโหลดไฟล์" : e?.message || e));
  } finally { clearTimeout(timeout); }
});

// ---- window ----
function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1320, height: 820, minWidth: 1020, minHeight: 660, title: "Nexia Launcher", backgroundColor: "#000000",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false, spellcheck: false },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.on("context-menu", (e) => e.preventDefault());
}
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => { createWindow(); if (cfg.presence !== false) { presence.init(cfg.discordClientId); idle(); } });
app.on("before-quit", () => { stopGameLogWatch(); presence.stop(); });
app.on("window-all-closed", () => app.quit());
