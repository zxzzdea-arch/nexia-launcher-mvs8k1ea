// ติดตั้งไฟล์ Minecraft / Loader / Java และ sync modpack สำหรับ Nexia Launcher (Windows x64)
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { spawn } = require("child_process");

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const JAVA_ALL = "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";
const FABRIC = "https://meta.fabricmc.net/v2/versions";

const sha1 = (b) => crypto.createHash("sha1").update(b).digest("hex");
const getJson = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); };
const mk = (p) => fs.mkdirSync(p, { recursive: true });

function safeJoin(base, rel) {
  const b = path.resolve(base), p = path.resolve(b, rel);
  if (path.isAbsolute(rel) || !(p === b || p.startsWith(b + path.sep))) throw new Error("unsafe path: " + rel);
  return p;
}

async function dl(url, dest, hash) {
  if (fs.existsSync(dest)) { if (!hash) return; if (sha1(fs.readFileSync(dest)) === hash) return; }
  mk(path.dirname(dest));
  let err;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url} → ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      if (hash && sha1(b) !== hash) throw new Error("sha1 mismatch: " + url);
      fs.writeFileSync(dest, b); return;
    } catch (e) { err = e; }
  }
  throw err;
}

async function batch(label, jobs, emit, n = 16) {
  let done = 0, i = 0;
  emit(label, 0, jobs.length);
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (i < jobs.length) { const j = jobs[i++]; await dl(j.url, j.dest, j.sha1); emit(label, ++done, jobs.length); }
  }));
}

// ---------- Java ----------
async function ensureJava(root, comp, emit) {
  const all = await getJson(JAVA_ALL);
  const entry = all["windows-x64"]?.[comp]?.[0];
  if (!entry) throw new Error("ไม่มี Java runtime สำหรับ " + comp);
  const man = await getJson(entry.manifest.url);
  const base = path.join(root, "runtime", comp);
  const jobs = Object.entries(man.files).filter(([, f]) => f.type === "file")
    .map(([p, f]) => ({ url: f.downloads.raw.url, dest: safeJoin(base, p), sha1: f.downloads.raw.sha1 }));
  await batch("Java runtime", jobs, emit);
  return { javaw: path.join(base, "bin", "javaw.exe"), java: path.join(base, "bin", "java.exe") };
}

// ---------- เวอร์ชัน ----------
async function ensureVanilla(root, mcv) {
  const dir = path.join(root, "versions", mcv), f = path.join(dir, mcv + ".json");
  try {
    const url = (await getJson(MANIFEST)).versions.find((v) => v.id === mcv)?.url;
    if (!url) throw new Error("ไม่พบเวอร์ชัน " + mcv);
    mk(dir); fs.writeFileSync(f, JSON.stringify(await getJson(url)));
  } catch (e) { if (!fs.existsSync(f)) throw e; } // ออฟไลน์ใช้ของเดิมได้
}

function readVersion(root, id) {
  const v = JSON.parse(fs.readFileSync(path.join(root, "versions", id, id + ".json"), "utf8"));
  if (!v.inheritsFrom) { v.jarId = v.id; return v; }
  const p = readVersion(root, v.inheritsFrom);
  return {
    ...p, ...v,
    libraries: [...(v.libraries || []), ...(p.libraries || [])],
    arguments: { game: [...(p.arguments?.game || []), ...(v.arguments?.game || [])], jvm: [...(p.arguments?.jvm || []), ...(v.arguments?.jvm || [])] },
    minecraftArguments: v.minecraftArguments || p.minecraftArguments,
    assetIndex: v.assetIndex || p.assetIndex, downloads: p.downloads || v.downloads,
    javaVersion: v.javaVersion || p.javaVersion, jarId: p.jarId,
  };
}

