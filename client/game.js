import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ── Constants (keep in sync with server) ────────────────────────────────────
const SERVER_URL   = window.location.origin;
let   MAP_W = 1600, MAP_H = 900;   // updated from game_start
const S = 0.01;                     // server → world scale  (1600→16, 900→9)
const TEAM_COLORS  = [0xe74c3c, 0x2980b9];
const TEAM_HEX     = ['#e74c3c', '#2980b9'];
const TEAM_NAMES   = ['Красные', 'Синие'];
const CHAR_LETTERS = 'abcdefghijklmnopqr'.split('');
const HOOK_COOLDOWN_MS = 6000;

// VIEW_SIZE is computed dynamically in positionCamera() based on actual map size
let VIEW_SIZE = 6;

// ── Telegram ──────────────────────────────────────────────────────────────────
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const tgUser = tg?.initDataUnsafe?.user ?? null;

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
scene.background = new THREE.Color(0x3a7020);
// No fog — isometric view shows the whole scene from far away; fog kills visibility

// ── Camera ────────────────────────────────────────────────────────────────────
let aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.OrthographicCamera(
  -VIEW_SIZE * aspect, VIEW_SIZE * aspect, VIEW_SIZE, -VIEW_SIZE, 0.1, 200
);

function positionCamera() {
  const mcx = MAP_W * S / 2, mcz = MAP_H * S / 2;
  // Proportional offset — preserves the same ~45° isometric angle at any map size
  const offX = mcx * 1.75;
  const offY = mcx * 2.75;
  const offZ = mcx * 2.25;
  camera.position.set(mcx + offX, offY, mcz + offZ);
  camera.lookAt(mcx, 0, mcz);
  // Auto-fit VIEW_SIZE: formula derived from projecting map corner (0,0) onto
  // the camera's up-axis with the proportional offset above (+0.3 safety margin)
  VIEW_SIZE = mcx * 0.427 + mcz * 0.548 + 0.3;
  camera.top    =  VIEW_SIZE;
  camera.bottom = -VIEW_SIZE;
  camera.left   = -VIEW_SIZE * aspect;
  camera.right  =  VIEW_SIZE * aspect;
  camera.updateProjectionMatrix();
}
positionCamera();

// ── Lighting ──────────────────────────────────────────────────────────────────
// Strong ambient so no face is ever fully dark
scene.add(new THREE.AmbientLight(0xeef4ff, 1.4));

// Sky / ground hemisphere
const hemi = new THREE.HemisphereLight(0x99ccff, 0x3d8028, 1.0);
scene.add(hemi);

// Key directional (casts shadows)
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(10, 20, 10);
sun.castShadow = true;
Object.assign(sun.shadow.mapSize, { width: 2048, height: 2048 });
Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 90 });
scene.add(sun);

// Front fill (warm, opposite side)
const fill = new THREE.DirectionalLight(0xffd0a0, 0.9);
fill.position.set(-5, 12, -5);
scene.add(fill);

// Overhead fill — ensures tops of characters are well-lit
const over = new THREE.DirectionalLight(0xffeedd, 0.7);
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

// ── GLB loader ────────────────────────────────────────────────────────────────
const gltfLoader = new GLTFLoader();
const modelCache = new Map();

function loadChar(letter) {
  if (modelCache.has(letter)) return Promise.resolve(modelCache.get(letter));
  return new Promise(resolve => {
    gltfLoader.load(
      `assets/chars/Models/GLB%20format/character-${letter}.glb`,
      gltf => {
        const m = gltf.scene;
        m.traverse(c => { if (c.isMesh) c.castShadow = true; });
        modelCache.set(letter, m);
        resolve(m);
      },
      undefined,
      () => resolve(null)
    );
  });
}
['a', 'b', 'c', 'd'].forEach(loadChar);

// ── Map ───────────────────────────────────────────────────────────────────────
let mapGroup = null;

