// Snake Clash — Playdate-style 400x240 canvas game
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const W = 400, H = 240;
const GRID = 8;
const COLS = W / GRID; // 50
const ROWS = H / GRID; // 30
const GAME_DURATION = 180; // seconds before boss
const BOSS_WARN = 10;      // seconds of warning before boss

// ── Palette (1-bit style) ──────────────────────────────────────────
const BLACK = '#000';
const WHITE = '#fff';
const GRAY  = '#aaa';
const DKGRAY = '#444';

// ── Character definitions ──────────────────────────────────────────
const CHARACTERS = [
  {
    id: 0,
    name: 'VIPER',
    desc: 'Speed Burst',
    tip: 'Z: Dash forward 3 tiles',
    color: WHITE,
    headChar: 'V',
    baseSpeed: 200, // ms per move
    ability: 'dash',
    abilityCooldown: 5000,
  },
  {
    id: 1,
    name: 'CHOMPER',
    desc: 'Wide Bite',
    tip: 'Z: Eat adjacent tiles too',
    color: WHITE,
    headChar: 'C',
    baseSpeed: 240,
    ability: 'widebite',
    abilityCooldown: 6000,
  },
  {
    id: 2,
    name: 'SHIELD',
    desc: 'Barrier',
    tip: 'Z: Invincible for 2s',
    color: WHITE,
    headChar: 'S',
    baseSpeed: 220,
    ability: 'shield',
    abilityCooldown: 8000,
  },
];

// ── Game state ─────────────────────────────────────────────────────
let state = 'title';       // title | select | play | gameover | leaderboard
let player = null;
let enemies = [];
let boss = null;
let score = 0;
let highScores = loadScores();
let timeLeft = GAME_DURATION;
let lastTime = 0;
let dt = 0;
let bossSpawned = false;
let bossWarning = false;
let selectedChar = 0;
let enterNameMode = false;
let nameInput = '';
let mapSeed = 0;
let particles = [];

