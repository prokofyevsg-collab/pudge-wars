import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ── Constants ────────────────────────────────────────────────────────────────
const SERVER_URL   = window.location.origin;
const MAP_W = 800, MAP_H = 600;
const S = 0.01;          // server→world scale: 800→8, 600→6
const TEAM_COLORS  = [0xe74c3c, 0x2980b9];
const TEAM_HEX     = ['#e74c3c', '#2980b9'];
const TEAM_NAMES   = ['Красные', 'Синие'];
const CHAR_LETTERS = 'abcdefghijklmnopqr'.split('');
const VIEW_SIZE    = 7;  // orthographic half-height in world units

// ── Telegram ─────────────────────────────────────────────────────────────────
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const tgUser = tg?.initDataUnsafe?.user ?? null;

// ── Renderer ─────────────────────────────────────────────────────────────────
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

// ── Camera (isometric orthographic) ──────────────────────────────────────────
const aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.OrthographicCamera(
  -VIEW_SIZE * aspect, VIEW_SIZE * aspect, VIEW_SIZE, -VIEW_SIZE, 0.1, 100
);
// Diablo-style: above and behind map center
const MCX = MAP_W * S / 2, MCZ = MAP_H * S / 2;
camera.position.set(MCX + 7, 11, MCZ + 9);
camera.lookAt(MCX, 0, MCZ);

// ── Lighting ──────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffe4cc, 0.55));

const sun = new THREE.DirectionalLight(0xfff5e0, 1.1);
sun.position.set(8, 16, 8);
sun.castShadow = true;
Object.assign(sun.shadow.mapSize, { width: 1024, height: 1024 });
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 50 });
scene.add(sun);

// Atmospheric torches
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
const modelCache = new Map(); // letter → THREE.Group

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

// Preload first few models
['a', 'b', 'c', 'd'].forEach(loadChar);

// ── Map ───────────────────────────────────────────────────────────────────────
let mapGroup = null;

function buildMap(obstacles) {
  if (mapGroup) { scene.remove(mapGroup); }
  mapGroup = new THREE.Group();

  const mw = MAP_W * S, mh = MAP_H * S;

  // Floor — warm stone
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(mw, mh, 20, 15),
    new THREE.MeshLambertMaterial({ color: 0x7a4520 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(mw / 2, 0, mh / 2);
  floor.receiveShadow = true;
  mapGroup.add(floor);

  // Floor tile pattern (subtle grid)
  const tileSize = 0.5;
  const tileMat = new THREE.MeshBasicMaterial({ color: 0x5a3010, wireframe: true, transparent: true, opacity: 0.15 });
  const tileGrid = new THREE.Mesh(new THREE.PlaneGeometry(mw, mh, mw / tileSize, mh / tileSize), tileMat);
  tileGrid.rotation.x = -Math.PI / 2;
  tileGrid.position.set(mw / 2, 0.003, mh / 2);
  mapGroup.add(tileGrid);

  // Perimeter walls
  const wallMat  = new THREE.MeshLambertMaterial({ color: 0x5a4878 });
  const wallCapM = new THREE.MeshLambertMaterial({ color: 0x8a7aaa });
  const WH = 1.1, WT = 0.35;

  const wallDefs = [
    [mw / 2, WH / 2, -WT / 2,       mw + WT * 2, WH, WT],
    [mw / 2, WH / 2, mh + WT / 2,   mw + WT * 2, WH, WT],
    [-WT / 2, WH / 2, mh / 2,        WT, WH, mh],
    [mw + WT / 2, WH / 2, mh / 2,    WT, WH, mh],
  ];
  wallDefs.forEach(([x, y, z, w, h, d]) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mapGroup.add(mesh);
    // Cap
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), wallCapM);
    cap.position.set(x, h + 0.03, z);
    mapGroup.add(cap);
  });

  // Obstacles — dungeon pillars/blocks
  const obsMat  = new THREE.MeshLambertMaterial({ color: 0x625278 });
  const obsCapM = new THREE.MeshLambertMaterial({ color: 0x9a88bc });
  obstacles.forEach(o => {
    const ox = o.x * S, oz = o.y * S;
    const ow = o.w * S, oh = o.h * S;
    const BH = 0.85;
    // Shadow decal
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(ow + 0.15, oh + 0.15),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(ox, 0.002, oz);
    mapGroup.add(shadow);
    // Block
    const block = new THREE.Mesh(new THREE.BoxGeometry(ow, BH, oh), obsMat);
    block.position.set(ox, BH / 2, oz);
    block.castShadow = true;
    block.receiveShadow = true;
    mapGroup.add(block);
    // Top cap
    const cap = new THREE.Mesh(new THREE.BoxGeometry(ow, 0.07, oh), obsCapM);
    cap.position.set(ox, BH + 0.035, oz);
    mapGroup.add(cap);
  });

  scene.add(mapGroup);
}