function buildMap(obstacles) {
  if (mapGroup) scene.remove(mapGroup);
  mapGroup = new THREE.Group();
  const mw = MAP_W * S, mh = MAP_H * S;

  const mGrass  = new THREE.MeshLambertMaterial({ color: 0x4a8530 });
  const mGrass2 = new THREE.MeshLambertMaterial({ color: 0x3d7025 });
  const mDirt   = new THREE.MeshLambertMaterial({ color: 0x8a5c28 });
  const mPath   = new THREE.MeshLambertMaterial({ color: 0xa07040 });
  const mWater  = new THREE.MeshLambertMaterial({ color: 0x2277aa });
  const mStone  = new THREE.MeshLambertMaterial({ color: 0x6d6458 });
  const mRock   = new THREE.MeshLambertMaterial({ color: 0x857a6a });
  const mTrunk  = new THREE.MeshLambertMaterial({ color: 0x5a3510 });
  const mLeaf   = new THREE.MeshLambertMaterial({ color: 0x296618 });
  const mLeaf2  = new THREE.MeshLambertMaterial({ color: 0x1e5012 });

  function flat(x, z, w, d, mat, y, ro = 0) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2; m.position.set(x, y, z);
    m.receiveShadow = true; m.renderOrder = ro;
    mapGroup.add(m);
  }

  function addTree(tx, tz, scale = 1.0) {
    const h = (0.6 + Math.abs(Math.sin(tx * 3.7 + tz * 5.1)) * 0.5) * scale;
    const r = (0.32 + Math.abs(Math.sin(tx * 7.1 + tz * 2.3)) * 0.18) * scale;
    const leafMat = Math.sin(tx + tz) > 0 ? mLeaf : mLeaf2;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.055 * scale, 0.09 * scale, h, 6), mTrunk);
    trunk.position.set(tx, h / 2, tz); trunk.castShadow = true; mapGroup.add(trunk);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 5), leafMat);
    crown.scale.y = 1.3; crown.position.set(tx, h + r * 0.6, tz);
    crown.castShadow = true; mapGroup.add(crown);
  }

  // ── Бесконечный газон: огромная плоскость покрывает весь экран за краями карты
  flat(mw / 2, mh / 2, 200, 200, mGrass2, 0, 0);
  // Светлый газон внутри карты
  flat(mw / 2, mh / 2, mw, mh, mGrass, 0.001, 1);

  // ── Центральный коридор боя (грязь, 54% высоты карты)
  const laneH = mh * 0.54, laneZ = mh / 2;
  flat(mw / 2, laneZ, mw, laneH, mDirt, 0.003, 2);
  // Светлые полосы по краям коридора
  flat(mw / 2, laneZ - laneH / 2 + 0.25, mw, 0.50, mPath, 0.004, 3);
  flat(mw / 2, laneZ + laneH / 2 - 0.25, mw, 0.50, mPath, 0.004, 3);

  // ── Река через центр коридора
  const rH = laneH * 0.30;
  flat(mw / 2, laneZ, mw, rH, mWater, 0.006, 4);
  flat(mw / 2, laneZ - rH / 2 - 0.18, mw, 0.36, mStone, 0.005, 3);
  flat(mw / 2, laneZ + rH / 2 + 0.18, mw, 0.36, mStone, 0.005, 3);

  // ── Центральный фонтан
  const fMat = new THREE.MeshLambertMaterial({ color: 0x786e60 });
  const fBase = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.75, 0.22, 16), fMat);
  fBase.position.set(mw / 2, 0.11, laneZ); fBase.castShadow = true; mapGroup.add(fBase);
  const fPillar = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.78, 12), fMat);
  fPillar.position.set(mw / 2, 0.60, laneZ); fPillar.castShadow = true; mapGroup.add(fPillar);
  const fBowl = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.12, 8, 24), fMat);
  fBowl.rotation.x = Math.PI / 2; fBowl.position.set(mw / 2, 1.00, laneZ); mapGroup.add(fBowl);
  const fWater = new THREE.Mesh(new THREE.CircleGeometry(0.40, 20),
    new THREE.MeshBasicMaterial({ color: 0x55bbff, transparent: true, opacity: 0.78 }));
  fWater.rotation.x = -Math.PI / 2; fWater.position.set(mw / 2, 1.02, laneZ);
  fWater.renderOrder = 5; mapGroup.add(fWater);

  // ── Деревья: несколько рядов, создают эффект "лес → поляна → коридор"
  const zLo = laneZ - laneH / 2;
  const zHi = laneZ + laneH / 2;

  // За пределами карты — густой лес (крупные деревья)
  for (let i = 0; i < 22; i++) {
    const tx = -3 + (i / 21) * (mw + 6);
    addTree(tx, -1.2, 1.3);
    addTree(tx, mh + 1.2, 1.3);
  }
  // По краям карты — деревья средние
  for (let i = 0; i < 16; i++) {
    const tx = -0.5 + (i / 15) * (mw + 1.0);
    addTree(tx, -0.3, 1.1);
    addTree(tx, mh + 0.3, 1.1);
  }
  // Внутри карты в траве — мелкие деревья
  for (let i = 0; i < 12; i++) {
    const tx = 0.4 + (i / 11) * (mw - 0.8);
    if (i % 2 === 0) addTree(tx, zLo - 0.6, 0.9);
    if (i % 2 === 1) addTree(tx, zHi + 0.6, 0.9);
    // Ещё ряды глубже в траву
    if (i % 3 === 0) addTree(tx, zLo - 1.3, 1.0);
    if (i % 3 === 1) addTree(tx, zHi + 1.3, 1.0);
  }
  // Деревья по левому и правому краям (вертикальные стены леса)
  for (let i = 0; i < 8; i++) {
    const tz = zLo + 0.2 + (i / 7) * laneH * 0.6;
    addTree(-0.5, tz, 1.0);
    addTree(mw + 0.5, tz, 1.0);
  }

  // ── Каменные препятствия (из сервера) — рендерим как природные валуны
  obstacles.forEach(o => {
    const ox = o.x * S, oz = o.y * S, ow = o.w * S, od = o.h * S;
    const rh = 0.5 + Math.abs(Math.sin(ox * 5.3 + oz * 7.1)) * 0.35;
    const radius = Math.max(ow, od) * 0.48;
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 1), mRock);
    rock.scale.set(ow / (radius * 2), rh / (radius * 2), od / (radius * 2));
    rock.rotation.y = Math.abs(Math.sin(ox * 3.7 + oz * 11.3)) * Math.PI * 2;
    rock.position.set(ox, rh * 0.45, oz);
    rock.castShadow = true; rock.receiveShadow = true; mapGroup.add(rock);
    const shdw = new THREE.Mesh(
      new THREE.CircleGeometry(Math.max(ow, od) * 0.55, 10),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 })
    );
    shdw.rotation.x = -Math.PI / 2; shdw.position.set(ox, 0.002, oz);
    shdw.renderOrder = 2; mapGroup.add(shdw);
  });

  scene.add(mapGroup);

  // ── Освещение: фонтан синий + оранжевые факелы у коридора
  torches.length = 0;
  const fl = new THREE.PointLight(0x44aaff, 3.5, 7);
  fl.position.set(mw / 2, 2.0, laneZ); scene.add(fl); torches.push(fl);
  addTorch(mw * 0.22, zLo - 0.2); addTorch(mw * 0.78, zLo - 0.2);
  addTorch(mw * 0.22, zHi + 0.2); addTorch(mw * 0.78, zHi + 0.2);
  addTorch(mw * 0.50, zLo - 0.2); addTorch(mw * 0.50, zHi + 0.2);
}

