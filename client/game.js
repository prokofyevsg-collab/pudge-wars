import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const SERVER_URL   = window.location.origin;
const MAP_W = 800, MAP_H = 600;
const S = 0.01;
const TEAM_COLORS  = [0xe74c3c, 0x2980b9];
const TEAM_HEX     = ['#e74c3c', '#2980b9'];
const TEAM_NAMES   = ['Красные', 'Синие'];
const CHAR_LETTERS = 'abcdefghijklmnopqr'.split('');
const VIEW_SIZE    = 7;
const HOOK_COOLDOWN_MS = 6000;

// ── Telegram ──────────────────────────────────────────────────────────────────
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const tgUser = tg?.initDataUnsafe?.user ?? null;

// ── Lock landscape ────────────────────────────────────────────────────────────
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
scene.background = new THREE.Color(0x110008);
scene.fog = new THREE.FogExp2(0x110008, 0.07);

// ── Camera ────────────────────────────────────────────────────────────────────
let aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.OrthographicCamera(
  -VIEW_SIZE * aspect, VIEW_SIZE * aspect, VIEW_SIZE, -VIEW_SIZE, 0.1, 100
);
const MCX = MAP_W * S / 2, MCZ = MAP_H * S / 2;
camera.position.set(MCX + 7, 11, MCZ + 9);
camera.lookAt(MCX, 0, MCZ);

// ── Lighting ──────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffe4cc, 0.6));

const sun = new THREE.DirectionalLight(0xfff5e0, 1.1);
sun.position.set(8, 16, 8);
sun.castShadow = true;
Object.assign(sun.shadow.mapSize, { width: 1024, height: 1024 });
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 50 });
scene.add(sun);

const torch = (x, z) => {
  const l = new THREE.PointLight(0xff7700, 2.0, 7);
  l.position.set(x, 1.2, z);
  scene.add(l);
  return l;
};
const torches = [
  torch(0.5, 0.5), torch(MAP_W * S - 0.5, MAP_H * S - 0.5),
  torch(0.5, MAP_H * S - 0.5), torch(MAP_W * S - 0.5, 0.5),
];

// ── GLB loader ────────────────────────────────────────────────────────────────
const gltfLoader = new GLTFLoader();
const modelCache = new Map();

function loadChar(letter) {
  if (modelCache.has(letter)) return Promise.resolve(modelCache.get(letter));
  return new Promise(resolve => {
    const url = `assets/chars/Models/GLB%20format/character-${letter}.glb`;
    gltfLoader.load(url, gltf => {
      const model = gltf.scene;
      model.traverse(c => { if (c.isMesh) c.castShadow = true; });
      modelCache.set(letter, model);
      resolve(model);
    }, undefined, () => resolve(null));
  });
}
['a', 'b', 'c', 'd'].forEach(loadChar);

// ── Map ───────────────────────────────────────────────────────────────────────
let mapGroup = null;

function buildMap(obstacles) {
  if (mapGroup) scene.remove(mapGroup);
  mapGroup = new THREE.Group();
  const mw = MAP_W * S, mh = MAP_H * S;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(mw, mh, 20, 15),
    new THREE.MeshLambertMaterial({ color: 0x7a4520 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(mw / 2, 0, mh / 2);
  floor.receiveShadow = true;
  mapGroup.add(floor);

  const tileSize = 0.5;
  const tileGrid = new THREE.Mesh(
    new THREE.PlaneGeometry(mw, mh, mw / tileSize, mh / tileSize),
    new THREE.MeshBasicMaterial({ color: 0x5a3010, wireframe: true, transparent: true, opacity: 0.13 })
  );
  tileGrid.rotation.x = -Math.PI / 2;
  tileGrid.position.set(mw / 2, 0.003, mh / 2);
  mapGroup.add(tileGrid);

  const wallMat  = new THREE.MeshLambertMaterial({ color: 0x5a4878 });
  const wallCapM = new THREE.MeshLambertMaterial({ color: 0x8a7aaa });
  const WH = 1.1, WT = 0.35;
  [[mw / 2, WH / 2, -WT / 2, mw + WT * 2, WH, WT],
   [mw / 2, WH / 2, mh + WT / 2, mw + WT * 2, WH, WT],
   [-WT / 2, WH / 2, mh / 2, WT, WH, mh],
   [mw + WT / 2, WH / 2, mh / 2, WT, WH, mh]].forEach(([x, y, z, w, h, d]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    mapGroup.add(m);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), wallCapM);
    cap.position.set(x, h + 0.03, z);
    mapGroup.add(cap);
  });

  const obsMat  = new THREE.MeshLambertMaterial({ color: 0x625278 });
  const obsCapM = new THREE.MeshLambertMaterial({ color: 0x9a88bc });
  obstacles.forEach(o => {
    const ox = o.x * S, oz = o.y * S, ow = o.w * S, oh = o.h * S, BH = 0.85;
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(ow + 0.15, oh + 0.15),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(ox, 0.002, oz);
    mapGroup.add(shadow);
    const block = new THREE.Mesh(new THREE.BoxGeometry(ow, BH, oh), obsMat);
    block.position.set(ox, BH / 2, oz); block.castShadow = true; block.receiveShadow = true;
    mapGroup.add(block);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(ow, 0.07, oh), obsCapM);
    cap.position.set(ox, BH + 0.035, oz);
    mapGroup.add(cap);
  });

  scene.add(mapGroup);
}