async function ensureVersion(root, spec, emit) {
  const { mc, loader, loaderVersion: lv } = spec;
  await ensureVanilla(root, mc);
  if (loader === "vanilla") return mc;
  if (!lv) throw new Error("ต้องเลือกเวอร์ชันของ " + loader);
  if (loader === "fabric") {
    const prof = await getJson(`${FABRIC}/loader/${mc}/${lv}/profile/json`);
    const d = path.join(root, "versions", prof.id); mk(d);
    fs.writeFileSync(path.join(d, prof.id + ".json"), JSON.stringify(prof));
    return prof.id;
  }
  if (loader === "forge") {
    const id = `${mc}-forge-${lv}`;
    if (fs.existsSync(path.join(root, "versions", id, id + ".json"))) return id;
    const base = readVersion(root, mc);
    const jar = path.join(root, "versions", mc, mc + ".jar");
    await dl(base.downloads.client.url, jar, base.downloads.client.sha1);
    const { java } = await ensureJava(spec.javaRoot || root, base.javaVersion?.component || "jre-legacy", emit);
    const inst = path.join(root, "tmp", `forge-${mc}-${lv}-installer.jar`);
    emit("Forge installer", 0, 1);
    await dl(`https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${lv}/forge-${mc}-${lv}-installer.jar`, inst);
    const lp = path.join(root, "launcher_profiles.json"); if (!fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ profiles: {}, version: 3 }));
    emit("กำลังติดตั้ง Forge (ใช้เวลาสักครู่)", 0, 0);
    await new Promise((res, rej) => {
      let tail = "";
      const c = spawn(java, ["-jar", inst, "--installClient", root], { cwd: root, windowsHide: true });
      const keep = (b) => { tail = (tail + b).slice(-600); };
      c.stdout.on("data", keep); c.stderr.on("data", keep);
      c.on("error", rej);
      c.on("close", (code) => code === 0 ? res() : rej(new Error("Forge installer ล้มเหลว: " + tail)));
    });
    if (!fs.existsSync(path.join(root, "versions", id, id + ".json"))) throw new Error("ติดตั้ง Forge แล้วไม่พบ version " + id);
    return id;
  }
  throw new Error("unknown loader");
}