// ── Characters ────────────────────────────────────────────────────────────────
const charEntries = new Map();
const playerSlots = new Map();

function makeFallbackBody(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.22, 0.45, 4, 8),
    new THREE.MeshLambertMaterial({ color })
  );
  body.position.y = 0.5; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 8, 8),
    new THREE.MeshLambertMaterial({ color })
  );
  head.position.y = 1.0; head.castShadow = true; g.add(head);
  return g;
}

async function getOrCreateChar(id, team) {
  if (charEntries.has(id)) return charEntries.get(id);

  if (!playerSlots.has(id)) playerSlots.set(id, playerSlots.size);
  const letter = CHAR_LETTERS[playerSlots.get(id) % CHAR_LETTERS.length];
  const color  = TEAM_COLORS[team];
  const group  = new THREE.Group();

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.40, 24),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.005;
  group.add(ring);

  const base = await loadChar(letter);
  if (base) {
    const model = base.clone();
    model.scale.setScalar(0.55);
    model.rotation.y = Math.PI * 1.25;
    model.traverse(c => {
      if (!c.isMesh) return;
      c.castShadow = true; c.receiveShadow = true;
      c.material = c.material.clone();
      c.material.alphaTest   = 0.1;
      c.material.transparent = false;
      c.material.depthWrite  = true;
      c.material.emissive    = new THREE.Color(color);
      c.material.emissiveIntensity = 0.35;
    });
    group.add(model);
  } else {
    group.add(makeFallbackBody(color));
  }

  scene.add(group);
  const entry = { group, ring, team };
  charEntries.set(id, entry);
  return entry;
}