// ── Input ──────────────────────────────────────────────────────────
const keys = {};
const justPressed = {};
window.addEventListener('keydown', e => {
  if (!keys[e.code]) justPressed[e.code] = true;
  keys[e.code] = true;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) {
    e.preventDefault();
  }
  handleNameInput(e);
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

function consumeKey(code) {
  const v = justPressed[code];
  justPressed[code] = false;
  return v;
}

// ── Utilities ──────────────────────────────────────────────────────
function rng(seed) {
  // simple LCG for seeded random
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function randInt(r, min, max) { return Math.floor(r() * (max - min + 1)) + min; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function loadScores() {
  try { return JSON.parse(localStorage.getItem('snakeclash_scores') || '[]'); }
  catch { return []; }
}
function saveScore(name, pts) {
  highScores.push({ name: name.toUpperCase().slice(0, 6), score: pts });
  highScores.sort((a, b) => b.score - a.score);
  highScores = highScores.slice(0, 10);
  localStorage.setItem('snakeclash_scores', JSON.stringify(highScores));
}

// ── Snake class ────────────────────────────────────────────────────
class Snake {
  constructor(x, y, dir, length, speed, color, isPlayer = false, charDef = null) {
    this.segments = [];
    for (let i = 0; i < length; i++) {
      this.segments.push({ x: x - i * dirVec(dir).x, y: y - i * dirVec(dir).y });
    }
    this.dir = dir;         // 'up'|'down'|'left'|'right'
    this.nextDir = dir;
    this.speed = speed;     // ms per move
    this.moveTimer = 0;
    this.color = color;
    this.isPlayer = isPlayer;
    this.charDef = charDef;
    this.alive = true;
    this.eatProgress = 0;   // sections eaten from tail
    this.totalSections = length;
    this.abilityTimer = 0;
    this.abilityCooldown = charDef ? charDef.abilityCooldown : 0;
    this.abilityActive = false;
    this.abilityDuration = 0;
    this.shielded = false;
    this.wideBite = false;
    this.points = length * 10; // score value when fully eaten
    this.isBoss = false;
  }

  get head() { return this.segments[0]; }
  get length() { return this.segments.length; }

  turnTo(d) {
    const opposites = { up:'down', down:'up', left:'right', right:'left' };
    if (opposites[this.dir] !== d) this.nextDir = d;
  }

  useAbility() {
    if (!this.charDef) return;
    if (this.abilityTimer > 0) return;
    const ability = this.charDef.ability;
    this.abilityTimer = this.charDef.abilityCooldown;
    if (ability === 'dash') {
      for (let i = 0; i < 3; i++) this.stepMove();
    } else if (ability === 'widebite') {
      this.wideBite = true;
      this.abilityDuration = 3000;
      this.abilityActive = true;
    } else if (ability === 'shield') {
      this.shielded = true;
      this.abilityDuration = 2000;
      this.abilityActive = true;
    }
    spawnParticles(this.head.x, this.head.y, 6, WHITE);
  }

  stepMove() {
    this.dir = this.nextDir;
    const v = dirVec(this.dir);
    const nx = ((this.head.x + v.x) + COLS) % COLS;
    const ny = ((this.head.y + v.y) + ROWS) % ROWS;
    this.segments.unshift({ x: nx, y: ny });
    this.segments.pop();
  }

  update(delta) {
    if (!this.alive) return;
    this.moveTimer += delta;
    const spd = (this.charDef?.ability === 'dash' && this.abilityActive) ? this.speed * 0.4 : this.speed;
    if (this.moveTimer >= spd) {
      this.moveTimer -= spd;
      this.stepMove();
    }
    if (this.abilityActive) {
      this.abilityDuration -= delta;
      if (this.abilityDuration <= 0) {
        this.abilityActive = false;
        this.shielded = false;
        this.wideBite = false;
      }
    }
    if (this.abilityTimer > 0) {
      this.abilityTimer = Math.max(0, this.abilityTimer - delta);
    }
  }

  draw() {
    if (!this.alive) return;
    const flash = this.shielded && Math.floor(Date.now() / 100) % 2 === 0;

    if (this.isPlayer) {
      // Player body: white filled with black border, checkerboard pattern
      for (let i = 1; i < this.segments.length; i++) {
        const s = this.segments[i];
        const checker = (i % 2 === 0);
        ctx.fillStyle = checker ? WHITE : GRAY;
        ctx.fillRect(s.x * GRID + 1, s.y * GRID + 1, GRID - 2, GRID - 2);
        ctx.strokeStyle = BLACK;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(s.x * GRID + 1, s.y * GRID + 1, GRID - 2, GRID - 2);
      }

      // Player head: larger, white, with black letter
      const h = this.head;
      const hx = h.x * GRID, hy = h.y * GRID;
      // Glow ring
      if (!flash) {
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(hx - 2, hy - 2, GRID + 4, GRID + 4);
      }
      ctx.fillStyle = flash ? GRAY : WHITE;
      ctx.fillRect(hx - 1, hy - 1, GRID + 2, GRID + 2);
      ctx.fillStyle = BLACK;
      ctx.font = 'bold 7px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(this.charDef.headChar, hx + GRID / 2, hy + GRID - 1);

      // Arrow above head pointing in movement direction
      const arrowOffset = { up: [0,-4], down: [0, GRID+4], left: [-4, GRID/2], right: [GRID+4, GRID/2] };
      const [ax, ay] = arrowOffset[this.dir] || [0, -4];
      ctx.fillStyle = WHITE;
      ctx.beginPath();
      if (this.dir === 'up')    { ctx.moveTo(hx+GRID/2, hy+ay-3); ctx.lineTo(hx+GRID/2-3, hy+ay+3); ctx.lineTo(hx+GRID/2+3, hy+ay+3); }
      if (this.dir === 'down')  { ctx.moveTo(hx+GRID/2, hy+ay+3); ctx.lineTo(hx+GRID/2-3, hy+ay-3); ctx.lineTo(hx+GRID/2+3, hy+ay-3); }
      if (this.dir === 'left')  { ctx.moveTo(hx+ax-3, hy+ay);   ctx.lineTo(hx+ax+3, hy+ay-3); ctx.lineTo(hx+ax+3, hy+ay+3); }
      if (this.dir === 'right') { ctx.moveTo(hx+ax+3, hy+ay);   ctx.lineTo(hx+ax-3, hy+ay-3); ctx.lineTo(hx+ax-3, hy+ay+3); }
      ctx.closePath();
      ctx.fill();
    } else {
      // Enemy body: simple small squares
      ctx.fillStyle = flash ? GRAY : this.color;
      for (let i = 1; i < this.segments.length; i++) {
        const s = this.segments[i];
        ctx.fillRect(s.x * GRID + 2, s.y * GRID + 2, GRID - 4, GRID - 4);
      }
      // Enemy head
      const h = this.head;
      ctx.fillStyle = this.isBoss ? WHITE : GRAY;
      ctx.fillRect(h.x * GRID + 1, h.y * GRID + 1, GRID - 2, GRID - 2);

      // Eaten-progress overlay (dimmed tail sections)
      if (this.eatProgress > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        const start = this.segments.length - this.eatProgress;
        for (let i = Math.max(1, start); i < this.segments.length; i++) {
          const s = this.segments[i];
          ctx.fillRect(s.x * GRID + 2, s.y * GRID + 2, GRID - 4, GRID - 4);
        }
      }
    }
  }
}

function dirVec(d) {
  return { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} }[d];
}

// ── Particles ──────────────────────────────────────────────────────
function spawnParticles(gx, gy, n, color) {
  for (let i = 0; i < n; i++) {
    particles.push({
      x: gx * GRID + GRID / 2, y: gy * GRID + GRID / 2,
      vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 60,
      life: 400, maxLife: 400, color
    });
  }
}

function updateParticles(delta) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * delta / 1000;
    p.y += p.vy * delta / 1000;
    p.life -= delta;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function drawParticles() {
  for (const p of particles) {
    const alpha = p.life / p.maxLife;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
  }
  ctx.globalAlpha = 1;
}

// ── Map / enemy spawning ───────────────────────────────────────────
const ENEMY_CONFIGS = [
  { length: 3, speed: 320, points: 30 },
  { length: 5, speed: 290, points: 60 },
  { length: 8, speed: 260, points: 100 },
  { length: 12, speed: 340, points: 150 },
];

const DIRS = ['up','down','left','right'];

function spawnEnemies(r, count) {
  enemies = [];
  for (let i = 0; i < count; i++) {
    spawnOneEnemy(r);
  }
}

function spawnOneEnemy(r) {
  if (!r) r = rng(Math.random() * 99999 | 0);
  const cfg = ENEMY_CONFIGS[randInt(r, 0, ENEMY_CONFIGS.length - 1)];
  const dir = DIRS[randInt(r, 0, 3)];
  let x, y, attempts = 0;
  do {
    x = randInt(r, 2, COLS - 3);
    y = randInt(r, 2, ROWS - 3);
    attempts++;
  } while (attempts < 20 && isTooClose(x, y, 6));
  const e = new Snake(x, y, dir, cfg.length, cfg.speed, WHITE);
  e.points = cfg.points;
  enemies.push(e);
}

function isTooClose(x, y, dist) {
  if (player && Math.abs(player.head.x - x) < dist && Math.abs(player.head.y - y) < dist) return true;
  for (const e of enemies) {
    if (Math.abs(e.head.x - x) < dist && Math.abs(e.head.y - y) < dist) return true;
  }
  return false;
}

// ── Boss ───────────────────────────────────────────────────────────
function spawnBoss(r) {
  const bx = randInt(r, 10, COLS - 10);
  const by = randInt(r, 5, ROWS - 5);
  boss = new Snake(bx, by, 'right', 20, 250, WHITE);
  boss.isBoss = true;
  boss.points = 500;
  // Boss AI: chases player
  boss.aiTimer = 0;
}

function updateBossAI(delta) {
  if (!boss || !boss.alive || !player || !player.alive) return;
  boss.aiTimer = (boss.aiTimer || 0) + delta;
  if (boss.aiTimer > 600) {
    boss.aiTimer = 0;
    const dx = player.head.x - boss.head.x;
    const dy = player.head.y - boss.head.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      boss.turnTo(dx > 0 ? 'right' : 'left');
    } else {
      boss.turnTo(dy > 0 ? 'down' : 'up');
    }
  }
}

// ── Enemy AI ───────────────────────────────────────────────────────
function updateEnemyAI(e, delta) {
  e.aiTimer = (e.aiTimer || 0) + delta;
  const interval = 800 + Math.random() * 400;
  if (e.aiTimer > interval) {
    e.aiTimer = 0;
    // Occasionally turn randomly, slight bias toward player
    if (Math.random() < 0.3 && player) {
      const dx = player.head.x - e.head.x;
      const dy = player.head.y - e.head.y;
      if (Math.abs(dx) > Math.abs(dy)) e.turnTo(dx > 0 ? 'right' : 'left');
      else e.turnTo(dy > 0 ? 'down' : 'up');
    } else {
      e.turnTo(DIRS[Math.floor(Math.random() * 4)]);
    }
  }
}

// ── Collision detection ────────────────────────────────────────────
function checkCollisions() {
  if (!player || !player.alive) return;
  const ph = player.head;

  // Player eats enemy tail sections
  const allSnakes = [...enemies, ...(boss ? [boss] : [])];
  for (const e of allSnakes) {
    if (!e.alive) continue;
    // Check if player head overlaps enemy tail
    for (let i = e.segments.length - 1; i >= 1; i--) {
      const s = e.segments[i];
      if (s.x === ph.x && s.y === ph.y) {
        eatSection(e, i);
        return;
      }
    }
    // Wide bite: also check neighbors
    if (player.wideBite) {
      const neighbors = [
        { x: ph.x + 1, y: ph.y }, { x: ph.x - 1, y: ph.y },
        { x: ph.x, y: ph.y + 1 }, { x: ph.x, y: ph.y - 1 },
      ];
      for (const nb of neighbors) {
        for (let i = e.segments.length - 1; i >= 1; i--) {
          const s = e.segments[i];
          if (s.x === nb.x && s.y === nb.y) {
            eatSection(e, i);
            return;
          }
        }
      }
    }
    // Player head hits enemy head → die (unless shielded)
    if (e.head.x === ph.x && e.head.y === ph.y) {
      if (!player.shielded) killPlayer();
      return;
    }
  }

  // Player hits own body
  for (let i = 4; i < player.segments.length; i++) {
    const s = player.segments[i];
    if (s.x === ph.x && s.y === ph.y) {
      if (!player.shielded) killPlayer();
      return;
    }
  }
}

function eatSection(enemy, segIndex) {
  enemy.eatProgress++;
  score += 10;
  spawnParticles(enemy.segments[segIndex].x, enemy.segments[segIndex].y, 3, WHITE);
  // Remove the eaten section
  enemy.segments.splice(segIndex, 1);
  if (enemy.segments.length <= 1) {
    // Fully eaten
    score += enemy.points;
    spawnParticles(enemy.head.x, enemy.head.y, 10, WHITE);
    enemy.alive = false;
    if (enemy === boss) {
      boss = null;
      score += 500;
    }
  }
}

function killPlayer() {
  player.alive = false;
  spawnParticles(player.head.x, player.head.y, 20, WHITE);
  setTimeout(() => { endGame(); }, 800);
}

function endGame() {
  // Check if qualifies for leaderboard
  const minScore = highScores.length < 10 ? 0 : (highScores[9]?.score || 0);
  if (score > minScore) {
    enterNameMode = true;
    nameInput = '';
  }
  state = 'gameover';
}

// ── Name entry ─────────────────────────────────────────────────────
function handleNameInput(e) {
  if (state !== 'gameover' || !enterNameMode) return;
  if (e.key === 'Enter') {
    if (nameInput.length > 0) {
      saveScore(nameInput, score);
      enterNameMode = false;
    }
  } else if (e.key === 'Backspace') {
    nameInput = nameInput.slice(0, -1);
  } else if (/^[a-zA-Z0-9]$/.test(e.key) && nameInput.length < 6) {
    nameInput += e.key.toUpperCase();
  }
}

// ── Game initialization ────────────────────────────────────────────
function startGame(charIndex) {
  const def = CHARACTERS[charIndex];
  mapSeed = Math.random() * 99999 | 0;
  const r = rng(mapSeed);

  score = 0;
  timeLeft = GAME_DURATION;
  bossSpawned = false;
  bossWarning = false;
  boss = null;
  particles = [];

  // Place player in center
  player = new Snake(COLS / 2 | 0, ROWS / 2 | 0, 'right', 4, def.baseSpeed, WHITE, true, def);

  spawnEnemies(r, 4);
  state = 'play';
}

// ── Input handling during play ─────────────────────────────────────
function handlePlayInput() {
  if (!player || !player.alive) return;
  if (consumeKey('ArrowUp'))    player.turnTo('up');
  if (consumeKey('ArrowDown'))  player.turnTo('down');
  if (consumeKey('ArrowLeft'))  player.turnTo('left');
  if (consumeKey('ArrowRight')) player.turnTo('right');
  if (consumeKey('KeyZ') || consumeKey('KeyX')) player.useAbility();
}

// ── Draw routines ──────────────────────────────────────────────────
function drawGrid() {
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 0.5;
  for (let x = 0; x < W; x += GRID) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += GRID) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
}

