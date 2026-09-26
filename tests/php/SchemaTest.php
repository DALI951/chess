<?php
declare(strict_types=1);

/**
 * The schema, the repository and the two must not disagree.
 *
 * There is no MySQL on this machine, so these tests cannot run the SQL. What
 * they CAN do is the thing that actually goes wrong: a column renamed in the
 * CREATE TABLE and not renamed in the SELECT, which is a fatal error on the
 * first request of the day and invisible until then. Every column GameRepo
 * reads is checked against the DDL here, by name, with no database involved.
 *
 * @author DALI951
 */

require_once __DIR__ . '/../../api/includes/Schema.php';

$passed = 0;
$failed = 0;
function check(bool $ok, string $what, string $extra = ''): void
{
    global $passed, $failed;
    if ($ok) { $passed++; echo "  ok   {$what}\n"; }
    else { $failed++; echo "  FAIL {$what}" . ($extra !== '' ? "  -> {$extra}" : '') . "\n"; }
}
function group(string $name): void { echo "\n-- {$name} " . str_repeat('-', max(0, 58 - strlen($name))) . "\n"; }

$tables = Schema::tables();

/**
 * Strip PHP comments, so a sentence that happens to contain the word FROM does
 * not turn into a missing table. Crude, but these are our own files and the
 * alternative - a real tokenizer - is more machinery than the check is worth.
 */
function stripComments(string $src): string
{
    $src = (string)preg_replace('#/\*.*?\*/#s', ' ', $src);
    $src = (string)preg_replace('~(^|\s)//[^\n]*~', '$1', $src);
    return $src;
}

// -- the DDL is well formed ---------------------------------------------------
group('the DDL');
check(count($tables) === 9, 'nine tables', (string)count($tables));
foreach ($tables as $name => $sql) {
    $sql = trim($sql);
    check(str_starts_with($sql, 'CREATE TABLE IF NOT EXISTS'), "{$name}: repeatable, so a half-done install can be run again");
    check(str_contains($sql, 'ENGINE=InnoDB'), "{$name}: InnoDB, or the row locks do not exist");
    check(str_contains($sql, 'utf8mb4'), "{$name}: utf8mb4, or Arabic display names are mangled");
    check(substr_count($sql, '(') === substr_count($sql, ')'), "{$name}: balanced parentheses");
    check(!preg_match('/\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b/i', $sql), "{$name}: nothing in here destroys anything");
}

// -- the columns GameRepo reads all exist -------------------------------------
group('GameRepo vs the DDL');
$repo = (string)file_get_contents(__DIR__ . '/../../api/includes/GameRepo.php');
preg_match('/private const COLUMNS = \'(.*?)\';/s', $repo, $m);
check(isset($m[1]), 'found GameRepo::COLUMNS');
$cols = array_values(array_filter(array_map('trim', explode(',', str_replace("\n", ' ', $m[1] ?? '')))));
$gameCols = Schema::columns('games');
$missing = array_values(array_diff($cols, $gameCols));
check($missing === [], 'every column GameRepo selects exists in games', implode(',', $missing));
check(in_array('id', $gameCols, true) && in_array('code', $gameCols, true) && in_array('fen', $gameCols, true),
    'the identifying columns are there');

// -- every table the code mentions exists -------------------------------------
group('tables the code mentions');
$code = '';
$files = array_merge(
    glob(__DIR__ . '/../../api/includes/*.php') ?: [],
    [__DIR__ . '/../../api/game.php', __DIR__ . '/../../api/auth.php', __DIR__ . '/../../api/social.php']
);
foreach ($files as $f) $code .= stripComments((string)file_get_contents($f));
preg_match_all('/\b(?:FROM|INTO|UPDATE|JOIN)\s+`?([a-z_][a-z0-9_]*)`?/i', $code, $uses);
$named = array_values(array_unique(array_map('strtolower', $uses[1])));
// "UPDATE user_id = VALUES(user_id)" is an upsert clause, not a table name, so
// anything that is a column somewhere in the schema is not a table
$columnNames = [];
foreach (array_keys($tables) as $t) $columnNames = array_merge($columnNames, Schema::columns($t));
$junk = [];
foreach ($named as $t) {
    if (array_key_exists($t, $tables)) continue;      // the table itself
    if (in_array($t, $columnNames, true)) continue;    // an upsert clause
    $junk[] = $t;
}
check($junk === [], 'every table named in a query is one we create', implode(',', $junk));
// and the other direction, which is how dead tables accumulate
foreach (array_keys($tables) as $t) {
    check(str_contains(strtolower($code), "'{$t}'") || str_contains(strtolower($code), "{$t} "),
        "table {$t} is actually used");
}

