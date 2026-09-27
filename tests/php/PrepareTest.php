<?php
declare(strict_types=1);

/**
 * No named placeholder may appear twice in one statement.
 *
 * These are native prepared statements - PDO::ATTR_EMULATE_PREPARES is false in
 * Db::conn() - and MySQL will not bind the same named parameter to two
 * positions. PDO lets you write the SQL; the server rejects it at execution
 * with SQLSTATE[HY093] "Invalid parameter number", which is a 500 rather than a
 * helpful message.
 *
 * It shipped like this in Http::limit(), where :now and :cut were each written
 * twice, and it took the whole rate limiter down with it: register, login,
 * create, move, chat and leaderboard all call it, so every one of those
 * endpoints was a 500 in production while the site itself loaded fine and looked
 * completely healthy. The tests did not catch it because none of them run MySQL,
 * and no amount of testing the PHP will ever catch it here. But the mistake is
 * pure syntax - the same placeholder name appearing twice in one string - so a
 * static check catches it, and that check is what should have existed.
 *
 * The other half of the rule: every :name in the SQL has to be in the $args
 * array, and every key in $args has to be used. A missing one binds as NULL
 * under emulation and throws under native prepares; an extra one is silently
 * ignored by some drivers and a warning in others.
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

$root = dirname(__DIR__, 2) . '/api';
$files = [];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    if ($f->isFile() && $f->getExtension() === 'php') $files[] = $f->getPathname();
}
sort($files);

group('the scraper itself is trustworthy');

// A check that silently stops finding anything is worse than no check: it goes
// green while looking at nothing. So assert it can still see the file it once
// missed, and pin the number so a future tokenizer change cannot quietly
// reduce coverage without failing here.
$authSql = statements((string)file_get_contents($root . '/includes/Auth.php'));
check(count($authSql) >= 3, 'Auth.php still yields its statements', (string)count($authSql) . ' found');
$totalSql = 0;
foreach ($files as $f) $totalSql += count(statements((string)file_get_contents($f)));
check($totalSql >= 40, 'at least 40 statements are visible across api/', (string)$totalSql . ' found');

group('every SQL statement binds cleanly');

$checked = 0;
$bad = [];

foreach ($files as $file) {
    $rel = basename($file);
    $src = (string)file_get_contents($file);
    foreach (statements($src) as $lit) {
        $sql = unphp($lit);
        // drop SQL string literals so a ':x' inside one is not read as a bind
        $bare = preg_replace("/'[^']*'/", "''", $sql) ?? $sql;

        if (!preg_match_all('/:([a-z_][a-z0-9_]*)/i', $bare, $m)) continue;
        $names = array_map('strtolower', $m[1]);
        $checked++;

        $counts = array_count_values($names);
        foreach ($counts as $name => $n) {
            if ($n > 1) {
                $bad[] = "{$rel}: :{$name} used {$n}x in one statement - MySQL binds a named "
                       . "parameter once, so this is a fatal at run time";
            }
        }
    }
}

/**
 * Pull SQL out of a PHP file as exact string literals, joined across
 * concatenation so 'SELECT ... ' . 'FROM x' reads as one statement.
 *
 * This used to be a regex over the raw source, and it was quietly finding
 * nothing in Auth.php - the single most important file for this check. The
 * reason is that a hand-rolled string-literal scanner cannot tell a quote
 * inside a comment from a real one: the first `// don't do that` in a file
 * starts a phantom string that swallows text up to the next quote, and every
 * real literal after that point is misaligned. So the bug it missed was the
 * exact bug it exists to catch, and it reported "all green" while Auth::register
 * was throwing SQLSTATE[HY093] in production.
 *
 * token_get_all() is PHP's own lexer: it knows what a comment is. Use that.
 */
function statements(string $src): array
{
    $tokens = @token_get_all($src);
    $out = [];
    $buf = '';

    foreach ($tokens as $t) {
        if (is_array($t)) {
            if ($t[0] === T_CONSTANT_ENCAPSED_STRING) {
                $buf .= $t[1];
                continue;
            }
            // any other token ends a run of concatenated literals
            if ($buf !== '') { $out[] = $buf; $buf = ''; }
            continue;
        }
        if ($t === '.') continue;             // still concatenating
        if ($buf !== '') { $out[] = $buf; $buf = ''; }
    }
    if ($buf !== '') $out[] = $buf;

    $sql = [];
    foreach ($out as $lit) {
        $body = trim($lit, "'\" \t\n\r");
        if (preg_match('/\b(?:SELECT|UPDATE|INSERT\s+INTO|DELETE\s+FROM|REPLACE\s+INTO)\b/i', $body)) {
            $sql[] = $body;
        }
    }
    return $sql;
}

/** The literal's own quoting, minus the quotes: turns \' into ' and "" into ". */
function unphp(string $lit): string
{
    $q = $lit[0];
    $body = substr($lit, 1, -1);
    if ($q === "'") return str_replace(["\\'", '\\\\'], ["'", '\\'], $body);
    if ($q === '"') return str_replace(['\\"', '\\\\'], ['"', '\\'], $body);
    return $body;
}

foreach ($files as $file) {
    $rel = basename($file);
    $src = (string)file_get_contents($file);
    foreach (statements($src) as $sql) {
        // strip quoted literals so a ':x' inside a string is not a placeholder
        $bare = preg_replace("/'(?:\\\\.|[^'\\\\])*'/", "''", $sql) ?? $sql;

        if (!preg_match_all('/:([a-z_][a-z0-9_]*)/i', $bare, $m)) continue;
        $names = array_map('strtolower', $m[1]);
        $checked++;

        $counts = array_count_values($names);
        foreach ($counts as $name => $n) {
            if ($n > 1) {
                $bad[] = "{$rel}: :{$name} used {$n}x in one statement - MySQL binds a named "
                       . "parameter once, so this is a fatal at run time";
            }
        }
    }
}

check($checked > 20, 'the scraper found statements worth checking', (string)$checked);
foreach (array_unique($bad) as $b) check(false, $b);
if ($bad === []) check(true, 'no statement reuses a named placeholder');

group('PDO is in the mode that makes the rule matter');
$db = (string)file_get_contents($root . '/includes/Db.php');
check((bool)preg_match('/ATTR_EMULATE_PREPARES\s*=>\s*false/', $db),
    'EMULATE_PREPARES is false, so repeated placeholders really are fatal');
check(stripos($db, 'ATTR_EMULATE_PREPARES') !== false,
    'the attribute is set explicitly rather than left to the driver default');

echo "\n" . str_repeat('=', 60) . "\n";
printf("%s - %d assertions\n", $failed === 0 ? 'ALL GREEN' : "{$failed} FAILED", $passed + $failed);
exit($failed === 0 ? 0 : 1);
