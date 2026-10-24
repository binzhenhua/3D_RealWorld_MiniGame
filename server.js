// 多人打靶服务器 v3：地图系统 + 障碍物 + 跳跃。服务器负责判定命中（子弹会被墙挡住）、血量、得分。
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000, MAX_PLAYERS = 4, DMG = 20, RESPAWN_MS = 3000, MAX_BRICKS = 4000;
const rnd = (a, b) => a + Math.random() * (b - a), clamp = (v, B = 45) => Math.max(-B, Math.min(B, v));
const rooms = new Map(); let nextId = 1;

// ---------- 房间存档：saves/<房间号的十六进制>.json ----------
const SAVE_DIR = path.join(__dirname, 'saves');
const saveFile = key => path.join(SAVE_DIR, Buffer.from(key).toString('hex') + '.json');
const makeUid = pid => typeof pid === 'string' && /^[0-9a-f]{16,64}$/.test(pid)       // 玩家的公开编号 = 浏览器身份码的哈希，别人拿到它也冒充不了
  ? crypto.createHash('sha256').update(pid).digest('hex').slice(0, 10) : crypto.randomBytes(5).toString('hex');
function loadSave(key) { try { return JSON.parse(fs.readFileSync(saveFile(key), 'utf8')); } catch { return null; } }
function saveRoom(R) {                        // 先写临时文件再改名，写到一半断电也不会毁掉旧存档
  clearTimeout(R.saveTimer); R.saveTimer = null; R.dirty = false;
  try {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    const f = saveFile(R.key), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, room: R.key, mapId: R.map.id, protect: R.protect, savedAt: Date.now(), bricks: [...R.bricks.values()] }));
    fs.renameSync(tmp, f); send(R, { t: 'saved' });
  } catch (e) { console.log('存档失败', R.key, e.message); }
}
function markDirty(R) { R.dirty = true; if (!R.saveTimer) R.saveTimer = setTimeout(() => saveRoom(R), 2000); }   // 变化后 2 秒内合并保存一次
function validBrick(R, b) {                   // 读档时逐块检查：地图改过、文件被改坏都不会出问题
  if (!Array.isArray(b) || (b.length !== 5 && b.length !== 6) || (b.length === 6 && b[5] !== 0 && b[5] !== 1) || !b.slice(0, 4).every(Number.isInteger) || typeof b[4] !== 'string' || b[4].length > 16) return false;
  const [x, y, z, t] = b, B = R.map.bounds;
  if (t < 0 || t > 5 || x < -B || x >= B || z < -B || z >= B || y < 0 || y >= 40) return false;
  return !R.map.aabb.some(a => x < a.max.x - .01 && x + 1 > a.min.x + .01 && y < a.max.y - .01 && y + 1 > a.min.y + .01 && z < a.max.z - .01 && z + 1 > a.min.z + .01);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { rooms.forEach(R => { if (R.dirty) saveRoom(R); }); process.exit(0); });

// ---------- 地图：maps/<地图名>/map.json（数据，不含代码） ----------
const MAPS = {};
function loadMaps() {
  const dir = path.join(__dirname, 'maps');
  if (!fs.existsSync(dir)) return;
  for (const id of fs.readdirSync(dir)) {
    if (!/^[\w-]+$/.test(id)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, id, 'map.json'), 'utf8'));
      raw.obstacles = (raw.obstacles || []).slice(0, 500).filter(o => Array.isArray(o.pos) && Array.isArray(o.size) && o.pos.length === 3 && o.size.length === 3 && o.pos.concat(o.size).every(Number.isFinite));
      raw.bounds = Math.min(100, +raw.bounds || 45);
      const aabb = raw.obstacles.map(o => ({
        min: { x: o.pos[0] - o.size[0] / 2, y: o.pos[1] - o.size[1] / 2, z: o.pos[2] - o.size[2] / 2 },
        max: { x: o.pos[0] + o.size[0] / 2, y: o.pos[1] + o.size[1] / 2, z: o.pos[2] + o.size[2] / 2 } }));
      MAPS[id] = { id, raw, aabb, bounds: raw.bounds };
      console.log('已加载地图：' + id + '（' + (raw.name || '') + '，障碍物 ' + aabb.length + ' 个）');
    } catch (e) { console.log('地图加载失败', id, e.message); }
  }
}
loadMaps();
if (!Object.keys(MAPS).length) MAPS.default = { id: 'default', raw: { name: '空旷平地', bounds: 45, obstacles: [] }, aabb: [], bounds: 45 };

