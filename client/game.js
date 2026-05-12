'use strict';

// ── Config ──────────────────────────────────────────────────────────────────
const SERVER_URL = window.location.origin; // same-origin; change if hosted separately

const TEAM_COLORS  = [0xe74c3c, 0x2980b9]; // red, blue
const TEAM_NAMES   = ['Красные', 'Синие'];
const MAP_W = 800, MAP_H = 600;

// ── Telegram init ────────────────────────────────────────────────────────────
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const tgUser = tg?.initDataUnsafe?.user ?? null;

// ══════════════════════════════════════════════════════════════════════════════
// MenuScene
// ══════════════════════════════════════════════════════════════════════════════
class MenuScene extends Phaser.Scene {
  constructor() { super('MenuScene'); }

  create() {
    const W = this.scale.width, H = this.scale.height;

    // Background
    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1a);
    drawGrid(this, W, H, 60, 0x1a1a3a, 0.4);

    // Title
    this.add.text(W / 2, H * 0.22, 'PUDGE WARS', {
      fontSize: '52px', fontFamily: 'Arial Black',
      color: '#e74c3c', stroke: '#000', strokeThickness: 8,
    }).setOrigin(0.5);

    this.add.text(W / 2, H * 0.22 + 60, '2  vs  2  •  Хукай и побеждай', {
      fontSize: '18px', color: '#8888aa',
    }).setOrigin(0.5);

    // Instructions card
    const cardY = H * 0.55;
    this.add.rectangle(W / 2, cardY, Math.min(W - 40, 380), 120, 0x1a1a3a, 0.9)
      .setStrokeStyle(1, 0x3a3a6a);
    this.add.text(W / 2, cardY, [
      '🕹  Левый палец — джойстик движения',
      '🎯  Правый палец — цель хука',
      '💀  2 попадания = враг повержен',
    ].join('\n'), {
      fontSize: '15px', color: '#ccc', align: 'left',
      lineSpacing: 8,
    }).setOrigin(0.5);

    // Find game button
    const btnY = H * 0.76;
    const btn = this.add.rectangle(W / 2, btnY, 220, 52, 0xe74c3c)
      .setInteractive({ useHandCursor: true });
    const btnText = this.add.text(W / 2, btnY, 'НАЙТИ ИГРУ  (2v2)', {
      fontSize: '18px', fontFamily: 'Arial Black', color: '#fff',
    }).setOrigin(0.5);

    btn.on('pointerover',  () => btn.setFillStyle(0xc0392b));
    btn.on('pointerout',   () => btn.setFillStyle(0xe74c3c));
    btn.on('pointerdown',  () => {
      btn.setFillStyle(0x922b21);
      btnText.setText('...');
      this.scene.start('GameScene', { mode: 'pvp' });
    });

    // Bot test button
    const botBtnY = H * 0.88;
    const botBtn = this.add.rectangle(W / 2, botBtnY, 220, 52, 0x27ae60)
      .setInteractive({ useHandCursor: true });
    const botBtnText = this.add.text(W / 2, botBtnY, 'ИГРАТЬ vs БОТЫ', {
      fontSize: '18px', fontFamily: 'Arial Black', color: '#fff',
    }).setOrigin(0.5);