// ── Character meshes ──────────────────────────────────────────────────────────
const charEntries  = new Map(); // id → { group, ring }
const playerSlots  = new Map(); // id → slotIndex

function makeFallbackBody(teamColor) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.22, 0.45, 4, 8),
    new THREE.MeshLambertMaterial({ color: teamColor })
  );
  body.position.y = 0.5;
  body.castShadow = true;
  g.add(body);
  // Head
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 8, 8),
    new THREE.MeshLambertMaterial({ color: teamColor })
  );
  head.position.y = 1.0;
  head.castShadow = true;
  g.add(head);
  return g;
}

async function getOrCreateChar(id, team, name) {
  if (charEntries.has(id)) return charEntries.get(id);

  if (!playerSlots.has(id)) playerSlots.set(id, playerSlots.size);
  const slot   = playerSlots.get(id);
  const letter = CHAR_LETTERS[slot % CHAR_LETTERS.length];
  const color  = TEAM_COLORS[team];

  const group = new THREE.Group();

  // Team color ground ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.40, 24),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.005;
  group.add(ring);

  // Load GLB character
  const baseModel = await loadChar(letter);
  if (baseModel) {
    const model = baseModel.clone();
    // Scale to fit ~1 unit tall, rotate to face camera direction
    model.scale.setScalar(0.55);
    model.rotation.y = Math.PI * 1.25; // face toward camera angle
    model.traverse(c => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
        c.material = c.material.clone();
        c.material.emissive = new THREE.Color(color);
        c.material.emissiveIntensity = 0.12;
      }
    });
    group.add(model);
  } else {
    const fb = makeFallbackBody(color);
    group.add(fb);
  }

  scene.add(group);
  const entry = { group, ring, team, alive: true };
  charEntries.set(id, entry);
  return entry;
}

function removeChar(id) {
  const e = charEntries.get(id);
  if (e) { scene.remove(e.group); charEntries.delete(id); }
}

// ── Hook lines ────────────────────────────────────────────────────────────────
const hookLines = new Map(); // ownerId → { line, tip }

function upsertHook(hook, ownerPlayer) {
  const color = TEAM_COLORS[ownerPlayer.team];
  if (!hookLines.has(hook.ownerId)) {
    const pts = [new THREE.Vector3(), new THREE.Vector3()];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, linewidth: 2 }));
    const tip  = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 8),
      new THREE.MeshLambertMaterial({ color: 0xdddddd, emissive: 0xffffff, emissiveIntensity: 0.3 })
    );
    scene.add(line); scene.add(tip);
    hookLines.set(hook.ownerId, { line, tip });
  }
  const { line, tip } = hookLines.get(hook.ownerId);
  const op = sw(ownerPlayer.x, ownerPlayer.y, 0.55);
  const hp = sw(hook.x, hook.y, 0.55);
  line.geometry.setFromPoints([op, hp]);
  line.geometry.attributes.position.needsUpdate = true;
  tip.position.copy(hp);
}

function removeHookLine(ownerId) {
  const h = hookLines.get(ownerId);
  if (!h) return;
  scene.remove(h.line); scene.remove(h.tip);
  h.line.geometry.dispose();
  hookLines.delete(ownerId);
}

// server coords → world Vector3 (Y is up, Z is server Y axis)
function sw(sx, sy, worldY = 0) {
  return new THREE.Vector3(sx * S, worldY, sy * S);
}

// ── Game state ────────────────────────────────────────────────────────────────
let socket = null, myId = null, myTeam = null, mode = 'pvp';
let gameState  = 'menu'; // menu | searching | playing | gameover
let sPlayers   = [];     // latest server state
let sHooks     = [];
let mapBuilt   = false;

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = document.getElementById(`screen-${name}`);
  if (s) s.classList.add('active');

  const playing = (name === 'game');
  document.getElementById('overlay').style.pointerEvents = playing ? 'none' : 'auto';
  document.getElementById('hud').style.display        = playing ? 'block' : 'none';
  document.getElementById('hook-canvas').style.display = playing ? 'block' : 'none';
  document.getElementById('zone-hint').style.display   = playing ? 'block' : 'none';
  document.getElementById('joy-canvas').style.display  = playing ? 'block' : 'none';
}

