/**
 * Playing a person instead of a machine.
 *
 * The rule this whole file obeys: THE SERVER OWNS THE GAME. Not mostly, not
 * usually - owns it. The board here is a picture of what the server said, the
 * clocks are numbers the server sent, whose turn it is is the server's opinion,
 * and who won is the server's decision. That is not politeness about trust, it
 * is the only arrangement in which the two players can never disagree about
 * what happened.
 *
 * So there is exactly one flow:
 *
 *   1. it is my turn, I click a legal square
 *   2. the move goes to the server
 *   3. the server decides, and sends the whole game back
 *   4. the local board is REBUILT from the server's move list
 *
 * Step 4 rebuilds rather than replays-locally, which sounds wasteful and is
 * deliberate: a local chess.move() followed by a server correction is how two
 * players end up looking at different positions on the same game. One move, one
 * source, one rebuild.
 *
 * The clocks never tick on their own authority either. The server sends the
 * remaining time and the moment it measured it; the client works out how far its
 * own clock has drifted since and draws a smooth count, and the next poll throws
 * that away and starts again. If the browser is backgrounded for a minute, the
 * displayed clock is a minute wrong until the next poll lands, and then it is
 * right. Nothing is decided on it.
 *
 * @author DALI951
 */

import { api, ApiError } from './api.js';
import { Chess, WHITE, BLACK } from './engine.js';

const POLL_ACTIVE_MS = 500;      // half a second while it is somebody's turn
const POLL_IDLE_MS = 2000;       // two seconds when waiting or watching
const POLL_CHAT_MS = 2500;

const state = {
  game: null,          // {code, status, white, black, tc, clock, moves, ...}
  gameId: 0,
  myColor: WHITE,
  user: null,
  pollTimer: null,
  chatTimer: null,
  lastPly: -1,
  lastChatId: 0,
  skewMs: 0,           // serverNow - clientNow, from the last response
  drawOfferedBy: null,
  busy: false,         // a move is in flight
  onChange: null,      // set by app.js: the one function allowed to repaint
  onAccount: null,     // the session changed: who is signed in
  onFinish: null,
  chatSink: null,      // set by the chat pane
  lastError: null,
};

// ── clock: the only place time is turned into a number ───────────────────────

/** Best estimate of the server's clock, from the client's point of view. */
function serverNow() {
  return Date.now() + state.skewMs;
}

/**
 * The two clocks as they should be drawn right now.
 *
 * A side that is NOT to move is frozen, so its number is whatever the server
 * said. The side to move drains, by however long it has been since the server
 * measured. That asymmetry is the entire point of a chess clock and it is why
 * this cannot be a simple countdown.
 */
function liveClock() {
  const c = state.game?.clock;
  if (!c) return { white: 0, black: 0, timed: false, turn: null };
  if (!c.timed) return { white: 0, black: 0, timed: false, turn: null };

  let { white, black } = c;
  const elapsed = Math.max(0, serverNow() - (state.game.now_ms || serverNow()));
  if (c.turn === 'white') white = Math.max(0, white - elapsed);
  else if (c.turn === 'black') black = Math.max(0, black - elapsed);
  return { white, black, timed: true, turn: c.turn };
}

// ── applying what the server said ───────────────────────────────────────────

/**
 * Rebuild the local board from the server's move list and copy across everything
 * else it told us. Returns true if anything visible changed, so the caller can
 * skip a repaint on a poll that only refreshed the clocks.
 */
function applyState(payload) {
  const g = payload?.game;
  if (!g) return false;

  const prevPly = state.lastPly;
  const prevStatus = state.game?.status;
  const prevFen = state.game?.fen;

  state.game = g;
  state.gameId = g.id ?? state.gameId;
  state.drawOfferedBy = payload.draw_offered_by ?? null;

  // The skew is measured on every response, not once: a client's Date.now() can
  // be off, a network hop adds latency, and both move. Recomputing each time is
  // what keeps a 5-minute game honest without trusting the browser's wall clock.
  if (typeof payload.now_ms === 'number') {
    // half the round trip: the response was sent halfway through the journey
    const rtt = Math.max(0, (Date.now() - (state.requestedAt || Date.now())));
    state.skewMs = payload.now_ms - Date.now() + rtt / 2;
  }

  const plyChanged = prevPly !== g.ply;
  const fenChanged = prevFen !== g.fen;
  if (plyChanged || fenChanged) {
    const next = new Chess();
    for (const san of g.moves || []) {
      if (!next.moveSan(san)) {
        // A move list the local engine refuses means the two engines have
        // drifted. Saying so beats showing a board that is quietly wrong.
        console.error('online: move list did not replay locally:', san);
        return false;
      }
    }
    state.lastPly = g.ply;
    state.onChange?.({ rebuilt: true, chess: next });
  }

  // Which seat is mine is the server's answer, asked for explicitly. Guessing
  // it from a player id is how a player ends up flipping their own side on a
  // reload, and "me: null" (watching) is a real answer that is not white.
  if (g.me === 'white') state.myColor = WHITE;
  else if (g.me === 'black') state.myColor = BLACK;

  if (g.status === 'ended' && prevStatus !== 'ended') {
    state.onFinish?.(g);
  }
  return plyChanged || fenChanged || prevStatus !== g.status;
}