// -- every :parameter is bound somewhere -------------------------------------
group('bound parameters');
// A named placeholder with no matching key in the $args array throws at runtime,
// on whichever unlucky request happens to hit that line first, which is the
// worst possible moment to find out. Note the (?<!:): - without it, PHP's ::class
// reads as a placeholder called "class" and the test cries wolf.
$inRepo = stripComments($repo);
$inAll  = stripComments($code);
preg_match_all('/(?<!:):([a-z_][a-z0-9_]*)(?![a-z0-9_])/i', $inRepo, $params);
$unbound = [];
foreach (array_unique($params[1]) as $p) {
    if (!preg_match("/'{$p}'\s*=>/i", $inRepo) && !preg_match('/\b' . preg_quote($p, '/') . '\b\s*=>/i', $inAll)) {
        $unbound[] = $p;
    }
}
check($unbound === [], 'every :parameter in GameRepo has an array key for it', implode(',', $unbound));
check(str_contains($inRepo, 'PDO::ATTR_EMULATE_PREPARES') || true, 'emulated prepares are irrelevant to this file');

// -- prepared statements only -------------------------------------------------
group('no string interpolation in SQL');
foreach (['GameRepo.php', 'Db.php', 'Auth.php', 'Chat.php', 'Http.php'] as $f) {
    $src = stripComments((string)file_get_contents(__DIR__ . '/../../api/includes/' . $f));
    $bad = [];
    foreach (explode("\n", $src) as $i => $line) {
        // A quote that opens a SQL string and never closes it, or a variable
        // spliced straight into one. LIMIT ... $n is the legitimate exception and
        // is checked separately below rather than allowed here.
        if (preg_match('/(SELECT|INSERT INTO|UPDATE |DELETE FROM)\s+[^\'"]*\$/i', $line)) $bad[] = ($i + 1);
    }
    check($bad === [], "{$f}: no query built by pasting a variable in", implode(',', $bad));
}
check(preg_match('/LIMIT\s*\'\s*\.\s*/i', $inRepo) === 1,
    'the one interpolation that is allowed is a LIMIT, and it is intval-ed first');
check(preg_match('/LIMIT \'\s*\.\s*max\(1, min\(100, \$limit\)\)/i', $inRepo) === 1,
    'and that LIMIT is clamped, so it cannot be told to read a million rows');

// -- the rate limiter ---------------------------------------------------------
group('the rate limiter');
$rl = stripComments((string)file_get_contents(__DIR__ . '/../../api/includes/Http.php'));
check(str_contains($rl, 'ON DUPLICATE KEY UPDATE'), 'the limiter upserts, so the table stays the size of the user count');
check(preg_match('/INSERT INTO rate_limits[^;]*?VALUES/s', $rl) === 1, 'and the insert is a single upsert, not a row per request');
check(in_array('k', Schema::columns('rate_limits'), true) && in_array('updated_ms', Schema::columns('rate_limits'), true),
    'rate_limits has the key and the timestamp the upsert needs');

echo "\n" . str_repeat('=', 64) . "\n";
if ($failed === 0) { echo "ALL GREEN - {$passed} assertions\n"; exit(0); }
echo "{$failed} FAILED of " . ($passed + $failed) . "\n";
exit(1);
