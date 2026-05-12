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
class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  init(data) {
    this.mode = data?.mode || 'pvp';
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
    g.fillStyle(0x0d0d1a).fillRect(0, 0, this.W, this.H);
    drawGrid(this, this.W, this.H, 50, 0x1a1a2e, 0.5, g);

    // Team zones (subtle)
    g.fillStyle(TEAM_COLORS[0], 0.06).fillRect(0, 0, this.W / 2, this.H);
    g.fillStyle(TEAM_COLORS[1], 0.06).fillRect(this.W / 2, 0, this.W / 2, this.H);

    // Obstacles
    const og = this.obstGfx;
    og.clear();
    for (const o of this.obstacles) {
      const ox = o.x * this.scaleX, oy = o.y * this.scaleY;
      const ow = o.w * this.scaleX, oh = o.h * this.scaleY;
      og.fillStyle(0x2c3e50).fillRect(ox - ow / 2, oy - oh / 2, ow, oh);
      og.lineStyle(2, 0x34495e, 1).strokeRect(ox - ow / 2, oy - oh / 2, ow, oh);
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

      if (!p.alive) {
        pg.lineStyle(2, color, 0.3).strokeCircle(px, py, r);
        pg.fillStyle(0x000000, 0.5).fillCircle(px, py, r);
        this.setNameText(p.id, px, py + r + 5, `💀 ${p.name}`, '#666666');
        continue;
      }

      // Shadow
      pg.fillStyle(0x000000, 0.35).fillEllipse(px + 3, py + 5, r * 1.8, r * 0.8);

      // Body
      const bodyColor = flash ? 0xffffff : color;
      pg.fillStyle(bodyColor, 1).fillCircle(px, py, r);

      // Me indicator ring
      if (isMe) {
        pg.lineStyle(3, 0xffffff, 0.9).strokeCircle(px, py, r + 4);
      }

      // HP pips
      for (let i = 0; i < 2; i++) {
        const pipX = px + (i === 0 ? -8 : 8) * this.scaleX;
        const pipY = py - (r + 10);
        const filled = i < p.hp;
        pg.fillStyle(filled ? 0xff4444 : 0x333333, 1).fillCircle(pipX, pipY, 5);
        pg.lineStyle(1, 0x000, 0.5).strokeCircle(pipX, pipY, 5);
      }

      // Hook ready indicator
      const hookReady = p.hookCooldown <= 0;
      pg.fillStyle(hookReady ? 0x2ecc71 : 0xe74c3c, 1)
        .fillCircle(px, py - r - 18, 4);

      // Name
      this.setNameText(p.id, px, py + r + 4,
        (isMe ? '▶ ' : '') + p.name,
        isMe ? '#ffffff' : '#cccccc');
    }
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