// ── who is it, and is it my turn ────────────────────────────────────────────

export function isOnline() {
  return !!state.game;
}

export function myColor() {
  return state.myColor;
}

export function myUserId() {
  return state.user?.id ?? null;
}

/**
 * Is this move mine to make?
 *
 * The local board is asked whether the turn is even right, and the server's
 * status is asked whether the game is still going. Both have to agree: if the
 * client thinks it is white's move but the server says the game ended, the
 * answer is no.
 */
export function isMyTurn() {
  if (!state.game) return false;
  if (state.game.status !== 'active') return false;
  if (state.drawOfferedBy && state.drawOfferedBy !== state.user?.id) return false;
  return state.game.turn === (state.myColor === WHITE ? 'white' : 'black');
}

export function game() {
  return state.game;
}

export function isBusy() {
  return state.busy;
}

export function lastError() {
  return state.lastError;
}

// ── playing ─────────────────────────────────────────────────────────────────

/**
 * Send a move. It is NOT applied locally first: the server decides whether it
 * happened, and the reply rebuilds the board.
 */
export async function play(from, to, promotion) {
  if (state.busy) return false;
  if (!isMyTurn()) return false;
  state.busy = true;
  state.lastError = null;
  try {
    const res = await api.move(state.gameId, from, to, promotion || null);
    applyState(res);
    return true;
  } catch (err) {
    if (err instanceof ApiError) {
      state.lastError = err;
      // not_your_turn and illegal_move mean the client was behind, not that the
      // player did something wrong. Resync instead of showing a scolding.
      if (err.code === 'not_your_turn' || err.code === 'illegal_move' || err.code === 'not_playing') {
        await refresh();
      } else {
        state.onError?.(err);
      }
    }
    return false;
  } finally {
    state.busy = false;
  }
}

export async function resign() {
  try {
    applyState(await api.resign(state.gameId));
    return true;
  } catch (err) {
    state.onError?.(err);
    return false;
  }
}

export async function offerDraw() {
  try {
    const res = await api.draw(state.gameId, false);
    state.drawOfferedBy = res.draw_offered_by ?? null;
    applyState(res);
    return true;
  } catch (err) {
    state.onError?.(err);
    return false;
  }
}

export async function declineDraw() {
  try {
    await api.draw(state.gameId, true);
    state.drawOfferedBy = null;
    state.onChange?.({ rebuilt: false });
    return true;
  } catch (err) {
    state.onError?.(err);
    return false;
  }
}

// ── entering and leaving a game ─────────────────────────────────────────────

export async function createGame({ baseMs, incrementMs, open }) {
  const res = await api.createGame({ baseMs, incrementMs, open });
  adopt(res, res.code);
  return res.code;
}

export async function joinGame(code) {
  const res = await api.joinGame(code);
  adopt(res, code);
  return res.code;
}

/**
 * Quick match. Returns true if an opponent was found and seated straight away,
 * false if nobody was waiting - in which case we are now the waiting game and
 * startPolling() will bring the opponent in when they arrive. Both outcomes are
 * a game you are in; the difference is only how long the board says "waiting".
 */
export async function quickMatch(opts) {
  const res = await api.quickMatch(opts);
  adopt(res, res.code);
  return Boolean(res.matched);
}

/** Open a game somebody else made, without taking a seat. */
export async function watch(code) {
  const res = await api.watchGame(code);
  adopt(res, code, true);
  return res.game?.code ?? code;
}

function adopt(res, code, watching = false) {
  const g = res.game;
  if (!g) throw new Error('no game in that response');
  g.id = g.id ?? res.code ?? code;
  state.gameId = Number(g.id);
  state.game = g;
  state.lastPly = -1;                 // force one rebuild on the next paint
  state.lastChatId = 0;
  state.drawOfferedBy = res.draw_offered_by ?? null;
  applyState({ ...res, game: g, draw_offered_by: res.draw_offered_by ?? null });
  startPolling();
  if (!watching) startChat();
  return g;
}

/** Throw the local game away and go back to whatever the board was doing. */
export function leave() {
  stopPolling();
  stopChat();
  state.game = null;
  state.gameId = 0;
  state.lastPly = -1;
  state.lastChatId = 0;
  state.drawOfferedBy = null;
  state.skewMs = 0;
  state.lastError = null;
}

