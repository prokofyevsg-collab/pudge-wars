import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ── Constants (keep in sync with server) ────────────────────────────────────
const SERVER_URL   = window.location.origin;
let   MAP_W = 1600, MAP_H = 900;   // updated from game_start
const S = 0.01;                     // server → world scale  (1600→16, 900→9)
const HOOK_RANGE_WORLD = 7.0;       // 700 server units * S
const TEAM_COLORS  = [0xe74c3c, 0x2980b9];
const TEAM_HEX     = ['#e74c3c', '#2980b9'];
const TEAM_NAMES   = ['Красные', 'Синие'];
const CHAR_LETTERS = 'abcdefghijklmnopqr'.split('');
const HOOK_COOLDOWN_MS = 6000;

// VIEW_SIZE is computed dynamically in positionCamera() based on actual map size
let VIEW_SIZE = 6;

// ── Telegram ──────────────────────────────────────────────────────────────────
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.requestFullscreen?.();           // убирает верхний хедер (Telegram 8.0+)
  tg.setHeaderColor?.('#0a1208');     // цвет хедера под фон игры
  tg.setBackgroundColor?.('#0a1208');
}
const tgUser = tg?.initDataUnsafe?.user ?? null;

const clientId = localStorage.getItem('pwClientId') ?? (() => {
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  localStorage.setItem('pwClientId', id);
  return id;
})();

// ── Landscape lock ────────────────────────────────────────────────────────────
try { screen.orientation.lock('landscape'); } catch (_) {}

// ── Renderer ──────────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(window.innerWidth, window.innerHeight);

// ── Scene ─────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a3d10);
// No fog — isometric view shows the whole scene from far away; fog kills visibility

// ── Camera ────────────────────────────────────────────────────────────────────
let aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.OrthographicCamera(
  -VIEW_SIZE * aspect, VIEW_SIZE * aspect, VIEW_SIZE, -VIEW_SIZE, 0.1, 200
);

function positionCamera() {
  const mcx = MAP_W * S / 2, mcz = MAP_H * S / 2;
  // FIFA-style: camera centred on X (no diagonal skew), large Z offset for ~38° tilt.
  // River stays as a vertical stripe in the middle; map fills the screen edge-to-edge.
  camera.position.set(mcx, mcz * 2.5, mcz + mcz * 2.0);
  camera.lookAt(mcx, 0, mcz);
  // Adapt VIEW_SIZE to screen aspect so the map always fills the canvas:
  //   height constraint: mcz * 0.78  (map half-height projected at ~38° tilt)
  //   width constraint:  mcx / aspect (map half-width in screen half-space)
  // Take the larger and add 8% so extended grass covers any edge instead of black.
  VIEW_SIZE = Math.max(mcz * 0.78, mcx / aspect) * 1.08;
  camera.top    =  VIEW_SIZE;
  camera.bottom = -VIEW_SIZE;
  camera.left   = -VIEW_SIZE * aspect;
  camera.right  =  VIEW_SIZE * aspect;
  camera.updateProjectionMatrix();
}
positionCamera();

// ── Toon gradient (shared across all MeshToonMaterial) ────────────────────────
const toonGrad = (() => {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 1;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#222'; ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = '#888'; ctx.fillRect(1, 0, 1, 1);
  ctx.fillStyle = '#ccc'; ctx.fillRect(2, 0, 1, 1);
  ctx.fillStyle = '#fff'; ctx.fillRect(3, 0, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  return t;
})();

// ── Lighting ──────────────────────────────────────────────────────────────────
// Bright daylight — feeds cel-shading well
scene.add(new THREE.AmbientLight(0xfff0cc, 1.6));

// Sky / ground hemisphere (vivid sky blue → forest green)
const hemi = new THREE.HemisphereLight(0xaaddff, 0x44aa22, 1.1);
scene.add(hemi);

// Key directional (casts shadows)
const sun = new THREE.DirectionalLight(0xfffbe8, 2.0);
sun.position.set(10, 20, 10);
sun.castShadow = true;
Object.assign(sun.shadow.mapSize, { width: 2048, height: 2048 });
Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 90 });
scene.add(sun);

// Front fill (cool, opposite side)
const fill = new THREE.DirectionalLight(0xaaddcc, 0.8);
fill.position.set(-5, 12, -5);
scene.add(fill);

// Overhead fill — ensures tops of characters are well-lit
const over = new THREE.DirectionalLight(0xddeebb, 0.7);
over.position.set(0, 20, 0);
scene.add(over);

// Animated torches at map corners
const torches = [];
function addTorch(x, z) {
  const l = new THREE.PointLight(0xff7700, 2.5, 10);
  l.position.set(x, 1.5, z);
  scene.add(l);
  torches.push(l);
}

// ── GLB loader + model pool ───────────────────────────────────────────────────
const gltfLoader = new GLTFLoader();

// ── Nature assets (Kenney) — included in loading counter ──────────────────────
const natureModels = {};
const NATURE_ASSETS = [
  'tree', 'tree-tall', 'tree-autumn', 'tree-autumn-tall',
  'rock-a', 'rock-b', 'rock-c', 'rock-flat-grass',
  'patch-grass', 'patch-grass-large', 'grass-large',
  'campfire-pit',
];
function _applyToonToNature(obj) {
  obj.traverse(c => {
    if (!c.isMesh || !c.material) return;
    const conv = m => new THREE.MeshToonMaterial({
      color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
      map: m.map ?? null,
      gradientMap: toonGrad,
    });
    c.material = Array.isArray(c.material) ? c.material.map(conv) : conv(c.material);
    c.castShadow = true; c.receiveShadow = true;
  });
}
NATURE_ASSETS.forEach(name => {
  gltfLoader.load(`/nature/${name}.glb`, gltf => {
    _applyToonToNature(gltf.scene);
    natureModels[name] = gltf.scene;
    _onAsset();
  }, undefined, () => _onAsset()); // count errors too so we never hang
});

// Place a nature GLB model — deterministic rotation, auto-scale to targetH
function placeNature(name, wx, wz, targetH, scaleVar = 0) {
  const base = natureModels[name];
  if (!base || !mapGroup) return;
  const m = base.clone(true);
  const box = new THREE.Box3().setFromObject(m);
  const h = box.getSize(new THREE.Vector3()).y || 1;
  const s = (targetH / h) * (1 + scaleVar * 0.15);
  m.scale.setScalar(s);
  m.rotation.y = ((wx * 7.3 + wz * 3.1) % (Math.PI * 2));
  const box2 = new THREE.Box3().setFromObject(m);
  m.position.set(wx, -box2.min.y * s + 0.01, wz);
  mapGroup.add(m);
}

// Global animation clips (shared across all character instances, same skeleton)
let walkClip = null, runClip = null, hookClip = null, dieClip = null;

// When a clip loads late, add it to already-created characters
function onClipReady(name, clip) {
  if (!clip) return;
  for (const entry of charEntries.values()) {
    if (entry.mixer && entry.actions && !entry.actions[name]) {
      entry.actions[name] = entry.mixer.clipAction(clip);
    }
  }
}

// ── Asset load tracking ───────────────────────────────────────────────────────
let _assetsLoaded = 0;
const _assetsTotal = 19; // 4 walk + run + hook + die + 12 nature assets

const _LOAD_TIPS = [
  'Хукай первым — побеждай последним',
  'Прицел показывает точную дальность хука',
  'Сердце даёт дополнительную жизнь',
  '2 попадания — и враг повержен',
  'Играй в команде — побеждайте вместе',
];
let _tipTimer = null;
function _startTipCycle() {
  let idx = 0;
  const el = document.getElementById('load-tip');
  if (!el) return;
  el.textContent = _LOAD_TIPS[0];
  _tipTimer = setInterval(() => {
    el.style.opacity = '0';
    setTimeout(() => {
      idx = (idx + 1) % _LOAD_TIPS.length;
      el.textContent = _LOAD_TIPS[idx];
      el.style.opacity = '1';
    }, 350);
  }, 2200);
}
function _stopTipCycle() { if (_tipTimer) { clearInterval(_tipTimer); _tipTimer = null; } }

function _onAsset() {
  _assetsLoaded++;
  _updateLoadUI();
}

function _updateLoadUI() {
  const pct = Math.min(100, Math.round(_assetsLoaded / _assetsTotal * 100));
  const bar = document.getElementById('load-bar');
  const lbl = document.getElementById('load-pct');
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = pct + '%';
}

function waitForAssets() {
  _updateLoadUI();
  if (_assetsLoaded >= _assetsTotal) return Promise.resolve();
  return new Promise(resolve => {
    const id = setInterval(() => {
      _updateLoadUI();
      if (_assetsLoaded >= _assetsTotal) { clearInterval(id); _updateLoadUI(); resolve(); }
    }, 60);
  });
}

