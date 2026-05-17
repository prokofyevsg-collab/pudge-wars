const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs   = require('fs');

const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8'));

process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve index.html before static middleware — injects ?v= into game.js to bust cache
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  let html = fs.readFileSync(path.join(__dirname, 'client', 'index.html'), 'utf8');
  html = html.replace('src="game.js"', `src="game.js?v=${version}"`);
  res.type('html').send(html);
});

app.use(express.static(path.join(__dirname, 'client'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  },
}));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/nature', express.static(path.join(__dirname, 'assets', 'GLB format')));
app.use('/gltf', express.static(path.join(__dirname, 'assets', 'GLTF format')));
app.use('/newassets', express.static(path.join(__dirname, 'assets', 'new assets for map')));

// --- Stats ---
const STATS_FILE = path.join(__dirname, 'stats.json');
let statsDB = {};
try { statsDB = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (_) {}

function saveStats() {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(statsDB)); } catch (e) { console.error('[stats]', e); }
}
function updatePlayerStats(statsId, name, kills, deaths, won) {
  if (!statsId) return;
  if (!statsDB[statsId]) statsDB[statsId] = { name, kills: 0, deaths: 0, wins: 0, games: 0 };
  const s = statsDB[statsId];
  s.name   = name;
  s.kills  += kills;
  s.deaths  = (s.deaths || 0) + deaths;
  if (won) s.wins++;
  s.games++;
}

app.get('/version', (_req, res) => res.json({ version }));

app.post('/admin/broadcast', express.json(), (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'forbidden' });
  const { message, reply_markup } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  sendGroupUpdate(message, reply_markup ?? null);
  res.json({ ok: true });
});

app.get('/leaderboard', (_req, res) => {
  const rows = Object.values(statsDB)
    .map(r => ({
      name:    r.name,
      kills:   r.kills,
      deaths:  r.deaths || 0,
      wins:    r.wins,
      losses:  r.games - r.wins,
      winrate: r.games > 0 ? Math.round(r.wins / r.games * 100) : 0,
    }))
    .sort((a, b) => b.kills - a.kills || b.winrate - a.winrate)
    .slice(0, 20);
  res.json(rows);
});

// --- Constants ---
const TICK_RATE = 30;
const MAP_W = 2000;
const MAP_H = 1200;
const PLAYER_SPEED = 200;
const HOOK_SPEED = 660;
const HOOK_RANGE = 700;
const HOOK_COOLDOWN = 6000;
const PLAYER_RADIUS = 22;
const HOOK_HIT_RADIUS = 18;

// Spawn positions: team 0 = left mid, team 1 = right mid
const SPAWNS = [
  { x: 260, y: 400 },
  { x: MAP_W - 260, y: MAP_H - 400 },
  { x: 260, y: MAP_H - 400 },
  { x: MAP_W - 260, y: 400 },
];

// River constants
const RIVER_CX = MAP_W / 2;   // 1000
const RIVER_W  = 200;          // total river width (narrower for gameplay)

// No water physics — river is visual only
const WATER_ZONES = [];

// Obstacles calibrated via visual editor (v1.52)
const OBSTACLES = [
  { x:  741,  y:  244,  w:  84, h:  98 },
  { x: 1291,  y:  265,  w:  59, h:  89 },
  { x:  445,  y:  452,  w:  72, h: 148 },
  { x: 1569,  y:  421,  w:  70, h:  85 },
  { x: 1001,  y:  588,  w: 126, h: 203, island: true },
  { x:  433,  y:  727,  w:  76, h: 186 },
  { x: 1588,  y:  672,  w:  54, h:  70 },
  { x:  757,  y:  797,  w:  67, h: 103 },
  { x: 1254,  y:  805,  w:  61, h: 115 },
  { x:  778,  y:  341,  w:  60, h: 100 },
  { x:  401,  y:  500,  w:  32, h:  78 },
  { x:  721,  y:  896,  w:  61, h: 100 },
  { x:  776,  y:   91,  w:  48, h:  67 },
  { x: 1298,  y:  887,  w:  55, h:  78 },
  { x: 1560,  y:  715,  w:  57, h:  76 },
  { x: 1568,  y:  789,  w:  59, h:  71 },
  { x: 1590,  y:  503,  w:  60, h:  86 },
  { x: 1556,  y:  484,  w:  30, h:  53 },
  { x: 1246,  y:  367,  w:  51, h: 100 },
  { x: 1252,  y:  301,  w:  30, h:  69 },
  { x: 1799,  y:   32,  w:  62, h:  69 },
  { x: 1273,  y: 1169,  w:  50, h:  66 },
  { x: 1823,  y:  593,  w:  72, h:  86 },
  { x:  177,  y:  599,  w:  69, h:  87 },
];

