<?php
declare(strict_types=1);

/**
 * The array GameState::create() returns is fed straight into GameRepo::insert().
 *
 * Nothing type-checks that hand-off, because both sides speak plain arrays. So
 * they drifted, and it cost every single game on the site: create() did not set
 * 'sans', the games table declares that column NOT NULL, and insert() bound
 * NULL - so creating a game was a 500 on "Column 'sans' cannot be null" for
 * every player, while the engine, the board and the schema all tested green.
 *
 * The fix is the same shape of guard as the other two tests here: the contract
 * is written down twice, so read the keys out of one and check them against the
 * other instead of trusting that somebody remembered.
 *
 * @author DALI951
 */

require_once __DIR__ . '/../../api/includes/Engine.php';   // Chess, and the START_FEN GameState::create() reads
require_once __DIR__ . '/../../api/includes/GameState.php';
require_once __DIR__ . '/../../api/includes/Schema.php';

$passed = 0;
$failed = 0;
function check(bool $ok, string $what, string $extra = ''): void
{
    global $passed, $failed;
    if ($ok) { $passed++; echo "  ok   {$what}\n"; }
    else { $failed++; echo "  FAIL {$what}" . ($extra !== '' ? "  -> {$extra}" : '') . "\n"; }
}
function group(string $n): void { echo "\n-- {$n} " . str_repeat('-', max(0, 58 - strlen($n))) . "\n"; }

$repo   = (string)file_get_contents(dirname(__DIR__, 2) . '/api/includes/GameRepo.php');
$schema = (string)file_get_contents(dirname(__DIR__, 2) . '/api/includes/Schema.php');

group('create() produces every key insert() reads');

$fresh = GameState::create(['white_user' => 7, 'black_user' => 9, 'now_ms' => 1_700_000_000_000]);

// every $game['x'] that insert() reads
preg_match_all("/\\\$game\['([a-z_0-9]+)'\]/", substr($repo, (int)strpos($repo, 'function insert'), 3000), $m);
$read = array_values(array_unique($m[1]));
sort($read);

$missing = [];
foreach ($read as $key) {
    if (!array_key_exists($key, $fresh)) $missing[] = $key;
}
check($read !== [], 'the test actually found the keys insert() reads', implode(',', $read));
check($missing === [], 'create() supplies every key insert() reads', implode(',', $missing));
foreach ($read as $key) {
    if (array_key_exists($key, $fresh)) check(true, "create()['{$key}'] is present");
}

group('the NOT NULL columns insert() binds are all set');

// The actual crash: sans is NOT NULL and was never set. If a column insert()
// writes is NOT NULL, create() has to give it a value or every insert is a 500.
// Parsed line by line - a regex over the whole DDL has to survive the -- comment
// lines that sit in the middle of the column list.
$lines = preg_split('/\R/', $schema) ?: [];
$ddl = [];
$inGames = false;
foreach ($lines as $ln) {
    if (preg_match('/CREATE TABLE IF NOT EXISTS games\s*\(/i', $ln)) { $inGames = true; continue; }
    if (!$inGames) continue;
    if (preg_match('/^\s*\)/', $ln)) break;
    $t = trim($ln);
    if ($t === '' || str_starts_with($t, '--')) continue;
    if (preg_match('/^([a-z_]+)\s+(INT|BIGINT|CHAR|TINYINT|SMALLINT|VARCHAR|TEXT|MEDIUMTEXT|ENUM)\b/i', $t, $cm2)) {
        $ddl[$cm2[1]] = (bool)preg_match('/\bNOT NULL\b/i', $t);
    }
}
$notNull = array_keys(array_filter($ddl, static fn($v) => $v));
check($notNull !== [], 'the games NOT NULL columns were found', implode(',', $notNull));

// the columns insert() names in its INSERT list
$insertBody = substr($repo, (int)strpos($repo, 'function insert'), 3000);
preg_match('/INSERT INTO games \((.*?)\)\s*VALUES/s', $insertBody, $im);
$boundCols = array_map('trim', explode(',', $im[1] ?? ''));