// Pool of pre-loaded model scenes (one per possible player)
const pudgePool = [];
for (let i = 0; i < 4; i++) {
  gltfLoader.load('assets/pudge/pudge-walk.glb', gltf => {
    gltf.scene.traverse(c => { if (c.isMesh) { c.castShadow = c.receiveShadow = true; } });
    if (!walkClip && gltf.animations[0]) walkClip = gltf.animations[0];
    pudgePool.push(gltf.scene);
    _onAsset();
  }, undefined, () => _onAsset());
}
gltfLoader.load('assets/pudge/pudge-run.glb',  gltf => { runClip  = gltf.animations[0] ?? null; onClipReady('run',  runClip);  _onAsset(); }, undefined, () => _onAsset());
gltfLoader.load('assets/pudge/pudge-hook.glb', gltf => { hookClip = gltf.animations[0] ?? null; onClipReady('hook', hookClip); _onAsset(); }, undefined, () => _onAsset());
gltfLoader.load('assets/pudge/pudge-die.glb',  gltf => { dieClip  = gltf.animations[0] ?? null; onClipReady('die',  dieClip);  _onAsset(); }, undefined, () => _onAsset());

// ── Countdown 3-2-1 ───────────────────────────────────────────────────────────
async function showCountdown() {
  const overlay = document.getElementById('countdown-overlay');
  const el      = document.getElementById('countdown-num');
  overlay.style.display = 'flex';

  const steps = [['3','#fff'],['2','#fff'],['1','#e74c3c'],['GO!','#2ecc71']];
  for (const [text, color] of steps) {
    el.style.transition = 'none';
    el.style.color      = color;
    el.style.opacity    = '0';
    el.style.transform  = 'scale(1.6)';
    el.textContent      = text;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    el.style.transition = 'transform 0.75s cubic-bezier(.17,.67,.4,1.2), opacity 0.18s ease';
    el.style.opacity    = '1';
    el.style.transform  = 'scale(1)';
    const hold = text === 'GO!' ? 520 : 940;
    await new Promise(r => setTimeout(r, hold));
  }

  el.style.transition = 'opacity 0.3s ease';
  el.style.opacity    = '0';
  await new Promise(r => setTimeout(r, 320));
  overlay.style.display = 'none';
}

// ── Map ───────────────────────────────────────────────────────────────────────
let mapGroup = null;