// --- Helpers ---
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function dist(ax, ay, bx, by) { return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2); }

function circleVsRect(cx, cy, r, rx, ry, rw, rh) {
  const nearX = clamp(cx, rx - rw / 2, rx + rw / 2);
  const nearY = clamp(cy, ry - rh / 2, ry + rh / 2);
  return dist(cx, cy, nearX, nearY) < r;
}

function resolveWater(p, r) {
  for (const z of WATER_ZONES) {
    if (!circleVsRect(p.x, p.y, r, z.x, z.y, z.w, z.h)) continue;
    const edgeLeft  = z.x - z.w / 2;
    const edgeRight = z.x + z.w / 2;
    if (Math.abs(p.x - edgeLeft) < Math.abs(p.x - edgeRight)) p.x = edgeLeft - r;
    else p.x = edgeRight + r;
    break;
  }
}

function resolveObstacleCircle(p, r) {
  for (const o of OBSTACLES) {
    if (!circleVsRect(p.x, p.y, r, o.x, o.y, o.w, o.h)) continue;
    // Push out on nearest axis
    const overlapLeft = p.x - (o.x - o.w / 2 - r);
    const overlapRight = (o.x + o.w / 2 + r) - p.x;
    const overlapTop = p.y - (o.y - o.h / 2 - r);
    const overlapBottom = (o.y + o.h / 2 + r) - p.y;
    const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);
    if (minOverlap === overlapLeft) p.x -= overlapLeft;
    else if (minOverlap === overlapRight) p.x += overlapRight;
    else if (minOverlap === overlapTop) p.y -= overlapTop;
    else p.y += overlapBottom;
  }
}

function segmentHitsRect(x1, y1, x2, y2, rx, ry, rw, rh) {
  // Simple AABB vs segment check
  const left = rx - rw / 2, right = rx + rw / 2;
  const top = ry - rh / 2, bottom = ry + rh / 2;
  if (x2 >= left && x2 <= right && y2 >= top && y2 <= bottom) return true;
  // Check each edge
  function lineIntersect(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y) {
    const s1x = p1x - p0x, s1y = p1y - p0y;
    const s2x = p3x - p2x, s2y = p3y - p2y;
    const d = -s2x * s1y + s1x * s2y;
    if (Math.abs(d) < 0.001) return false;
    const s = (-s1y * (p0x - p2x) + s1x * (p0y - p2y)) / d;
    const t = (s2x * (p0y - p2y) - s2y * (p0x - p2x)) / d;
    return s >= 0 && s <= 1 && t >= 0 && t <= 1;
  }
  return (
    lineIntersect(x1, y1, x2, y2, left, top, right, top) ||
    lineIntersect(x1, y1, x2, y2, right, top, right, bottom) ||
    lineIntersect(x1, y1, x2, y2, right, bottom, left, bottom) ||
    lineIntersect(x1, y1, x2, y2, left, bottom, left, top)
  );
}

// --- GameRoom ---
class GameRoom {
  constructor(id) {
    this.id = id;
    this.players = new Map(); // socketId -> player
    this.hooks = new Map();   // socketId -> hook
    this.state = 'waiting';
    this.pendingKills = [];
    this.pendingPickups = [];
    this.heart = null;
    this.heartTimer = 15; // seconds until first spawn
    this.killsPerPlayer   = new Map();
    this.pickupsPerPlayer = new Map();
    this.deathsPerPlayer  = new Map();
  }

  addPlayer(socketId, user, statsId = null) {
    const idx = this.players.size;
    const team = idx % 2;
    const spawn = SPAWNS[idx];
    this.players.set(socketId, {
      id: socketId,
      name: user?.first_name || `P${idx + 1}`,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      team,
      hp: 2,
      alive: true,
      hookCooldown: 0,
      statsId,
    });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.hooks.delete(socketId);
  }