const MIME = { '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg' };
const handler = (req, res) => {
  let url; try { url = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (url === '/api/maps') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(Object.values(MAPS).map(m => ({ id: m.id, name: m.raw.name || m.id }))));
  }
  const mm = url.match(/^\/maps\/([\w-]+)\/([\w.-]+)$/);       // 只允许地图文件夹内的文件，不能跳出目录
  const file = mm ? path.join(__dirname, 'maps', mm[1], mm[2]) : path.join(__dirname, 'shooter-three.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(mm ? 404 : 500); return res.end(mm ? '没有这个文件' : '找不到 shooter-three.html（需和 server.js 放在同一文件夹）'); }
    res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mm ? (MIME[path.extname(file).toLowerCase()] || 'application/octet-stream') : 'text/html; charset=utf-8' });
    res.end(data);
  });
};
const server = http.createServer(handler);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });       // http 和 https 两个端口共用同一个 WebSocket 服务
const onUpgrade = (req, sock, head) => wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
server.on('upgrade', onUpgrade);
const send = (R, m) => { const s = JSON.stringify(m); R.players.forEach(p => p.ws.readyState === 1 && p.ws.send(s)); };

function spawnPos(R, team) {
  const sp = R.map.raw.spawns || {}, list = R.mode === 'pvp' ? sp[team ? 'red' : 'blue'] : sp.coop;
  if (Array.isArray(list) && list.length) { const s = list[Math.floor(Math.random() * list.length)]; return { x: +s[0] || 0, z: +s[1] || 0 }; }
  return { x: rnd(-8, 8), z: rnd(8, 14) };
}
// ---------- 目标：蝙蝠 / 幽灵 / 怪物（位置由服务器计算） ----------
const MOB = [{ r: .7, hp: 1, pts: 1 }, { r: 1.1, hp: 2, pts: 2 }, { r: 1.4, hp: 3, pts: 3 }];   // 0 蝙蝠 1 幽灵 2 怪物
const pubMob = m => ({ id: m.id, type: m.type, hp: m.hp, max: m.max, x: m.x, y: m.y, z: m.z, ry: m.ry, alive: m.alive });
function hitsWall(R, x, y, z, r) {            // 球体是否碰到地图障碍物或玩家砌的方块
  if (R.map.aabb.some(a => x + r > a.min.x && x - r < a.max.x && y + r > a.min.y && y - r < a.max.y && z + r > a.min.z && z - r < a.max.z)) return true;
  if (!R.bricks.size) return false;
  for (let i = Math.floor(x - r); i <= Math.floor(x + r); i++) for (let j = Math.floor(y - r); j <= Math.floor(y + r); j++) for (let k = Math.floor(z - r); k <= Math.floor(z + r); k++)
    { const bb = R.bricks.get(i + ',' + j + ',' + k); if (bb && !(bb[3] === 4 && bb[5])) return true; }       // 开着的门不挡怪物
  return false;
}
function zoneOf(R) {                          // 活动区域：targetZone 的 x、z 向外扩 6 格，不超出地图
  const Z = R.map.raw.targetZone || { x: [-18, 18], z: [-30, -3] }, B = R.map.bounds - 2;
  return { x0: Math.max(-B, Z.x[0] - 6), x1: Math.min(B, Z.x[1] + 6), z0: Math.max(-B, Z.z[0] - 6), z1: Math.min(B, Z.z[1] + 6) };
}
function spawnWave(R) {
  R.wave++; R.boxes = [];                     // 变量名沿用 boxes，现在装的是怪物
  const Z = zoneOf(R);
  for (let i = 0; i < R.n; i++) {
    const type = [0, 0, 0, 1, 1, 2][Math.floor(Math.random() * 6)], d = MOB[type];      // 蝙蝠最多，怪物最少
    let m;
    for (let k = 0; k < 80; k++) {
      m = { x: rnd(Z.x0, Z.x1), y: type === 2 ? d.r : rnd(2, 6), z: rnd(Z.z0, Z.z1) };
      if (!hitsWall(R, m.x, m.y, m.z, d.r) && [...R.players.values()].every(q => Math.hypot(q.x - m.x, q.z - m.z) > 10)) break;
    }
    R.boxes.push({ id: i, type, r: d.r, hp: d.hp, max: d.hp, x: m.x, y: m.y, z: m.z, base: m.y, vx: 0, vy: 0, vz: 0, t: 0, ry: rnd(0, 6.28), alive: true });
  }
  send(R, { t: 'wave', wave: R.wave, boxes: R.boxes.map(pubMob) });
}
function nearestPlayer(R, m) {
  let best = null, bd = 1e9;
  for (const q of R.players.values()) if (q.alive) { const d = Math.hypot(q.x - m.x, q.z - m.z); if (d < bd) { bd = d; best = q; } }
  return best && { q: best, d: bd };
}
function stepMobs(R, dt) {
  const Z = zoneOf(R), cl = (v, a, b) => Math.max(a, Math.min(b, v));
  for (const m of R.boxes) if (m.alive) {
    m.t -= dt; let dx = 0, dy = 0, dz = 0;
    if (m.type === 0) {                       // 蝙蝠：不规则乱飞，被墙挡住就换方向
      if (m.t <= 0) { const a = rnd(0, 6.28); m.vx = Math.cos(a) * 6; m.vz = Math.sin(a) * 6; m.vy = rnd(-2.5, 2.5); m.t = rnd(.6, 1.6); }
      dx = m.vx * dt; dy = m.vy * dt; dz = m.vz * dt;
    } else if (m.type === 1) {                // 幽灵：慢慢飘向最近的玩家，能穿墙，上下浮动
      const n = nearestPlayer(R, m);
      if (n && n.d > 2) { m.vx = (n.q.x - m.x) / n.d * 2.2; m.vz = (n.q.z - m.z) / n.d * 2.2; } else m.vx = m.vz = 0;
      dx = m.vx * dt; dz = m.vz * dt; m.y = m.base + Math.sin(Date.now() / 700 + m.id) * .8;
    } else {                                  // 怪物：在地面上走向最近的玩家，被墙挡住就随机绕一下
      if (m.t <= 0) { m.t = rnd(.5, 1.2); const n = nearestPlayer(R, m);
        if (n && n.d > 3) { m.vx = (n.q.x - m.x) / n.d * 3; m.vz = (n.q.z - m.z) / n.d * 3; } else m.vx = m.vz = 0; }
      dx = m.vx * dt; dz = m.vz * dt;
    }
    const solid = m.type !== 1, ok = (x, y, z) => !solid || !hitsWall(R, x, y, z, m.r);
    const tx = cl(m.x + dx, Z.x0, Z.x1), tz = cl(m.z + dz, Z.z0, Z.z1), ty = m.type === 0 ? cl(m.y + dy, 2, 8) : m.y;
    if (ok(tx, ty, tz)) { m.x = tx; m.y = ty; m.z = tz; }
    else if (ok(tx, m.y, m.z)) m.x = tx;
    else if (ok(m.x, m.y, tz)) m.z = tz;
    else if (m.type === 2) { m.vx = rnd(-3, 3); m.vz = rnd(-3, 3); m.t = rnd(.8, 1.5); }
    else m.t = 0;
    if (Math.hypot(m.vx, m.vz) > .1) m.ry = Math.atan2(-m.vx, -m.vz);
  }
}