function buildMap(obstacles) {
  if (mapGroup) scene.remove(mapGroup);
  mapGroup = new THREE.Group();
  const mw = MAP_W * S, mh = MAP_H * S;

  // ── Геометрия реки (вертикальная полоса по центру x) ─────────────────────
  const riverCX = mw / 2;
  const riverHW = mw * 0.085;          // полуширина воды в world-units ≈ 1.7
  const bankW   = mw * 0.048;          // полоса грязного берега ≈ 1.0
  const leftEnd  = riverCX - riverHW - bankW;   // правая граница левой травы
  const rightSt  = riverCX + riverHW + bankW;   // левая граница правой травы

  // ── Материалы (cel-shading) ───────────────────────────────────────────────
  const T = (color, opts = {}) => new THREE.MeshToonMaterial({ color, gradientMap: toonGrad, ...opts });
  const mVoid   = T(0x0a1206);
  const mGrassA = T(0x5ec22e); // vivid Pandoria-style grass
  const mGrassB = T(0x4aaa1e); // slightly darker grass tile
  const mDirt   = T(0xb08848); // warm sandy dirt
  const mMud    = T(0x8a6638); // mud by riverbank
  const mWater  = T(0x1ac4d8, { transparent: true, opacity: 0.88 }); // turquoise river
  const mDeep   = T(0x0fa0b8, { transparent: true, opacity: 0.92 }); // deep water
  const mRipple = new THREE.MeshBasicMaterial({ color: 0x88eeff, transparent: true, opacity: 0.20 });
  const mBark   = T(0x8a5228); // warm brown bark
  const mLeafA  = T(0x32b818); // bright leaf
  const mLeafB  = T(0x229010); // medium leaf
  const mLeafC  = T(0x156008); // dark leaf
  const mRock   = T(0x8a8a78); // warm grey rock
  const mStone  = T(0xaaaa90); // lighter stone
  const mWall   = T(0x6a6a58); // stone wall
  const mFount  = T(0x88bbdd); // fountain
  const mWaterF = new THREE.MeshBasicMaterial({ color: 0x44ddff, transparent: true, opacity: 0.72 });

  function flat(x, z, w, d, mat, y = 0, ro = 0) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.receiveShadow = true;
    m.renderOrder = ro;
    mapGroup.add(m);
  }
  function box3(x, y, z, w, h, d, mat, sh = true) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (sh) { m.castShadow = true; m.receiveShadow = true; }
    mapGroup.add(m); return m;
  }

  // ── Базовый слой (заполняет пространство за пределами карты) ─────────────
  flat(mw / 2, mh / 2, mw * 2.5, mh * 2.5, mGrassA, -0.015);     // трава за краями
  flat(riverCX, mh / 2, riverHW * 2, mh * 2.5, mWater, -0.010, 3); // река тоже тянется
  flat(mw / 2, mh / 2, 600, 600, mVoid, -0.02);                    // чёрная подложка (дальний план)

  // ── Трава (шахматные плитки, левая и правая стороны) ──────────────────────
  const tC = 6, tR = 8;
  const tW = leftEnd / tC, tH = mh / tR;
  for (let c = 0; c < tC; c++) for (let r = 0; r < tR; r++) {
    flat(tW * (c + 0.5), tH * (r + 0.5), tW, tH,
         (c + r) % 2 === 0 ? mGrassA : mGrassB, 0.001, 1);
  }
  const rW = (mw - rightSt) / tC;
  for (let c = 0; c < tC; c++) for (let r = 0; r < tR; r++) {
    flat(rightSt + rW * (c + 0.5), tH * (r + 0.5), rW, tH,
         (c + r) % 2 === 0 ? mGrassA : mGrassB, 0.001, 1);
  }

  // ── Грязевые берега ───────────────────────────────────────────────────────
  flat(riverCX - riverHW - bankW / 2, mh / 2, bankW, mh, mMud,  0.003, 2);
  flat(riverCX + riverHW + bankW / 2, mh / 2, bankW, mh, mMud,  0.003, 2);
  // Переходные грязевые полоски (светлее)
  flat(riverCX - riverHW - bankW - 0.12, mh / 2, 0.28, mh, mDirt, 0.002, 2);
  flat(riverCX + riverHW + bankW + 0.12, mh / 2, 0.28, mh, mDirt, 0.002, 2);

  // ── Вода ──────────────────────────────────────────────────────────────────
  flat(riverCX, mh / 2, riverHW * 2, mh, mWater, 0.005, 3);
  flat(riverCX, mh / 2, riverHW * 0.75, mh, mDeep, 0.006, 4);
  // Рябь (горизонтальные полосы)
  for (let i = 0; i < 10; i++) {
    flat(riverCX, mh * (i + 0.4) / 10, riverHW * 1.65, 0.10, mRipple, 0.007, 5);
  }

  // ── Периметр (каменные стены) ─────────────────────────────────────────────
  const bH = 0.42, bT = 0.20;
  box3(mw / 2, bH / 2, -bT / 2,   mw + bT * 2, bH, bT, mWall);
  box3(mw / 2, bH / 2, mh + bT/2, mw + bT * 2, bH, bT, mWall);
  box3(-bT / 2, bH / 2, mh / 2,   bT, bH, mh, mWall);
  box3(mw + bT/2, bH / 2, mh / 2, bT, bH, mh, mWall);

  // ── Деревья ───────────────────────────────────────────────────────────────
  const treeVariants = ['tree', 'tree-tall', 'tree-autumn', 'tree-autumn-tall'];
  function addTree(wx, wz, sc = 1.0) {
    const vi = Math.abs(Math.round(wx * 31 + wz * 17)) % treeVariants.length;
    const name = treeVariants[vi];
    if (natureModels[name]) {
      placeNature(name, wx, wz, 1.1 * sc, vi);
      return;
    }
    // Procedural fallback
    const tH2 = 0.70 * sc, tR = 0.085 * sc;
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(tR * 0.55, tR, tH2, 7), mBark);
    tr.position.set(wx, tH2 / 2, wz); tr.castShadow = true; mapGroup.add(tr);
    const br = 0.42 * sc, cH = 0.64 * sc;
    [
      { y: tH2 + cH * 0.22, r: br * 1.05, mat: mLeafA },
      { y: tH2 + cH * 0.58, r: br * 0.72, mat: mLeafB },
      { y: tH2 + cH * 0.90, r: br * 0.44, mat: mLeafC },
    ].forEach(({ y, r, mat }) => {
      const c = new THREE.Mesh(new THREE.ConeGeometry(r, cH * 0.55, 8), mat);
      c.position.set(wx, y, wz); c.castShadow = true; mapGroup.add(c);
    });
    const crown = new THREE.Mesh(new THREE.SphereGeometry(br * 0.40, 7, 5), mLeafB);
    crown.position.set(wx, tH2 + cH * 1.10, wz);
    crown.castShadow = true; mapGroup.add(crown);
  }

  // Левая сторона — плотный лесной бордюр
  [
    [0.06, 0.07, 1.1], [0.20, 0.19, 1.2], [0.09, 0.36, 0.9],
    [0.28, 0.52, 1.0], [0.07, 0.68, 1.2], [0.23, 0.83, 1.0],
    [0.13, 0.94, 0.9], [0.31, 0.11, 1.1], [0.04, 0.50, 1.0],
    [0.26, 0.63, 1.2], [0.11, 0.28, 0.85],[0.33, 0.77, 0.9],
    [0.38, 0.40, 1.0], [0.18, 0.60, 0.95],[0.35, 0.85, 1.1],
    [0.08, 0.45, 1.05],[0.30, 0.25, 0.9], [0.22, 0.73, 1.0],
  ].forEach(([fx, fz, sc]) => addTree(fx * leftEnd, fz * mh, sc));

  // Правая сторона (зеркально)
  [
    [0.06, 0.07, 1.1], [0.20, 0.19, 1.2], [0.09, 0.36, 0.9],
    [0.28, 0.52, 1.0], [0.07, 0.68, 1.2], [0.23, 0.83, 1.0],
    [0.13, 0.94, 0.9], [0.31, 0.11, 1.1], [0.04, 0.50, 1.0],
    [0.26, 0.63, 1.2], [0.11, 0.28, 0.85],[0.33, 0.77, 0.9],
    [0.38, 0.40, 1.0], [0.18, 0.60, 0.95],[0.35, 0.85, 1.1],
    [0.08, 0.45, 1.05],[0.30, 0.25, 0.9], [0.22, 0.73, 1.0],
  ].forEach(([fx, fz, sc]) => addTree(mw - fx * (mw - rightSt), fz * mh, sc));

  // Деревья вдоль верхней и нижней стен
  [
    [0.08, 0.03, 0.85], [0.22, 0.04, 0.95], [0.42, 0.03, 0.80],
    [0.58, 0.04, 0.90], [0.78, 0.03, 0.85], [0.92, 0.04, 0.90],
  ].forEach(([fx, fz, sc]) => {
    const wx = fx * mw;
    if (wx > leftEnd + 0.5 && wx < rightSt - 0.5) return; // skip over river
    addTree(wx, fz * mh, sc);
    addTree(wx, (1 - fz) * mh, sc);
  });

  // ── Камни вдоль берега (GLB или процедурные) ─────────────────────────────
  const rockVariants = ['rock-a', 'rock-b', 'rock-c', 'rock-flat-grass'];
  [0.08,0.18,0.30,0.42,0.55,0.66,0.78,0.90].forEach((fz, i) => {
    const z = fz * mh;
    const sc = 0.85 + (i % 3) * 0.15;
    const offL = (i % 2 === 0 ? 0.08 : -0.06);
    const offR = (i % 2 === 0 ? -0.08 : 0.06);
    [
      [riverCX - riverHW - bankW * 0.35 + offL, z],
      [riverCX + riverHW + bankW * 0.35 + offR, z],
    ].forEach(([rx, rz]) => {
      const rname = rockVariants[(i * 2 + Math.round(rx)) % rockVariants.length];
      if (natureModels[rname]) {
        placeNature(rname, rx, rz, 0.22 * sc);
      } else {
        const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.11 * sc, 0), mRock);
        r.position.set(rx, 0.05 * sc, rz); r.rotation.y = fz * 7.3;
        r.castShadow = true; mapGroup.add(r);
      }
    });
  });

  // ── Трава и декор по полю ─────────────────────────────────────────────────
  [
    [0.15, 0.22], [0.28, 0.55], [0.10, 0.70], [0.32, 0.38], [0.22, 0.85],
    [0.05, 0.44], [0.38, 0.62], [0.18, 0.10], [0.30, 0.78],
  ].forEach(([fx, fz], i) => {
    const gname = i % 3 === 0 ? 'grass-large' : 'patch-grass';
    placeNature(gname, fx * leftEnd, fz * mh, 0.28);
    placeNature(gname, mw - fx * (mw - rightSt), fz * mh, 0.28);
  });

  // ── Кострище внизу реки ───────────────────────────────────────────────────
  placeNature('campfire-pit', riverCX, mh * 0.88, 0.35);

  // ── Дополнительная трава по полю ─────────────────────────────────────────
  [
    [0.12, 0.32], [0.42, 0.48], [0.58, 0.15], [0.78, 0.38],
    [0.22, 0.65], [0.65, 0.72], [0.48, 0.88], [0.85, 0.55],
    [0.30, 0.18], [0.70, 0.25], [0.50, 0.58], [0.38, 0.80],
    [0.75, 0.90], [0.15, 0.52], [0.55, 0.42],
  ].forEach(([fx, fz], i) => {
    const gnArr = ['patch-grass', 'patch-grass', 'patch-grass-large', 'grass-large'];
    const gname = gnArr[i % gnArr.length];
    placeNature(gname, fx * leftEnd, fz * mh, 0.20 + (i % 3) * 0.04);
    placeNature(gname, mw - fx * (mw - rightSt), fz * mh, 0.20 + (i % 3) * 0.04);
  });

  // ── Лужи (маленькие водоёмы в поле) ─────────────────────────────────────
  function addPuddle(wx, wz, r) {
    const circ = new THREE.Mesh(new THREE.CircleGeometry(r, 12), mWater);
    circ.rotation.x = -Math.PI / 2;
    circ.position.set(wx, 0.008, wz);
    circ.receiveShadow = true; circ.renderOrder = 3;
    mapGroup.add(circ);
    const rim = new THREE.Mesh(new THREE.RingGeometry(r * 0.52, r * 0.72, 12), mRipple);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(wx, 0.009, wz); rim.renderOrder = 5;
    mapGroup.add(rim);
  }
  [
    [0.68, 0.28, 0.30], [0.52, 0.72, 0.24], [0.78, 0.55, 0.27],
  ].forEach(([fx, fz, r]) => {
    addPuddle(fx * leftEnd, fz * mh, r);
    addPuddle(mw - fx * (mw - rightSt), fz * mh, r);
  });

  // ── Камни в поле (рассыпаны по травяным зонам) ───────────────────────────
  [
    [0.55, 0.18, 0.9], [0.72, 0.45, 1.1], [0.45, 0.62, 0.8],
    [0.62, 0.82, 0.95], [0.80, 0.30, 0.85], [0.35, 0.55, 1.0],
  ].forEach(([fx, fz, sc], i) => {
    const rname = rockVariants[i % rockVariants.length];
    [fx * leftEnd, mw - fx * (mw - rightSt)].forEach(rx => {
      if (natureModels[rname]) {
        placeNature(rname, rx, fz * mh, 0.17 * sc);
      } else {
        const rk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.09 * sc, 0), mRock);
        rk.position.set(rx, 0.04, fz * mh);
        rk.rotation.y = fx * 5.7; rk.castShadow = true; mapGroup.add(rk);
      }
    });
  });

  // ── Пригорки ─────────────────────────────────────────────────────────────
  function addHill(wx, wz, r) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(r, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.50),
      T(0x4aaa1e)
    );
    dome.position.set(wx, 0, wz);
    dome.castShadow = true; dome.receiveShadow = true;
    mapGroup.add(dome);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.06, 0.04, 10), T(0x3a8818));
    base.position.set(wx, 0.02, wz);
    base.receiveShadow = true; mapGroup.add(base);
  }
  [
    [0.15, 0.14, 0.45], [0.65, 0.82, 0.40],
    [0.20, 0.55, 0.50], [0.55, 0.28, 0.38],
  ].forEach(([fx, fz, r]) => {
    addHill(fx * leftEnd, fz * mh, r);
    addHill(mw - fx * (mw - rightSt), fz * mh, r);
  });

  // ── Фонтан / руна (вверху по центру реки) ────────────────────────────────
  const fcx = riverCX, fcz = mh * 0.10;
  box3(fcx, 0.07, fcz, 0.95, 0.14, 0.95, mStone);
  box3(fcx, 0.22, fcz, 0.72, 0.16, 0.72, mStone);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.40, 0.058, 7, 20), mFount);
  rim.rotation.x = Math.PI / 2; rim.position.set(fcx, 0.32, fcz);
  rim.castShadow = true; mapGroup.add(rim);
  flat(fcx, fcz, 0.64, 0.64, mWaterF, 0.30, 6);
  box3(fcx, 0.60, fcz, 0.11, 0.42, 0.11, mFount);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), mFount);
  ball.position.set(fcx, 0.88, fcz); mapGroup.add(ball);

  // ── Препятствия-пни (данные сервера) ─────────────────────────────────────
  obstacles.forEach(o => {
    const cx = o.x * S, cz = o.y * S;
    const r = Math.min(o.w, o.h) * S * 0.38;
    const stH = 0.46;
    const st = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.52, r * 0.72, stH, 10), mBark);
    st.position.set(cx, stH / 2, cz); st.castShadow = true; mapGroup.add(st);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.06, 10),
      T(0x9a6840));
    cap.position.set(cx, stH + 0.02, cz); mapGroup.add(cap);
    const sh = new THREE.Mesh(new THREE.CircleGeometry(r * 0.95, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }));
    sh.rotation.x = -Math.PI / 2; sh.position.set(cx, 0.01, cz);
    sh.renderOrder = 2; mapGroup.add(sh);
  });

  scene.add(mapGroup);

  // ── Освещение ─────────────────────────────────────────────────────────────
  torches.length = 0;

  // Фонтанный свет (синий, пульсирующий)
  const fLight = new THREE.PointLight(0x44aaff, 4.5, mw * 0.55);
  fLight.position.set(fcx, 1.2, fcz); scene.add(fLight); torches.push(fLight);

  // Речной свет по центру
  const riverGlow = new THREE.PointLight(0x2266cc, 2.8, riverHW * 14);
  riverGlow.position.set(riverCX, 0.6, mh * 0.5); scene.add(riverGlow); torches.push(riverGlow);

  // Солнечный свет по сторонам (зеленоватый)
  const sunL = new THREE.PointLight(0x88cc55, 1.4, mw * 0.65);
  sunL.position.set(mw * 0.18, 3.5, mh * 0.5); scene.add(sunL); torches.push(sunL);
  const sunR = new THREE.PointLight(0x55aa88, 1.4, mw * 0.65);
  sunR.position.set(mw * 0.82, 3.5, mh * 0.5); scene.add(sunR); torches.push(sunR);

  // Маленькие огни по углам
  [[0.06,0.06],[0.94,0.06],[0.06,0.94],[0.94,0.94]].forEach(([fx,fz]) => {
    const l = new THREE.PointLight(0xffcc44, 1.8, mw * 0.28);
    l.position.set(mw * fx, 1.2, mh * fz); scene.add(l); torches.push(l);
  });
}