foreach ($boundCols as $col) {
    if ($col === '' || in_array($col, ['0', 'ply'], true)) continue;      // literal values
    if (!in_array($col, $notNull, true)) continue;

    // 'code' is excluded on purpose: GameRepo::insert() generates the room code
    // itself and retries on a collision, so an empty code from create() is the
    // design, not an oversight. What matters is that it is not null.
    //
    // And the assertion is against null, not against ''. NOT NULL forbids NULL;
    // an empty pgn is a real, correct value for a game nobody has finished.
    if ($col === 'code') {
        check(array_key_exists($col, $fresh), "'{$col}' is present (insert() fills it)");
        continue;
    }
    check(
        array_key_exists($col, $fresh) && $fresh[$col] !== null,
        "NOT NULL column '{$col}' is never null from create()",
        array_key_exists($col, $fresh) ? var_export($fresh[$col], true) : 'key absent'
    );
}

group('a row is the same shape however it was obtained');

// The other half of the same drift: publicState() read updated_at_ms while a
// row loaded from the games table carries updated_ms, so the client's
// freshness stamp came back 0.
$both = array_intersect_key($fresh, ['updated_at_ms' => 1, 'updated_ms' => 1, 'created_at_ms' => 1, 'created_ms' => 1]);
check(count($both) === 4, 'create() carries both timestamp spellings', implode(',', array_keys($both)));
check($fresh['updated_at_ms'] === $fresh['updated_ms'], 'the two updated stamps agree');
check($fresh['created_at_ms'] === $fresh['created_ms'], 'the two created stamps agree');
check(json_decode((string)$fresh['sans'], true) === [], 'sans starts as an empty JSON list', $fresh['sans']);

group('ratings can actually settle');

// settleRatings() bailed on !empty($game['rated']), and 'rated' is not a column
// on games - so on any row read back from the table the key was absent, the
// check was false, and the function returned before writing anything. Games
// ended, results were stored, and no rating moved anywhere on the site.
check(!array_key_exists('rated', $ddl), "'rated' really is not a column (that is the trap)", implode(',', array_keys($ddl)));

$settleSrc = (string)file_get_contents(dirname(__DIR__, 2) . '/api/includes/GameRepo.php');
$settleBody = substr($settleSrc, (int)strpos($settleSrc, 'function settleRatings'), 1600);
check(
    !preg_match("/\\\$rated\s*=\s*!empty\(\s*\\\$game\['rated'\]/", $settleBody),
    'settleRatings does not treat an absent rated key as unrated'
);
check(
    (bool)preg_match("/array_key_exists\(\s*'rated'\s*,\s*\\\$game\s*\)/", $settleBody),
    'settleRatings defaults a missing rated flag to rated'
);
check((bool)preg_match('/\bblack_user\b/', $settleBody), 'settleRatings reads black_user, so a seated game rates');

group('matchmaking reads the open games as the queue');

// Matchmaking has no table of its own: an open game IS somebody waiting, so the
// contract to hold is that the query only ever offers games which can actually
// be seated in - waiting, black seat free, not yours, same setup, not brand new.
$repoAll = $repo;
// A generous window: this is a source-text contract, and a long explanatory
// comment pushed the return statement past a 3000-char slice once already.
$matchBody = (string)substr($repoAll, (int)strpos($repoAll, 'function match'), 6000);
check($matchBody !== '', 'GameRepo::match() exists');

$rules = [
    'only waiting games'        => 'status = :waiting',
    'only games with a free seat' => 'black_user IS NULL',
    'never the creator yourself' => 'white_user <> :me',
    'only the same starting position' => 'fen = :fen',
    'only the same time control' => 'tc_base_ms = :base',
    'oldest waiter first'       => 'ORDER BY created_ms ASC',
];
foreach ($rules as $label => $needle) {
    check(str_contains($matchBody, $needle), "matchmaking: {$label}", $needle);
}

// NO minimum-age clause. It reads like a sensible guard against being matched
// into the room you just left, but the query already refuses that (you cannot
// be the creator, and a room you were seated in has black_user set). What it
// really did was stop two people who pressed quick play in the same second from
// ever meeting - the one job this feature has. Abandoned rooms are expireStale's
// job now, and it has a two-minute TTL for unjoined rooms.
check(
    !str_contains($matchBody, 'created_ms <'),
    'matchmaking: no minimum-age clause, or quick players never meet'
);