  processInput(socketId, input) {
    const p = this.players.get(socketId);
    if (!p || !p.alive || this.state !== 'playing') return;

    if (input.dx !== undefined) {
      const len = Math.sqrt(input.dx ** 2 + input.dy ** 2);
      if (len > 0.05) {
        p.vx = (input.dx / len) * PLAYER_SPEED;
        p.vy = (input.dy / len) * PLAYER_SPEED;
      } else {
        p.vx = 0;
        p.vy = 0;
      }
    }

    if (input.hookX !== undefined && p.hookCooldown <= 0 && !this.hooks.has(socketId)) {
      const dx = input.hookX - p.x;
      const dy = input.hookY - p.y;
      const len = Math.sqrt(dx ** 2 + dy ** 2);
      if (len > 5) {
        p.hookCooldown = HOOK_COOLDOWN;
        this.hooks.set(socketId, {
          ownerId: socketId,
          x: p.x,
          y: p.y,
          vx: (dx / len) * HOOK_SPEED,
          vy: (dy / len) * HOOK_SPEED,
          startX: p.x,
          startY: p.y,
          returning: false,
          caughtId: null,
          heartCaught: false,
        });
      }
    }
  }

  tick(dt) {
    // Update player positions
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      p.hookCooldown = Math.max(0, p.hookCooldown - dt * 1000);

      // Don't move if caught by a hook
      if (p.caughtByHook) continue;

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.x = clamp(p.x, PLAYER_RADIUS, MAP_W - PLAYER_RADIUS);
      p.y = clamp(p.y, PLAYER_RADIUS, MAP_H - PLAYER_RADIUS);
      resolveObstacleCircle(p, PLAYER_RADIUS);
      resolveWater(p, PLAYER_RADIUS);
    }

    // Update hooks
    for (const [ownerId, hook] of this.hooks) {
      const owner = this.players.get(ownerId);
      if (!owner || !owner.alive) {
        if (hook.heartCaught) this.heartTimer = Math.max(this.heartTimer, 5); // ensure timer runs
        this.hooks.delete(ownerId);
        continue;
      }

      if (hook.returning) {
        // Pull caught player with hook
        if (hook.caughtId) {
          const caught = this.players.get(hook.caughtId);
          if (caught && caught.alive) {
            caught.x = hook.x;
            caught.y = hook.y;
            caught.caughtByHook = true;
          }
        }

        const dx = owner.x - hook.x;
        const dy = owner.y - hook.y;
        const d = Math.sqrt(dx ** 2 + dy ** 2);

        if (d < 25) {
          if (hook.caughtId) {
            const caught = this.players.get(hook.caughtId);
            if (caught) caught.caughtByHook = false;
          }
          if (hook.heartCaught) {
            owner.hp = Math.min(owner.hp + 1, 3);
            this.pendingPickups.push({ playerName: owner.name, playerTeam: owner.team });
            this.pickupsPerPlayer.set(ownerId, (this.pickupsPerPlayer.get(ownerId) || 0) + 1);
            this.heartTimer = 20;
          }
          this.hooks.delete(ownerId);
          continue;
        }

        const speed = HOOK_SPEED * 1.1;
        hook.x += (dx / d) * speed * dt;
        hook.y += (dy / d) * speed * dt;
      } else {
        const prevX = hook.x;
        const prevY = hook.y;
        hook.x += hook.vx * dt;
        hook.y += hook.vy * dt;

        const traveled = dist(hook.x, hook.y, hook.startX, hook.startY);

        // Hit obstacle
        let hitObstacle = false;
        for (const o of OBSTACLES) {
          if (segmentHitsRect(prevX, prevY, hook.x, hook.y, o.x, o.y, o.w, o.h)) {
            hitObstacle = true;
            break;
          }
        }

        if (
          traveled >= HOOK_RANGE ||
          hook.x < 0 || hook.x > MAP_W ||
          hook.y < 0 || hook.y > MAP_H ||
          hitObstacle
        ) {
          hook.returning = true;
          continue;
        }

        // Check player hit
        for (const [targetId, target] of this.players) {
          if (targetId === ownerId) continue;
          if (!target.alive) continue;

          if (dist(hook.x, hook.y, target.x, target.y) < HOOK_HIT_RADIUS + PLAYER_RADIUS) {
            if (target.team === owner.team) {
              // Союзник: подтянуть без урона
              hook.caughtId = targetId;
              target.caughtByHook = true;
            } else {
              // Враг: урон + подтягивание
              target.hp -= 1;
              target.hitFlash = 300;
              if (target.hp <= 0) {
                target.alive = false;
                target.caughtByHook = false;
                hook.caughtId = null;
                this.pendingKills.push({
                  killerName: owner.name,
                  killerTeam: owner.team,
                  victimName: target.name,
                  victimTeam: target.team,
                });
                this.killsPerPlayer.set(ownerId, (this.killsPerPlayer.get(ownerId) || 0) + 1);
                this.deathsPerPlayer.set(targetId, (this.deathsPerPlayer.get(targetId) || 0) + 1);
              } else {
                hook.caughtId = targetId;
                target.caughtByHook = true;
              }
            }
            hook.returning = true;
            break;
          }
        }

        // Check heart hit — hook can snag the heart and drag it back
        if (!hook.returning && this.heart) {
          if (dist(hook.x, hook.y, this.heart.x, this.heart.y) < HOOK_HIT_RADIUS + 30) {
            hook.heartCaught = true;
            hook.returning = true;
            this.heart = null;
            this.heartTimer = 25; // prevent immediate respawn while heart is in flight
          }
        }
      }
    }