// ── Characters ────────────────────────────────────────────────────────────────
const charEntries = new Map();
const playerSlots = new Map();

function makePudgeBody(teamColor) {
  const g = new THREE.Group();
  const tc = new THREE.Color(teamColor);

  const skin  = new THREE.MeshLambertMaterial({ color: 0x909040, emissive: tc, emissiveIntensity: 0.18 });
  const red   = new THREE.MeshLambertMaterial({ color: 0xcc1010 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x909099, metalness: 0.88, roughness: 0.14 });
  const chain = new THREE.MeshStandardMaterial({ color: 0x555560, metalness: 0.75, roughness: 0.32 });
  const brown = new THREE.MeshLambertMaterial({ color: 0x6b3318 });
  const ivory = new THREE.MeshLambertMaterial({ color: 0xe8e0c8 });
  const blood = new THREE.MeshLambertMaterial({ color: 0xaa0808 });

  function m(geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  }

  // Жирное тело
  m(new THREE.SphereGeometry(0.28, 12, 9), skin, 0, 0.37, 0, 0, 0, 0, 1.3, 0.95, 1.05);
  // Живот (выпуклый спереди)
  m(new THREE.SphereGeometry(0.22, 10, 8), skin, 0, 0.28, 0.15, 0, 0, 0, 1.0, 0.75, 0.7);
  // Большая голова
  m(new THREE.SphereGeometry(0.24, 12, 9), skin, 0, 0.75, 0, 0, 0, 0, 1.05, 1.0, 1.0);
  // Злые красные глаза
  m(new THREE.SphereGeometry(0.048, 7, 6), red,  -0.09, 0.81, 0.20);
  m(new THREE.SphereGeometry(0.048, 7, 6), red,   0.09, 0.81, 0.20);
  // Зрачки
  m(new THREE.SphereGeometry(0.024, 5, 4), new THREE.MeshLambertMaterial({ color: 0x110000 }), -0.09, 0.81, 0.235);
  m(new THREE.SphereGeometry(0.024, 5, 4), new THREE.MeshLambertMaterial({ color: 0x110000 }),  0.09, 0.81, 0.235);
  // Пасть
  m(new THREE.CylinderGeometry(0.12, 0.09, 0.05, 14, 1, false, 0, Math.PI),
    new THREE.MeshLambertMaterial({ color: 0x880000 }), 0, 0.63, 0.21, Math.PI, 0, 0);
  // Зубы (4 штуки)
  [-0.07, -0.02, 0.03, 0.08].forEach((tx, i) => {
    m(new THREE.BoxGeometry(0.036, 0.055, 0.022), ivory, tx, 0.60, 0.22);
  });
  // Шрамы на голове (полоски)
  m(new THREE.BoxGeometry(0.04, 0.006, 0.01), new THREE.MeshLambertMaterial({ color: 0x554020 }), -0.05, 0.95, 0.19);
  m(new THREE.BoxGeometry(0.04, 0.006, 0.01), new THREE.MeshLambertMaterial({ color: 0x554020 }),  0.06, 0.90, 0.20);

  // Пояс
  m(new THREE.TorusGeometry(0.27, 0.038, 7, 18), brown, 0, 0.22, 0, Math.PI / 2, 0, 0);
  m(new THREE.BoxGeometry(0.08, 0.055, 0.025), metal, 0, 0.22, 0.28); // пряжка

  // Левая рука (поднята вверх — держит цепь)
  m(new THREE.CapsuleGeometry(0.08, 0.22, 4, 8), skin, -0.30, 0.63, 0, 0, 0, -Math.PI * 0.35);
  m(new THREE.SphereGeometry(0.10, 8, 7), skin, -0.44, 0.79, 0); // кулак
  // Цепь (5 звеньев)
  for (let i = 0; i < 5; i++) {
    m(new THREE.TorusGeometry(0.038, 0.013, 5, 9), chain,
      -0.44 - i * 0.045, 0.87 + i * 0.07, 0, 0, (i % 2) * Math.PI / 2, 0);
  }
  // Крюк над цепью
  const hPts = [
    new THREE.Vector3(0, 0, 0),      new THREE.Vector3(-0.05, 0.05, 0),
    new THREE.Vector3(-0.11, 0.04, 0), new THREE.Vector3(-0.13, -0.01, 0),
    new THREE.Vector3(-0.11, -0.08, 0), new THREE.Vector3(-0.05, -0.09, 0),
    new THREE.Vector3(-0.01, -0.05, 0),
  ];
  const hm = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(hPts), 14, 0.018, 7),
    metal
  );
  hm.position.set(-0.65, 1.20, 0); hm.castShadow = true; g.add(hm);

  // Правая рука (вниз, тесак)
  m(new THREE.CapsuleGeometry(0.075, 0.19, 4, 8), skin, 0.30, 0.47, 0, 0, 0, Math.PI * 0.22);
  m(new THREE.SphereGeometry(0.09, 8, 7), skin, 0.40, 0.29, 0.04); // кулак
  m(new THREE.CylinderGeometry(0.024, 0.019, 0.16, 7), brown, 0.46, 0.22, 0.06, 0, 0, Math.PI / 4); // рукоять
  m(new THREE.BoxGeometry(0.15, 0.13, 0.022), metal, 0.52, 0.12, 0.04, 0, 0, Math.PI / 6); // лезвие

  // Кровь (пятна на теле)
  [[0.09, 0.45, 0.27], [-0.13, 0.55, 0.22], [0.04, 0.68, 0.21], [-0.06, 0.32, 0.28], [0.15, 0.30, 0.20]]
    .forEach(([bx, by, bz]) => {
      m(new THREE.SphereGeometry(0.034, 5, 4), blood, bx, by, bz, 0, 0, 0, 1, 0.28, 1);
    });

  return g;
}

function applyTeamColor(model, teamColor) {
  const tc = new THREE.Color(teamColor);
  model.traverse(c => {
    if (!c.isMesh || !c.material) return;
    const toToon = mat => new THREE.MeshToonMaterial({
      color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
      map: mat.map ?? null,
      gradientMap: toonGrad,
      emissive: tc,
      emissiveIntensity: 0.18,
    });
    if (Array.isArray(c.material)) {
      c.material = c.material.map(toToon);
    } else {
      c.material = toToon(c.material);
    }
  });
}

function getOrCreateChar(id, team) {
  if (charEntries.has(id)) return charEntries.get(id);
  if (!playerSlots.has(id)) playerSlots.set(id, playerSlots.size);

  const color = TEAM_COLORS[team];
  const group = new THREE.Group();

  // Кольцо команды на земле
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.50, 0.70, 28),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.006;
  ring.userData.isRing = true;
  group.add(ring);

  let mixer = null;
  const actions = {};

  const model = pudgePool.pop() ?? null;
  if (model) {
    model.scale.set(1, 1, 1); // reset before measuring (pool reuse fix)
    const box  = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const s    = size.y > 0.001 ? 1.28 / size.y : 0.65;
    model.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(model);
    model.position.y = -box2.min.y;
    applyTeamColor(model, color);
    group.add(model);

    mixer = new THREE.AnimationMixer(model);
    if (walkClip) actions.walk = mixer.clipAction(walkClip);
    if (runClip)  actions.run  = mixer.clipAction(runClip);
    if (hookClip) actions.hook = mixer.clipAction(hookClip);
    if (dieClip)  actions.die  = mixer.clipAction(dieClip);

    // Die and hook play once then hold last frame
    ['die', 'hook'].forEach(n => {
      if (actions[n]) { actions[n].setLoop(THREE.LoopOnce, 1); actions[n].clampWhenFinished = true; }
    });
  }

  scene.add(group);
  const entry = {
    group, ring, model, team, mixer, actions,
    currentAnim: null,
    prevX: null, prevY: null,
    targetRotY: 0,
    prevHasHook: false, hookFiring: false, hookTimer: 0, hookAngle: 0,
  };
  charEntries.set(id, entry);
  return entry;
}