function drawHUD() {
  ctx.fillStyle = WHITE;
  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`SCORE ${score}`, 4, 10);

  // Timer
  const mins = Math.floor(timeLeft / 60);
  const secs = Math.floor(timeLeft % 60);
  const tStr = `${mins}:${secs.toString().padStart(2,'0')}`;
  ctx.textAlign = 'center';

  if (bossWarning && Math.floor(Date.now() / 300) % 2 === 0) {
    ctx.fillStyle = WHITE;
    ctx.fillText('!! BOSS INCOMING !!', W / 2, 10);
  } else {
    ctx.fillStyle = timeLeft < 30 && Math.floor(Date.now() / 500) % 2 === 0 ? GRAY : WHITE;
    ctx.fillText(tStr, W / 2, 10);
  }

  // Ability cooldown
  if (player && player.charDef) {
    ctx.textAlign = 'right';
    ctx.fillStyle = WHITE;
    ctx.font = '7px monospace';
    if (player.abilityTimer > 0) {
      const pct = 1 - player.abilityTimer / player.charDef.abilityCooldown;
      const barW = 40;
      ctx.fillStyle = DKGRAY;
      ctx.fillRect(W - 4 - barW, 4, barW, 5);
      ctx.fillStyle = WHITE;
      ctx.fillRect(W - 4 - barW, 4, barW * pct, 5);
      ctx.fillStyle = DKGRAY;
      ctx.fillText('Z CD', W - 6, 10);
    } else {
      ctx.fillStyle = WHITE;
      ctx.fillText('Z RDY', W - 6, 10);
    }
    if (player.abilityActive) {
      ctx.textAlign = 'center';
      ctx.fillStyle = WHITE;
      ctx.fillText(player.charDef.desc.toUpperCase() + '!', W / 2, H - 4);
    }
  }

  // Enemy count
  const alive = enemies.filter(e => e.alive).length;
  ctx.textAlign = 'left';
  ctx.fillStyle = GRAY;
  ctx.font = '7px monospace';
  ctx.fillText(`SNAKES ${alive}`, 4, H - 4);

  // Boss health bar
  if (boss && boss.alive) {
    const pct = boss.segments.length / 20;
    ctx.fillStyle = DKGRAY;
    ctx.fillRect(W / 2 - 40, H - 10, 80, 5);
    ctx.fillStyle = WHITE;
    ctx.fillRect(W / 2 - 40, H - 10, 80 * pct, 5);
    ctx.fillStyle = WHITE;
    ctx.font = '6px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('BOSS', W / 2, H - 3);
  }

  // Shield indicator
  if (player && player.shielded) {
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 1;
    ctx.strokeRect(player.head.x * GRID - 1, player.head.y * GRID - 1, GRID + 2, GRID + 2);
  }
}