// ── polling ─────────────────────────────────────────────────────────────────

/**
 * One poll. Exported because the smoke test drives it directly rather than
 * waiting for a timer, which is the difference between a test that finishes and
 * a test that flakes.
 */
export async function refresh() {
  if (!state.gameId) return null;
  state.requestedAt = Date.now();
  try {
    const res = await api.state(state.gameId, state.lastPly);
    const changed = applyState(res);
    if (changed) state.onChange?.({ rebuilt: true });
    return res;
  } catch (err) {
    // A failed poll is not a game-ending event. The board stays exactly as it
    // was and the next one tries again; the clock keeps draining locally from
    // the last known server value, so the game stays honest for a few seconds
    // of network trouble.
    if (!(err instanceof ApiError) || err.status >= 500) state.lastError = err;
    return null;
  }
}

function startPolling() {
  stopPolling();
  const tick = async () => {
    await refresh();
    // Polling twice a second for a game nobody is watching is how a shared host
    // falls over, so the interval follows the game instead of being a constant.
    const status = state.game?.status;
    const fast = status === 'active';
    state.pollTimer = setTimeout(tick, fast ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  };
  state.pollTimer = setTimeout(tick, POLL_ACTIVE_MS);
}

function stopPolling() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

/**
 * Stop polling entirely: a backgrounded tab should not keep a game alive on the
 * server's clock, and a tab nobody is looking at does not need 2 requests a
 * second from a phone battery.
 */
export function onVisibility() {
  if (document.hidden) {
    stopPolling();
    stopChat();
  } else if (state.game) {
    startPolling();
    startChat();
  }
}

// ── chat ────────────────────────────────────────────────────────────────────

function startChat() {
  stopChat();
  const tick = async () => {
    if (state.gameId) {
      try {
        const res = await api.chat(state.gameId, state.lastChatId);
        if (res.messages?.length) {
          state.lastChatId = res.messages[res.messages.length - 1].id;
          state.chatSink?.(res.messages);
        }
      } catch { /* a dropped chat poll is not worth a message */ }
    }
    state.chatTimer = setTimeout(tick, POLL_CHAT_MS);
  };
  state.chatTimer = setTimeout(tick, POLL_CHAT_MS);
}

function stopChat() {
  if (state.chatTimer) clearTimeout(state.chatTimer);
  state.chatTimer = null;
}

export async function say(body) {
  const text = String(body || '').trim();
  if (!text) return false;
  try {
    const res = await api.say(state.gameId, text);
    if (res.message) {
      state.lastChatId = Math.max(state.lastChatId, res.message.id);
      state.chatSink?.([res.message]);
    }
    return true;
  } catch (err) {
    state.onError?.(err);
    return false;
  }
}

// ── the session ─────────────────────────────────────────────────────────────

/**
 * Who am I?
 *
 * Needed for exactly one decision - whether the player id in an ended game is
 * mine - and getting it wrong means the winner is shown the loss screen. It is
 * fetched once at boot and never guessed from anything the server did not say.
 */
export async function loadSession() {
  try {
    const res = await api.me();
    state.user = res.user ?? null;
    return state.user;
  } catch {
    // Not being logged in is the normal state of somebody who just wants to
    // play the computer, so this is not an error worth reporting: a failed
    // session check must never stop the local game from loading.
    state.user = null;
    return null;
  } finally {
    // Whoever the account panel is belongs to the app, so the app is told. The
    // session changes on boot, on login and on logout, and leaving the name on
    // screen after a logout is the kind of thing that looks like a security bug
    // to the person who just logged out.
    state.onAccount?.(state.user);
  }
}

export function user() {
  return state.user;
}

export async function login(username, password, remember) {
  const res = await api.login(username, password, !!remember);
  state.user = res.user ?? null;
  state.onAccount?.(state.user);
  return state.user;
}

export async function register(username, password, displayName, remember) {
  const res = await api.register(username, password, displayName, !!remember);
  state.user = res.user ?? null;
  state.onAccount?.(state.user);
  return state.user;
}

export async function logout() {
  await api.logout(!!state.user?.remember);
  state.user = null;
  state.onAccount?.(null);
  leave();
}

// ── wiring ──────────────────────────────────────────────────────────────────

export function attach({ onChange, onFinish, onError, onChat, onAccount, user }) {
  state.onChange = onChange;
  state.onAccount = onAccount;
  state.onFinish = onFinish;
  state.onError = onError;
  state.chatSink = onChat;
  state.user = user;
}

export function setUser(user) {
  state.user = user;
}

export function clockNow() {
  return liveClock();
}

document.addEventListener('visibilitychange', onVisibility);