function removeChar(id) {
  const e = charEntries.get(id);
  if (e) {
    if (e.model) {
      e.mixer?.stopAllAction();
      e.group.remove(e.model);
      pudgePool.push(e.model); // return model to pool for next game
    }
    scene.remove(e.group);
    charEntries.delete(id);
  }
}

// ── Heart pickup ──────────────────────────────────────────────────────────────
let heartGroup = null;
let sHeart = null;
let heartRenderPos = null; // smoothly interpolated position

function makeHeartGroup() {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0xff2244, emissive: 0xcc0022, emissiveIntensity: 0.6 });
  const r = 0.13;
  for (const sx of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 10), mat);
    b.position.set(sx * r * 0.65, 0, 0);
    b.castShadow = true;
    g.add(b);
  }
  const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 1.35, r * 2.4, 8), mat);
  cone.position.y = -r * 1.35;
  cone.rotation.z = Math.PI;
  cone.castShadow = true;
  g.add(cone);
  g.add(new THREE.PointLight(0xff2244, 6, 3.5));
  return g;
}

function updateHeartItem(d) {
  if (d.heart) {
    if (!heartGroup) { heartGroup = makeHeartGroup(); scene.add(heartGroup); }
    if (!heartRenderPos) heartRenderPos = { x: d.heart.x, y: d.heart.y }; // snap on first appear
    sHeart = d.heart;
  } else {
    if (heartGroup) { scene.remove(heartGroup); heartGroup = null; }
    sHeart = null;
    heartRenderPos = null;
  }
}

function showHeartPickupEffect() {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;font-size:40px;pointer-events:none;z-index:200;' +
    'top:50%;left:50%;transform:translate(-50%,-50%);animation:heart-pop 0.75s ease-out forwards;';
  el.textContent = '❤';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 750);
}

function addPickupFeed(pickup) {
  const feed = document.getElementById('kill-feed');
  const el = document.createElement('div');
  el.className = 'kill-entry';
  el.style.borderColor = '#ff2244';
  el.innerHTML = `<span style="color:#ff4466">❤</span>
    <span style="color:${TEAM_HEX[pickup.playerTeam]}">${pickup.playerName}</span>
    <span style="color:#aaa;font-size:11px">+1 HP</span>`;
  feed.prepend(el);
  setTimeout(() => { el.style.opacity = '0'; }, 2500);
  setTimeout(() => { el.remove(); }, 3800);
  while (feed.children.length > 5) feed.lastChild.remove();

  // Effect for local player
  const me = sPlayers.find(p => p.id === myId);
  if (me && pickup.playerName === me.name) showHeartPickupEffect();
}

// ── Hook geometry ─────────────────────────────────────────────────────────────
function makeHookHead() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xb8c0cc, metalness: 0.97, roughness: 0.05 });
  // J-shape curve — scaled up 2.8x for visibility
  const sc = 2.8;
  const pts = [
    new THREE.Vector3(0,          0, -0.18 * sc),
    new THREE.Vector3(0,          0, -0.08 * sc),
    new THREE.Vector3(0,          0,  0.00),
    new THREE.Vector3(-0.03 * sc, 0,  0.05 * sc),
    new THREE.Vector3(-0.07 * sc, 0,  0.05 * sc),
    new THREE.Vector3(-0.10 * sc, 0,  0.01 * sc),
    new THREE.Vector3(-0.10 * sc, 0, -0.05 * sc),
    new THREE.Vector3(-0.07 * sc, 0, -0.08 * sc),
    new THREE.Vector3(-0.03 * sc, 0, -0.06 * sc),
  ];
  const geo  = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.036, 8, false);
  const hook = new THREE.Mesh(geo, mat);
  hook.castShadow = true;
  const eye  = new THREE.Mesh(new THREE.TorusGeometry(0.022 * sc, 0.010 * sc, 6, 12), mat);
  eye.rotation.x = Math.PI / 2;
  eye.position.set(0, 0, -0.22 * sc);
  const g = new THREE.Group();
  g.add(hook); g.add(eye);
  return g;
}

function makeRope() {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(0.034, 0.034, 1, 6),
    new THREE.MeshLambertMaterial({ color: 0x7a5520 })
  );
}

function positionRope(rope, from, to) {
  const dir = to.clone().sub(from);
  const len = dir.length();
  if (len < 0.01) { rope.visible = false; return; }
  rope.visible = true;
  rope.position.copy(from).addScaledVector(dir.clone().normalize(), len / 2);
  rope.scale.set(1, len, 1);
  rope.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
}

function orientHookHead(head, from, to) {
  const dir = to.clone().sub(from);
  head.position.copy(to);
  if (dir.length() > 0.01) head.rotation.y = Math.atan2(dir.x, dir.z);
}

const hookLines = new Map(); // ownerId → { rope, head }

function upsertHook(hook, owner) {
  if (!hookLines.has(hook.ownerId)) {
    const rope = makeRope(), head = makeHookHead();
    scene.add(rope); scene.add(head);
    hookLines.set(hook.ownerId, { rope, head });
  }
  const { rope, head } = hookLines.get(hook.ownerId);
  const from = sw(owner.x, owner.y, 0.80);
  const to   = sw(hook.x,  hook.y,  0.80);
  positionRope(rope, from, to);
  orientHookHead(head, from, to);
}

function removeHookLine(id) {
  const h = hookLines.get(id);
  if (!h) return;
  scene.remove(h.rope); scene.remove(h.head);
  h.rope.geometry.dispose();
  hookLines.delete(id);
}

// ── Aim indicator ─────────────────────────────────────────────────────────────
let aimObjects = null;

function buildAimObjects() {
  const ao = {};

  // Tapered triangle: fat base at origin (0,0,±hw), tip at (1,0,0).
  // Scale X by HOOK_RANGE_WORLD so length always matches hook range.
  function makeBeam(hw, color, opacity, y, order) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([0, 0, -hw,  0, 0, hw,  1, 0, 0]), 3
    ));
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(HOOK_RANGE_WORLD, 1, 1);
    mesh.position.y = y;
    mesh.renderOrder = order;
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  }

  ao.beamGlow = makeBeam(0.22, 0x33ff55, 0.16, 0.02, 10); // wide, subtle glow
  ao.beam     = makeBeam(0.09, 0x55ff77, 0.62, 0.03, 11); // narrow, opaque core
  return ao;
}

function showAimIndicators(fromW, toW) {
  if (!aimObjects) aimObjects = buildAimObjects();
  const ao = aimObjects;

  const dir = new THREE.Vector3(toW.x - fromW.x, 0, toW.z - fromW.z);
  if (dir.length() < 0.01) {
    ao.beam.visible = false;
    ao.beamGlow.visible = false;
    return;
  }
  dir.normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);

  ao.beam.visible = true;
  ao.beam.position.set(fromW.x, 0.03, fromW.z);
  ao.beam.quaternion.copy(quat);

  ao.beamGlow.visible = true;
  ao.beamGlow.position.set(fromW.x, 0.02, fromW.z);
  ao.beamGlow.quaternion.copy(quat);
}

function hideAimIndicators() {
  if (!aimObjects) return;
  aimObjects.beam.visible = false;
  aimObjects.beamGlow.visible = false;
}

// ── Coord helpers ─────────────────────────────────────────────────────────────
function sw(sx, sy, worldY = 0) {
  return new THREE.Vector3(sx * S, worldY, sy * S);
}

const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster  = new THREE.Raycaster();

function screenToServerCoords(sx, sy) {
  const ndc = new THREE.Vector2(
    (sx / window.innerWidth)  * 2 - 1,
    (sy / window.innerHeight) * -2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const pt = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(floorPlane, pt)) return null;
  return { x: pt.x / S, y: pt.z / S };
}

// Convert right-joystick direction to server target coords
function aimDirToServer(jx, jy) {
  const me = sPlayers.find(p => p.id === myId);
  if (!me) return null;
  const ndc = sw(me.x, me.y, 0).project(camera);
  const px = (ndc.x + 1) * 0.5 * window.innerWidth;
  const py = (-ndc.y + 1) * 0.5 * window.innerHeight;
  return screenToServerCoords(px + jx * 420, py + jy * 420);
}

// ── Game state ────────────────────────────────────────────────────────────────
let socket = null, myId = null, myTeam = null, mode = 'pvp';
let gameState = 'menu';
let sPlayers  = [];
let sHooks    = [];
let mapBuilt  = false;
let myHookCooldown = 0;

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = document.getElementById(`screen-${name}`);
  if (s) s.classList.add('active');
  const playing = (name === 'game');
  document.getElementById('overlay').style.pointerEvents = playing ? 'none' : 'auto';
  document.getElementById('hud').style.display        = playing ? 'block' : 'none';
  document.getElementById('joy-canvas').style.display  = playing ? 'block' : 'none';
  if (name === 'loading') _startTipCycle(); else _stopTipCycle();
}