function drawTitle() {
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, W, H);

  // Decorative snake border
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 1;
  ctx.strokeRect(2, 2, W - 4, H - 4);

  ctx.fillStyle = WHITE;
  ctx.font = 'bold 24px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('SNAKE CLASH', W / 2, 70);

  ctx.font = '8px monospace';
  ctx.fillStyle = GRAY;
  ctx.fillText('EAT OR BE EATEN', W / 2, 88);

  // Animated snake decoration
  const t = Date.now() / 600;
  for (let i = 0; i < 8; i++) {
    const x = 60 + i * 35 + Math.sin(t + i) * 4;
    const y = 110 + Math.sin(t + i * 0.8) * 8;
    ctx.fillStyle = i === 0 ? WHITE : GRAY;
    ctx.fillRect(x - 4, y - 4, 8, 8);
  }

  ctx.fillStyle = WHITE;
  ctx.font = '8px monospace';
  ctx.fillText('PRESS ENTER', W / 2, 150);

  ctx.fillStyle = GRAY;
  ctx.font = '7px monospace';
  ctx.fillText('3 MINUTES UNTIL THE BOSS', W / 2, 170);
  ctx.fillText('EAT ENEMY TAILS TO SCORE', W / 2, 180);

  if (highScores.length > 0) {
    ctx.fillStyle = WHITE;
    ctx.font = '7px monospace';
    ctx.fillText(`HI-SCORE: ${highScores[0].score} ${highScores[0].name}`, W / 2, 200);
  }

  if (consumeKey('Enter')) state = 'select';
}

