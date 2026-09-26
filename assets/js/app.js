/**
 * CHESS — phase 1 app: board, input, clocks, vs-AI, i18n, themes.
 *
 * The rules come from assets/js/engine.js, the one engine proven by perft AND
 * by a SAN/PGN suite in both JavaScript and PHP. This file draws and dispatches;
 * it never decides what a legal move is.
 *
 * Board geometry lives in geom()/squareAt()/sqEl() and is the only place that
 * knows about the flip. Getting it wrong maps clicks onto the wrong squares, so
 * it is written once, explicitly, and used everywhere.
 *
 * @author DALI951
 */
import { Chess, WHITE, BLACK, typeOf, colorOf, fromAlgebraic } from './engine.js';
import { pieceMarkup, GLYPH } from './pieces.js';
import { loadLang, applyLang, t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const FILES = 'abcdefgh';

const S = {
  lang: loadLang(),
  chess: new Chess(),
  flipped: false,
  mode: 'ai',
  playerColor: WHITE,
  thinking: false,
  over: false,
  selected: null,
  targets: new Map(),      // target square -> legal moves that reach it
  cursor: 'e2',
  dragFrom: null,
  evalCp: null,
  aiInfo: '',
  clock: { w: 600, b: 600, inc: 0, unlimited: false, raw: '600', timer: null, running: false, last: 0 },
};

let worker = null;
let searchId = 0;

// exposed for the smoke test and for poking at the game from the console
window.__chess = S;

// ── geometry ────────────────────────────────────────────────────────────────
/** Grid row r, column f -> { rank, file } as 0-based indices. */
const geom = (r, f) => ({
  rank: S.flipped ? r : 7 - r,     // unflipped: the bottom row is rank 1
  file: S.flipped ? 7 - f : f,     // unflipped: the left column is the a-file
});

const squareAt = (r, f) => {
  const g = geom(r, f);
  return FILES[g.file] + (g.rank + 1);
};

/** The DOM cell that currently DISPLAYS a square (flip-aware). */
function sqEl(name) {
  const rank = Number(name[1]) - 1;
  const file = FILES.indexOf(name[0]);
  const r = S.flipped ? rank : 7 - rank;
  const f = S.flipped ? 7 - file : file;
  return $('board').children[r * 8 + f];
}

// ── sound ───────────────────────────────────────────────────────────────────
let actx = null;
const SFX = {
  move: [[520, 0.03]],
  capture: [[220, 0.05], [170, 0.05]],
  check: [[700, 0.05], [900, 0.08]],
  win: [[523, 0.09], [659, 0.09], [784, 0.18]],
  lose: [[392, 0.12], [280, 0.22]],
  click: [[900, 0.014]],
};
function blip(kind) {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    let at = actx.currentTime;
    for (const [hz, dur] of SFX[kind] || SFX.move) {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = 'triangle';
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.13, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(actx.destination);
      o.start(at);
      o.stop(at + dur + 0.02);
      at += dur;
    }
  } catch { /* audio is a nicety, never a blocker */ }
}

// ── board ───────────────────────────────────────────────────────────────────
function buildBoard() {
  const board = $('board');
  board.textContent = '';
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = document.createElement('div');
      sq.className = 'sq';
      sq.dataset.r = r;
      sq.dataset.f = f;
      board.appendChild(sq);
    }
  }
}

function render() {
  const history = S.chess.history({ verbose: true });
  const last = history.length ? history[history.length - 1] : null;
  const checked = S.chess.inCheck() ? S.chess.kingSquare(S.chess.turnColor()) : null;
  const sans = S.chess.history();

  for (const el of $('board').children) {
    const r = +el.dataset.r;
    const f = +el.dataset.f;
    const name = squareAt(r, f);
    const g = geom(r, f);
    const piece = S.chess.get(fromAlgebraic(name));

    el.style.visibility = '';
    el.className = 'sq ' + ((r + f) % 2 === 0 ? 'sq-light' : 'sq-dark');
    if (last && (last.from === name || last.to === name)) el.classList.add('last');
    if (name === S.selected) el.classList.add('sel');
    if (name === checked) el.classList.add('check');
    if (!S.selected && name === S.cursor) el.classList.add('cursor');
    el.textContent = '';

    if (S.selected && S.targets.has(name)) {
      const mark = document.createElement('i');
      mark.className = piece ? 'ring' : 'dot';
      el.appendChild(mark);
    }
    if (piece) {
      el.insertAdjacentHTML('beforeend', pieceMarkup(colorOf(piece) === WHITE ? 'w' : 'b', typeOf(piece)));
    }
    // coordinates live on the viewer's left and bottom edges, so they follow
    // the FLIP and not the a-file: anchoring them to the a-file made the letters
    // jump to the other side of the board
    if (f === 0) {                                 // leftmost column
      const c = document.createElement('span');
      c.className = 'coord file';
      c.textContent = FILES[g.file];
      el.appendChild(c);
    }
    if (r === 7) {                                 // bottom row
      const c = document.createElement('span');
      c.className = 'coord rank';
      c.textContent = String(g.rank + 1);
      el.appendChild(c);
    }
  }
  renderMoves(sans);
  $('statMoves').textContent = String(sans.length);
}