// 射线与方块（AABB）、球体相交，返回距离或 null
function rayAABB(o, d, lo, hi) {
  let tmin = 0, tmax = 1e9;
  for (const a of ['x', 'y', 'z']) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) return null; }
    else { let t1 = (lo[a] - o[a]) / d[a], t2 = (hi[a] - o[a]) / d[a]; if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return null; }
  }
  return tmin;
}
function raySphere(o, d, c, r) {
  const mx = o.x - c.x, my = o.y - c.y, mz = o.z - c.z;
  const B = mx * d.x + my * d.y + mz * d.z, C = mx * mx + my * my + mz * mz - r * r;
  if (C > 0 && B > 0) return null;
  const disc = B * B - C; return disc < 0 ? null : Math.max(0, -B - Math.sqrt(disc));
}

// 沿射线逐格穿过砖块网格（Amanatides-Woo），返回碰到第一块砖的距离
function rayBricks(R, o, d, maxT) {
  if (!R.bricks.size) return null;
  let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
  const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
  const dx = sx ? Math.abs(1 / d.x) : Infinity, dy = sy ? Math.abs(1 / d.y) : Infinity, dz = sz ? Math.abs(1 / d.z) : Infinity;
  let tx = sx ? (sx > 0 ? x + 1 - o.x : o.x - x) * dx : Infinity, ty = sy ? (sy > 0 ? y + 1 - o.y : o.y - y) * dy : Infinity, tz = sz ? (sz > 0 ? z + 1 - o.z : o.z - z) * dz : Infinity;
  let t = 0, first = true;
  while (t <= maxT) {
    const bb = !first && R.bricks.get(x + ',' + y + ',' + z);
    if (bb && bb[3] !== 5 && !(bb[3] === 4 && bb[5])) return t;        // 窗和开着的门挡不住子弹
    first = false;
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += dx; } else if (ty < tz) { y += sy; t = ty; ty += dy; } else { z += sz; t = tz; tz += dz; }
  }
  return null;
}
// 砌砖 / 拆砖：服务器校验后再广播给全房间
function onBuild(R, p, m) {
  const now = Date.now(); if (!p.alive || !p.tool || p.tool > 2 || now - p.lastBuild < 80) return; p.lastBuild = now;
  const c = Array.isArray(m.c) && m.c.length === 3 ? m.c.map(n => Math.floor(+n)) : null;
  if (!c || c.some(n => !Number.isFinite(n))) return;
  const [x, y, z] = c, B = R.map.bounds, k = x + ',' + y + ',' + z;
  if (Math.hypot(x + .5 - p.x, y + .5 - (p.y + 3), z + .5 - p.z) > 10) return;          // 够不着
  if (m.op === 'del') {                       // 只能拆自己砌的；砌的人已离开的“无主方块”任何人可以拆
    const b = R.bricks.get(k); if (!b || (R.protect && b[4] !== p.uid && [...R.players.values()].some(q => q.uid === b[4]))) return;
    R.bricks.delete(k); markDirty(R); send(R, { t: 'brick', op: 'del', c, by: p.id }); return;
  }
  const type = Math.floor(+m.b);                                                           // 0 砖 1 木板 2 玻璃 3 石头
  if (m.op !== 'add' || p.tool !== 1 || !(type >= 0 && type <= 5) || R.bricks.has(k) || R.bricks.size >= MAX_BRICKS) return;
  if (x < -B || x >= B || z < -B || z >= B || y < 0 || y >= 40) return;
  const ov = a => x < a.max.x - .01 && x + 1 > a.min.x + .01 && y < a.max.y - .01 && y + 1 > a.min.y + .01 && z < a.max.z - .01 && z + 1 > a.min.z + .01;
  if (R.map.aabb.some(ov)) return;                                                         // 不能砌进地图障碍物里
  if (R.boxes.some(b => b.alive && ov({ min: { x: b.x - b.r, y: b.y - b.r, z: b.z - b.r }, max: { x: b.x + b.r, y: b.y + b.r, z: b.z + b.r } }))) return;   // 不能砌进箱子里
  for (const q of R.players.values()) if (q.alive && ov({ min: { x: q.x - .4, y: q.y, z: q.z - .4 }, max: { x: q.x + .4, y: q.y + 3.2, z: q.z + .4 } })) return;   // 不能砌在人身上
  const cell = type === 4 ? [x, y, z, type, p.uid, 0] : [x, y, z, type, p.uid];     // 门多一个“开/关”状态
  R.bricks.set(k, cell); markDirty(R); send(R, { t: 'brick', op: 'add', c: cell, by: p.id });
}