// ── Character meshes ──────────────────────────────────────────────────────────
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
  const slot   = playerSlots.get(id);
  const letter = CHAR_LETTERS[slot % CHAR_LETTERS.length];
  const color  = TEAM_COLORS[team];

  const group = new THREE.Group();

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.40, 24),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.005;
  group.add(ring);

  const baseModel = await loadChar(letter);
  if (baseModel) {
    const model = baseModel.clone();
    model.scale.setScalar(0.55);
    model.rotation.y = Math.PI * 1.25;
    model.traverse(c => {
      if (!c.isMesh) return;
      c.castShadow = true;
      c.receiveShadow = true;
      c.material = c.material.clone();
      // alphaTest cuts transparent UV-map pixels without making the mesh transparent
      c.material.alphaTest = 0.1;
      c.material.transparent = false;
      c.material.depthWrite = true;
      c.material.emissive    = new THREE.Color(color);
      c.material.emissiveIntensity = 0.12;
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
// J-shaped hook head built from a smooth CatmullRom curve in the XZ plane
function makeHookHead() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xccccdd, metalness: 0.95, roughness: 0.07 });

  // Curve defined in XZ plane (Y=0), shank along -Z, bend opens toward -X
  const pts = [
    new THREE.Vector3(0,    0, -0.18), // eye end (trailing)
    new THREE.Vector3(0,    0, -0.10),
    new THREE.Vector3(0,    0,  0.00), // start of bend
    new THREE.Vector3(-0.03, 0, 0.04),
    new THREE.Vector3(-0.07, 0, 0.04),
    new THREE.Vector3(-0.10, 0, 0.00),
    new THREE.Vector3(-0.10, 0, -0.05),
    new THREE.Vector3(-0.07, 0, -0.08), // barb / tip
    new THREE.Vector3(-0.04, 0, -0.07),
  ];
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo   = new THREE.TubeGeometry(curve, 24, 0.014, 8, false);
  const hook  = new THREE.Mesh(geo, mat);

  // Small ring/eye at the shank end
  const eye = new THREE.Mesh(
    new THREE.TorusGeometry(0.022, 0.008, 6, 12),
    mat
  );
  eye.rotation.x = Math.PI / 2; // ring lies in XZ plane
  eye.position.set(0, 0, -0.22);

  const g = new THREE.Group();
  g.add(hook);
  g.add(eye);
  return g;
}

