/**
 * The server, as a JavaScript object.
 *
 * Every call is a JSON POST with credentials, because every call is either
 * changing something or reading something that is per-user, and a GET would be
 * cacheable in exactly the places it must not be.
 *
 * Two things this module does NOT do, and the reasons are the whole design:
 *
 * It never decides anything about a game. It sends, it receives, it hands back
 * what the server said. Every rule - whose turn it is, whether a clock has run
 * out, who won - is the server's answer, and this file has no opinion.
 *
 * It never trusts a clock. The server sends remaining milliseconds and the
 * moment it was measured; the client interpolates from there to draw a smooth
 * clock, and the next poll overwrites it. If the client's own idea of the time is
 * wrong, the visible clock is briefly wrong and nothing else is.
 *
 * @author DALI951
 */

const TIMEOUT_MS = 15000;

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function post(file, body, { timeout = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  // A poll that hangs forever looks to a player exactly like a game that has
  // frozen, and a game that looks frozen is a bug report. So every request has
  // a deadline and gives up out loud.
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(`api/${file}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ApiError('timeout', 'The server did not answer in time.', 0);
    }
    throw new ApiError('offline', 'Cannot reach the server.', 0);
  } finally {
    clearTimeout(timer);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    // an HTML error page where JSON was expected means the PHP is broken or the
    // .htaccess is wrong; saying so beats "unexpected token <"
    throw new ApiError('bad_response', 'The server sent something that was not JSON.', response.status);
  }
  if (!response.ok || data?.ok === false) {
    throw new ApiError(data?.error || 'http_' + response.status, data?.message || '', response.status);
  }
  return data;
}

export const api = {
  // -- session ---------------------------------------------------------------
  me: () => post('auth.php', { action: 'me' }, { timeout: 6000 }),
  register: (username, password, displayName, remember) =>
    post('auth.php', { action: 'register', username, password, display_name: displayName, remember }),
  login: (username, password, remember) =>
    post('auth.php', { action: 'login', username, password, remember }),
  logout: (remember) => post('auth.php', { action: 'logout', remember }),

  // -- games -----------------------------------------------------------------
  createGame: ({ baseMs, incrementMs, open, fen }) =>
    post('game.php', { action: 'create', tc_base_ms: baseMs, tc_increment_ms: incrementMs, open, fen }),
    joinGame: (code) => post('game.php', { action: 'join', code }),
    // matchmaking: the server either seats us with somebody or puts us in a new
    // open game to wait in, so a short timeout here is not a failure
    quickMatch: ({ baseMs, incrementMs, fen } = {}) =>
      post('game.php', { action: 'quick', tc_base_ms: baseMs, tc_increment_ms: incrementMs, fen }, { timeout: 12000 }),
  state: (game, sinceMove = 0) => post('game.php', { action: 'state', game, since_move: sinceMove }, { timeout: 8000 }),
  // the same state, addressed by room code, for somebody opening a shared link
  watchGame: (code) => post('game.php', { action: 'state', code }, { timeout: 8000 }),
  move: (game, from, to, promotion) => post('game.php', { action: 'move', game, from, to, promotion }),
  resign: (game) => post('game.php', { action: 'resign', game }),
  draw: (game, decline = false) => post('game.php', { action: 'draw', game, decline }),
  listGames: () => post('game.php', { action: 'list' }, { timeout: 8000 }),

  // -- chat ------------------------------------------------------------------
  chat: (game, after = 0) => post('game.php', { action: 'chat', game, after }, { timeout: 8000 }),
  say: (game, body) => post('game.php', { action: 'chat', game, body }),

  // -- social ----------------------------------------------------------------
  leaderboard: () => post('social.php', { action: 'leaderboard' }, { timeout: 8000 }),
  myRecord: () => post('social.php', { action: 'me' }),
  searchPlayers: (q) => post('social.php', { action: 'search', q }),
  friends: () => post('social.php', { action: 'friends' }, { timeout: 8000 }),
  addFriend: (user) => post('social.php', { action: 'friend', user }),
  removeFriend: (user) => post('social.php', { action: 'unfriend', user }),
};

/**
 * Is the server even there?
 *
 * Used to decide whether to show "you are offline" or to quietly keep the local
 * game playable. A local game must never become unplayable because a shared host
 * is having a bad afternoon.
 */
export async function ping() {
  try {
    await api.me();
    return true;
  } catch {
    return false;
  }
}