// 开/关门：同一列上连着的门一起开关（叠 4 块高就是一扇人能走过的门）；任何人都可以开关，但不能把门关在人身上
function onDoor(R, p, m) {
  const now = Date.now(); if (!p.alive || p.tool === 3 || now - p.lastDoor < 150) return; p.lastDoor = now;
  const c = Array.isArray(m.c) && m.c.length === 3 ? m.c.map(n => Math.floor(+n)) : null; if (!c || c.some(n => !Number.isFinite(n))) return;
  const at = y => R.bricks.get(c[0] + ',' + y + ',' + c[2]), b = at(c[1]);
  if (!b || b[3] !== 4 || Math.hypot(c[0] + .5 - p.x, c[1] + .5 - (p.y + 3), c[2] + .5 - p.z) > 10) return;
  const open = b[5] ? 0 : 1, cells = [];
  for (let y = c[1]; at(y) && at(y)[3] === 4; y--) cells.push([c[0], y, c[2]]);
  for (let y = c[1] + 1; at(y) && at(y)[3] === 4; y++) cells.push([c[0], y, c[2]]);
  if (!open) for (const q of R.players.values()) if (q.alive && cells.some(([x, y, z]) => q.x + .4 > x && q.x - .4 < x + 1 && q.y + 3.2 > y && q.y < y + 1 && q.z + .4 > z && q.z - .4 < z + 1)) return;
  cells.forEach(([x, y, z]) => { R.bricks.get(x + ',' + y + ',' + z)[5] = open; });
  markDirty(R); send(R, { t: 'door', cells, open, by: p.id });
}

