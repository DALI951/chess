/**
 * AI WORKER — a small alpha-beta search that runs off the main thread.
 *
 * PHASE 1 PLACEHOLDER. The shipped engine will be Stockfish compiled to WASM
 * (see the plan); this exists so "play vs the computer" already works today on
 * a phone. It drives the SAME proven move generator as the UI, so it can never
 * answer with an illegal move, and it reports its node count so the search is
 * not a black box.
 *
 * chess.moves() hands back ALGEBRAIC from/to plus `captured` and `promotion` as
 * letters, and chess.move() takes exactly that shape back — so moves are simply
 * replayed verbatim. No coordinate conversion lives in here.
 *
 * @author DALI951
 */
import { Chess, typeOf, colorOf, PIECE_VALUES, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING } from './engine.js';

/** PSTs are written from White's side, rank 8 first — the usual layout. */
const PIECE_PST = {
  [PAWN]: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  [KNIGHT]: [
   -50,-40,-30,-30,-30,-30,-40,-50,
   -40,-20,  0,  0,  0,  0,-20,-40,
   -30,  0, 10, 15, 15, 10,  0,-30,
   -30,  5, 15, 20, 20, 15,  5,-30,
   -30,  0, 15, 20, 20, 15,  0,-30,
   -30,  5, 10, 15, 15, 10,  5,-30,
   -40,-20,  0,  5,  5,  0,-20,-40,
   -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  [BISHOP]: [
   -20,-10,-10,-10,-10,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5, 10, 10,  5,  0,-10,
   -10,  5,  5, 10, 10,  5,  5,-10,
   -10,  0, 10, 10, 10, 10,  0,-10,
   -10, 10, 10, 10, 10, 10, 10,-10,
   -10,  5,  0,  0,  0,  0,  5,-10,
   -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  [ROOK]: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  [QUEEN]: [
   -20,-10,-10, -5, -5,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5,  5,  5,  5,  0,-10,
    -5,  0,  5,  5,  5,  5,  0, -5,
     0,  0,  5,  5,  5,  5,  0, -5,
   -10,  5,  5,  5,  5,  5,  0,-10,
   -10,  0,  5,  0,  0,  0,  0,-10,
   -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  [KING]: [
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -20,-30,-30,-40,-40,-30,-30,-20,
   -10,-20,-20,-20,-20,-20,-20,-10,
    20, 20,  0,  0,  0,  0, 20, 20,
    20, 30, 10,  0,  0, 10, 30, 20,
  ],
};

const LETTER_TYPE = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
const MATE = 100000;
const ABORT = { abort: true };

let nodes = 0;
let deadline = 0;

const timeUp = () => (nodes & 2047) === 0 && Date.now() > deadline;

/** White's point of view, in centipawns. */
function evaluate(chess) {
  const board = chess.board();
  let score = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }        // 0x88 gap: skip the off-board file
    const p = board[sq];
    if (!p) continue;
    const type = typeOf(p);
    const white = colorOf(p) === 0;
    const row = white ? 7 - (sq >> 4) : sq >> 4; // mirror for Black
    const v = PIECE_VALUES[type] + PIECE_PST[type][row * 8 + (sq & 7)];
    score += white ? v : -v;
  }
  return score;
}

/** MVV-LVA: the biggest victim for the cheapest attacker, promotions first. */
function orderMoves(moves) {
  return moves
    .map((mv) => ({
      mv,
      s: mv.promotion ? 9000
        : mv.captured ? PIECE_VALUES[LETTER_TYPE[mv.captured]] * 10 - PIECE_VALUES[mv.pieceType]
        : 0,
    }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.mv);
}

const play = (chess, mv) => chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });

/** Captures only, so an evaluation never freezes in the middle of an exchange. */
function quiesce(chess, alpha, beta) {
  nodes++;
  if (timeUp()) throw ABORT;

  const stand = evaluate(chess);
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;

  for (const mv of orderMoves(chess.moves())) {
    if (!mv.captured) continue;
    play(chess, mv);
    const score = -quiesce(chess, -beta, -alpha);
    chess.undo();
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

/** Negamax + alpha-beta. Score is always from the side to move's point of view. */
function search(chess, depth, ply, alpha, beta) {
  nodes++;
  if (timeUp()) throw ABORT;
  if (depth <= 0) return quiesce(chess, alpha, beta);

  const moves = orderMoves(chess.moves());
  if (!moves.length) return chess.inCheck() ? -MATE + ply : 0;   // mate distance

  let best = -Infinity;
  for (const mv of moves) {
    play(chess, mv);
    const score = -search(chess, depth - 1, ply + 1, -beta, -alpha);
    chess.undo();
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;                                    // beta cutoff
  }
  return best;
}

/** Elo -> (max depth, time budget). Weak levels are shallow AND fast, on purpose. */
function budgetFor(elo) {
  const table = [
    [600, 1, 100], [900, 2, 150], [1200, 2, 300], [1500, 3, 400],
    [1800, 3, 700], [2100, 4, 1100], [2400, 4, 1600], [2700, 5, 2200], [3000, 5, 3000],
  ];
  let best = table[0];
  for (const row of table) if (elo >= row[0]) best = row;
  return { depth: best[1], ms: best[2] };
}

self.onmessage = (e) => {
  const { fen, elo, id } = e.data;
  const chess = new Chess(fen);
  const { depth: maxDepth, ms } = budgetFor(Number(elo) || 1200);
  nodes = 0;
  deadline = Date.now() + ms;

  const root = orderMoves(chess.moves());
  let best = root[0] ?? null;
  let bestScore = 0;
  let reached = 0;

  // Iterative deepening. The best move from the last COMPLETED depth is kept,
  // so a timeout still answers with a real move instead of nothing.
  for (let d = 1; d <= maxDepth; d++) {
    let alpha = -Infinity;
    let localBest = null;
    let localScore = -Infinity;
    try {
      for (const mv of root) {
        play(chess, mv);
        const score = -search(chess, d - 1, 1, -Infinity, -alpha);
        chess.undo();
        if (score > localScore) {
          localScore = score;
          localBest = mv;
          if (score > alpha) alpha = score;
        }
      }
    } catch (err) {
      if (err !== ABORT) throw err;
      break;
    }
    if (localBest) {
      best = localBest;
      bestScore = localScore;
      reached = d;
    }
  }

  self.postMessage({
    id,
    move: best ? { from: best.from, to: best.to, promotion: best.promotion } : null,
    score: bestScore,
    nodes,
    depth: reached,
  });
};
