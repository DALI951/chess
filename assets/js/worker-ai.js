/**
 * AI WORKER — a UCI front end for Stockfish, compiled to WebAssembly.
 *
 * The engine is stockfish.js 10.0.2 (Stockfish 17) vendored at
 * assets/vendor/stockfish/ and loaded from this file's own directory. It runs in
 * its OWN worker, so this file is a worker that creates a worker. Browsers have
 * had nested workers for years (Chrome 69, Firefox 55, Safari 16.4), and it is
 * the only arrangement where the bookkeeping below stays off the main thread:
 * every info line the engine emits is a string parse, and on the main thread
 * that is a dropped frame in the middle of a drag. The UI should only ever see
 * a finished move.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not trust the engine. Stockfish is
 * given a FEN and answers with a long-algebraic move; that move is then handed
 * to the same chess.move() the player's own clicks go through, so an engine
 * that ever returned something illegal would be rejected by the same code that
 * rejects an illegal click. The engine gets no reference to the board at all.
 *
 * Only the newest search is worth running. The UI bumps an id per search and
 * throws away anything older, so finishing a superseded search would burn the
 * phone's battery to produce a move nobody will read.
 *
 * @author DALI951
 */

const ENGINE_URL = new URL('../vendor/stockfish/stockfish.wasm.js', import.meta.url);

let engine = null;     // the Stockfish worker itself
let booted = false;    // uciok seen, so setoption will actually be honoured
let active = null;     // the search Stockfish is running right now
let queued = null;     // the newest request waiting for that one to finish
let dead = false;      // the engine failed to load; stop trying

/**
 * Stockfish refuses UCI_Elo below 1320, so the bottom of our 400-3000 range
 * cannot use the honest strength limiter and has to use Skill Level instead.
 * Above the floor we use the limiter, because it is actually calibrated: Skill
 * Level 0 is not "a beginner", it is closer to "plays a near-random move among
 * the plausible ones", which beginners find maddening rather than easy.
 */
const UCI_ELO_FLOOR = 1320;

function optionsFor(elo) {
  const level = Math.max(0, Math.min(3000, Number(elo) || 1200));
  if (level >= UCI_ELO_FLOOR) {
    return [
      'setoption name UCI_LimitStrength value true',
      `setoption name UCI_Elo value ${Math.min(level, 3190)}`,
      'setoption name Skill Level value 20',
    ];
  }
  return [
    'setoption name UCI_LimitStrength value false',
    `setoption name Skill Level value ${Math.round(((level - 400) / (UCI_ELO_FLOOR - 400)) * 6)}`,
  ];
}

/**
 * Thinking time. The strength limiter already decides how good the move is, so
 * the time budget is free to be about LATENCY instead. Spending four seconds a
 * move to gain nothing a player can feel is a worse product than 300ms, and this
 * has to survive a mid-range phone. The file is licensed GPL-3.0, which is why
 * it lives in its own directory with its own LICENSE rather than being merged in.
 */
function budgetFor(elo) {
  const t = (Math.max(400, Math.min(3000, Number(elo) || 1200)) - 400) / 2600;
  return Math.round(150 + t * 1350);   // 150ms at 400 ... 1500ms at 3000
}

/** "e7e5" / "e7e8q" -> the { from, to, promotion } shape chess.move() takes. */
function toAppMove(uci) {
  if (!uci || uci.length < 4 || uci === '0000' || uci === '(none)') return null;
  const move = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
  if (uci.length > 4) move.promotion = uci[4];
  return move;
}

const send = (line) => engine.postMessage(line);

function boot() {
  if (engine || dead) return;
  try {
    engine = new Worker(ENGINE_URL);
  } catch (err) {
    dead = true;
    postMessage({ id: 0, type: 'error', message: String(err && err.message || err) });
    return;
  }
  engine.onmessage = (e) => onLine(String(e.data));
  engine.onerror = (e) => {
    dead = true;
    postMessage({ id: 0, type: 'error', message: (e && e.message) || 'engine failed to load' });
  };
  send('uci');            // the reply also triggers the WASM compile, so this is
                          // where the ~640KB download and compile gets paid for
}

function onLine(line) {
  if (line.startsWith('info ')) { harvest(line); return; }
  if (line === 'uciok') { send('isready'); return; }   // readyok means the options are live
  if (line === 'readyok') { booted = true; pump(); return; }
  if (line.startsWith('bestmove')) { finish(line); return; }
}

/**
 * The engine streams one info line per improvement. Keeping the newest score is
 * what lets the eval bar move while it is still thinking instead of snapping
 * into place at the end, and depth/nodes are what the "thinking" readout shows,
 * so a stalled search is visible as a stalled search.
 */
function harvest(line) {
  if (!active) return;
  const d = /\bdepth (\d+)/.exec(line);
  const n = /\bnodes (\d+)/.exec(line);
  const cp = /\bscore cp (-?\d+)/.exec(line);
  const mate = /\bscore mate (-?\d+)/.exec(line);
  if (d) active.depth = Number(d[1]);
  if (n) active.nodes = Number(n[1]);
  if (cp) active.cp = Number(cp[1]);
  else if (mate) active.cp = Number(mate[1]) > 0 ? 10000 : -10000;   // peg the bar
  else return;
  if (!active.depth && !active.nodes) return;
  postMessage({
    id: active.id, type: 'info',
    cp: active.cp, depth: active.depth, nodes: active.nodes, moverIsWhite: active.moverIsWhite,
  });
}

function finish(line) {
  const job = active;
  active = null;
  if (job && !job.cancelled) {
    const uci = line.trim().split(/\s+/)[1] || '';
    postMessage({
      id: job.id, type: 'move',
      move: toAppMove(uci),
      score: job.cp, depth: job.depth, nodes: job.nodes,
    });
  }
  pump();
}

function pump() {
  if (!booted || dead || active || !queued) return;
  const job = queued;
  queued = null;
  active = job;
  for (const line of optionsFor(job.elo)) send(line);
  // ucinewgame throws away the transposition table. Without it the engine
  // starts game two already remembering game one, which leaks the opening and
  // makes a rematch feel scripted.
  send('ucinewgame');
  send('position fen ' + job.fen);
  send('go movetime ' + budgetFor(job.elo));
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'warm') { boot(); return; }   // compile before it is needed
  const { id, fen } = msg;
  if (typeof fen !== 'string' || !fen) return;
  boot();
  if (dead) return;
  const job = {
    id, fen, elo: Number(msg.elo) || 1200,
    cp: 0, depth: 0, nodes: 0, cancelled: false,
    // Stockfish scores from the side to move, and the FEN says who that is, so
    // the score can be flipped to White here instead of at the far end of a
    // postMessage hop.
    moverIsWhite: fen.trim().split(/\s+/)[1] === 'w',
  };
  if (active) {
    if (active.id === id) return;    // the same search, asked twice
    active.cancelled = true;
    send('stop');                    // bestmove still arrives; finish() drops it
  }
  queued = job;
  pump();
};