function renderMoves(moves) {
  const list = $('moveList');
  list.textContent = '';
  if (!moves.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '—';
    list.appendChild(e);
    return;
  }
  moves.forEach((mv, i) => {
    if (i % 2 === 0) {
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = `${i / 2 + 1}.`;
      list.appendChild(n);
    }
    const cell = document.createElement('span');
    cell.className = 'm';
    cell.textContent = mv.san;
    if (i === moves.length - 1) cell.classList.add('last');
    list.appendChild(cell);
  });
  list.scrollTop = list.scrollHeight;
}

// ── making moves ────────────────────────────────────────────────────────────
function humanToMove() {
  if (S.over || S.thinking) return false;
  return S.mode === 'duo' || S.chess.turnColor() === S.playerColor;
}

function canPick(name) {
  const piece = S.chess.get(fromAlgebraic(name));
  return !!piece && (S.mode === 'duo' || (colorOf(piece) === S.playerColor && S.chess.turnColor() === S.playerColor));
}

function select(name) {
  S.selected = name;
  S.targets = new Map();
  if (name) {
    for (const mv of S.chess.moves()) {
      if (mv.from !== name) continue;
      if (!S.targets.has(mv.to)) S.targets.set(mv.to, []);
      S.targets.get(mv.to).push(mv);
    }
  }
  render();
}

/**
 * Try to move from -> to. The promotion argument is passed ONLY when the target
 * is unambiguous: a pawn reaching the last rank has four legal moves to the same
 * square, and handing in one of them forced the move to queen and made the
 * promotion picker unreachable.
 */
function tryTarget(from, to) {
  const legal = S.chess.moves().filter((m) => m.from === from && m.to === to);
  if (!legal.length) { render(); return false; }
  return playMove(from, to, legal.length === 1 ? legal[0].promotion : undefined);
}

function playMove(from, to, promotion) {
  const legal = S.chess.moves().filter((m) => m.from === from && m.to === to);
  if (!legal.length) return false;
  if (!promotion && legal.length > 1) return askPromotion(from, to, legal);
  const mv = S.chess.move({ from, to, promotion: promotion || legal[0].promotion });
  S.selected = null;
  S.targets = new Map();
  blip(mv.san.includes('x') ? 'capture' : 'move');
  afterMove();
  return true;
}

function askPromotion(from, to, legal) {
  const board = $('board');
  const host = sqEl(to);
  const box = document.createElement('div');
  box.className = 'promo';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', t(S.lang, 'promoTitle'));
  const order = { q: '♕', r: '♖', b: '♗', n: '♘' };
  for (const mv of legal) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = order[mv.promotion] || '♕';
    btn.setAttribute('aria-label', mv.promotion.toUpperCase());
    btn.onclick = () => {
      box.remove();
      document.removeEventListener('keydown', onKey);
      playMove(from, to, mv.promotion);
    };
    box.appendChild(btn);
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', onKey); render(); }
  };
  document.addEventListener('keydown', onKey);
  board.appendChild(box);

  // centre it on the target square, then clamp INSIDE the board: the board
  // clips its overflow, so anything hanging over an edge loses its hit area
  const pad = 6;
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  const left = Math.min(board.clientWidth - w - pad, Math.max(pad, host.offsetLeft + host.offsetWidth / 2 - w / 2));
  const top = Math.min(board.clientHeight - h - pad, Math.max(pad, host.offsetTop + host.offsetHeight / 2 - h / 2));
  box.style.left = left + 'px';
  box.style.top = top + 'px';
  box.firstElementChild?.focus();
  return false;
}

// ── pointer input: tap-tap everywhere, drag as well for the mouse ───────────
let dragEl = null;