// ── Socket ────────────────────────────────────────────────────────────────────
function connectSocket() {
  if (socket) { socket.disconnect(); }
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
    myId = socket.id;
    gameState = 'playing';
    sPlayers  = d.players;
    sHooks    = [];

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
    // Remove vanished hooks
    const live = new Set(d.hooks.map(h => h.ownerId));
    for (const id of hookLines.keys()) if (!live.has(id)) removeHookLine(id);
    sHooks = d.hooks;
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
  mapBuilt  = false;
  sPlayers  = [];
  sHooks    = [];
}

// ── Input ─────────────────────────────────────────────────────────────────────
const joy     = { active: false, pid: -1, baseX: 0, baseY: 0, nx: 0, ny: 0 };
const hookPtr = { active: false, pid: -1 };
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster  = new THREE.Raycaster();

function screenToServerCoords(sx, sy) {
  const ndc = new THREE.Vector2(
    (sx / window.innerWidth)  *  2 - 1,
    (sy / window.innerHeight) * -2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const pt = new THREE.Vector3();
  raycaster.ray.intersectPlane(floorPlane, pt);
  return { x: pt.x / S, y: pt.z / S };
}

function fireHook(screenX, screenY) {
  const gc = screenToServerCoords(screenX, screenY);
  socket?.emit('input', { hookX: gc.x, hookY: gc.y });
}

canvas.addEventListener('touchstart', e => {
  if (gameState !== 'playing') return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (!joy.active && t.clientX < window.innerWidth / 2) {
      Object.assign(joy, { active: true, pid: t.identifier, baseX: t.clientX, baseY: t.clientY, nx: 0, ny: 0 });
    } else if (!hookPtr.active && t.clientX >= window.innerWidth / 2) {
      hookPtr.active = true; hookPtr.pid = t.identifier;
      fireHook(t.clientX, t.clientY);
    }
  }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  if (gameState !== 'playing') return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (joy.active && t.identifier === joy.pid) {
      const dx = t.clientX - joy.baseX, dy = t.clientY - joy.baseY;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      joy.nx = len > 8 ? dx / len : 0;
      joy.ny = len > 8 ? dy / len : 0;
      socket?.emit('input', { dx: joy.nx, dy: joy.ny });
    }
  }
}, { passive: false });

canvas.addEventListener('touchend', e => {
  if (gameState !== 'playing') return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (joy.active && t.identifier === joy.pid) {
      Object.assign(joy, { active: false, pid: -1, nx: 0, ny: 0 });
      socket?.emit('input', { dx: 0, dy: 0 });
    }
    if (hookPtr.active && t.identifier === hookPtr.pid) {
      hookPtr.active = false; hookPtr.pid = -1;
    }
  }
}, { passive: false });

// Desktop: mouse click for hook, WASD for movement
canvas.addEventListener('click', e => {
  if (gameState !== 'playing') return;
  if (e.clientX >= window.innerWidth / 2) fireHook(e.clientX, e.clientY);
});

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

// ── Joystick canvas overlay ───────────────────────────────────────────────────
const joyCanvas = document.getElementById('joy-canvas');
const joyCtx    = joyCanvas.getContext('2d');

function resizeJoyCanvas() {
  joyCanvas.width  = window.innerWidth;
  joyCanvas.height = window.innerHeight;
}
resizeJoyCanvas();

function drawJoystick() {
  joyCtx.clearRect(0, 0, joyCanvas.width, joyCanvas.height);
  if (gameState !== 'playing' || !joy.active) return;

  const maxR = 55;
  const dx = joy.nx * maxR, dy = joy.ny * maxR;
  const tx = joy.baseX + dx, ty = joy.baseY + dy;

  // Base
  joyCtx.beginPath();
  joyCtx.arc(joy.baseX, joy.baseY, maxR, 0, Math.PI * 2);
  joyCtx.strokeStyle = 'rgba(255,255,255,0.2)';
  joyCtx.lineWidth   = 2;
  joyCtx.stroke();
  joyCtx.fillStyle   = 'rgba(255,255,255,0.06)';
  joyCtx.fill();

  // Thumb
  joyCtx.beginPath();
  joyCtx.arc(tx, ty, 22, 0, Math.PI * 2);
  joyCtx.fillStyle = 'rgba(255,255,255,0.35)';
  joyCtx.fill();
}