// Rope: single cylinder scaled along its length each frame
function makeRope() {
  const geo = new THREE.CylinderGeometry(0.022, 0.022, 1, 6);
  return new THREE.Mesh(
    geo,
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
  const len = dir.length();
  head.position.copy(to);
  if (len > 0.01) {
    // Rotate around Y so local +Z faces direction of travel
    head.rotation.y = Math.atan2(dir.x, dir.z);
  }
}

// hookLines: ownerId → { rope, head }
const hookLines = new Map();

function upsertHook(hook, owner) {
  if (!hookLines.has(hook.ownerId)) {
    const rope = makeRope();
    const head = makeHookHead();
    scene.add(rope);
    scene.add(head);
    hookLines.set(hook.ownerId, { rope, head });
  }
  const { rope, head } = hookLines.get(hook.ownerId);
  const from = sw(owner.x, owner.y, 0.55);
  const to   = sw(hook.x, hook.y, 0.55);
  positionRope(rope, from, to);
  orientHookHead(head, from, to);
}

function removeHookLine(ownerId) {
  const h = hookLines.get(ownerId);
  if (!h) return;
  scene.remove(h.rope); scene.remove(h.head);
  h.rope.geometry.dispose();
  hookLines.delete(ownerId);
}

// ── Aim indicator (dashed line while right joystick held) ─────────────────────
let aimLineMesh = null;

function ensureAimLine() {
  if (aimLineMesh) return;
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.LineDashedMaterial({
    color: 0xffffff, transparent: true, opacity: 0.45,
    dashSize: 0.18, gapSize: 0.1,
  });
  aimLineMesh = new THREE.Line(geo, mat);
  aimLineMesh.visible = false;
  scene.add(aimLineMesh);
}
ensureAimLine();

function showAimLine(fromW, toW) {
  aimLineMesh.visible = true;
  aimLineMesh.geometry.setFromPoints([fromW, toW]);
  aimLineMesh.geometry.attributes.position.needsUpdate = true;
  aimLineMesh.computeLineDistances();
}
function hideAimLine() { if (aimLineMesh) aimLineMesh.visible = false; }

// ── Coord helpers ─────────────────────────────────────────────────────────────
function sw(sx, sy, worldY = 0) {
  return new THREE.Vector3(sx * S, worldY, sy * S);
}

const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster  = new THREE.Raycaster();

function screenToServerCoords(sx, sy) {
  const ndc = new THREE.Vector2(
    (sx / window.innerWidth)  *  2 - 1,
    (sy / window.innerHeight) * -2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const pt = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(floorPlane, pt)) return null;
  return { x: pt.x / S, y: pt.z / S };
}

// Project joystick screen-space direction to server coords from player origin
function aimDirToServer(jx, jy) {
  const me = sPlayers.find(p => p.id === myId);
  if (!me) return null;
  const ndc = sw(me.x, me.y, 0).project(camera);
  const px = (ndc.x + 1) * 0.5 * window.innerWidth;
  const py = (-ndc.y + 1) * 0.5 * window.innerHeight;
  return screenToServerCoords(px + jx * 380, py + jy * 380);
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
  document.getElementById('hud').style.display       = playing ? 'block' : 'none';
  document.getElementById('joy-canvas').style.display = playing ? 'block' : 'none';
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
    const sub   = document.getElementById('gameover-sub');
    title.textContent = draw ? 'НИЧЬЯ' : won ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ';
    title.style.color = draw ? '#f39c12' : won ? '#f1c40f' : '#e74c3c';
    sub.textContent   = draw ? '' : `${TEAM_NAMES[d.winner]} побеждают`;
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
  hideAimLine();
}

// ── Dual joystick input ───────────────────────────────────────────────────────
const JR = 58; // joystick radius px

// Move joystick (left, fixed base)
const moveJoy = { active: false, pid: -1, bx: 0, by: 0, nx: 0, ny: 0 };
// Aim joystick (right, fixed base) — fires hook on release
const aimJoy  = { active: false, pid: -1, bx: 0, by: 0, nx: 0, ny: 0 };

let moveBase = { x: 110, y: 0 };
let aimBase  = { x: 0,   y: 0 };

function updateJoyBases() {
  const w = window.innerWidth, h = window.innerHeight;
  moveBase = { x: 110,     y: h - 110 };
  aimBase  = { x: w - 110, y: h - 110 };
}
updateJoyBases();

function onTouchStart(e) {
  if (gameState !== 'playing') return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    const cx = t.clientX, cy = t.clientY;
    const mid = window.innerWidth / 2;
    if (!moveJoy.active && cx < mid) {
      Object.assign(moveJoy, { active: true, pid: t.identifier, bx: moveBase.x, by: moveBase.y, nx: 0, ny: 0 });
    } else if (!aimJoy.active && cx >= mid) {
      Object.assign(aimJoy,  { active: true, pid: t.identifier, bx: aimBase.x,  by: aimBase.y,  nx: 0, ny: 0 });
    }
  }
}

function onTouchMove(e) {
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
      // Show 3D aim line
      if (Math.abs(aimJoy.nx) > 0.05 || Math.abs(aimJoy.ny) > 0.05) {
        const me = sPlayers.find(p => p.id === myId);
        if (me) {
          const target = aimDirToServer(aimJoy.nx, aimJoy.ny);
          if (target) showAimLine(sw(me.x, me.y, 0.6), sw(target.x, target.y, 0.6));
        }
      }
    }
  }
}

function onTouchEnd(e) {
  if (gameState !== 'playing') return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (moveJoy.active && t.identifier === moveJoy.pid) {
      Object.assign(moveJoy, { active: false, pid: -1, nx: 0, ny: 0 });
      socket?.emit('input', { dx: 0, dy: 0 });
    }
    if (aimJoy.active && t.identifier === aimJoy.pid) {
      // Fire hook toward aimed direction on release
      if (Math.abs(aimJoy.nx) > 0.05 || Math.abs(aimJoy.ny) > 0.05) {
        const target = aimDirToServer(aimJoy.nx, aimJoy.ny);
        if (target) socket?.emit('input', { hookX: target.x, hookY: target.y });
      }
      Object.assign(aimJoy, { active: false, pid: -1, nx: 0, ny: 0 });
      hideAimLine();
    }
  }
}