function drawSelect() {
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 1;
  ctx.strokeRect(2, 2, W - 4, H - 4);

  ctx.fillStyle = WHITE;
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('CHOOSE YOUR SNAKE', W / 2, 20);

  const boxW = 100, boxH = 100;
  const startX = (W - CHARACTERS.length * boxW - (CHARACTERS.length - 1) * 10) / 2;

  for (let i = 0; i < CHARACTERS.length; i++) {
    const ch = CHARACTERS[i];
    const bx = startX + i * (boxW + 10);
    const by = 30;
    const selected = selectedChar === i;

    ctx.strokeStyle = selected ? WHITE : DKGRAY;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(bx, by, boxW, boxH);
    ctx.fillStyle = selected ? WHITE : DKGRAY;
    ctx.fillRect(bx, by, boxW, boxH);

    ctx.fillStyle = selected ? BLACK : GRAY;
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(ch.headChar, bx + boxW / 2, by + 22);

    ctx.font = 'bold 8px monospace';
    ctx.fillText(ch.name, bx + boxW / 2, by + 38);

    ctx.font = '7px monospace';
    ctx.fillStyle = selected ? '#333' : '#666';
    ctx.fillText(ch.desc, bx + boxW / 2, by + 52);

    // Wrap tip text
    const words = ch.tip.split(' ');
    let line = '';
    let ly = by + 66;
    for (const w of words) {
      const test = line + (line ? ' ' : '') + w;
      if (ctx.measureText(test).width > boxW - 8) {
        ctx.fillText(line, bx + boxW / 2, ly);
        line = w; ly += 10;
      } else { line = test; }
    }
    if (line) ctx.fillText(line, bx + boxW / 2, ly);

    // Speed indicator
    const speedLabel = ch.baseSpeed <= 120 ? 'SPD ●●●' : ch.baseSpeed <= 140 ? 'SPD ●●○' : 'SPD ●○○';
    ctx.fillStyle = selected ? '#333' : '#555';
    ctx.font = '6px monospace';
    ctx.fillText(speedLabel, bx + boxW / 2, by + boxH - 8);
  }

  ctx.fillStyle = WHITE;
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← → TO SELECT   ENTER TO START', W / 2, H - 10);

  if (consumeKey('ArrowLeft'))  selectedChar = (selectedChar - 1 + 3) % 3;
  if (consumeKey('ArrowRight')) selectedChar = (selectedChar + 1) % 3;
  if (consumeKey('Enter'))      startGame(selectedChar);
}

function drawGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = WHITE;
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('GAME OVER', W / 2, 60);

  ctx.font = '10px monospace';
  ctx.fillText(`SCORE: ${score}`, W / 2, 82);

  if (enterNameMode) {
    ctx.font = '8px monospace';
    ctx.fillStyle = GRAY;
    ctx.fillText('NEW HIGH SCORE! ENTER NAME:', W / 2, 108);
    ctx.fillStyle = WHITE;
    ctx.font = 'bold 14px monospace';
    ctx.fillText(nameInput + (Math.floor(Date.now() / 400) % 2 === 0 ? '_' : ' '), W / 2, 128);
    ctx.font = '7px monospace';
    ctx.fillStyle = GRAY;
    ctx.fillText('LETTERS/NUMBERS + ENTER', W / 2, 145);
  } else {
    drawLeaderboard(160);
    ctx.fillStyle = WHITE;
    ctx.font = '8px monospace';
    ctx.fillText('ENTER — PLAY AGAIN    L — LEADERBOARD', W / 2, H - 10);
    if (consumeKey('Enter')) { state = 'select'; }
    if (consumeKey('KeyL'))  { state = 'leaderboard'; }
  }
}

function drawLeaderboard(yStart) {
  ctx.fillStyle = WHITE;
  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('HIGH SCORES', W / 2, yStart);
  ctx.font = '7px monospace';
  const show = highScores.slice(0, 5);
  for (let i = 0; i < show.length; i++) {
    const hs = show[i];
    ctx.fillStyle = i === 0 ? WHITE : GRAY;
    ctx.fillText(`${i + 1}. ${hs.name.padEnd(6)} ${hs.score}`, W / 2, yStart + 14 + i * 11);
  }
}