    // Update flash timers
    for (const p of this.players.values()) {
      if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - dt * 1000);
    }

    // Heart item — only tick timer when no heart is present
    if (!this.heart) this.heartTimer -= dt;
    if (this.heartTimer <= 0 && !this.heart) {
      // Spawn heart near top or bottom ford, on a random bank — strategic objective
      const fordY  = Math.random() > 0.5 ? 300 : 900;
      const bankDir = Math.random() > 0.5 ? 1 : -1;
      this.heart = {
        x: RIVER_CX + bankDir * (RIVER_W / 2 + 70 + Math.random() * 100),
        y: fordY + (Math.random() - 0.5) * 60,
      };
    }
    if (this.heart) {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (dist(p.x, p.y, this.heart.x, this.heart.y) < PLAYER_RADIUS + 35) {
          p.hp = Math.min(p.hp + 1, 3);
          this.pendingPickups.push({ playerName: p.name, playerTeam: p.team });
          this.pickupsPerPlayer.set(p.id, (this.pickupsPerPlayer.get(p.id) || 0) + 1);
          this.heart = null;
          this.heartTimer = 20;
          break;
        }
      }
    }

    // Check win condition
    const teamAlive = new Map();
    for (const p of this.players.values()) {
      if (!teamAlive.has(p.team)) teamAlive.set(p.team, false);
      if (p.alive) teamAlive.set(p.team, true);
    }
    const aliveTeams = [...teamAlive.entries()].filter(([, alive]) => alive);
    if (aliveTeams.length <= 1) {
      return { winner: aliveTeams.length === 1 ? aliveTeams[0][0] : -1 };
    }
    return null;
  }

  snapshot() {
    const kills = this.pendingKills.splice(0);
    const pickups = this.pendingPickups.splice(0);
    return {
      players: [...this.players.values()].map(p => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        team: p.team,
        hp: p.hp,
        alive: p.alive,
        hookCooldown: p.hookCooldown,
        hitFlash: p.hitFlash || 0,
      })),
      hooks: [...this.hooks.values()].map(h => ({
        ownerId: h.ownerId,
        x: h.x,
        y: h.y,
        returning: h.returning,
        caughtId: h.caughtId,
      })),
      kills,
      pickups,
      heart: (() => {
        if (this.heart) return { x: this.heart.x, y: this.heart.y };
        for (const [, h] of this.hooks) if (h.heartCaught) return { x: h.x, y: h.y };
        return null;
      })(),
    };
  }
}

// --- Lobby ---
class Lobby {
  constructor(id, leaderId) {
    this.id = id;
    this.leaderId = leaderId;
    this.slots = [null, null, null, null]; // {socketId?, name, isBot, team}
  }
  addHuman(socketId, name) {
    const i = this.slots.findIndex(s => s === null);
    if (i < 0) return -1;
    this.slots[i] = { socketId, name, isBot: false, team: i % 2 };
    return i;
  }
  addBot() {
    const i = this.slots.findIndex(s => s === null);
    if (i < 0) return -1;
    const names = ['Алёша', 'Борис', 'Вася', 'Гриша'];
    this.slots[i] = { socketId: null, name: `Бот ${names[i]}`, isBot: true, team: i % 2 };
    return i;
  }
  removeHuman(socketId) {
    const i = this.slots.findIndex(s => s?.socketId === socketId);
    if (i >= 0) this.slots[i] = null;
  }
  isFull()       { return this.slots.every(s => s !== null); }
  hasEmpty()     { return this.slots.some(s => s === null); }
  humanSockets() { return this.slots.filter(s => s && !s.isBot).map(s => s.socketId); }
  forClient()    {
    return { id: this.id, leaderId: this.leaderId,
             slots: this.slots.map(s => s ? { name: s.name, isBot: s.isBot, team: s.team } : null) };
  }
}