function removeChar(id) {
  const e = charEntries.get(id);
  if (e) { scene.remove(e.group); charEntries.delete(id); }
}

// ── Hook geometry ─────────────────────────────────────────────────────────────
function makeHookHead() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xccccdd, metalness: 0.95, roughness: 0.07 });
  // J-shape curve in XZ plane: shank along -Z, bend opens toward -X
  const pts = [
    new THREE.Vector3(0,     0, -0.18),
    new THREE.Vector3(0,     0, -0.08),
    new THREE.Vector3(0,     0,  0.00),
    new THREE.Vector3(-0.03, 0,  0.05),
    new THREE.Vector3(-0.07, 0,  0.05),
    new THREE.Vector3(-0.10, 0,  0.01),
    new THREE.Vector3(-0.10, 0, -0.05),
    new THREE.Vector3(-0.07, 0, -0.08),
    new THREE.Vector3(-0.03, 0, -0.06),
  ];
  const geo  = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.014, 8, false);
  const hook = new THREE.Mesh(geo, mat);
  const eye  = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.008, 6, 12), mat);
  eye.rotation.x = Math.PI / 2;
  eye.position.set(0, 0, -0.22);
  const g = new THREE.Group();
  g.add(hook); g.add(eye);
  return g;
}

function makeRope() {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 1, 6),
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
  const from = sw(owner.x, owner.y, 0.55);
  const to   = sw(hook.x,  hook.y,  0.55);
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
// Dashed line from player → target
let aimLine = null;
function ensureAimLine() {
  if (aimLine) return;
  const mat = new THREE.LineDashedMaterial({
    color: 0xff5533, transparent: true, opacity: 0.55,
    dashSize: 0.22, gapSize: 0.12,
  });
  aimLine = new THREE.Line(new THREE.BufferGeometry(), mat);
  aimLine.visible = false;
  scene.add(aimLine);
}
ensureAimLine();

// Crosshair ring at target position
let aimCrosshair = null;
let crosshairTick = 0;

function buildCrosshair() {
  const g = new THREE.Group();
  const mat = () => new THREE.MeshBasicMaterial({
    color: 0xff3311, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false,
  });
  // Outer ring
  g.add(Object.assign(
    new THREE.Mesh(new THREE.RingGeometry(0.26, 0.32, 32), mat()),
    { rotation: { x: -Math.PI / 2 }, position: { y: 0.04 } }
  ));
  // Inner dot
  g.add(Object.assign(
    new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), mat()),
    { rotation: { x: -Math.PI / 2 }, position: { y: 0.04 } }
  ));
  // 4 tick marks
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.14), mat());
    tick.rotation.x = -Math.PI / 2;
    tick.rotation.z = a;
    tick.position.set(Math.cos(a) * 0.46, 0.04, Math.sin(a) * 0.46);
    g.add(tick);
  }
  g.visible = false;
  scene.add(g);
  return g;
}