function onShoot(R, p, d) {
  const now = Date.now(); if (!p.alive || (p.tool && p.tool !== 3) || now - p.last < 120) return; p.last = now;
  const L = Math.hypot(d.x, d.y, d.z) || 1; d = { x: d.x / L, y: d.y / L, z: d.z / L };
  const o = { x: p.x, y: p.y + 3, z: p.z }; let best = null;
  const upd = (t, extra) => { if (t !== null && (!best || t < best.t)) best = { t, ...extra }; };
  for (const a of R.map.aabb) upd(rayAABB(o, d, a.min, a.max), { wall: true });
  upd(rayBricks(R, o, d, 80), { wall: true });                                            // 砖墙也会挡子弹          // 墙会挡住子弹
  for (const b of R.boxes) if (b.alive) upd(raySphere(o, d, b, b.r), { box: b });          // 怪物用球体判定
  if (R.mode === 'pvp')                       // 对战模式：只能打不同阵营的人（无友伤）
    for (const q of R.players.values()) if (q !== p && q.alive && q.team !== p.team)
      for (const h of [.8, 1.8, 2.8]) upd(raySphere(o, d, { x: q.x, y: q.y + h, z: q.z }, .7), { player: q });
  send(R, { t: 'shot', id: p.id, o, d, len: best ? best.t : 80 });
  if (!best || best.wall) return;
  if (best.box) {
    const b = best.box; b.hp--; if (b.hp <= 0) { b.alive = false; p.score += MOB[b.type].pts; }
    send(R, { t: 'mobhit', id: b.id, by: p.id, hp: b.hp, dead: !b.alive });
    if (R.boxes.every(b => !b.alive)) { send(R, { t: 'clear' }); setTimeout(() => { if (rooms.get(R.key) === R) spawnWave(R); }, 1500); }
  } else {
    const q = best.player; q.hp = Math.max(0, q.hp - DMG);
    send(R, { t: 'hurt', id: q.id, by: p.id, hp: q.hp });
    if (q.hp === 0) {
      q.alive = false; p.score += 3;
      setTimeout(() => { if (!R.players.has(q.id)) return; const s = spawnPos(R, q.team);
        Object.assign(q, { hp: 100, alive: true, x: s.x, y: 0, z: s.z }); send(R, { t: 'respawn', id: q.id, x: s.x, z: s.z, hp: 100 }); }, RESPAWN_MS);
    }
  }
}