canvas.addEventListener('touchstart', onTouchStart, { passive: false });
canvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
canvas.addEventListener('touchend',   onTouchEnd,   { passive: false });
canvas.addEventListener('touchcancel',onTouchEnd,   { passive: false });

// Desktop: WASD + right-click to aim/fire
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

// ── Joystick canvas ───────────────────────────────────────────────────────────
const joyCanvas = document.getElementById('joy-canvas');
const joyCtx    = joyCanvas.getContext('2d');

function resizeJoyCanvas() {
  joyCanvas.width  = window.innerWidth;
  joyCanvas.height = window.innerHeight;
}
resizeJoyCanvas();

function drawJoystick(ctx, base, joy, isAim) {
  const tx = base.x + joy.nx * JR, ty = base.y + joy.ny * JR;

  // Base ring
  ctx.beginPath();
  ctx.arc(base.x, base.y, JR, 0, Math.PI * 2);
  ctx.strokeStyle = joy.active ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)';
  ctx.lineWidth   = 2.5;
  ctx.stroke();
  ctx.fillStyle   = joy.active ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)';
  ctx.fill();

  // Hook cooldown arc on aim joystick base
  if (isAim) {
    const ready = myHookCooldown <= 0;
    const frac  = ready ? 1 : 1 - myHookCooldown / HOOK_COOLDOWN_MS;
    ctx.beginPath();
    ctx.arc(base.x, base.y, JR - 4, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = ready ? 'rgba(46,204,113,0.8)' : 'rgba(231,76,60,0.7)';
    ctx.lineWidth   = 4;
    ctx.stroke();
    // Center icon/text
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    if (ready && !joy.active) {
      ctx.font      = '18px Arial';
      ctx.fillStyle = 'rgba(46,204,113,0.6)';
      ctx.fillText('⚓', base.x, base.y);
    } else if (!ready && !joy.active) {
      ctx.font      = 'bold 12px Arial';
      ctx.fillStyle = 'rgba(231,76,60,0.8)';
      ctx.fillText((myHookCooldown / 1000).toFixed(1), base.x, base.y);
    }
  }

  // Thumb
  if (joy.active) {
    ctx.beginPath();
    ctx.arc(tx, ty, 22, 0, Math.PI * 2);
    ctx.fillStyle = isAim ? 'rgba(231,76,60,0.7)' : 'rgba(255,255,255,0.4)';
    ctx.fill();
  }
}

function drawJoysticks() {
  joyCtx.clearRect(0, 0, joyCanvas.width, joyCanvas.height);
  if (gameState !== 'playing') return;
  drawJoystick(joyCtx, moveBase, moveJoy, false);
  drawJoystick(joyCtx, aimBase,  aimJoy,  true);
}

// ── Render loop ───────────────────────────────────────────────────────────────
async function updatePlayers() {
  const activeIds = new Set(sPlayers.map(p => p.id));
  for (const id of charEntries.keys()) {
    if (!activeIds.has(id)) removeChar(id);
  }
  for (const p of sPlayers) {
    const entry = await getOrCreateChar(p.id, p.team);
    entry.group.position.lerp(sw(p.x, p.y, 0), 0.25);

    const alive = p.alive;
    entry.ring.material.opacity = alive ? 0.85 : 0.2;

    entry.group.traverse(c => {
      if (!c.isMesh || !c.material) return;
      if (!alive) {
        c.material.transparent = true;
        c.material.opacity = 0.3;
        c.material.depthWrite = false;
      } else {
        c.material.transparent = false;
        c.material.opacity = 1;
        c.material.depthWrite = true;
        c.material.emissiveIntensity = (p.hitFlash > 0) ? 0.9 : (p.id === myId ? 0.22 : 0.12);
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
  torches.forEach((l, i) => { l.intensity = 2.0 + Math.sin(t * (3.1 + i * 0.7)) * 0.5; });
}

function updateHUD() {
  const me = sPlayers.find(p => p.id === myId);
  if (me) {
    document.getElementById('hud-hp').textContent =
      '❤'.repeat(me.hp) + '🖤'.repeat(2 - me.hp);
  }
}

function animate() {
  requestAnimationFrame(animate);
  if (gameState === 'playing') {
    updatePlayers();
    updateHooks();
    animateTorches();
    updateHUD();
    drawJoysticks();
  }
  renderer.render(scene, camera);
}

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  aspect = w / h;
  renderer.setSize(w, h);
  camera.left   = -VIEW_SIZE * aspect;
  camera.right  =  VIEW_SIZE * aspect;
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