// A race is normal: two people click at once, both read the same candidate, and
// one of them loses the seat. That must be a "try the next one", not a 500.
check(
    str_contains($matchBody, "errorCode === 'seat_taken'"),
    'matchmaking: losing the seat race is handled, not thrown'
);

// When nobody is waiting it must still hand back a game, or the caller has
// nothing to poll and the button appears to do nothing.
check(
    str_contains($matchBody, "'matched' => false"),
    'matchmaking: finding nobody is a waiting game, not a failure'
);
check(
    str_contains($matchBody, "'matched' => true"),
    'matchmaking: sitting down reports matched'
);

group('save() persists every column the rest of the code mutates');

// save() wrote every column of a game EXCEPT white_user and black_user, so
// seat() looked like it worked and persisted nothing. A column that is read
// somewhere and changed somewhere must be in the UPDATE; this lists the ones
// that are read on a loaded row and fails if any is missing from the statement.
$saveBody = substr($repo, (int)strpos($repo, 'function save'), 2200);
foreach (['white_user', 'black_user', 'status', 'fen', 'ply', 'sans', 'pgn', 'white_ms', 'black_ms',
          'turn_started_at_ms', 'turn_started_ms', 'result', 'reason', 'winner_user', 'ended_at_ms'] as $col) {
    check(
        (bool)preg_match('/\b' . preg_quote($col, '/') . '\s*=/', $saveBody),
        "save() writes {$col}"
    );
}

group('a waiting game has a free black seat');

// The join path used to test the WRONG seat. An open game is created with the
// creator already in white and black_user NULL, so "is white taken?" was always
// yes and every join came back seat_taken. The site loaded, the board worked,
// and no two people could ever play each other. This asserts the shape that
// makes a join possible, so the guard cannot be pointed at the wrong column
// again without this going red.
$open = GameState::create(['white_user' => 42, 'black_user' => null, 'now_ms' => 1_700_000_000_000]);
check($open['status'] === GameState::WAITING, 'an open game is waiting', $open['status']);
check($open['white_user'] === 42, 'the creator holds white', var_export($open['white_user'], true));
check($open['black_user'] === null, 'black is the open seat', var_export($open['black_user'], true));
check($open['turn_started_at_ms'] === null, 'no clock runs while waiting');

// and the seat() guard must read black_user, not white_user
$seatSrc = (string)file_get_contents(dirname(__DIR__, 2) . '/api/includes/GameRepo.php');
$seatBody = substr($seatSrc, (int)strpos($seatSrc, 'function seat'), 2200);
$guardsWhite = (bool)preg_match("/if \(\s*\\\$game\['white_user'\]\s*!==\s*null\s*\)/", $seatBody);
$guardsBlack = (bool)preg_match("/if \(\s*\\\$game\['black_user'\]\s*!==\s*null\s*\)/", $seatBody);
check($guardsBlack, "seat() guards the BLACK seat, the one that is actually open");
check(!$guardsWhite, "seat() does not refuse a join because white is taken (that was the bug)");

group('a real game builds end to end');
$g = GameState::create(['white_user' => 1, 'black_user' => 2, 'now_ms' => 1_700_000_000_000]);
check($g['status'] === GameState::ACTIVE, 'two players means active', (string)$g['status']);
check($g['turn_started_at_ms'] !== null, 'the clock started for a real game');
$w = GameState::create(['white_user' => 1, 'now_ms' => 1_700_000_000_000]);
check($w['status'] === GameState::WAITING, 'one player means waiting', (string)$w['status']);
check($w['turn_started_at_ms'] === null, 'a waiting game runs no clock');
check($w['white_ms'] === 600000, 'the waiting player still holds a full clock', (string)$w['white_ms']);

echo "\n" . str_repeat('=', 60) . "\n";
printf("%s - %d assertions\n", $failed === 0 ? 'ALL GREEN' : "{$failed} FAILED", $passed + $failed);
exit($failed === 0 ? 0 : 1);
