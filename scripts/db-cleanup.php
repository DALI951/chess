<?php
declare(strict_types=1);
/**
 * Delete the accounts and games the live tests created. TEMPORARY, one-shot.
 *
 * The site has no delete-account feature, so scripts/live-smoke.py cannot clean
 * up after itself and every run leaves two accounts and a finished game behind.
 * On a leaderboard that is worse than useless - a new player sees "Smoke w 1516"
 * at the top. This removes exactly the test debris and nothing else.
 *
 * Two guards, because this deletes rows and it briefly sits at a public URL:
 *   1. it needs the setup token
 *   2. it refuses to run unless every single user matches a test username
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

$userIds = [];
foreach (Db::all("SELECT id FROM users WHERE username REGEXP '^(probe|smoke|dali)[0-9]*_'") as $r) {
    $userIds[] = (int)$r['id'];
}
$u = implode(',', $userIds) ?: '0';

$gameIds = [];
foreach (Db::all("SELECT id FROM games WHERE white_user IN ($u) OR black_user IN ($u)") as $r) {
    $gameIds[] = (int)$r['id'];
}
$g = implode(',', $gameIds) ?: '0';

$strangers = Db::one("SELECT COUNT(*) c FROM users WHERE id NOT IN ($u)")['c'];

echo "test users : " . count($userIds) . "\n";
echo "test games : " . count($gameIds) . "\n";
echo "other users: $strangers\n";

if ($strangers > 0) {
    exit("STOPPED: $strangers account(s) are not test accounts, so I will not guess.\n");
}
if (count($userIds) === 0) {
    echo "nothing to do\n";
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