// ── Socket ────────────────────────────────────────────────────────────────────
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io(SERVER_URL, { transports: ['websocket'] });

  socket.on('connect', () => {
    myId = socket.id;
    if (mode === 'bots') {
      socket.emit('play_vs_bots', { user: tgUser, clientId });
    } else {
      socket.emit('join_lobby', { user: tgUser, clientId });
    }
  });

  socket.on('lobby_update', state => {
    renderLobbySlots(state);
  });

  socket.on('game_start', async d => {
    myId = socket.id;
    if (d.mapW) { MAP_W = d.mapW; MAP_H = d.mapH; }
    positionCamera();
    // Set up team info immediately (for HUD), but keep sPlayers empty until assets loaded
    // so updatePlayers() doesn't create characters before pudgePool is ready
    const me = d.players.find(p => p.id === myId);
    if (me) {
      myTeam = me.team;
      const el = document.getElementById('hud-team');
      el.textContent = `Команда: ${TEAM_NAMES[me.team]}`;
      el.style.color = TEAM_HEX[me.team];
    }
    if (!mapBuilt) { buildMap(d.obstacles); mapBuilt = true; }

    // 'countdown' state: scene renders but input is blocked
    gameState = 'countdown';
    showScreen('loading');
    await waitForAssets();
    if (gameState !== 'countdown') return; // game ended while loading

    // Assets ready — now populate sPlayers so characters are created with full pool
    sPlayers = d.players; sHooks = [];

    // Models ready — show arena with countdown overlay
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('overlay').style.pointerEvents = 'none';
    await showCountdown();
    if (gameState !== 'countdown') return; // game ended during countdown

    // Signal server: client is ready, start the game loop
    gameState = 'playing';
    socket?.emit('player_ready');
    showScreen('game');
  });

  socket.on('state', d => {
    if (gameState !== 'playing') return;
    const prevMe = sPlayers.find(p => p.id === myId);
    sPlayers = d.players;
    const live = new Set(d.hooks.map(h => h.ownerId));
    for (const id of hookLines.keys()) if (!live.has(id)) removeHookLine(id);
    sHooks = d.hooks;
    const me = d.players.find(p => p.id === myId);
    if (me) {
      myHookCooldown = me.hookCooldown ?? 0;
      if (me.hitFlash > 0 && (!prevMe || prevMe.hitFlash === 0)) triggerShake(380);
      const deadEl = document.getElementById('dead-overlay');
      if (!me.alive) deadEl.classList.add('show'); else deadEl.classList.remove('show');
      document.getElementById('hud-hp').textContent = '❤'.repeat(Math.max(0, me.hp));
    }
    if (d.kills?.length) d.kills.forEach(addKillFeed);
    if (d.pickups?.length) d.pickups.forEach(addPickupFeed);
    updateHeartItem(d);
  });

  socket.on('player_left', d => {
    removeChar(d.id);
    sPlayers = sPlayers.filter(p => p.id !== d.id);
  });

  socket.on('game_over', d => {
    gameState = 'gameover';
    document.getElementById('dead-overlay').classList.remove('show');
    const won = d.winner === myTeam, draw = d.winner === -1;
    const title = document.getElementById('gameover-title');
    title.textContent = draw ? 'НИЧЬЯ' : won ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ';
    title.style.color = draw ? '#f39c12' : won ? '#f1c40f' : '#e74c3c';
    document.getElementById('gameover-sub').textContent = draw ? '' : `${TEAM_NAMES[d.winner]} побеждают`;
    showScreen('gameover');
  });

  socket.on('disconnect', () => {
    if (gameState === 'playing' || gameState === 'countdown') { cleanupGame(); showScreen('menu'); }
    else if (gameState === 'lobby') { gameState = 'menu'; showScreen('menu'); }
  });
}

function cleanupGame() {
  gameState = 'menu';
  charEntries.forEach((_, id) => removeChar(id));
  playerSlots.clear();
  hookLines.forEach((_, id) => removeHookLine(id));
  if (mapGroup) { scene.remove(mapGroup); mapGroup = null; }
  mapBuilt = false; sPlayers = []; sHooks = [];
  if (heartGroup) { scene.remove(heartGroup); heartGroup = null; }
  sHeart = null;
  hideAimIndicators();
  torches.forEach(l => scene.remove(l));
  torches.length = 0;
  shakeUntil = 0; document.body.style.transform = '';
  document.getElementById('dead-overlay').classList.remove('show');
  document.getElementById('kill-feed').innerHTML = '';
  document.getElementById('hud-hp').textContent = '❤❤';
}

// ── Dual joystick ─────────────────────────────────────────────────────────────
const JR = 58;
const moveJoy = { active: false, pid: -1, nx: 0, ny: 0 };
const aimJoy  = { active: false, pid: -1, nx: 0, ny: 0, snx: 0, sny: 0 };
let moveBase = { x: 110, y: 0 };
let aimBase  = { x: 0,   y: 0 };

function updateJoyBases() {
  const w = window.innerWidth, h = window.innerHeight;
  moveBase = { x: 110,     y: h - 110 };
  aimBase  = { x: w - 110, y: h - 110 };
}
updateJoyBases();

canvas.addEventListener('touchstart', e => {
  if (gameState !== 'playing') return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    const mid = window.innerWidth / 2;
    if (!moveJoy.active && t.clientX < mid)
      Object.assign(moveJoy, { active: true, pid: t.identifier, nx: 0, ny: 0 });
    else if (!aimJoy.active && t.clientX >= mid)
      Object.assign(aimJoy,  { active: true, pid: t.identifier, nx: 0, ny: 0 });
  }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  if (gameState !== 'playing') return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (moveJoy.active && t.identifier === moveJoy.pid) {
      const dx = t.clientX - moveBase.x, dy = t.clientY - moveBase.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      moveJoy.nx = len > 8 ? dx / len : 0;
      moveJoy.ny = len > 8 ? dy / len : 0;
      socket?.emit('input', { dx: moveJoy.nx, dy: moveJoy.ny });
    }
    if (aimJoy.active && t.identifier === aimJoy.pid) {
      const dx = t.clientX - aimBase.x, dy = t.clientY - aimBase.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      aimJoy.nx = len > 8 ? dx / len : 0;
      aimJoy.ny = len > 8 ? dy / len : 0;
    }
  }
}, { passive: false });

canvas.addEventListener('touchend', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (moveJoy.active && t.identifier === moveJoy.pid) {
      Object.assign(moveJoy, { active: false, pid: -1, nx: 0, ny: 0 });
      if (gameState === 'playing') socket?.emit('input', { dx: 0, dy: 0 });
    }
    if (aimJoy.active && t.identifier === aimJoy.pid) {
      if (gameState === 'playing' && (Math.abs(aimJoy.snx) > 0.05 || Math.abs(aimJoy.sny) > 0.05)) {
        const target = aimDirToServer(aimJoy.snx, aimJoy.sny);
        if (target) socket?.emit('input', { hookX: target.x, hookY: target.y });
      }
      Object.assign(aimJoy, { active: false, pid: -1, nx: 0, ny: 0, snx: 0, sny: 0 });
      hideAimIndicators();
    }
  }
}, { passive: false });
canvas.addEventListener('touchcancel', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (moveJoy.active && t.identifier === moveJoy.pid) {
      Object.assign(moveJoy, { active: false, pid: -1, nx: 0, ny: 0 });
      socket?.emit('input', { dx: 0, dy: 0 });
    }
    if (aimJoy.active && t.identifier === aimJoy.pid) {
      Object.assign(aimJoy, { active: false, pid: -1, nx: 0, ny: 0, snx: 0, sny: 0 });
      hideAimIndicators();
    }
  }
}, { passive: false });

// Desktop WASD + click
const keys = {};
window.addEventListener('keydown', e => {
  keys[e.key] = true;
  if (gameState !== 'playing') return;
  const dx = (keys['d'] || keys['ArrowRight'] ? 1 : 0) - (keys['a'] || keys['ArrowLeft'] ? 1 : 0);
  const dy = (keys['s'] || keys['ArrowDown']  ? 1 : 0) - (keys['w'] || keys['ArrowUp']   ? 1 : 0);
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  socket?.emit('input', { dx: dx ? dx / len : 0, dy: dy ? dy / len : 0 });
});
window.addEventListener('keyup', e => {
  keys[e.key] = false;
  if (gameState !== 'playing') return;
  const dx = (keys['d'] || keys['ArrowRight'] ? 1 : 0) - (keys['a'] || keys['ArrowLeft'] ? 1 : 0);
  const dy = (keys['s'] || keys['ArrowDown']  ? 1 : 0) - (keys['w'] || keys['ArrowUp']   ? 1 : 0);
  socket?.emit('input', { dx, dy });
});
canvas.addEventListener('click', e => {
  if (gameState !== 'playing') return;
  const gc = screenToServerCoords(e.clientX, e.clientY);
  if (gc) socket?.emit('input', { hookX: gc.x, hookY: gc.y });
});
// Desktop mouse move: show aim indicator toward cursor
canvas.addEventListener('mousemove', e => {
  if (gameState !== 'playing') return;
  const gc = screenToServerCoords(e.clientX, e.clientY);
  const me = sPlayers.find(p => p.id === myId);
  if (gc && me) showAimIndicators(sw(me.x, me.y, 0), sw(gc.x, gc.y, 0));
});