function drawLeaderboardScreen() {
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 1;
  ctx.strokeRect(2, 2, W - 4, H - 4);

  ctx.fillStyle = WHITE;
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('LEADERBOARD', W / 2, 22);

  ctx.font = '8px monospace';
  const show = highScores.slice(0, 10);
  for (let i = 0; i < show.length; i++) {
    const hs = show[i];
    ctx.fillStyle = i === 0 ? WHITE : GRAY;
    ctx.textAlign = 'left';
    ctx.fillText(`${(i + 1).toString().padStart(2)}. ${hs.name.padEnd(6)}  ${hs.score}`, W / 2 - 60, 40 + i * 16);
  }
  if (show.length === 0) {
    ctx.fillStyle = GRAY;
    ctx.textAlign = 'center';
    ctx.fillText('NO SCORES YET', W / 2, 100);
  }

  ctx.fillStyle = WHITE;
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('ENTER — BACK', W / 2, H - 10);
  if (consumeKey('Enter')) state = 'title';
}

// ── Main update ────────────────────────────────────────────────────
function update(delta) {
  if (state !== 'play') return;

  handlePlayInput();

  // Timer
  timeLeft -= delta / 1000;
  if (timeLeft < 0) timeLeft = 0;

  if (!bossSpawned && timeLeft <= BOSS_WARN) bossWarning = true;
  if (!bossSpawned && timeLeft <= 0) {
    bossSpawned = true;
    bossWarning = false;
    const r = rng(mapSeed + 1);
    spawnBoss(r);
  }

  // Respawn enemies if too few
  if (enemies.filter(e => e.alive).length < 3) {
    spawnOneEnemy(null);
  }

  if (player && player.alive) player.update(delta);
  for (const e of enemies) {
    if (!e.alive) continue;
    updateEnemyAI(e, delta);
    e.update(delta);
  }
  if (boss && boss.alive) {
    updateBossAI(delta);
    boss.update(delta);
  }

  checkCollisions();
  updateParticles(delta);
}

// ── Main draw ──────────────────────────────────────────────────────
function draw() {
  if (state === 'title') { drawTitle(); return; }
  if (state === 'select') { drawSelect(); return; }
  if (state === 'gameover') {
    drawGrid();
    drawParticles();
    drawGameOver();
    return;
  }
  if (state === 'leaderboard') { drawLeaderboardScreen(); return; }

  // Play
  drawGrid();
  for (const e of enemies) e.draw();
  if (boss) boss.draw();
  if (player) player.draw();
  drawParticles();
  drawHUD();
}

// ── Game loop ──────────────────────────────────────────────────────
function loop(ts) {
  dt = ts - lastTime;
  lastTime = ts;
  if (dt > 100) dt = 100; // clamp for tab-switch

  update(dt);
  draw();

  // Clear justPressed at end of frame
  for (const k in justPressed) justPressed[k] = false;

  requestAnimationFrame(loop);
}

requestAnimationFrame(ts => { lastTime = ts; requestAnimationFrame(loop); });