const lobbies = new Map();
let openLobbyId = null;

function getOrCreateLobby(leaderId) {
  if (openLobbyId) {
    const l = lobbies.get(openLobbyId);
    if (l && l.hasEmpty()) return l;
    openLobbyId = null;
  }
  const id = `lobby_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const l = new Lobby(id, leaderId);
  lobbies.set(id, l);
  openLobbyId = id;
  return l;
}

function broadcastLobby(lobby) {
  lobby.humanSockets().forEach(sid => io.to(sid).emit('lobby_update', lobby.forClient()));
}

function leaveLobby(socket) {
  const lobby = lobbies.get(socket.data.lobbyId);
  if (!lobby) { socket.data.lobbyId = null; return; }
  lobby.removeHuman(socket.id);
  socket.data.lobbyId = null;
  if (lobby.humanSockets().length === 0) {
    lobbies.delete(lobby.id);
    if (openLobbyId === lobby.id) openLobbyId = null;
  } else {
    broadcastLobby(lobby);
  }
}

// --- Bot AI ---
function tickBots(room, dt) {
  for (const [id, bot] of room.players) {
    if (!bot.isBot || !bot.alive) continue;

    // Reaction delay timer — bot "thinks" before acting
    bot.reactionTimer = (bot.reactionTimer ?? 2.0) - dt;
    if (bot.reactionTimer > 0) continue;

    // Find nearest enemy
    let nearestEnemy = null, nearestDist = Infinity;
    for (const [, e] of room.players) {
      if (e.team === bot.team || !e.alive) continue;
      const d = dist(bot.x, bot.y, e.x, e.y);
      if (d < nearestDist) { nearestDist = d; nearestEnemy = e; }
    }

    if (!nearestEnemy) { bot.vx = 0; bot.vy = 0; continue; }

    // Slow, wandering movement toward enemy
    const wander = 160;
    const t = Date.now() / 1200 + id.charCodeAt(4);
    const dx = nearestEnemy.x - bot.x + Math.sin(t) * wander;
    const dy = nearestEnemy.y - bot.y + Math.cos(t) * wander;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const stopDist = 380;

    if (nearestDist > stopDist) {
      bot.vx = (dx / len) * PLAYER_SPEED * 0.62;
      bot.vy = (dy / len) * PLAYER_SPEED * 0.62;
    } else {
      bot.vx = 0; bot.vy = 0;
    }

    // Hook only when cooldown ready + close enough + with inaccuracy
    const hookRange = HOOK_RANGE;
    if (bot.hookCooldown <= 0 && !room.hooks.has(id) && nearestDist < hookRange) {
      // Add aim error so player can dodge
      const aimError = 40;
      const targetX = nearestEnemy.x + (Math.random() - 0.5) * aimError;
      const targetY = nearestEnemy.y + (Math.random() - 0.5) * aimError;
      const nx = targetX - bot.x, ny = targetY - bot.y;
      const nl = Math.sqrt(nx * nx + ny * ny) || 1;
      bot.hookCooldown = HOOK_COOLDOWN;
      room.hooks.set(id, {
        ownerId: id,
        x: bot.x, y: bot.y,
        vx: (nx / nl) * HOOK_SPEED,
        vy: (ny / nl) * HOOK_SPEED,
        startX: bot.x, startY: bot.y,
        returning: false, caughtId: null, heartCaught: false,
      });
      // Reset reaction timer after hooking — bot pauses again
      bot.reactionTimer = 1.5 + Math.random() * 1.5;
    }
  }
}

function startGameLoop(room, roomId) {
  if (room._readyTimeout) { clearTimeout(room._readyTimeout); room._readyTimeout = null; }
  if (room.state !== 'waiting') return; // already started or finished
  room.state = 'playing';

  let lastTick = Date.now();
  const gameLoop = setInterval(() => {
    try {
      const now = Date.now();
      const dt = clamp((now - lastTick) / 1000, 0, 0.1);
      lastTick = now;

      tickBots(room, dt);
      const result = room.tick(dt);
      io.to(roomId).emit('state', room.snapshot());

      if (result) {
        clearInterval(gameLoop);
        room.state = 'finished';
        for (const [pid, p] of room.players) {
          if (p.isBot) continue;
          updatePlayerStats(
            p.statsId, p.name,
            room.killsPerPlayer.get(pid)  || 0,
            room.deathsPerPlayer.get(pid) || 0,
            result.winner === p.team,
          );
        }
        saveStats();
        io.to(roomId).emit('game_over', result);
        rooms.delete(roomId);
      }
    } catch (err) {
      console.error(`[gameLoop ${roomId}]`, err);
      clearInterval(gameLoop);
      rooms.delete(roomId);
      io.to(roomId).emit('game_over', { winner: -1, error: true });
    }
  }, 1000 / TICK_RATE);
}

function startRoom(room, roomId, sockets) {
  rooms.set(roomId, room);
  room.state = 'waiting';
  room.humanIds = new Set(sockets.filter(Boolean).map(s => s.id));
  room.readyIds = new Set();

  sockets.forEach(s => {
    if (!s) return;
    s.join(roomId);
    s.data.roomId = roomId;
  });

  io.to(roomId).emit('game_start', {
    roomId,
    players: [...room.players.values()],
    obstacles: OBSTACLES,
    mapW: MAP_W,
    mapH: MAP_H,
  });

  // Safety timeout: start game anyway after 20s even if client never signals ready
  room._readyTimeout = setTimeout(() => startGameLoop(room, roomId), 20000);
}

// --- Rooms ---
const rooms = new Map();

// --- Socket.io ---
io.on('connection', (socket) => {
  socket.on('play_vs_bots', (data) => {
    const roomId = `bot_${Date.now()}_${socket.id.slice(0, 4)}`;
    const room = new GameRoom(roomId);

    const statsId = data?.user?.id?.toString() || data?.clientId || socket.id;
    socket.data.statsId = statsId;
    room.addPlayer(socket.id, data?.user, statsId);

    // 3 bots (teammate + 2 enemies)
    const botDefs = [
      { id: `bot_a_${roomId}`, name: 'Бот Алёша', team: 0 },
      { id: `bot_b_${roomId}`, name: 'Бот Борис', team: 1 },
      { id: `bot_c_${roomId}`, name: 'Бот Вася',  team: 1 },
    ];
    botDefs.forEach((b, i) => {
      room.addPlayer(b.id, { first_name: b.name });
      const p = room.players.get(b.id);
      p.isBot = true;
      p.team = b.team;
    });

    // Assign spawns by team so same-team players are always on the same bank
    const teamSpawns = {
      0: [{ x: 260, y: 400 }, { x: 260, y: MAP_H - 400 }],
      1: [{ x: MAP_W - 260, y: MAP_H - 400 }, { x: MAP_W - 260, y: 400 }],
    };
    const teamIdx = { 0: 0, 1: 0 };
    for (const p of room.players.values()) {
      const sp = teamSpawns[p.team][teamIdx[p.team]++];
      p.x = sp.x; p.y = sp.y;
    }

    startRoom(room, roomId, [socket]);
  });

  socket.on('join_lobby', (data) => {
    if (socket.data.lobbyId) leaveLobby(socket);
    const name = data?.user?.first_name || 'Игрок';
    const statsId = data?.user?.id?.toString() || data?.clientId || socket.id;
    socket.data.statsId = statsId;
    const lobby = getOrCreateLobby(socket.id);
    lobby.addHuman(socket.id, name);
    socket.data.lobbyId = lobby.id;
    if (!lobby.hasEmpty()) openLobbyId = null;
    socket.emit('lobby_update', lobby.forClient());
    broadcastLobby(lobby);
  });

  socket.on('add_bot_to_lobby', () => {
    const lobby = lobbies.get(socket.data.lobbyId);
    if (!lobby || !lobby.hasEmpty()) return;
    lobby.addBot();
    if (!lobby.hasEmpty()) openLobbyId = null;
    broadcastLobby(lobby);
  });

  socket.on('leave_lobby', () => {
    if (socket.data.lobbyId) leaveLobby(socket);
  });

  socket.on('start_lobby', () => {
    const lobby = lobbies.get(socket.data.lobbyId);
    if (!lobby || !lobby.isFull()) return;

    const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const room = new GameRoom(roomId);
    const humanSockets = [];

    lobby.slots.forEach((slot, i) => {
      if (!slot) return;
      if (slot.isBot) {
        const botId = `bot_${i}_${roomId}`;
        room.players.set(botId, {
          id: botId, name: slot.name, isBot: true, reactionTimer: 2.0,
          x: SPAWNS[i].x, y: SPAWNS[i].y, vx: 0, vy: 0,
          team: slot.team, hp: 2, alive: true, hookCooldown: 0,
        });
      } else {
        const sock = io.sockets.sockets.get(slot.socketId);
        if (!sock) return;
        room.players.set(slot.socketId, {
          id: slot.socketId, name: slot.name,
          x: SPAWNS[i].x, y: SPAWNS[i].y, vx: 0, vy: 0,
          team: slot.team, hp: 2, alive: true, hookCooldown: 0,
          statsId: sock.data.statsId || null,
        });
        sock.data.lobbyId = null;
        humanSockets.push(sock);
      }
    });

    lobbies.delete(lobby.id);
    if (openLobbyId === lobby.id) openLobbyId = null;
    startRoom(room, roomId, humanSockets);
  });

  socket.on('player_ready', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.state !== 'waiting') return;
    room.readyIds.add(socket.id);
    if (room.readyIds.size >= room.humanIds.size) {
      startGameLoop(room, roomId);
    }
  });

  socket.on('input', (input) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) room.processInput(socket.id, input);
  });

  socket.on('disconnect', () => {
    if (socket.data.lobbyId) leaveLobby(socket);
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.removePlayer(socket.id);
    io.to(roomId).emit('player_left', { id: socket.id });
    if (room.players.size === 0) rooms.delete(roomId);
  });
});

function sendGroupUpdate(text, replyMarkup = null) {
  const token   = process.env.BOT_TOKEN;
  const chatId  = process.env.NOTIFY_GROUP_ID;
  const gameUrl = process.env.GAME_URL || 'https://pudge-wars-production-e0d3.up.railway.app';
  if (!token || !chatId) { console.log('[notify] BOT_TOKEN or NOTIFY_GROUP_ID not set'); return; }
  const payload = { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true };
  payload.reply_markup = replyMarkup ?? {
    inline_keyboard: [[{ text: '🎮 Играть в Pudge Wars', url: 'https://t.me/PudgeWars2Bot' }]],
  };
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => r.json()).then(d => {
    if (!d.ok) console.error('[notify] send error', d.description);
    else console.log('[notify] group notified');
  }).catch(e => console.error('[notify]', e.message));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Pudge Wars v${version} on port ${PORT}`);
  startTelegramBot();
});