// ── Screen shake ──────────────────────────────────────────────────────────────
let shakeUntil = 0;
function triggerShake(ms = 320) { shakeUntil = Date.now() + ms; }
function applyShake() {
  if (Date.now() >= shakeUntil) { document.body.style.transform = ''; return; }
  const x = (Math.random() - 0.5) * 14;
  const y = (Math.random() - 0.5) * 14;
  document.body.style.transform = `translate(${x}px,${y}px)`;
}

// ── Kill feed ─────────────────────────────────────────────────────────────────
function addKillFeed(kill) {
  const feed = document.getElementById('kill-feed');
  const el   = document.createElement('div');
  el.className = 'kill-entry';
  el.style.borderColor = TEAM_HEX[kill.killerTeam];
  el.innerHTML =
    `<span style="color:${TEAM_HEX[kill.killerTeam]}">${kill.killerName}</span>` +
    ` <span style="color:#aaa;font-size:11px">⚓</span> ` +
    `<span style="color:${TEAM_HEX[kill.victimTeam]}">${kill.victimName}</span>`;
  feed.prepend(el);
  setTimeout(() => { el.style.opacity = '0'; }, 3000);
  setTimeout(() => { el.remove(); }, 4200);
  while (feed.children.length > 5) feed.lastChild.remove();
}

// ── Joystick canvas ───────────────────────────────────────────────────────────
const joyCanvas = document.getElementById('joy-canvas');
const joyCtx    = joyCanvas.getContext('2d');

function resizeJoyCanvas() {
  joyCanvas.width  = window.innerWidth;
  joyCanvas.height = window.innerHeight;
}
resizeJoyCanvas();

function drawOneJoystick(base, joy, isAim) {
  const tx = base.x + joy.nx * JR, ty = base.y + joy.ny * JR;

  // Base ring
  joyCtx.beginPath();
  joyCtx.arc(base.x, base.y, JR, 0, Math.PI * 2);
  joyCtx.strokeStyle = joy.active ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.14)';
  joyCtx.lineWidth   = 2.5;
  joyCtx.stroke();
  joyCtx.fillStyle   = joy.active ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)';
  joyCtx.fill();

  // Hook cooldown arc (right joystick only)
  if (isAim) {
    const ready = myHookCooldown <= 0;
    const frac  = ready ? 1 : 1 - myHookCooldown / HOOK_COOLDOWN_MS;
    joyCtx.beginPath();
    joyCtx.arc(base.x, base.y, JR - 5, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    joyCtx.strokeStyle = ready ? 'rgba(46,204,113,0.9)' : 'rgba(231,76,60,0.75)';
    joyCtx.lineWidth   = 4.5;
    joyCtx.stroke();

    if (!joy.active) {
      joyCtx.textAlign    = 'center';
      joyCtx.textBaseline = 'middle';
      if (ready) {
        joyCtx.font      = '19px Arial';
        joyCtx.fillStyle = 'rgba(46,204,113,0.7)';
        joyCtx.fillText('⚓', base.x, base.y);
      } else {
        joyCtx.font      = 'bold 13px Arial';
        joyCtx.fillStyle = 'rgba(231,76,60,0.9)';
        joyCtx.fillText((myHookCooldown / 1000).toFixed(1), base.x, base.y);
      }
    }
  }

  // Thumb
  if (joy.active) {
    joyCtx.beginPath();
    joyCtx.arc(tx, ty, 22, 0, Math.PI * 2);
    joyCtx.fillStyle = isAim ? 'rgba(231,76,60,0.75)' : 'rgba(255,255,255,0.45)';
    joyCtx.fill();
  }
}

function projectToScreen(wx, wy, wz) {
  const v = new THREE.Vector3(wx, wy, wz).project(camera);
  return {
    x: (v.x + 1) / 2 * window.innerWidth,
    y: (-v.y + 1) / 2 * window.innerHeight,
    visible: v.z < 1,
  };
}

function drawNameLabels() {
  const playing = gameState === 'playing' || gameState === 'countdown';
  if (!playing) return;
  for (const p of sPlayers) {
    const sp = projectToScreen(p.x * S, 1.75, p.y * S);
    if (!sp.visible) continue;

    const isMe    = p.id === myId;
    const nameCol = TEAM_HEX[p.team];
    const barW    = 56, barH = 5;
    const hpFrac  = Math.min(1, Math.max(0, p.hp) / 2);
    const baseY   = sp.y;

    // HP bar background
    joyCtx.fillStyle = 'rgba(0,0,0,0.65)';
    joyCtx.fillRect(sp.x - barW / 2 - 1, baseY - 2, barW + 2, barH + 2);
    joyCtx.fillStyle = '#2a2a2a';
    joyCtx.fillRect(sp.x - barW / 2, baseY - 1, barW, barH);
    joyCtx.fillStyle = p.hp >= 3 ? '#f39c12' : p.hp > 1 ? '#2ecc71' : '#e74c3c';
    joyCtx.fillRect(sp.x - barW / 2, baseY - 1, barW * hpFrac, barH);

    // Name label
    joyCtx.font = `${isMe ? 'bold ' : ''}${isMe ? 13 : 12}px Arial`;
    joyCtx.textAlign    = 'center';
    joyCtx.textBaseline = 'bottom';
    const nameY = baseY - 5;
    // Shadow
    joyCtx.fillStyle = 'rgba(0,0,0,0.8)';
    joyCtx.fillText(p.name, sp.x + 1, nameY + 1);
    joyCtx.fillStyle = p.alive ? nameCol : '#555';
    joyCtx.fillText(p.name, sp.x, nameY);
  }
}

function drawJoysticks() {
  joyCtx.clearRect(0, 0, joyCanvas.width, joyCanvas.height);
  drawNameLabels();
  if (gameState !== 'playing') return;
  drawOneJoystick(moveBase, moveJoy, false);
  drawOneJoystick(aimBase,  aimJoy,  true);
}

// Shortest-path angle lerp (handles 0/2π wrap-around)
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d >  Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ── Animation state machine ───────────────────────────────────────────────────
function playAnim(entry, name, fade = 0.2, timeScale = 1.0) {
  const next = entry.actions[name];
  if (!next) return;
  next.setEffectiveTimeScale(timeScale);
  if (entry.currentAnim === name) return;
  const prev = entry.currentAnim ? entry.actions[entry.currentAnim] : null;
  next.reset().setEffectiveWeight(1).play();
  if (prev && fade > 0) next.crossFadeFrom(prev, fade, true);
  entry.currentAnim = name;
}