// ── HUD: hook cooldown arc ────────────────────────────────────────────────────
const hCanvas = document.getElementById('hook-canvas');
const hCtx    = hCanvas.getContext('2d');

function drawHookHUD(me) {
  const W = hCanvas.width, H = hCanvas.height;
  hCtx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, r = 28;
  const ready = me.hookCooldown <= 0;
  const frac  = ready ? 1 : 1 - me.hookCooldown / 6000;

  hCtx.beginPath();
  hCtx.arc(cx, cy, r, 0, Math.PI * 2);
  hCtx.strokeStyle = 'rgba(30,30,50,0.9)';
  hCtx.lineWidth   = 7;
  hCtx.stroke();

  if (frac > 0.01) {
    hCtx.beginPath();
    hCtx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    hCtx.strokeStyle = ready ? '#2ecc71' : '#e74c3c';
    hCtx.lineWidth   = 7;
    hCtx.stroke();
  }

  hCtx.textAlign    = 'center';
  hCtx.textBaseline = 'middle';
  if (ready) {
    hCtx.font      = '20px Arial';
    hCtx.fillStyle = '#2ecc71';
    hCtx.fillText('⚓', cx, cy);
  } else {
    hCtx.font      = 'bold 13px Arial';
    hCtx.fillStyle = '#e74c3c';
    hCtx.fillText((me.hookCooldown / 1000).toFixed(1), cx, cy);
  }
}

// ── Render loop ───────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

async function updatePlayers() {
  const activeIds = new Set(sPlayers.map(p => p.id));

  // Remove departed players
  for (const id of charEntries.keys()) {
    if (!activeIds.has(id)) removeChar(id);
  }

  // Update each player
  for (const p of sPlayers) {
    const entry = await getOrCreateChar(p.id, p.team, p.name);
    const target = sw(p.x, p.y, 0);

    // Smooth lerp to server position
    entry.group.position.lerp(target, 0.25);

    // Alive / dead state
    const alpha = p.alive ? 1 : 0.3;
    entry.group.traverse(c => {
      if (c.isMesh && c.material) {
        c.material.transparent = true;
        c.material.opacity = alpha;
        if (p.hitFlash > 0 && p.alive) {
          c.material.emissiveIntensity = 0.9;
        } else {
          c.material.emissiveIntensity = p.id === myId ? 0.2 : 0.12;
        }
      }
    });
    entry.ring.material.opacity = p.alive ? 0.85 : 0.2;
  }
}

function updateHooks() {
  for (const hook of sHooks) {
    const owner = sPlayers.find(p => p.id === hook.ownerId);
    if (owner) upsertHook(hook, owner);
  }
}

function animateTorches() {
  const t = Date.now() / 800;
  torches.forEach((l, i) => {
    l.intensity = 2.0 + Math.sin(t * (3.1 + i * 0.7)) * 0.5;
  });
}

function animate() {
  requestAnimationFrame(animate);
  clock.getDelta(); // keep clock ticking

  if (gameState === 'playing') {
    updatePlayers();
    updateHooks();
    animateTorches();
    drawJoystick();

    const me = sPlayers.find(p => p.id === myId);
    if (me) {
      document.getElementById('hud-hp').textContent =
        '❤'.repeat(me.hp) + '🖤'.repeat(2 - me.hp);
      drawHookHUD(me);
    }
  }

  renderer.render(scene, camera);
}

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  const asp = w / h;
  camera.left   = -VIEW_SIZE * asp;
  camera.right  =  VIEW_SIZE * asp;
  camera.updateProjectionMatrix();
  resizeJoyCanvas();
});

// ── Menu buttons ──────────────────────────────────────────────────────────────
document.getElementById('btn-pvp').addEventListener('click', () => {
  mode = 'pvp'; showScreen('search'); connectSocket();
});
document.getElementById('btn-bots').addEventListener('click', () => {
  mode = 'bots'; showScreen('search'); connectSocket();
});

// ── Start ─────────────────────────────────────────────────────────────────────
showScreen('menu');
animate();
