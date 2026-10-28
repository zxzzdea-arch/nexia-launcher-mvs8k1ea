const fs = require('fs');
const path = require('path');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const TYPES = {
  mods: { modrinth: 'mod', folder: 'mods' },
  resourcepacks: { modrinth: 'resourcepack', folder: 'resourcepacks' },
  shaders: { modrinth: 'shader', folder: 'shaderpacks' },
};
const LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'liteloader']);
const safeHttps = (v) => typeof v === 'string' && /^https:\/\//i.test(v);

async function apiJson(url, headers = {}) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'NexiaLauncher/0.5.2', ...headers }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) {
    if (r.status === 429) throw new Error('Modrinth จำกัดจำนวนคำขอชั่วคราว กรุณารอสักครู่แล้วค้นหาใหม่');
    if (r.status === 401 || r.status === 403) throw new Error('Modrinth ปฏิเสธคำขอ (' + r.status + ')');
    if (r.status === 404) throw new Error('ไม่พบข้อมูลหรือเวอร์ชันที่ร้องขอ');
    throw new Error('เชื่อมต่อ Modrinth ไม่ได้ (' + r.status + ')');
  }
  return r.json();
}

function normalizeInput(o = {}) {
  const type = String(o.type || 'mods');
  const query = String(o.query || '').trim().slice(0, 120);
  const gameVersion = String(o.gameVersion || '').trim();
  const loader = String(o.loader || '').toLowerCase();
  const offset = Math.min(10000, Math.max(0, Math.trunc(Number(o.offset) || 0)));
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(o.limit) || 100)));
  if (!TYPES[type]) throw new Error('ประเภท Library ไม่ถูกต้อง');
  if (gameVersion && !/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(gameVersion)) throw new Error('รูปแบบเวอร์ชัน Minecraft ไม่ถูกต้อง');
  if (loader && loader !== 'any' && !LOADERS.has(loader)) throw new Error('Loader ไม่ถูกต้อง');
  return { type, query, gameVersion, loader: loader === 'any' ? '' : loader, offset, limit };
}

async function searchModrinth(o) {
  const facets = [[`project_type:${TYPES[o.type].modrinth}`]];
  if (o.gameVersion) facets.push([`versions:${o.gameVersion}`]);
  if (o.loader && o.type === 'mods') facets.push([`categories:${o.loader}`]);
  const params = new URLSearchParams({ query: o.query, facets: JSON.stringify(facets), limit: String(o.limit), offset: String(o.offset), index: 'downloads' });
  const data = await apiJson(`${MODRINTH_API}/search?${params}`);
  const items = (data.hits || []).map((x) => ({
    id: String(x.project_id), source: 'modrinth', type: o.type, title: x.title || 'Untitled',
    description: x.description || '', author: x.author || 'Unknown', downloads: Number(x.downloads) || 0,
    iconUrl: safeHttps(x.icon_url) ? x.icon_url : '',
    coverUrl: safeHttps(x.icon_url) ? x.icon_url : '',
    bannerUrl: safeHttps(x.featured_gallery) ? x.featured_gallery : (Array.isArray(x.gallery) && safeHttps(x.gallery[0]) ? x.gallery[0] : ''),
    url: `https://modrinth.com/${TYPES[o.type].modrinth}/${encodeURIComponent(x.slug || x.project_id)}`,
  }));
  return { items, totalHits: Math.max(0, Number(data.total_hits) || items.length), offset: o.offset, limit: o.limit };
}
async function search(raw) { return searchModrinth(normalizeInput(raw)); }