    botBtn.on('pointerover',  () => botBtn.setFillStyle(0x1e8449));
    botBtn.on('pointerout',   () => botBtn.setFillStyle(0x27ae60));
    botBtn.on('pointerdown',  () => {
      botBtn.setFillStyle(0x145a32);
      botBtnText.setText('...');
      this.scene.start('GameScene', { mode: 'bots' });
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GameScene
// ══════════════════════════════════════════════════════════════════════════════
// 18 characters, assigned round-robin per player slot
const CHAR_KEYS = ['a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r'];

class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  init(data) {
    this.mode = data?.mode || 'pvp';
  }

  preload() {
    CHAR_KEYS.forEach(k => {
      this.load.image(`char-${k}`, `assets/chars/char-${k}.png`);
    });
  }

  create() {
    const W = this.scale.width, H = this.scale.height;
    this.W = W; this.H = H;
    this.scaleX = W / MAP_W;
    this.scaleY = H / MAP_H;

    // State
    this.socket      = null;
    this.myId        = null;
    this.myTeam      = null;
    this.started     = false;
    this.obstacles   = [];
    this.serverPlayers = [];
    this.serverHooks   = [];

    // Graphics layers
    this.bgGfx     = this.add.graphics().setDepth(0);
    this.obstGfx   = this.add.graphics().setDepth(1);
    this.hookGfx   = this.add.graphics().setDepth(2);
    this.playerGfx = this.add.graphics().setDepth(3);
    this.uiGfx     = this.add.graphics().setDepth(10);

    // Sprite containers: id -> { img, mask, maskGfx }
    this.charSprites = new Map();
    // Player slot index: id -> number (for char key assignment)
    this.playerSlots = new Map();

    // Text layers
    this.nameTexts  = new Map(); // id -> Text
    this.statusText = this.add.text(W / 2, H / 2, 'Подключение...', {
      fontSize: '24px', color: '#fff', align: 'center',
    }).setOrigin(0.5).setDepth(15);

    this.hudText = this.add.text(10, 10, '', {
      fontSize: '16px', color: '#fff', stroke: '#000', strokeThickness: 3,
    }).setDepth(15);

    this.teamText = this.add.text(W - 10, 10, '', {
      fontSize: '16px', color: '#fff', stroke: '#000', strokeThickness: 3,
      align: 'right',
    }).setOrigin(1, 0).setDepth(15);

    // Joystick visuals
    this.joyBase  = this.add.circle(0, 0, 55, 0xffffff, 0.12).setDepth(12).setVisible(false);
    this.joyThumb = this.add.circle(0, 0, 24, 0xffffff, 0.40).setDepth(12).setVisible(false);

    // Hook aim dot
    this.hookDot = this.add.circle(0, 0, 10, 0xffff00, 0.6).setDepth(12).setVisible(false);

    // Input state
    this.joy = { active: false, pid: -1, baseX: 0, baseY: 0, nx: 0, ny: 0 };
    this.hookPtr = { active: false, pid: -1 };
    this.inputDirty = false;

    this.input.addPointer(3);
    this.input.on('pointerdown', this.onDown, this);
    this.input.on('pointermove', this.onMove, this);
    this.input.on('pointerup',   this.onUp,   this);

    this.connectSocket();
  }

  // ── Socket ─────────────────────────────────────────────────────────────────
  connectSocket() {
    this.socket = io(SERVER_URL, { transports: ['websocket'] });

    this.socket.on('connect', () => {
      this.myId = this.socket.id;
      if (this.mode === 'bots') {
        this.statusText.setText('Подготовка ботов...');
        this.socket.emit('play_vs_bots', { user: tgUser });
      } else {
        this.statusText.setText('Поиск игроков...\n0 / 4');
        this.socket.emit('join_queue', { user: tgUser });
      }
    });

    this.socket.on('queue_status', d => {
      this.statusText.setText(`Поиск игроков...\n${d.inQueue} / 4`);
    });

    this.socket.on('game_start', d => {
      this.myId      = this.socket.id;
      this.obstacles = d.obstacles;
      this.started   = true;
      this.statusText.setVisible(false);

      const me = d.players.find(p => p.id === this.myId);
      if (me) {
        this.myTeam = me.team;
        this.teamText.setText(`Команда: ${TEAM_NAMES[me.team]}`);
        this.teamText.setColor(me.team === 0 ? '#e74c3c' : '#2980b9');
      }

      this.drawBackground();
      this.serverPlayers = d.players;
    });

    this.socket.on('state', d => {
      if (!this.started) return;
      this.serverPlayers = d.players;
      this.serverHooks   = d.hooks;
    });

    this.socket.on('player_left', d => {
      this.serverPlayers = this.serverPlayers.filter(p => p.id !== d.id);
      const t = this.nameTexts.get(d.id);
      if (t) { t.destroy(); this.nameTexts.delete(d.id); }
      const s = this.charSprites.get(d.id);
      if (s) { s.img.destroy(); s.maskShape.destroy(); this.charSprites.delete(d.id); }
    });

    this.socket.on('game_over', d => {
      this.showGameOver(d.winner);
    });

    this.socket.on('disconnect', () => {
      if (!this.started) return;
      this.showMessage('Соединение потеряно');
      this.time.delayedCall(2000, () => this.scene.start('MenuScene'));
    });
  }

  // ── Background ─────────────────────────────────────────────────────────────
  drawBackground() {
    const g = this.bgGfx;
    g.clear();

    // Dungeon floor — warm orange/brown like the Kenney modular environment
    g.fillStyle(0x7a4a28).fillRect(0, 0, this.W, this.H);

    // Floor tile grid
    const tileSize = 48 * Math.min(this.scaleX, this.scaleY);
    g.lineStyle(1, 0x5a3618, 0.6);
    for (let x = 0; x < this.W; x += tileSize) {
      g.beginPath().moveTo(x, 0).lineTo(x, this.H).strokePath();
    }
    for (let y = 0; y < this.H; y += tileSize) {
      g.beginPath().moveTo(0, y).lineTo(this.W, y).strokePath();
    }

    // Dungeon border walls (thick purple/stone)
    const bw = 16;
    g.fillStyle(0x5a4a7a);
    g.fillRect(0, 0, this.W, bw);           // top
    g.fillRect(0, this.H - bw, this.W, bw); // bottom
    g.fillRect(0, 0, bw, this.H);           // left
    g.fillRect(this.W - bw, 0, bw, this.H); // right

    // Wall detail lines
    g.lineStyle(2, 0x8a7aaa, 0.6);
    g.strokeRect(bw, bw, this.W - bw * 2, this.H - bw * 2);

    // Team zone subtle tint
    g.fillStyle(TEAM_COLORS[0], 0.06).fillRect(bw, bw, this.W / 2 - bw, this.H - bw * 2);
    g.fillStyle(TEAM_COLORS[1], 0.06).fillRect(this.W / 2, bw, this.W / 2 - bw, this.H - bw * 2);

    // Obstacles — dungeon stone blocks
    const og = this.obstGfx;
    og.clear();
    for (const o of this.obstacles) {
      const ox = o.x * this.scaleX, oy = o.y * this.scaleY;
      const ow = o.w * this.scaleX, oh = o.h * this.scaleY;
      // Stone block shadow
      og.fillStyle(0x1a1020, 0.5).fillRect(ox - ow / 2 + 4, oy - oh / 2 + 4, ow, oh);
      // Stone fill
      og.fillStyle(0x6a5a8a).fillRect(ox - ow / 2, oy - oh / 2, ow, oh);
      // Stone highlight top
      og.fillStyle(0x8a7aaa, 0.5).fillRect(ox - ow / 2, oy - oh / 2, ow, 6);
      og.fillStyle(0x8a7aaa, 0.3).fillRect(ox - ow / 2, oy - oh / 2, 6, oh);
      // Stone outline
      og.lineStyle(2, 0x4a3a6a, 1).strokeRect(ox - ow / 2, oy - oh / 2, ow, oh);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  renderState() {
    const pg = this.playerGfx, hg = this.hookGfx;
    pg.clear(); hg.clear();

    // Hooks (chains)
    for (const hook of this.serverHooks) {
      const owner = this.serverPlayers.find(p => p.id === hook.ownerId);
      if (!owner) continue;
      const color = TEAM_COLORS[owner.team];

      const ox = owner.x * this.scaleX, oy = owner.y * this.scaleY;
      const hx = hook.x  * this.scaleX, hy = hook.y  * this.scaleY;

      // Chain segments
      const segs = 8;
      hg.lineStyle(3, color, 0.75);
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs, t1 = (i + 1) / segs;
        const x0 = ox + (hx - ox) * t0, y0 = oy + (hy - oy) * t0;
        const x1 = ox + (hx - ox) * t1, y1 = oy + (hy - oy) * t1;
        const sag = Math.sin(Math.PI * (t0 + t1) / 2) * 4;
        const nx = -(hy - oy), ny = hx - ox;
        const nl = Math.sqrt(nx * nx + ny * ny) || 1;
        hg.beginPath();
        hg.moveTo(x0 + (nx / nl) * sag * 0.5, y0 + (ny / nl) * sag * 0.5);
        hg.lineTo(x1 + (nx / nl) * sag * 0.5, y1 + (ny / nl) * sag * 0.5);
        hg.strokePath();
      }

      // Hook tip
      hg.fillStyle(0xffffff, 1).fillCircle(hx, hy, 7);
      hg.fillStyle(color, 1).fillCircle(hx, hy, 4);
    }

    // Players
    for (const p of this.serverPlayers) {
      const px = p.x * this.scaleX, py = p.y * this.scaleY;
      const r = 22 * Math.min(this.scaleX, this.scaleY);
      const color = TEAM_COLORS[p.team];
      const isMe = p.id === this.myId;
      const flash = p.hitFlash > 0;

      // Assign slot index for char sprite selection
      if (!this.playerSlots.has(p.id)) {
        this.playerSlots.set(p.id, this.playerSlots.size);
      }
      const slotIdx = this.playerSlots.get(p.id);
      const charKey = `char-${CHAR_KEYS[slotIdx % CHAR_KEYS.length]}`;

      // Shadow
      pg.fillStyle(0x000000, 0.4).fillEllipse(px + 3, py + 6, r * 1.9, r * 0.75);

      if (!p.alive) {
        // Dead — dim circle
        pg.fillStyle(0x000000, 0.6).fillCircle(px, py, r);
        pg.lineStyle(2, color, 0.3).strokeCircle(px, py, r);
        this.updateCharSprite(p.id, px, py, r, charKey, 0.25, color);
        this.setNameText(p.id, px, py + r + 5, `💀 ${p.name}`, '#555555');
        continue;
      }

      // Coloured ring behind sprite (team color)
      pg.fillStyle(color, flash ? 1 : 0.9).fillCircle(px, py, r + 3);
      if (isMe) {
        pg.lineStyle(3, 0xffffff, 0.95).strokeCircle(px, py, r + 6);
      }

      // Character face sprite with circle mask
      this.updateCharSprite(p.id, px, py, r, charKey, flash ? 0.5 : 1, color);

      // HP pips
      for (let i = 0; i < 2; i++) {
        const pipX = px + (i === 0 ? -(r * 0.4) : (r * 0.4));
        const pipY = py - r - 10;
        const filled = i < p.hp;
        pg.fillStyle(filled ? 0xff3333 : 0x333333, 1).fillCircle(pipX, pipY, 5);
        pg.lineStyle(1, 0x000000, 0.6).strokeCircle(pipX, pipY, 5);
      }

      // Hook cooldown dot
      const hookReady = p.hookCooldown <= 0;
      pg.fillStyle(hookReady ? 0x2ecc71 : 0xe74c3c, 0.9)
        .fillCircle(px, py - r - 20, 4);

      // Name tag
      this.setNameText(p.id, px, py + r + 6,
        (isMe ? '▶ ' : '') + p.name,
        isMe ? '#ffffff' : '#dddddd');
    }
  }

  updateCharSprite(id, px, py, r, charKey, alpha, tintColor) {
    if (!this.charSprites.has(id)) {
      // Create masked sprite
      const img = this.add.image(px, py, charKey)
        .setDepth(3.5)
        .setDisplaySize(r * 2, r * 2);

      const maskShape = this.make.graphics({ x: px, y: py, add: false });
      maskShape.fillStyle(0xffffff).fillCircle(0, 0, r);
      const mask = maskShape.createGeometryMask();
      img.setMask(mask);

      this.charSprites.set(id, { img, maskShape });
    }

    const { img, maskShape } = this.charSprites.get(id);
    img.setPosition(px, py).setDisplaySize(r * 2, r * 2).setAlpha(alpha);
    maskShape.setPosition(px, py);
    maskShape.clear().fillStyle(0xffffff).fillCircle(0, 0, r);
  }

  setNameText(id, x, y, text, color) {
    if (!this.nameTexts.has(id)) {
      const t = this.add.text(x, y, text, {
        fontSize: '12px', color, stroke: '#000', strokeThickness: 2,
      }).setOrigin(0.5, 0).setDepth(5);
      this.nameTexts.set(id, t);
    } else {
      const t = this.nameTexts.get(id);
      t.setPosition(x, y).setText(text).setColor(color);
    }
  }

  // ── HUD ────────────────────────────────────────────────────────────────────
  renderHUD() {
    const me = this.serverPlayers.find(p => p.id === this.myId);
    if (!me) return;

    const hpStr = '❤'.repeat(me.hp) + '🖤'.repeat(2 - me.hp);
    this.hudText.setText(hpStr);

    const g = this.uiGfx;
    g.clear();

    // ── Hook cooldown arc (bottom-right zone) ──
    const cx = this.W * 0.75, cy = this.H - 48, rad = 30;
    const ready = me.hookCooldown <= 0;
    const frac = ready ? 1 : 1 - me.hookCooldown / 6000;

    // Background circle
    g.lineStyle(6, 0x222233, 0.9).strokeCircle(cx, cy, rad);

    // Progress arc
    if (frac > 0) {
      const color = ready ? 0x2ecc71 : 0xe74c3c;
      g.lineStyle(6, color, 1);
      g.beginPath();
      const start = -Math.PI / 2;
      const end = start + frac * Math.PI * 2;
      g.arc(cx, cy, rad, start, end, false);
      g.strokePath();
    }

    // Hook icon in center
    g.lineStyle(3, ready ? 0x2ecc71 : 0x888888, 1);
    g.beginPath();
    g.moveTo(cx - 8, cy - 8);
    g.lineTo(cx + 4, cy - 8);
    g.arc(cx + 4, cy - 2, 6, -Math.PI / 2, Math.PI / 2, false);
    g.lineTo(cx - 2, cy + 4);
    g.strokePath();

    // Cooldown seconds text
    if (!ready) {
      const cdSec = (me.hookCooldown / 1000).toFixed(1);
      if (!this.cdText) {
        this.cdText = this.add.text(cx, cy + rad + 12, '', {
          fontSize: '13px', color: '#e74c3c', stroke: '#000', strokeThickness: 2,
        }).setOrigin(0.5, 0).setDepth(15);
      }
      this.cdText.setText(cdSec + 'с').setVisible(true);
    } else {
      if (this.cdText) this.cdText.setVisible(false);
    }

    // ── Zone divider hint ──
    g.lineStyle(1, 0x444466, 0.25)
      .beginPath()
      .moveTo(this.W / 2, this.H - 100)
      .lineTo(this.W / 2, this.H)
      .strokePath();
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  onDown(ptr) {
    if (!this.started) return;

    if (!this.joy.active && ptr.x < this.W / 2) {
      this.joy = { active: true, pid: ptr.id, baseX: ptr.x, baseY: ptr.y, nx: 0, ny: 0 };
      this.joyBase.setPosition(ptr.x, ptr.y).setVisible(true);
      this.joyThumb.setPosition(ptr.x, ptr.y).setVisible(true);
    } else if (!this.hookPtr.active && ptr.x >= this.W / 2) {
      this.hookPtr = { active: true, pid: ptr.id };
      this.fireHook(ptr.x, ptr.y);
      this.hookDot.setPosition(ptr.x, ptr.y).setVisible(true);
    }
  }

  onMove(ptr) {
    if (this.joy.active && ptr.id === this.joy.pid) {
      const dx = ptr.x - this.joy.baseX;
      const dy = ptr.y - this.joy.baseY;
      const len = Math.sqrt(dx * dx + dy * dy);
      const maxR = 55;

      this.joy.nx = len > 5 ? dx / len : 0;
      this.joy.ny = len > 5 ? dy / len : 0;

      const tx = len > maxR ? this.joy.baseX + (dx / len) * maxR : ptr.x;
      const ty = len > maxR ? this.joy.baseY + (dy / len) * maxR : ptr.y;
      this.joyThumb.setPosition(tx, ty);

      this.socket.emit('input', { dx: this.joy.nx, dy: this.joy.ny });
    }

    if (this.hookPtr.active && ptr.id === this.hookPtr.pid) {
      this.hookDot.setPosition(ptr.x, ptr.y);
    }
  }

  onUp(ptr) {
    if (this.joy.active && ptr.id === this.joy.pid) {
      this.joy = { active: false, pid: -1, baseX: 0, baseY: 0, nx: 0, ny: 0 };
      this.joyBase.setVisible(false);
      this.joyThumb.setVisible(false);
      this.socket.emit('input', { dx: 0, dy: 0 });
    }
    if (this.hookPtr.active && ptr.id === this.hookPtr.pid) {
      this.hookPtr = { active: false, pid: -1 };
      this.hookDot.setVisible(false);
    }
  }

  fireHook(screenX, screenY) {
    const gameX = screenX / this.scaleX;
    const gameY = screenY / this.scaleY;
    this.socket.emit('input', { hookX: gameX, hookY: gameY });
  }

  // ── Overlay helpers ────────────────────────────────────────────────────────
  showGameOver(winner) {
    const W = this.W, H = this.H;
    const won = winner === this.myTeam;
    const isDraw = winner === -1;

    const overlay = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.7).setDepth(20);

    const msg = isDraw ? 'НИЧЬЯ' : won ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ';
    const col = isDraw ? '#f39c12' : won ? '#f1c40f' : '#e74c3c';

    this.add.text(W / 2, H / 2 - 30, msg, {
      fontSize: '56px', fontFamily: 'Arial Black', color: col,
      stroke: '#000', strokeThickness: 8,
    }).setOrigin(0.5).setDepth(21);

    if (!isDraw) {
      this.add.text(W / 2, H / 2 + 40, `${TEAM_NAMES[winner]} побеждают`, {
        fontSize: '22px', color: '#fff',
      }).setOrigin(0.5).setDepth(21);
    }

    this.time.delayedCall(4000, () => {
      this.socket?.disconnect();
      this.scene.start('MenuScene');
    });
  }

  showMessage(msg) {
    this.add.text(this.W / 2, this.H / 2, msg, {
      fontSize: '24px', color: '#fff', stroke: '#000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(20);
  }

  // ── Update loop ────────────────────────────────────────────────────────────
  update() {
    if (!this.started) return;
    this.renderState();
    this.renderHUD();
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────
function drawGrid(scene, W, H, step, color, alpha, gfx) {
  const g = gfx || scene.add.graphics();
  g.lineStyle(1, color, alpha);
  for (let x = 0; x <= W; x += step) {
    g.beginPath().moveTo(x, 0).lineTo(x, H).strokePath();
  }
  for (let y = 0; y <= H; y += step) {
    g.beginPath().moveTo(0, y).lineTo(W, y).strokePath();
  }
  return g;
}

// ── Phaser config ─────────────────────────────────────────────────────────────
new Phaser.Game({
  type: Phaser.AUTO,
  width:  window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#0d0d1a',
  scene: [MenuScene, GameScene],
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  input: { activePointers: 4 },
  parent: document.body,
  render: { antialias: true },
});