$('board').addEventListener('pointerdown', (ev) => {
  if (!humanToMove()) return;
  const sq = ev.target.closest('.sq');
  if (!sq) return;
  const name = squareAt(+sq.dataset.r, +sq.dataset.f);
  blip('click');

  if (S.selected && S.targets.has(name)) {
    tryTarget(S.selected, name);
    return;
  }
  if (!canPick(name)) { select(null); return; }
  select(name);

  if (ev.pointerType !== 'mouse') return;      // touch: tap, then tap the target
  const piece = sqEl(name).querySelector('.piece');
  if (!piece) return;
  dragEl = piece.cloneNode(true);
  dragEl.classList.add('drag');
  dragEl.style.width = sq.clientWidth + 'px';
  dragEl.style.height = sq.clientHeight + 'px';
  document.body.appendChild(dragEl);
  sqEl(name).style.visibility = 'hidden';
  S.dragFrom = name;
  moveDrag(ev);
});

function moveDrag(ev) {
  if (!dragEl) return;
  dragEl.style.left = ev.clientX - dragEl.offsetWidth / 2 + 'px';
  dragEl.style.top = ev.clientY - dragEl.offsetHeight / 2 + 'px';
}

document.addEventListener('pointermove', (ev) => { if (dragEl) { ev.preventDefault(); moveDrag(ev); } });

document.addEventListener('pointerup', (ev) => {
  if (!dragEl) return;
  const from = S.dragFrom;
  dragEl.remove();
  dragEl = null;
  S.dragFrom = null;
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  const sq = under?.closest?.('.sq');
  if (!sq) { render(); return; }
  const to = squareAt(+sq.dataset.r, +sq.dataset.f);
  if (to === from) { render(); return; }
  tryTarget(from, to);
});

document.addEventListener('pointercancel', () => {
  if (!dragEl) return;
  dragEl.remove();
  dragEl = null;
  S.dragFrom = null;
  render();
});

$('board').addEventListener('keydown', (ev) => {
  const step = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[ev.key];
  if (step) {
    ev.preventDefault();
    const el = sqEl(S.cursor);
    const r = Math.min(7, Math.max(0, +el.dataset.r + step[0]));
    const f = Math.min(7, Math.max(0, +el.dataset.f + step[1]));
    S.cursor = squareAt(r, f);
    render();
    return;
  }
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  ev.preventDefault();
  if (!humanToMove()) return;
  if (S.selected && S.targets.has(S.cursor)) {
    tryTarget(S.selected, S.cursor);
  } else if (canPick(S.cursor)) {
    select(S.cursor);
  }
});

// ── after every move ────────────────────────────────────────────────────────
function afterMove() {
  addIncrement();
  render();
  paintBars();
  const c = S.chess;

  if (c.isCheckmate()) return finish(c.turnColor() === WHITE ? -1 : 1, t(S.lang, 'resultCheckmate'));
  if (c.isStalemate()) return finish(0, t(S.lang, 'resultStalemate'));
  if (c.isInsufficientMaterial()) return finish(0, t(S.lang, 'resultMaterial'));
  if (c.isThreefoldRepetition()) return finish(0, t(S.lang, 'resultThreefold'));
  if (c.isDrawByFiftyMoves()) return finish(0, t(S.lang, 'resultFifty'));

  if (!S.clock.running) startClock();
  if (S.mode === 'ai' && c.turnColor() !== S.playerColor) askEngine();
}

function askEngine() {
  if (S.over) return;
  S.thinking = true;
  paintBars();
  const elo = Number($('level').value) || 1200;
  const id = ++searchId;
  ensureEngine();
  worker.postMessage({ id, fen: S.chess.fen(), elo });
}

/**
 * The engine worker is created on first use, but asked to warm up before it is
 * needed: the WASM is ~640KB and compiling it costs a moment on a phone, and
 * that cost should land while the player is still looking at the board rather
 * than in the middle of their first move.
 */