function showAimIndicators(fromW, toW) {
  // Dashed line
  aimLine.visible = true;
  aimLine.geometry.setFromPoints([fromW, toW]);
  aimLine.geometry.attributes.position.needsUpdate = true;
  aimLine.computeLineDistances();

  // Crosshair
  if (!aimCrosshair) aimCrosshair = buildCrosshair();
  aimCrosshair.visible = true;
  aimCrosshair.position.set(toW.x, 0.04, toW.z);
  crosshairTick += 0.06;
  const pulse = 1 + Math.sin(crosshairTick * 4) * 0.12;
  aimCrosshair.scale.setScalar(pulse);
  aimCrosshair.rotation.y = crosshairTick * 0.5;
}

function hideAimIndicators() {
  if (aimLine) aimLine.visible = false;
  if (aimCrosshair) aimCrosshair.visible = false;
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
}

// ── Socket ────────────────────────────────────────────────────────────────────
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io(SERVER_URL, { transports: ['websocket'] });

  socket.on('connect', () => {
    myId = socket.id;
    if (mode === 'bots') {
      document.getElementById('search-text').textContent = 'Подготовка ботов...';
      socket.emit('play_vs_bots', { user: tgUser });
    } else {
      socket.emit('join_queue', { user: tgUser });
    }
  });

  socket.on('queue_status', d => {
    document.getElementById('search-text').textContent = `Поиск игроков...\n${d.inQueue} / 4`;
  });

  socket.on('game_start', d => {
    myId = socket.id; gameState = 'playing';
    if (d.mapW) { MAP_W = d.mapW; MAP_H = d.mapH; }
    positionCamera();
    sPlayers = d.players; sHooks = [];
    const me = d.players.find(p => p.id === myId);
    if (me) {
      myTeam = me.team;
      const el = document.getElementById('hud-team');
      el.textContent = `Команда: ${TEAM_NAMES[me.team]}`;
      el.style.color = TEAM_HEX[me.team];
    }
    if (!mapBuilt) { buildMap(d.obstacles); mapBuilt = true; }
    showScreen('game');
  });

  socket.on('state', d => {
    if (gameState !== 'playing') return;
    sPlayers = d.players;
    const live = new Set(d.hooks.map(h => h.ownerId));
    for (const id of hookLines.keys()) if (!live.has(id)) removeHookLine(id);
    sHooks = d.hooks;
    const me = d.players.find(p => p.id === myId);
    if (me) myHookCooldown = me.hookCooldown ?? 0;
  });

  socket.on('player_left', d => {
    removeChar(d.id);
    sPlayers = sPlayers.filter(p => p.id !== d.id);
  });

  socket.on('game_over', d => {
    gameState = 'gameover';
    const won = d.winner === myTeam, draw = d.winner === -1;
    const title = document.getElementById('gameover-title');
    title.textContent = draw ? 'НИЧЬЯ' : won ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ';
    title.style.color = draw ? '#f39c12' : won ? '#f1c40f' : '#e74c3c';
    document.getElementById('gameover-sub').textContent = draw ? '' : `${TEAM_NAMES[d.winner]} побеждают`;
    showScreen('gameover');
    setTimeout(() => { cleanupGame(); showScreen('menu'); }, 4000);
  });

  socket.on('disconnect', () => {
    if (gameState === 'playing') { cleanupGame(); showScreen('menu'); }
  });
}

function cleanupGame() {
  gameState = 'menu';
  charEntries.forEach((_, id) => removeChar(id));
  playerSlots.clear();
  hookLines.forEach((_, id) => removeHookLine(id));
  if (mapGroup) { scene.remove(mapGroup); mapGroup = null; }
  mapBuilt = false; sPlayers = []; sHooks = [];
  hideAimIndicators();
  torches.forEach(l => scene.remove(l));
  torches.length = 0;
}