// ── Render loop ───────────────────────────────────────────────────────────────
function updatePlayers(delta) {
  const activeIds = new Set(sPlayers.map(p => p.id));
  for (const id of charEntries.keys()) if (!activeIds.has(id)) removeChar(id);

  // Frame-rate independent factors
  const posK = 1 - Math.exp(-delta * 22);   // position lerp (~22 Hz convergence)
  const rotK = 1 - Math.exp(-delta * 11);   // rotation lerp (~0.3s for 180°)
  const rotKFast = 1 - Math.exp(-delta * 22); // fast rotation for hook snap

  for (const p of sPlayers) {
    const entry = getOrCreateChar(p.id, p.team);
    const targetPos = sw(p.x, p.y, 0);
    entry.group.position.lerp(targetPos, posK);
    entry.ring.material.opacity = p.alive ? 0.90 : 0.2;

    // Movement delta (server units per frame)
    const hasPrev = entry.prevX !== null;
    const dx = hasPrev ? p.x - entry.prevX : 0;
    const dy = hasPrev ? p.y - entry.prevY : 0;
    const moveDist = Math.sqrt(dx * dx + dy * dy);

    // Update target rotation toward movement direction (suppressed while hook fires)
    if (moveDist > 0.4 && p.alive && !entry.hookFiring) {
      entry.targetRotY = Math.atan2(dx, dy);
    }
    entry.prevX = p.x; entry.prevY = p.y;

    // ── Animation state ──────────────────────────────────────────────────────
    if (entry.mixer) {
      if (!p.alive) {
        playAnim(entry, 'die', 0.15);
      } else {
        // Hook firing window
        const hasHook = sHooks.some(h => h.ownerId === p.id);
        if (hasHook && !entry.prevHasHook) {
          entry.hookFiring = true;
          entry.hookTimer  = 0.55;
          playAnim(entry, 'hook', 0.08);
        }
        entry.prevHasHook = hasHook;

        if (entry.hookFiring) {
          const h = sHooks.find(hk => hk.ownerId === p.id);
          if (h) {
            const hdx = h.x - p.x, hdz = h.y - p.y;
            if (Math.sqrt(hdx * hdx + hdz * hdz) > 8) {
              entry.hookAngle = Math.atan2(hdx, hdz);
            }
          }
          // Snap quickly to hook direction
          entry.targetRotY = entry.hookAngle;
          entry.group.rotation.y = lerpAngle(entry.group.rotation.y, entry.targetRotY, rotKFast);
          entry.hookTimer -= delta;
          if (entry.hookTimer <= 0) entry.hookFiring = false;
        }

        if (!entry.hookFiring) {
          // Apply smooth rotation
          entry.group.rotation.y = lerpAngle(entry.group.rotation.y, entry.targetRotY, rotK);

          const isMe = p.id === myId;
          const joyLen = isMe ? Math.sqrt(moveJoy.nx ** 2 + moveJoy.ny ** 2) : 0;

          if (!isMe) {
            entry.smoothSpeed = (entry.smoothSpeed ?? 0) * 0.78 + moveDist * 0.22;
          }
          const speed = isMe ? joyLen : (entry.smoothSpeed ?? moveDist);

          if (isMe ? joyLen > 0.50 : speed > 2.5) {
            playAnim(entry, 'run',  0.15);
          } else if (isMe ? joyLen > 0.06 : speed > 0.6) {
            playAnim(entry, 'walk', 0.20);
          } else {
            playAnim(entry, 'walk', 0.30, 0.10);
          }
        }
      }

      entry.mixer.update(delta);
    }

    entry.group.traverse(c => {
      if (!c.isMesh || !c.material || c.userData.isRing) return;
      if (!p.alive) {
        c.material.transparent = true; c.material.opacity = 0.28; c.material.depthWrite = false;
      } else {
        c.material.transparent = false; c.material.opacity = 1; c.material.depthWrite = true;
        if (c.material.emissive) {
          c.material.emissiveIntensity = p.hitFlash > 0 ? 1.0 : (p.id === myId ? 0.35 : 0.18);
        }
      }
    });
  }
}

function updateHooks() {
  for (const h of sHooks) {
    const owner = sPlayers.find(p => p.id === h.ownerId);
    if (owner) upsertHook(h, owner);
  }
}

function animateTorches() {
  const t = Date.now() / 800;
  torches.forEach((l, i) => {
    if (l.color.b > l.color.r) {
      l.intensity = 3.2 + Math.sin(t * 1.4) * 0.5; // fountain: gentle blue pulse
    } else {
      l.intensity = 2.5 + Math.sin(t * (3.1 + i * 0.7)) * 0.6; // torch: flicker
    }
  });
}

function updateAimFromJoystick(delta) {
  const k = 1 - Math.exp(-delta * 9); // smoothing: ~63% convergence in ~110ms
  aimJoy.snx += (aimJoy.nx - aimJoy.snx) * k;
  aimJoy.sny += (aimJoy.ny - aimJoy.sny) * k;
  if (!aimJoy.active || (Math.abs(aimJoy.snx) < 0.05 && Math.abs(aimJoy.sny) < 0.05)) return;
  const me = sPlayers.find(p => p.id === myId);
  if (!me) return;
  const target = aimDirToServer(aimJoy.snx, aimJoy.sny);
  if (target) showAimIndicators(sw(me.x, me.y, 0), sw(target.x, target.y, 0));
}

let _lastTime = performance.now();

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const delta = Math.min((now - _lastTime) / 1000, 0.1); // cap at 100ms
  _lastTime = now;

  applyShake();
  if (gameState === 'playing' || gameState === 'countdown') {
    updatePlayers(delta);
    updateHooks();
    animateTorches();
    // Animate heart — lerp render pos toward server pos for smooth hook-pull
    if (heartGroup && sHeart) {
      if (!heartRenderPos) heartRenderPos = { x: sHeart.x, y: sHeart.y };
      heartRenderPos.x += (sHeart.x - heartRenderPos.x) * 0.22;
      heartRenderPos.y += (sHeart.y - heartRenderPos.y) * 0.22;
      const t = Date.now();
      heartGroup.position.set(heartRenderPos.x * S, 0.55 + Math.sin(t / 500) * 0.1, heartRenderPos.y * S);
      heartGroup.rotation.y = t / 900;
    }
  }
  if (gameState === 'playing') {
    updateAimFromJoystick(delta);
  }
  drawJoysticks();
  renderer.render(scene, camera);
}

// ── Resize ────────────────────────────────────────────────────────────────────
function applyResize() {
  const vvp = window.visualViewport;
  const w = Math.round(vvp ? vvp.width  : window.innerWidth);
  const h = Math.round(vvp ? vvp.height : window.innerHeight);
  if (w < 100 || h < 100) return; // ignore degenerate sizes mid-transition
  aspect = w / h;
  renderer.setSize(w, h);
  camera.left   = -VIEW_SIZE * aspect;
  camera.right  =  VIEW_SIZE * aspect;
  camera.top    =  VIEW_SIZE;
  camera.bottom = -VIEW_SIZE;
  camera.updateProjectionMatrix();
  resizeJoyCanvas();
  updateJoyBases();
}

let _resizeTid = 0;
function scheduleResize() {
  clearTimeout(_resizeTid);
  _resizeTid = setTimeout(applyResize, 120); // wait for viewport to settle
}

window.addEventListener('resize', scheduleResize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);

// ── Lobby UI ──────────────────────────────────────────────────────────────────
function renderLobbySlots(state) {
  [0, 1, 2, 3].forEach(idx => {
    const el = document.getElementById(`lobby-slot-${idx}`);
    if (!el) return;
    const slot = state.slots[idx];
    const teamColor = TEAM_HEX[idx % 2];
    el.style.borderColor = slot ? `${teamColor}99` : 'rgba(255,255,255,0.12)';
    if (slot) {
      el.innerHTML = `<div style="font-size:20px">${slot.isBot ? '🤖' : '👤'}</div>
        <div style="color:#fff;font-size:12px;font-weight:bold;max-width:108px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${slot.name}</div>`;
    } else {
      el.innerHTML = `<div style="color:#555;font-size:11px;margin-bottom:3px">Свободно</div>
        <button style="font-size:11px;color:#bbb;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.18);border-radius:4px;padding:3px 9px;cursor:pointer">+ Бот</button>`;
      el.querySelector('button').addEventListener('click', () => socket?.emit('add_bot_to_lobby'));
    }
  });
  const allFilled = state.slots.every(s => s !== null);
  const startBtn = document.getElementById('btn-start-lobby');
  if (startBtn) startBtn.style.display = allFilled ? 'block' : 'none';
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
async function loadLeaderboard() {
  try {
    const rows = await fetch('/leaderboard').then(r => r.json());
    const tbody = document.getElementById('lb-body');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:#444;padding:16px">Пока пусто — сыграй первую игру!</td></tr>';
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    tbody.innerHTML = rows.map((r, i) =>
      `<tr>
        <td style="color:${i===0?'#f39c12':i===1?'#bbb':i===2?'#cd7f32':'#555'}">${medals[i] ?? i + 1}</td>
        <td>${r.name}</td>
        <td style="color:#e74c3c">${r.kills}</td>
        <td style="color:#888">${r.deaths}</td>
        <td style="color:#2ecc71">${r.wins}</td>
        <td style="color:#777">${r.games}</td>
        <td style="color:${r.winrate >= 50 ? '#2ecc71' : '#e74c3c'};font-weight:bold">${r.winrate}%</td>
      </tr>`
    ).join('');
  } catch (_) {}
}

// ── Menu ──────────────────────────────────────────────────────────────────────
document.getElementById('btn-pvp').addEventListener('click', () => {
  mode = 'lobby'; gameState = 'lobby';
  renderLobbySlots({ slots: [null, null, null, null] });
  showScreen('lobby'); connectSocket();
});
document.getElementById('btn-bots').addEventListener('click', () => {
  mode = 'bots'; showScreen('loading'); connectSocket();
});
document.getElementById('btn-rematch').addEventListener('click', () => {
  cleanupGame(); mode = 'bots'; showScreen('loading'); connectSocket();
});
document.getElementById('btn-menu').addEventListener('click', () => {
  cleanupGame(); showScreen('menu');
});
document.getElementById('btn-start-lobby').addEventListener('click', () => {
  socket?.emit('start_lobby');
});
document.getElementById('btn-leave-lobby').addEventListener('click', () => {
  socket?.emit('leave_lobby');
  if (socket) { socket.disconnect(); socket = null; }
  gameState = 'menu'; showScreen('menu');
});
document.getElementById('btn-leaderboard').addEventListener('click', () => {
  showScreen('leaderboard');
  loadLeaderboard();
});
document.getElementById('btn-lb-back').addEventListener('click', () => {
  showScreen('menu');
});

showScreen('menu');
fetch('/version').then(r => r.json()).then(d => {
  const el = document.getElementById('version-label');
  if (el) el.textContent = `v${d.version}`;
}).catch(() => {});
animate();