wss.on('connection', ws => {
  let R = null, p = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !p) {
      const name = String(m.name || '玩家').slice(0, 12), key = String(m.room || 'room1').slice(0, 16);
      R = rooms.get(key);
      if (!R) {
        const sv = loadSave(key), map = (sv && MAPS[sv.mapId]) || MAPS[m.map] || Object.values(MAPS)[0];   // 有存档的房间沿用存档的地图
        R = { key, map, mode: m.mode === 'pvp' ? 'pvp' : 'coop', n: Math.max(1, Math.min(10, parseInt(m.n) || 3)), players: new Map(), boxes: [], wave: 0, tex: {}, bricks: new Map(),
          protect: sv && typeof sv.protect === 'boolean' ? sv.protect : m.protect !== false };   // 建筑保护：存档的设置优先，否则听第一个进房间的人的
        if (sv && Array.isArray(sv.bricks)) for (const b of sv.bricks.slice(0, MAX_BRICKS)) if (validBrick(R, b)) R.bricks.set(b[0] + ',' + b[1] + ',' + b[2], b);
        rooms.set(key, R); spawnWave(R);
      }
      if (R.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); R = null; return; }
      const cnt = [0, 0]; R.players.forEach(q => cnt[q.team]++);
      const team = R.mode === 'pvp' ? (cnt[0] <= cnt[1] ? 0 : 1) : 0, sp = spawnPos(R, team);
      p = { id: nextId++, ws, name, team, x: sp.x, y: 0, z: sp.z, yaw: 0, pitch: 0, hp: 100, alive: true, score: 0, last: 0, tool: 0, lastBuild: 0, uid: makeUid(m.pid), voice: false, rtcT: 0, rtcN: 0, lastDoor: 0 };
      R.players.set(p.id, p);
      ws.send(JSON.stringify({ t: 'welcome', id: p.id, mode: R.mode, team, wave: R.wave, boxes: R.boxes.map(pubMob), tex: R.tex, map: R.map.raw, mapId: R.map.id, x: sp.x, z: sp.z, bricks: [...R.bricks.values()], uid: p.uid, protect: R.protect,
        avatars: Object.fromEntries([...R.players.values()].filter(q => q.avatar).map(q => [q.id, q.avatar])) }));
    } else if (!p) return;
    else if (m.t === 'move') { const B = R.map.bounds; p.x = clamp(+m.x || 0, B); p.z = clamp(+m.z || 0, B); p.y = Math.max(0, Math.min(80, +m.y || 0)); p.yaw = +m.yaw || 0; p.pitch = +m.pitch || 0; p.tool = (m.tool === 1 || m.tool === 2 || m.tool === 3) ? m.tool : 0; }
    else if (m.t === 'tex') {                 // 只接受体积受限的 JPEG 数据，存在房间里并广播
      const lim = { box: 150e3, sky: 500e3, ground: 300e3 }[m.kind], u = m.url;
      if (lim && typeof u === 'string' && u.length < lim && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(u)) {
        R.tex[m.kind] = u; send(R, { t: 'tex', kind: m.kind, url: u });
      }
    }
    else if (m.t === 'voice') p.voice = !!m.on;
    else if (m.t === 'rtc') {                 // 语音信令（WebRTC 握手信息）：只转发，不接触声音本身
      const now = Date.now(); if (now - p.rtcT > 1000) { p.rtcT = now; p.rtcN = 0; } if (++p.rtcN > 80) return;
      const q = R.players.get(+m.to);
      if (!q || q === p || !m.data || JSON.stringify(m.data).length > 12000) return;
      if (R.mode === 'pvp' && q.team !== p.team) return;                         // 对战模式：只和队友通话，服务器也不会转发给敌人
      if (q.ws.readyState === 1) q.ws.send(JSON.stringify({ t: 'rtc', from: p.id, data: m.data }));
    }
    else if (m.t === 'door') onDoor(R, p, m);
    else if (m.t === 'build') onBuild(R, p, m);
    else if (m.t === 'avatar') {              // 头像：128×128 的 JPEG，体积受限
      const u = m.url;
      if (typeof u === 'string' && u.length < 60e3 && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(u)) { p.avatar = u; send(R, { t: 'avatar', id: p.id, url: u }); }
    }
    else if (m.t === 'shoot') { const d = m.d || {}; onShoot(R, p, { x: +d.x || 0, y: +d.y || 0, z: +d.z || 0 }); }
  });
  ws.on('close', () => { if (p) { R.players.delete(p.id); if (!R.players.size) { if (R.dirty) saveRoom(R); rooms.delete(R.key); } } });
});
setInterval(() => rooms.forEach(R => {
  stepMobs(R, .05);
  send(R, { t: 'state',
    players: [...R.players.values()].map(({ id, name, team, x, y, z, yaw, pitch, hp, alive, score, tool, uid, voice }) => ({ id, name, team, x, y, z, yaw, pitch, hp, alive, score, tool, uid, voice })),
    mobs: R.boxes.filter(b => b.alive).map(b => [b.id, +b.x.toFixed(2), +b.y.toFixed(2), +b.z.toFixed(2), +b.ry.toFixed(2)]) });
}), 50);
server.listen(PORT, '0.0.0.0', () => {
  console.log('本机打开：http://localhost:' + PORT);
  const nets = require('os').networkInterfaces();
  for (const name in nets) for (const n of nets[name])
    if ((n.family === 'IPv4' || n.family === 4) && !n.internal) console.log('局域网的朋友打开：http://' + n.address + ':' + PORT + '  （网卡：' + name + '）');
});