// ── Dual joystick ─────────────────────────────────────────────────────────────
const JR = 58;
const moveJoy = { active: false, pid: -1, nx: 0, ny: 0 };
const aimJoy  = { active: false, pid: -1, nx: 0, ny: 0 };
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
  if (gameState !== 'playing') return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (moveJoy.active && t.identifier === moveJoy.pid) {
      Object.assign(moveJoy, { active: false, pid: -1, nx: 0, ny: 0 });
      socket?.emit('input', { dx: 0, dy: 0 });
    }
    if (aimJoy.active && t.identifier === aimJoy.pid) {
      if (Math.abs(aimJoy.nx) > 0.05 || Math.abs(aimJoy.ny) > 0.05) {
        const target = aimDirToServer(aimJoy.nx, aimJoy.ny);
        if (target) socket?.emit('input', { hookX: target.x, hookY: target.y });
      }
      Object.assign(aimJoy, { active: false, pid: -1, nx: 0, ny: 0 });
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
      Object.assign(aimJoy, { active: false, pid: -1, nx: 0, ny: 0 });
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
  if (gc && me) showAimIndicators(sw(me.x, me.y, 0.6), sw(gc.x, gc.y, 0.6));
});

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

function drawJoysticks() {
  joyCtx.clearRect(0, 0, joyCanvas.width, joyCanvas.height);
  if (gameState !== 'playing') return;
  drawOneJoystick(moveBase, moveJoy, false);
  drawOneJoystick(aimBase,  aimJoy,  true);
}

// ── Render loop ───────────────────────────────────────────────────────────────
async function updatePlayers() {
  const activeIds = new Set(sPlayers.map(p => p.id));
  for (const id of charEntries.keys()) if (!activeIds.has(id)) removeChar(id);

  for (const p of sPlayers) {
    const entry = await getOrCreateChar(p.id, p.team);
    entry.group.position.lerp(sw(p.x, p.y, 0), 0.28);
    entry.ring.material.opacity = p.alive ? 0.85 : 0.2;
    entry.group.traverse(c => {
      if (!c.isMesh || !c.material) return;
      if (!p.alive) {
        c.material.transparent = true; c.material.opacity = 0.3; c.material.depthWrite = false;
      } else {
        c.material.transparent = false; c.material.opacity = 1; c.material.depthWrite = true;
        c.material.emissiveIntensity = p.hitFlash > 0 ? 1.0 : (p.id === myId ? 0.55 : 0.35);
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

function updateAimFromJoystick() {
  if (!aimJoy.active || (Math.abs(aimJoy.nx) < 0.05 && Math.abs(aimJoy.ny) < 0.05)) return;
  const me = sPlayers.find(p => p.id === myId);
  if (!me) return;
  const target = aimDirToServer(aimJoy.nx, aimJoy.ny);
  if (target) showAimIndicators(sw(me.x, me.y, 0.6), sw(target.x, target.y, 0.6));
}

function animate() {
  requestAnimationFrame(animate);
  if (gameState === 'playing') {
    updatePlayers();
    updateHooks();
    animateTorches();
    updateAimFromJoystick();
    drawJoysticks();

    const me = sPlayers.find(p => p.id === myId);
    if (me) {
      document.getElementById('hud-hp').textContent =
        '❤'.repeat(me.hp) + '🖤'.repeat(2 - me.hp);
    }
  }
  renderer.render(scene, camera);
}

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  aspect = w / h;
  renderer.setSize(w, h);
  // Recompute full camera frustum (VIEW_SIZE stays, only width changes with aspect)
  camera.left   = -VIEW_SIZE * aspect;
  camera.right  =  VIEW_SIZE * aspect;
  camera.top    =  VIEW_SIZE;
  camera.bottom = -VIEW_SIZE;
  camera.updateProjectionMatrix();
  resizeJoyCanvas();
  updateJoyBases();
});

// ── Menu ──────────────────────────────────────────────────────────────────────
document.getElementById('btn-pvp').addEventListener('click', () => {
  mode = 'pvp'; showScreen('search'); connectSocket();
});
document.getElementById('btn-bots').addEventListener('click', () => {
  mode = 'bots'; showScreen('search'); connectSocket();
});

showScreen('menu');
animate();