function fileNameSafe(name) {
  const base = path.basename(String(name || 'download.bin')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
  if (!base || base === '.' || base === '..') return 'download.bin';
  return base;
}
async function downloadTo(url, dest) {
  if (!safeHttps(url)) throw new Error('ลิงก์ดาวน์โหลดไม่ใช่ HTTPS');
  const r = await fetch(url, { headers: { 'User-Agent': 'NexiaLauncher/0.5.2' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok || !safeHttps(r.url || url)) throw new Error('ดาวน์โหลดไฟล์ไม่ได้ (' + r.status + ')');
  const len = Number(r.headers.get('content-length') || 0);
  if (len > 500 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกินขีดจำกัด 500 MB');
  const data = Buffer.from(await r.arrayBuffer());
  if (!data.length || data.length > 500 * 1024 * 1024) throw new Error('ไฟล์ดาวน์โหลดว่างหรือมีขนาดเกิน 500 MB');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.nexia-tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, dest);
}
function chooseModrinthFile(version) {
  const files = Array.isArray(version && version.files) ? version.files : [];
  return files.find((f) => f.primary && safeHttps(f.url)) || files.find((f) => safeHttps(f.url));
}
async function modrinthVersion(projectId, gameVersion, loader, forceType = 'mods') {
  const params = new URLSearchParams();
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
  if (loader && forceType === 'mods') params.set('loaders', JSON.stringify([loader]));
  const list = await apiJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version${params.size ? `?${params}` : ''}`);
  const compatible = (list || []).filter((v) => (v.version_type || 'release') === 'release' && chooseModrinthFile(v));
  return compatible[0] || (list || []).find((v) => chooseModrinthFile(v)) || null;
}
async function install({ project, instance, gameDir, emit = () => {} }) {
  if (!project || project.source !== 'modrinth' || !TYPES[project.type]) throw new Error('รองรับการติดตั้งจาก Modrinth เท่านั้น');
  const id = String(project.id || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('Project ID ไม่ถูกต้อง');
  if (!instance || !/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(String(instance.mc || ''))) throw new Error('Instance ไม่มีเวอร์ชัน Minecraft ที่ถูกต้อง');
  const gameVersion = String(instance.mc);
  const loader = LOADERS.has(String(instance.loader || '').toLowerCase()) ? String(instance.loader).toLowerCase() : '';
  if (project.type === 'mods' && !loader) throw new Error('มอดต้องใช้ Instance ที่มี Fabric / Forge / NeoForge / Quilt ไม่รองรับ Vanilla');
  const folder = path.join(gameDir, TYPES[project.type].folder);
  fs.mkdirSync(folder, { recursive: true });
  const installed = new Set();
  const maxFiles = 100;
  let count = 0;

  const installProject = async (projectId, type, depth = 0, forcedVersionId = '') => {
    if (depth > 8) throw new Error('Dependency ซ้อนกันเกินขีดจำกัด');
    const key = `mr:${projectId}`;
    if (installed.has(key)) return '';
    installed.add(key);
    const version = forcedVersionId
      ? await apiJson(`${MODRINTH_API}/version/${encodeURIComponent(forcedVersionId)}`)
      : await modrinthVersion(projectId, gameVersion, loader, type);
    if (version && version.project_id && version.project_id !== projectId) throw new Error('Dependency version/project ID ไม่ตรงกัน');
    if (!version) throw new Error(`ไม่พบเวอร์ชันที่รองรับ Minecraft ${gameVersion} (${projectId})`);
    const f = chooseModrinthFile(version);
    if (!f) throw new Error('Project นี้ไม่มีไฟล์ดาวน์โหลด');
    if (++count > maxFiles) throw new Error('มีไฟล์หรือ Library ที่ต้องติดตั้งมากเกินขีดจำกัด');
    emit({ label: `กำลังโหลด ${f.filename || projectId}`, done: count - 1, total: maxFiles });
    await downloadTo(f.url, path.join(folder, fileNameSafe(f.filename || `${projectId}.jar`)));
    if (type === 'mods') {
      for (const dep of (version.dependencies || []).filter((x) => x.dependency_type === 'required')) {
        if (dep.project_id) await installProject(dep.project_id, 'mods', depth + 1);
        else if (dep.version_id) {
          const depVersion = await apiJson(`${MODRINTH_API}/version/${encodeURIComponent(dep.version_id)}`);
          if (depVersion && depVersion.project_id) await installProject(depVersion.project_id, 'mods', depth + 1, dep.version_id);
        }
      }
    }
    return f.filename || `${projectId}.jar`;
  };

  const name = await installProject(id, project.type);
  emit({ label: 'ติดตั้งไฟล์เสร็จแล้ว', done: count, total: Math.max(count, 1) });
  return { title: String(project.title || name || 'Project').slice(0, 150), fileName: name, type: project.type, count };
}

function openableProjectUrl(value) {
  if (!safeHttps(value)) throw new Error('ลิงก์ Project ไม่ถูกต้อง');
  const u = new URL(value);
  if (!['modrinth.com', 'www.modrinth.com'].includes(u.hostname)) throw new Error('อนุญาตให้เปิดได้เฉพาะหน้า Modrinth');
  return u.toString();
}
module.exports = { search, install, openableProjectUrl };