// ---------- HTTPS：浏览器只允许 https 或 localhost 使用麦克风，所以语音必须走 https ----------
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
function lanIps() {
  const out = [], nets = require('os').networkInterfaces();
  for (const n in nets) for (const a of nets[n]) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  return out;
}
function loadCert() {
  const dir = path.join(__dirname, 'certs'), kf = path.join(dir, 'key.pem'), cf = path.join(dir, 'cert.pem'), af = path.join(dir, 'auto.json');
  const ips = lanIps();
  try {
    const have = fs.existsSync(kf) && fs.existsSync(cf), auto = fs.existsSync(af) ? JSON.parse(fs.readFileSync(af, 'utf8')) : null;
    if (have && !auto) return { key: fs.readFileSync(kf), cert: fs.readFileSync(cf), src: '你放进 certs/ 的证书' };   // 手动提供的（比如 mkcert 生成的）不会被覆盖
    if (have && auto && Date.now() < auto.expires && ips.every(ip => auto.ips.includes(ip))) return { key: fs.readFileSync(kf), cert: fs.readFileSync(cf), src: '自动生成的自签名证书' };
    const selfsigned = require('selfsigned');                                  // 本机 IP 变了或第一次运行：重新生成，写进证书的有效地址里
    const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 825, keySize: 2048, algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map(ip => ({ type: 7, ip }))] }] });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(kf, pems.private); fs.writeFileSync(cf, pems.cert); fs.writeFileSync(af, JSON.stringify({ ips, expires: Date.now() + 800 * 864e5 }));
    return { key: pems.private, cert: pems.cert, src: '自动生成的自签名证书' };
  } catch (e) { console.log('HTTPS 未启用：' + e.message + '（请先运行 npm install）'); return null; }
}
const tls = loadCert();
if (tls) {
  const hs = https.createServer({ key: tls.key, cert: tls.cert }, handler);
  hs.on('upgrade', onUpgrade);
  hs.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log('—— 语音聊天请用 https 地址（' + tls.src + '）——');
    console.log('本机：https://localhost:' + HTTPS_PORT);
    lanIps().forEach(ip => console.log('局域网的朋友：https://' + ip + ':' + HTTPS_PORT));
    console.log('首次打开浏览器会提示“不安全/证书无效”，点“高级”→“继续前往”即可（每台设备一次）');
  });
}