// ---------- modpack ----------
// {"version":"1.0","files":[{"path":"mods/a.jar","url":"https://...","sha1":"..."}],"delete":["mods/old.jar"]}
// ไฟล์ที่ Nexia เคยลงแต่ไม่อยู่ใน pack ใหม่จะถูกลบ (ไม่แตะไฟล์ที่ผู้เล่นเพิ่มเอง)
async function syncPack(gameDir, packUrl, emit) {
  if (!/^https:\/\//.test(packUrl)) throw new Error("pack URL ต้องเป็น https");
  const m = await getJson(packUrl);
  const jobs = (m.files || []).map((f) => {
    if (!f.sha1 || !/^https:\/\//.test(f.url)) throw new Error("pack: ทุกไฟล์ต้องมี https url และ sha1");
    return { url: f.url, dest: safeJoin(gameDir, f.path), sha1: f.sha1, rel: path.normalize(f.path) };
  });
  const rec = path.join(gameDir, ".nexia-pack.json");
  let prev = []; try { prev = JSON.parse(fs.readFileSync(rec, "utf8")).files || []; } catch {}
  await batch("Mods", jobs, emit, 8);
  const cur = new Set(jobs.map((j) => j.rel));
  for (const p of [...prev.filter((x) => !cur.has(x)), ...(m.delete || [])]) { try { fs.rmSync(safeJoin(gameDir, p), { force: true }); } catch {} }
  fs.writeFileSync(rec, JSON.stringify({ version: String(m.version || ""), files: [...cur] }));
}

async function packInfo(nexiaDir, id, packUrl) {
  let local = null, remote = null;
  try { local = String(JSON.parse(fs.readFileSync(path.join(nexiaDir, "instances", id, ".nexia-pack.json"), "utf8")).version || ""); } catch {}
  try { if (packUrl) remote = String((await getJson(packUrl)).version || ""); } catch {}
  return { local, remote };
}

// ---------- รองรับการล้างโปรไฟล์ Nexia รุ่นเก่า (ไม่ใช้เพื่อเปิดเกม) ----------
function writeProfile(mcDir, inst, versionId, gameDir, ramMb, icon) {
  const f = path.join(mcDir, "launcher_profiles.json");
  let d = { profiles: {}, version: 3 };
  if (fs.existsSync(f)) {
    try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch { throw new Error("อ่าน launcher_profiles.json ไม่ได้ จึงไม่แก้ไข (ปิด Minecraft Launcher แล้วลองใหม่)"); }
    fs.copyFileSync(f, f + ".nexia.bak");
  }
  d.profiles = d.profiles || {};
  const key = "nexia-" + inst.id, old = d.profiles[key] || {}, now = new Date().toISOString();
  d.profiles[key] = { ...old, name: "Nexia · " + inst.name, type: "custom", created: old.created || now, lastUsed: old.lastUsed || now, icon, lastVersionId: versionId, gameDir,
    javaArgs: `-Xmx${Math.min(Math.max(+ramMb || 3072, 1024), 32768)}M -XX:+UseG1GC` };
  fs.writeFileSync(f + ".tmp", JSON.stringify(d, null, 2)); fs.renameSync(f + ".tmp", f);
}

// ---------- รายการเวอร์ชันสำหรับสร้าง Instance เอง ----------
let _mcv = null, _forge = null;
async function listMcVersions() {
  if (_mcv) return _mcv;
  const m = await getJson(MANIFEST);
  return (_mcv = m.versions.filter((v) => v.type === "release").map((v) => v.id));
}
async function listLoaderVersions(mcv, loader) {
  if (loader === "fabric") {
    const a = await getJson(`${FABRIC}/loader/${encodeURIComponent(mcv)}`);
    const st = a.filter((x) => x.loader.stable);
    return (st.length ? st : a).map((x) => x.loader.version).slice(0, 25);
  }
  if (loader === "forge") {
    if (!(+String(mcv).split(".")[1] >= 13)) return [];            // Forge เฉพาะ 1.13+
    if (!_forge) {
      const r = await fetch("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml");
      if (!r.ok) throw new Error("โหลดรายการ Forge ไม่ได้ (" + r.status + ")");
      _forge = [...(await r.text()).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    }
    return _forge.filter((v) => v.startsWith(mcv + "-")).map((v) => v.slice(mcv.length + 1)).filter((v) => /^[\w.+\-]{1,64}$/.test(v)).reverse().slice(0, 25);
  }
  return [];
}

function removeProfile(mcDir, id) {
  const f = path.join(mcDir, "launcher_profiles.json");
  if (!fs.existsSync(f)) return;
  let d; try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch { return; }
  if (!d.profiles || !d.profiles["nexia-" + id]) return;
  fs.copyFileSync(f, f + ".nexia.bak");
  delete d.profiles["nexia-" + id];
  fs.writeFileSync(f + ".tmp", JSON.stringify(d, null, 2)); fs.renameSync(f + ".tmp", f);
}

async function install({ mcDir, nexiaDir, inst, ramMb, icon, emit }) {
  // Nexia ทำงานเป็น Launcher แยก ไม่ต้องเพิ่มโปรไฟล์เข้า Minecraft Launcher ทางการ
  const gameDir = path.join(nexiaDir, "instances", inst.id);
  mk(gameDir); mk(mcDir);
  const id = await ensureVersion(mcDir, { mc: inst.mc, loader: inst.loader, loaderVersion: inst.loaderVersion, javaRoot: nexiaDir }, emit);
  if (inst.packUrl) await syncPack(gameDir, inst.packUrl, emit);
  const merged = readVersion(mcDir, id);
  const component = merged.javaVersion?.component || "jre-legacy";
  const runtime = await ensureJava(nexiaDir, component, emit);
  return { versionId: id, javaPath: runtime.javaw, javaConsolePath: runtime.java, javaComponent: component, gameDir };
}

module.exports = { install, packInfo, listMcVersions, listLoaderVersions, removeProfile, _t: { writeProfile, syncPack, safeJoin } };