// --- Telegram Bot (polling, no extra libs) ---
function startTelegramBot() {
  const token = process.env.BOT_TOKEN;
  const gameUrl = process.env.GAME_URL;
  if (!token || !gameUrl) {
    console.log('[bot] BOT_TOKEN or GAME_URL not set — skipping bot');
    return;
  }

  const API = `https://api.telegram.org/bot${token}`;
  let offset = 0;

  async function poll() {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=25&offset=${offset}`);
      const data = await res.json();
      if (!data.ok) { await sleep(5000); return poll(); }

      for (const upd of data.result) {
        offset = upd.update_id + 1;
        handleUpdate(upd);
      }
    } catch (e) {
      console.error('[bot poll]', e.message);
      await sleep(5000);
    }
    poll();
  }

  async function handleUpdate(upd) {
    const msg = upd.message;
    if (!msg?.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (text === '/start' || text.startsWith('/start ')) {
      await fetch(`${API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '🎮 *Pudge Wars* — хукай соперников и побеждай!\n\n2 попадания = победа. Играй один против ботов или найди команду.',
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🕹 Играть', web_app: { url: `${gameUrl}?v=${version}` } },
            ]],
          },
        }),
      });
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Delete webhook so polling works
  fetch(`${API}/deleteWebhook`).then(() => {
    console.log('[bot] polling started');
    poll();
  }).catch(e => console.error('[bot] init error', e.message));
}
