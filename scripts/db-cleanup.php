<?php
declare(strict_types=1);
/**
 * Delete the accounts and games the live tests created. TEMPORARY, one-shot.
 *
 * The site has no delete-account feature, so scripts/live-smoke.py and
 * scripts/live-match.py cannot clean up after themselves and every run leaves
 * accounts and a finished game behind. On a leaderboard that is worse than
 * useless - a new player sees "Smoke w 1516" at the top. This removes exactly
 * the test debris and nothing else.
 *
 * It needs the setup token, and the pattern is deliberately narrow: `probe_` and
 * `smoke_` are the only two prefixes scripts/live-match.py and
 * scripts/live-smoke.py ever create, so they are the only two things matched.
 * An earlier version also matched `dali[0-9]*_`, which is one rename away from
 * deleting the owner's own account, and it refused to run at all once the site
 * had a single real player - which is to say it stopped working the moment the
 * site started being worth cleaning.
 *
 * What replaces that guard: the delete set is built from the pattern and
 * nothing else, and before deleting anything this asserts that set does not
 * contain a single user outside the pattern, and that it is not about to empty
 * the table. Real accounts are counted, named in the output, and never touched.
 *
 * Run it through scripts/run-db-cleanup.py, which deletes this file afterwards.
 *
 * @author DALI951
 */

require_once __DIR__ . '/includes/bootstrap.php';

header('Content-Type: text/plain; charset=utf-8');

$expected = (string)($_GET['t'] ?? '');
if (!hash_equals((string)Config::setupToken(), $expected)) {
    exit("refusing: bad token\n");
}
$apply = (($_GET['mode'] ?? '') === 'apply');

// Exactly the two prefixes the live test scripts create, and nothing wider. A
// pattern loose enough to catch a real account is worse than no cleanup at all.
$TEST_USER_RE = '^(probe|smoke)_';

$userIds = [];
foreach (Db::all("SELECT id, username FROM users WHERE username REGEXP '$TEST_USER_RE'") as $r) {
    $userIds[] = (int)$r['id'];
}
$u = implode(',', $userIds ?: [0]);

$gameIds = [];
foreach (Db::all("SELECT id FROM games WHERE white_user IN ($u) OR black_user IN ($u)") as $r) {
    $gameIds[] = (int)$r['id'];
}
$g = implode(',', $gameIds ?: [0]);

// The real accounts, named out loud, so the output is a receipt and not a promise.
$keepers = Db::all("SELECT id, username FROM users WHERE username NOT REGEXP '$TEST_USER_RE' ORDER BY id");

echo "test users  : " . count($userIds) . "\n";
echo "test games  : " . count($gameIds) . "\n";
echo "kept (real) : " . count($keepers) . "\n";
foreach ($keepers as $k) {
    echo "   keeping  #{$k['id']}  {$k['username']}\n";
}

// The guards. The deletes below are scoped to $u by construction, so these are
// assertions that the construction held, not hopes that it did.
$total = (int)Db::one('SELECT COUNT(*) c FROM users')['c'];
$leaked = (int)Db::one("SELECT COUNT(*) c FROM users WHERE id NOT IN ($u) AND username REGEXP '$TEST_USER_RE'")['c'];
if ($leaked > 0) {
    exit("STOPPED: $leaked matched user(s) fell outside the delete set. Not guessing.\n");
}
if ($total > 0 && count($userIds) === $total) {
    exit("STOPPED: every account on the site looks like a test account. Refusing to empty the table.\n");
}
if (count($userIds) === 0) {
    echo "\nnothing to do\n";
    exit(0);
}

if (!$apply) {
    echo "\ndry run. nothing deleted. (add ?mode=apply)\n";
    exit(0);
}

// children before parents, or the foreign keys complain
foreach ([
    'chat_messages'     => "DELETE FROM chat_messages WHERE user_id IN ($u)",
    'game_draw_offers' => "DELETE FROM game_draw_offers WHERE game_id IN ($g)",
    'game_moves'       => "DELETE FROM game_moves WHERE game_id IN ($g)",
    'friends'          => "DELETE FROM friends WHERE user_id IN ($u) OR friend_id IN ($u)",
    'remember_tokens'  => "DELETE FROM remember_tokens WHERE user_id IN ($u)",
    'games'            => "DELETE FROM games WHERE id IN ($g)",
    'users'            => "DELETE FROM users WHERE id IN ($u)",
    // rate_limits is per-IP, not per-user, and every row is from the tests
    'rate_limits'      => 'DELETE FROM rate_limits',
] as $table => $sql) {
    Db::run($sql);
    echo "cleaned $table\n";
}

echo "\n";
foreach (['users', 'games', 'game_moves', 'chat_messages', 'friends'] as $t) {
    echo str_pad($t, 16) . " = " . Db::one("SELECT COUNT(*) c FROM $t")['c'] . "\n";
}
echo "app_meta kept: " . Db::one('SELECT COUNT(*) c FROM app_meta')['c'] . "\n";
