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

/**
 * The online controller is imported here and api.js is deliberately NOT imported
 * by this file. Everything the board does online goes through online.js, so
 * there is exactly one place where "the server owns the game" can be broken by
 * accident - and it is not in the file that draws squares.
 */
import * as online from './online.js';

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
  // Online is not a mode the board decides anything about. isMyTurn() has already
  // asked the server (and only the server) whose move it is; a local board that
  // thinks it is white's turn is not evidence of anything.
  if (online.isOnline()) return online.isMyTurn();
  return S.mode === 'duo' || S.chess.turnColor() === S.playerColor;
}

function canPick(name) {
  const piece = S.chess.get(fromAlgebraic(name));
  if (!piece) return false;
  if (online.isOnline()) {
    // The local board is only used to answer "is there a piece there"; whether
    // it is OURS is the server's business, and asking it per-click would be a
    // round trip for something isMyTurn() already knows.
    return colorOf(piece) === online.myColor();
  }
  return S.mode === 'duo' || (colorOf(piece) === S.playerColor && S.chess.turnColor() === S.playerColor);
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

  // Online: the move is NOT played on this board. It is sent, and the board is
  // rebuilt from whatever the server says happened. Playing it locally first and
  // then correcting is how two players end up looking at different positions.
  if (online.isOnline()) {
    S.selected = null;
    S.targets = new Map();
    render();
    online.play(from, to, promotion || legal[0].promotion);
    return true;
  }

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
  // The engine hands back promotion as an UPPER-CASE letter ("Q", "R", "B", "N")
  // from moves(). Keying this table by lower case meant order["Q"] was undefined,
  // every button fell through to the '?' fallback, and all four choices were
  // drawn as a queen. The moves were correct the whole time - only the four
  // buttons looked identical, which is the worst kind of bug: the game worked
  // and the picker quietly lied about what you were picking.
  const order = { q: '♕', r: '♖', b: '♗', n: '♘' };
  for (const mv of legal) {
    const piece = String(mv.promotion || '').toLowerCase();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.promotion = piece;
    btn.textContent = order[piece] || '♕';
    btn.setAttribute('aria-label', piece.toUpperCase() || 'QUEEN');
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

  // Online never gets here: a move in an online game does not go through
  // afterMove() at all, because the server decides whether it happened and what
  // the position is afterwards. The engine and the ending checks belong to games
  // played on this board, and running them here would end an online game the
  // moment a fifty-move counter ran out - with no draw offered and no agreement.
  if (online.isOnline()) return;

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
    // Online: a real opponent's name, or "spectating" when this browser is not
    // sitting in the game at all. Showing "You" and "Engine" over two human
    // players was the giveaway that the whole online path had been stubbed.
    if (online.isOnline()) {
      const g = online.game();
      const who = isWhite ? g?.white : g?.black;
      if (who?.display_name) return who.display_name;
      return isWhite ? t(S.lang, 'white') : t(S.lang, 'black');
    }
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
  // In an online game "New game" would start something unrelated and look like
  // the game restarting itself, so the button goes back to the lobby instead.
  const again = document.createElement('button');
  again.className = 'btn btn-primary';
  again.type = 'button';
  if (online.isOnline()) {
    again.textContent = t(S.lang, 'tabOnline');
    again.onclick = () => { $('boardVeil').hidden = true; leaveOnline(); };
  } else {
    again.textContent = t(S.lang, 'btnNewGame');
    again.onclick = () => { $('boardVeil').hidden = true; newGame(); };
  }
  const review = document.createElement('button');
  review.className = 'btn btn-ghost';
  review.type = 'button';
  review.textContent = t(S.lang, 'tabGame');
  review.onclick = () => { $('boardVeil').hidden = false; $('boardVeil').hidden = true; };
  actions.append(again, review);
  $('boardVeil').hidden = false;
  paintBars();
}

/**
 * An online game ended, and the server says how.
 *
 * `result` is from WHITE's point of view, so it has to be flipped for a player
 * who is sitting on the black side - otherwise the player who resigned is shown
 * the win screen. This was the single most likely bug in the whole online path
 * and it is why the reason string comes from the server too: "you flagged" and
 * "your opponent resigned" are different sentences and the client cannot tell
 * them apart from a result number.
 */
function onlineFinished(g) {
  const lang = S.lang;
  const drew = g.result === 0;
  // result is from white's point of view. "Is it my colour" is the wrong question
  // to ask of it - a player who reloads mid-game has two seats and no way to be
  // certain - so the winner's own id decides it.
  const iWon = g.winner != null ? g.winner === online.myUserId() : (g.me === 'white' ? g.result > 0 : g.result < 0);
  finish(drew ? 0 : (iWon ? 1 : -1), onlineReasonText(g));
}

function onlineReasonText(g) {
  const lang = S.lang;
  switch (g.reason) {
    case 'checkmate': return t(lang, 'resultCheckmate');
    case 'stalemate': return t(lang, 'resultStalemate');
    case 'material': return t(lang, 'resultMaterial');
    case 'threefold': return t(lang, 'resultThreefold');
    case 'fifty': return t(lang, 'resultFifty');
    case 'agreement': return t(lang, 'resultAgreement');
    case 'abandoned': return t(lang, 'resultAbandoned');
    // flagged is 'white' | 'black' - the side that ran out, told to us by the
    // server. Working it out from the result number here is how the player who
    // flagged ends up reading "your opponent ran out of time".
    case 'flag': return t(lang, g.flagged === g.me ? 'resultTimeYou' : 'resultTimeOther');
    // winner is a user id. The player who resigned is the LOSER, so being the
    // winner is exactly the case where it was the other one - this comparison
    // was the wrong way round, and told the winner they had resigned.
    case 'resign': return t(lang, g.winner === online.myUserId() ? 'resignedOther' : 'resigned');
    default: return t(lang, 'resultOther');
  }
}

/** Leave an online game and go back to a local board. */
function leaveOnline() {
  online.leave();
  S.over = false;
  S.thinking = false;
  S.selected = null;
  S.targets = new Map();
  $('boardVeil').hidden = true;
  newGame();
  paintOnlinePanel();
}

/**
 * The server sent a new game state. This is the ONE function that may replace
 * the local board, and it does so by rebuilding from the server's move list.
 */
function onOnlineChange({ rebuilt, chess }) {
  if (rebuilt && chess) S.chess = chess;
  S.over = false;
  render();
  paintBars();
  paintClocks();
  paintOnlinePanel();
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
  if (online.isOnline()) return;      // the server's clock is already running
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
  if (online.isOnline()) return;     // the server granted it, or did not
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
  // Online: the numbers are the server's, already discounted for the side to
  // move, and interpolated by the online module between polls. Nothing here
  // counts down on its own authority - a clock that ticks on the client's say-so
  // is a clock a player can win by changing their system time.
  if (online.isOnline()) {
    const c = online.clockNow();
    for (const isWhite of [true, false]) {
      const onTop = S.flipped ? isWhite : !isWhite;
      const el = $(onTop ? 'topClock' : 'botClock');
      if (!el) continue;
      if (!c.timed) {
        el.textContent = '∞';
        el.classList.remove('is-low');
        continue;
      }
      const s = Math.ceil((isWhite ? c.white : c.black) / 1000);
      el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      el.classList.toggle('is-low', s > 0 && s <= 30);
    }
    if (c.timed) requestAnimationFrame(paintClocks);   // smooth, from server data
    return;
  }

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
  // An online game is oriented by the seat the server gave us, not by whatever
  // the mode select last said. Reloading into a game as black has to show black
  // at the bottom or every click is mirrored.
  S.flipped = online.isOnline()
    ? online.myColor() === BLACK
    : (S.mode === 'ai' ? S.playerColor === BLACK : false);
  // the flip has to be settled BEFORE the clocks paint, or each side's time is
  // written under the other side's name
  readTimeControl();
  render();
  paintBars();
  if (online.isOnline()) { paintClocks(); return; }
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
  if (online.isOnline()) {
    // The server ends the game, not this function. Declaring a resignation
    // locally is how a player ends up with a win screen they did not earn.
    online.resign();
    return;
  }
  const loser = S.mode === 'ai' ? S.playerColor : S.chess.turnColor();
  finish(loser === WHITE ? -1 : 1, t(S.lang, 'resigned'));
};

$('mode').onchange = (ev) => {
  S.mode = ev.target.value;
  $('levelField').hidden = S.mode !== 'ai';
  $('colorField').hidden = S.mode !== 'ai';
  // Switching to online with a local game running is a normal thing to do by
  // accident, so the local game is left alone and the panel just takes over. The
  // reverse - leaving online - goes through leaveOnline(), which is the only
  // function that stops the polling.
  if (S.mode !== 'online' && online.isOnline()) leaveOnline();
  paintOnlinePanel();
  paintAuth();
  if (S.mode !== 'online') newGame();
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

// ── the account ─────────────────────────────────────────────────────────────

/**
 * Online needs an account; the local game does not. So the panel is only ever
 * shown in online mode, and the boot check is allowed to fail silently - a
 * database that is down must not stop somebody playing the computer.
 */
function paintAuth() {
  const panel = $('authPanel');
  if (!panel) return;
  panel.hidden = S.mode !== 'online';
  const u = online.user();
  $('authForm').hidden = !!u;
  $('authWho').hidden = !u;
  $('authLogoutBtn').hidden = !u;
  if (u) {
    $('authWho').textContent = `${u.display_name || u.username} · ${u.rating ?? '—'}`;
  }
}

function authMessage(key, fallback) {
  $('authHint').textContent = key ? t(S.lang, key) : (fallback || '');
}

async function authSubmit(ev, isRegister) {
  ev?.preventDefault();
  const username = $('authName').value.trim();
  const password = $('authPass').value;
  const display = $('authDisplay').value.trim();
  const remember = $('authRemember').checked;
  // The server is the authority on usernames and passwords, but an empty box
  // cannot be sent at all: a 400 for a field the player has not filled in yet is
  // noise, and the browser already knows it is required.
  if (!username || !password) { authMessage('authFillBoth'); return; }
  $('authLoginBtn').disabled = $('authRegisterBtn').disabled = true;
  try {
    if (isRegister) {
      await online.register(username, password, display, remember);
      authMessage('');
    } else {
      await online.login(username, password, remember);
      authMessage('');
    }
    $('authPass').value = '';
    paintAuth();
    paintOnlinePanel();
  } catch (err) {
    // Bad password and unknown user get the same message on purpose: telling
    // them apart is a free account-enumeration oracle.
    authMessage(err?.code === 'bad_credentials' || err?.code === 'wrong_password' ? 'authWrong' : 'authFailed');
  } finally {
    $('authLoginBtn').disabled = $('authRegisterBtn').disabled = false;
  }
}

function wireAuth() {
  $('authForm').onsubmit = (ev) => authSubmit(ev, false);
  $('authRegisterBtn').onclick = (ev) => authSubmit(ev, true);
  $('authLogoutBtn').onclick = async () => {
    try { await online.logout(); }
    finally { paintAuth(); paintOnlinePanel(); newGame(); }
  };
}

// ── the online panel ────────────────────────────────────────────────────────
/**
 * Show the room code, who is in the game, and the two things a server game needs
 * that a local one does not: a code worth copying, and somebody to wait for.
 */
function paintOnlinePanel() {
  // The setup block is what you see BEFORE a game, and the panel is what you see
  // during one. Putting the "new room" button inside the panel meant there was no
  // way to open the first room: the button was hidden until the game it starts.
  const setup = $('onlineSetup');
  if (setup) setup.hidden = S.mode !== 'online' || online.isOnline();

  const box = $('onlinePanel');
  if (!box) return;
  const g = online.game();
  box.hidden = !g;
  if (!g) return;

  $('onlineCode').textContent = g.code || '—';
  $('onlineStatus').textContent = {
    waiting: t(S.lang, 'onlineWaiting'),
    active: t(S.lang, 'onlinePlaying'),
    ended: t(S.lang, 'onlineEnded'),
  }[g.status] || g.status;

  // Watching an empty room is a real state: somebody sent you the link before
  // their friend had arrived. The way in is to take the seat, so that is the one
  // thing offered - not "new game", which would be a different room entirely.
  const canSit = g.status === 'waiting' && g.me === null;
  const seat = $('onlineTakeSeat');
  if (seat) seat.hidden = !canSit;
  const offer = $('onlineOffer');
  if (offer) offer.hidden = canSit;
  $('onlineDraw').hidden = g.status !== 'active' || g.me === null;
  $('onlineLeave').hidden = false;

  // The link is what actually gets sent to an opponent, and it is the one piece
  // of this feature that has to be right in both languages: a path, not a query
  // string, so it survives being pasted into anything.
  const link = `${location.origin}${location.pathname}#g=${g.code || ''}`;
  $('onlineLink').value = link;

  const mine = online.myUserId();
  const opp = g.me === 'white' ? g.black : g.white;
  $('onlineOpponent').textContent = opp
    ? `${opp.display_name}${opp.online ? '' : ` (${t(S.lang, 'offline')})`}`
    : t(S.lang, 'onlineNobody');

  if (online.drawOfferedBy && online.drawOfferedBy !== mine) {
    $('onlineDrawOffer').hidden = false;
  } else {
    $('onlineDrawOffer').hidden = true;
  }
}

async function withBusy(fn) {
  const btn = $('onlineJoinGo');
  if (btn) btn.disabled = true;
  try { await fn(); }
  catch (err) { $('onlineHint').textContent = err?.message || String(err); }
  finally { if (btn) btn.disabled = false; paintOnlinePanel(); }
}

function wireOnlinePanel() {
  const go = $('onlineJoinGo');
  if (go) {
    go.onclick = () => withBusy(async () => {
      const code = $('onlineCodeInput').value.trim().toUpperCase();
      if (!code) { $('onlineHint').textContent = t(S.lang, 'onlineNeedCode'); return; }
      await online.joinGame(code);
      $('boardVeil').hidden = true;
      newGame();
    });
  }
  const create = $('onlineCreate');
  if (create) {
    create.onclick = () => withBusy(async () => {
      const [b, i] = ($('timeControl').value || '600+0').split('+').map(Number);
      const code = await online.createGame({
        baseMs: (b || 0) * 1000,
        incrementMs: (i || 0) * 1000,
        open: true,
      });
      history.replaceState(null, '', `#g=${code}`);
      $('boardVeil').hidden = true;
      newGame();
    });
  }
  const quick = $('onlineQuick');
  if (quick) {
    quick.onclick = () => withBusy(async () => {
      const [b, i] = ($('timeControl').value || '600+0').split('+').map(Number);
      // matched === false is not an error: the server found nobody waiting, so
      // it put us in an open game and we sit in it. Polling brings the
      // opponent in, and the panel already says "waiting".
      const matched = await online.quickMatch({
        baseMs: (b || 0) * 1000,
        incrementMs: (i || 0) * 1000,
      });
      const code = online.game().code;
      history.replaceState(null, '', `#g=${code}`);
      $('boardVeil').hidden = true;
      newGame();
      if (!matched) $('onlineHint').textContent = t(S.lang, 'onlineQuickWaiting');
    });
  }
  const leave = $('onlineLeave');
  if (leave) leave.onclick = () => { history.replaceState(null, '', location.pathname); leaveOnline(); };

  const draw = $('onlineDraw');
  if (draw) draw.onclick = () => withBusy(() => online.offerDraw());
  const seat = $('onlineTakeSeat');
  if (seat) {
    seat.onclick = () => withBusy(async () => {
      await online.joinGame(online.game().code);
      $('boardVeil').hidden = true;
      newGame();
    });
  }
  const accept = $('onlineDrawYes');
  if (accept) accept.onclick = () => withBusy(() => online.offerDraw());
  const decline = $('onlineDrawNo');
  if (decline) decline.onclick = () => withBusy(() => online.declineDraw());

  const copyBtn = $('onlineCopy');
  if (copyBtn) copyBtn.onclick = () => copy($('onlineLink').value, copyBtn);
  const shareBtn = $('onlineShare');
  if (shareBtn) {
    shareBtn.onclick = async () => {
      const url = $('onlineLink').value;
      const me = online.user();
      const text = t(S.lang, 'onlineShareText')
        .replace('{name}', me?.display_name || t(S.lang, 'onlineRoom'))
        .replace('{url}', url);
      // On a phone this opens the system share sheet, which is the difference
      // between "here is a link, now go and paste it somewhere" and one tap into
      // WhatsApp. navigator.share is absent on desktop browsers and in some
      // embedded webviews, hence the copy fallback rather than an error.
      if (navigator.share) {
        try {
          await navigator.share({ title: t(S.lang, 'appTitle'), text, url });
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;   // they closed the sheet
        }
      }
      copy(url, shareBtn);
    };
  }

  const chatForm = $('chatForm');
  if (chatForm) {
    chatForm.onsubmit = (ev) => {
      ev.preventDefault();
      const input = $('chatInput');
      const text = input.value;
      input.value = '';
      online.say(text);
    };
  }
}

/** Append messages as text nodes. Never innerHTML - see Chat::clean(). */
function onChat(messages) {
  const log = $('chatLog');
  if (!log) return;
  for (const m of messages) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    const who = document.createElement('span');
    who.className = 'chat-who';
    who.textContent = m.display_name || m.username;
    const body = document.createElement('span');
    body.className = 'chat-body';
    body.textContent = m.body;
    row.append(who, body);
    log.append(row);
  }
  while (log.childElementCount > 200) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

function onOnlineError(err) {
  // Errors that are already a normal part of online life (a poll that timed out,
  // a move the server had already seen) do not get a dialog. The ones that mean
  // the player cannot play at all do.
  if (err?.code === 'not_logged_in') { $('onlineHint').textContent = t(S.lang, 'needLogin'); return; }
  if (err?.code === 'rate_limited') { $('onlineHint').textContent = t(S.lang, 'slowDown'); return; }
  $('onlineHint').textContent = err?.message || t(S.lang, 'connectionProblem');
}

// ── boot ────────────────────────────────────────────────────────────────────
const savedTheme = localStorage.getItem('chess.theme') || 'dark';
document.documentElement.dataset.theme = savedTheme;
for (const b of document.querySelectorAll('[data-theme]')) b.setAttribute('aria-pressed', String(b.dataset.theme === savedTheme));
applyLang(S.lang);
buildBoard();
$('levelField').hidden = S.mode !== 'ai';
$('colorField').hidden = S.mode !== 'ai';

online.attach({
  onChange: onOnlineChange,
  onFinish: onlineFinished,
  onError: onOnlineError,
  onChat,
  onAccount: () => { paintAuth(); paintOnlinePanel(); },
  user: null,
});
wireOnlinePanel();
wireAuth();
newGame();

// Ask the server who we are, once. Deliberately not awaited before the board is
// drawn: the local game has to be playable the instant the page loads, with or
// without a database, and a slow login check must not hold up a board.
online.loadSession().then(() => { paintAuth(); paintOnlinePanel(); });
// A #g=CODE in the URL is an invitation. Landing on one opens it, and if this
// browser is not logged in the panel says so instead of failing silently.
const invited = new URLSearchParams(location.hash.replace(/^#/, '')).get('g');
if (invited) {
  $('onlineCodeInput').value = invited.toUpperCase();
  withBusy(async () => {
    // watching, not joining: taking the seat is a separate, deliberate click
    await online.watch(invited.toUpperCase());
    $('boardVeil').hidden = true;
    newGame();
  });
}

// Exposed for the smoke test: the online controller is stateful and there is no
// way to test a clock you cannot read.
window.__online = online;