function ensureEngine() {
  if (worker) return;
  worker = new Worker(new URL('./worker-ai.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id: rid, type, move, score, cp, nodes, depth, moverIsWhite } = e.data;
    if (rid !== searchId) return;                 // a newer game superseded this search

    if (type === 'error') {
      S.thinking = false;
      console.error('engine:', e.data.message);
      finish(0, t(S.lang, 'engineError'));
      return;
    }
    // a score update from a search that is still running: this is what makes the
    // eval bar move while it thinks instead of snapping in at the end
    if (type === 'info') {
      S.evalCp = moverIsWhite ? cp : -cp;
      S.aiInfo = `${depth}p·${(nodes || 0).toLocaleString('en')}n`;
      paintEval();
      return;
    }

    S.thinking = false;
    S.aiInfo = `${depth}p·${(nodes || 0).toLocaleString('en')}n`;
    if (!move) { finish(0, t(S.lang, 'draw')); return; }
    const povWhite = S.chess.turnColor() === WHITE;   // the score is from the mover's side
    if (!S.chess.move(move)) { finish(0, t(S.lang, 'engineError')); return; }
    S.evalCp = povWhite ? score : -score;
    paintEval();
    blip('move');
    afterMove();
  };
  worker.onerror = (ev) => {
    S.thinking = false;
    console.error('engine worker:', ev.message);
    finish(0, t(S.lang, 'engineError'));
  };
  worker.postMessage({ type: 'warm' });
}

function paintEval() {
  const el = $('statEval');
  if (S.evalCp == null) { el.textContent = '—'; return; }
  // A forced mate arrives as a score far outside the centipawn scale. It is real
  // information, but "-100.0" is not a number of pawns and reading it as one is
  // just noise, so the bar pegs instead.
  const pawns = Math.max(-99.9, Math.min(99.9, S.evalCp / 100));
  el.textContent = (pawns > 0 ? '+' : '') + pawns.toFixed(1) + (S.aiInfo ? ` · ${S.aiInfo}` : '');
}

function paintBars() {
  const turnIsWhite = S.chess.turnColor() === WHITE;
  // The TOP bar shows whichever colour is at the top, which is black unless the
  // board is flipped. This used to swap the two ELEMENT NAMES instead of the two
  // colours, so on an ordinary unflipped board the top bar was labelled White
  // while the white pieces sat at the bottom: your own name sat over your
  // opponent's pieces. The is-turn glow was already colour-correct, which is
  // why the two disagreed with each other.
  const topIsWhite = S.flipped;                     // the top row is rank 8 when unflipped
  const nameOf = (isWhite) => {
    if (S.mode === 'duo') return t(S.lang, isWhite ? 'white' : 'black');
    const mine = isWhite === (S.playerColor === WHITE);
    return mine ? t(S.lang, 'you') : t(S.lang, 'engine');
  };
  $('topName').textContent = nameOf(topIsWhite);
  $('botName').textContent = nameOf(!topIsWhite);
  // the avatar is real piece art, the same silhouettes the board draws
  $('topAvatar').innerHTML = pieceMarkup(topIsWhite ? 'w' : 'b', 6);
  $('botAvatar').innerHTML = pieceMarkup(topIsWhite ? 'b' : 'w', 6);

  // isWhite is a BOOLEAN and turnColor() returns 0/1: comparing them with ===
  // was always false, so the turn labels and the glow never appeared
  const sub = (isWhite) => (S.over ? '' : isWhite === turnIsWhite ? (S.thinking ? t(S.lang, 'thinking') : t(S.lang, 'yourTurn')) : '');
  $('topSub').textContent = sub(topIsWhite);
  $('botSub').textContent = sub(!topIsWhite);
  $('playerTop').classList.toggle('is-turn', !S.over && topIsWhite === turnIsWhite);
  $('playerBottom').classList.toggle('is-turn', !S.over && topIsWhite !== turnIsWhite);

  paintCaptured(topIsWhite, $('topCaptured'));
  paintCaptured(!topIsWhite, $('botCaptured'));
}

/** What this side has taken, in the colour it was taken in. */
function paintCaptured(isWhite, el) {
  const taken = [];
  for (const mv of S.chess.history({ verbose: true })) {
    if (colorOf(mv.piece) === (isWhite ? WHITE : BLACK) && mv.captured) taken.push(mv.captured);
  }
  el.textContent = taken.map((l) => GLYPH[isWhite ? 'b' : 'w'][l] || '').join('');
}

function finish(result, reason) {
  S.over = true;
  S.thinking = false;
  S.clock.running = false;
  blip(result > 0 ? 'win' : result < 0 ? 'lose' : 'click');
  $('veilTitle').textContent = result > 0 ? t(S.lang, 'win') : result < 0 ? t(S.lang, 'lose') : t(S.lang, 'draw');
  $('veilSub').textContent = reason;
  const actions = $('veilActions');
  actions.textContent = '';
  const again = document.createElement('button');
  again.className = 'btn btn-primary';
  again.type = 'button';
  again.textContent = t(S.lang, 'btnNewGame');
  again.onclick = () => { $('boardVeil').hidden = true; newGame(); };
  const review = document.createElement('button');
  review.className = 'btn btn-ghost';
  review.type = 'button';
  review.textContent = t(S.lang, 'tabGame');
  review.onclick = () => { $('boardVeil').hidden = true; };
  actions.append(again, review);
  $('boardVeil').hidden = false;
  paintBars();
}

// ── clocks ──────────────────────────────────────────────────────────────────
/**
 * Read the time control into S.clock. Returns false when the selection cannot be
 * used (a custom control with no minutes), in which case the previous clock is
 * left completely untouched and the caller shows the reason.
 *
 * `unlimited` exists because "no clock" is not a clock of zero: with w=b=0 the
 * first tick subtracts a fraction, the value goes to 0 and the game ends
 * instantly as if it were checkmate. Zero now means "do not run a clock".
 */
function readTimeControl() {
  const raw = $('timeControl').value;
  $('customTime').hidden = raw !== 'custom';

  let base = 0;
  let inc = 0;
  if (raw === 'custom') {
    const mins = Number($('tcMinutes').value);
    if (!Number.isFinite(mins) || mins < 1) {
      $('tcHint').textContent = t(S.lang, 'customBad');
      return false;
    }
    base = Math.round(mins) * 60;
    inc = Math.max(0, Math.round(Number($('tcIncrement').value) || 0));
  } else {
    const [b, i] = raw.split('+').map(Number);
    base = b || 0;
    inc = i || 0;
  }
  $('tcHint').textContent = '';
  S.clock.raw = raw;
  S.clock.unlimited = base <= 0;
  S.clock.w = S.clock.b = base;
  S.clock.inc = S.clock.unlimited ? 0 : inc;
  S.clock.running = false;
  paintClocks();
  return true;
}

function startClock() {
  if (S.clock.running || S.clock.unlimited) return;
  S.clock.running = true;
  S.clock.last = Date.now();
  if (!S.clock.timer) {
    S.clock.timer = setInterval(() => {
      if (!S.clock.running || S.over) return;
      const now = Date.now();
      const dt = (now - S.clock.last) / 1000;
      S.clock.last = now;
      const side = S.chess.turnColor() === WHITE ? 'w' : 'b';
      S.clock[side] = Math.max(0, S.clock[side] - dt);
      paintClocks();
      // the side that ran out of time LOSES, and the reason has to say so: this
      // used to report checkmate, which is a different ending entirely
      if (S.clock[side] <= 0) {
        finish(side === 'w' ? -1 : 1, t(S.lang, side === 'w' ? 'resultTimeWhite' : 'resultTimeBlack'));
      }
    }, 200);
  }
}

/** The increment belongs to the side that JUST moved, i.e. not the side to move. */
function addIncrement() {
  if (!S.clock.inc || S.clock.unlimited) return;
  const side = S.chess.turnColor() === WHITE ? 'b' : 'w';
  S.clock[side] += S.clock.inc;
  paintClocks();
}

/**
 * Each clock belongs to a COLOUR, and a clock is only ever correct if it sits
 * under its own player's name. Unflipped, WHITE is at the bottom; flipped, white
 * is at the top. This used to hardcode white to the top clock, so after a flip
 * each player's time sat under the other player's name.
 */
function paintClocks() {
  for (const isWhite of [true, false]) {
    const onTop = S.flipped ? isWhite : !isWhite;
    const el = $(onTop ? 'topClock' : 'botClock');
    if (!el) continue;
    if (S.clock.unlimited) {
      el.textContent = '∞';
      el.classList.remove('is-low');
      continue;
    }
    const s = Math.ceil(S.clock[isWhite ? 'w' : 'b']);
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    el.classList.toggle('is-low', s > 0 && s <= 30);
  }
}

// ── controls ────────────────────────────────────────────────────────────────
function newGame(fen = '') {
  searchId++;                                    // orphan any search still in flight
  S.chess = new Chess(fen || undefined);
  S.selected = null;
  S.targets = new Map();
  S.over = false;
  S.thinking = false;
  S.evalCp = null;
  S.aiInfo = '';
  S.cursor = S.chess.turnColor() === WHITE ? 'e2' : 'e7';
  $('statEval').textContent = '—';
  S.flipped = S.mode === 'ai' ? S.playerColor === BLACK : false;
  // the flip has to be settled BEFORE the clocks paint, or each side's time is
  // written under the other side's name
  readTimeControl();
  render();
  paintBars();
  // warm the engine while the player is still looking at the board, so the WASM
  // compile is not paid for in the middle of their first move
  if (S.mode === 'ai') { ensureEngine(); if (S.chess.turnColor() !== S.playerColor) askEngine(); }
}

$('newGame').onclick = () => { $('boardVeil').hidden = true; newGame(); };

$('undoBtn').onclick = () => {
  if (S.over || !S.chess.history().length) return;
  searchId++;
  S.thinking = false;
  const back = S.mode === 'ai' ? 2 : 1;
  for (let i = 0; i < back && S.chess.history().length; i++) S.chess.undo();
  S.selected = null;
  S.targets = new Map();
  S.over = false;
  $('boardVeil').hidden = true;
  render();
  paintBars();
};

$('flipBtn').onclick = () => { S.flipped = !S.flipped; render(); paintBars(); paintClocks(); };

$('resignBtn').onclick = () => {
  if (S.over) return;
  const loser = S.mode === 'ai' ? S.playerColor : S.chess.turnColor();
  finish(loser === WHITE ? -1 : 1, t(S.lang, 'resigned'));
};

$('mode').onchange = (ev) => {
  S.mode = ev.target.value;
  $('levelField').hidden = S.mode !== 'ai';
  $('colorField').hidden = S.mode !== 'ai';
  newGame();
};

// An unusable custom control must not silently start a game on the old clock:
// the select snaps back and the reason is shown under the inputs.
$('timeControl').onchange = () => {
  if (readTimeControl()) newGame();
  else $('timeControl').value = S.clock.raw;
};
$('tcApply').onclick = () => {
  if (!readTimeControl()) return;
  $('timeControl').value = 'custom';
  newGame();
};
$('level').oninput = (ev) => { $('levelOut').textContent = ev.target.value; };

for (const btn of document.querySelectorAll('[data-color]')) {
  btn.onclick = () => {
    for (const b of document.querySelectorAll('[data-color]')) b.classList.toggle('is-on', b === btn);
    const pick = btn.dataset.color;
    S.playerColor = pick === 'r' ? (Math.random() < 0.5 ? WHITE : BLACK) : (pick === 'w' ? WHITE : BLACK);
    newGame();
  };
}

for (const btn of document.querySelectorAll('[data-theme]')) {
  btn.onclick = () => {
    document.documentElement.dataset.theme = btn.dataset.theme;
    for (const b of document.querySelectorAll('[data-theme]')) b.setAttribute('aria-pressed', String(b === btn));
    localStorage.setItem('chess.theme', btn.dataset.theme);
  };
}

$('loadFen').onclick = () => {
  const fen = $('fenInput').value.trim();
  if (!fen) return;
  try {
    const probe = new Chess(fen);
    $('boardVeil').hidden = true;
    newGame(probe.fen());
  } catch (err) {
    $('fenHint').textContent = String(err?.message || err);
  }
};
$('clearFen').onclick = () => { $('fenInput').value = ''; $('fenHint').textContent = t(S.lang, 'hintFen'); };

$('copyPgn').onclick = () => copy(S.chess.pgn(), $('copyPgn'));
$('copyFen').onclick = () => copy(S.chess.fen(), $('copyFen'));

async function copy(text, btn) {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = t(S.lang, 'copyOk');
  } catch {
    btn.textContent = t(S.lang, 'copyFail');
  }
  setTimeout(() => { btn.textContent = old; }, 1200);
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    for (const x of document.querySelectorAll('.tab')) {
      x.classList.toggle('is-active', x === tab);
      x.setAttribute('aria-selected', String(x === tab));
    }
    for (const p of document.querySelectorAll('.tabpane')) p.classList.toggle('is-active', p.dataset.pane === tab.dataset.tab);
  };
}

$('langToggle').onclick = () => {
  S.lang = S.lang === 'ar' ? 'en' : 'ar';
  applyLang(S.lang);
  render();
  paintBars();
};

// ── boot ────────────────────────────────────────────────────────────────────
const savedTheme = localStorage.getItem('chess.theme') || 'dark';
document.documentElement.dataset.theme = savedTheme;
for (const b of document.querySelectorAll('[data-theme]')) b.setAttribute('aria-pressed', String(b.dataset.theme === savedTheme));
applyLang(S.lang);
buildBoard();
$('levelField').hidden = S.mode !== 'ai';
$('colorField').hidden = S.mode !== 'ai';
newGame();
