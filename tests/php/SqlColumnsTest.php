<?php
declare(strict_types=1);

/**
 * Every column every query asks for, checked against the DDL. No database.
 *
 * This file exists because of a specific, real bug: the leaderboard ordered by
 * `wins_ms`, a column that has never existed. It is a 500 on the most-visited
 * page of the site, and nothing caught it - not the 71 passing assertions, not
 * the PHP lint, not the browser tests, which fake the server and so never touch
 * the SQL at all.
 *
 * So the check is deliberately blunt: parse the CREATE TABLE statements for
 * their column names, scrape the SQL strings out of the PHP, and require every
 * name that appears in a SELECT list, an UPDATE SET list or an INSERT column list
 * to exist in the table it is being read from. It cannot execute anything and
 * does not pretend to understand SQL. It only knows that `wins_ms` is not a
 * column of `users`, which is the entire class of mistake worth automating here.
 *
 * What it deliberately does NOT check: types, indexes, foreign keys, NULL
 * behaviour, or whether a query returns the right rows. Those need a real MySQL,
 * and pretending otherwise is how a test suite starts lying.
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

/**
 * Column names per table, straight out of the DDL.
 *
 * @return array<string,array<string,true>>
 */
function columnsFromDdl(): array
{
    $out = [];
    foreach (Schema::tables() as $table => $sql) {
        // The column list is the parenthesised group after the table name, and it
        // cannot be found with a regex like /\(([^)]*)\)/: a PRIMARY KEY (id) or a
        // UNIQUE KEY uq_x (a, b) closes a paren long before the real end, so the
        // naive match stops inside the key definitions and reports no columns at
        // all. So: find the opening paren, then walk to its match by depth.
        $open = strpos($sql, '(', (int)strpos($sql, $table));
        if ($open === false) continue;
        $depth = 0;
        $end   = null;
        for ($i = $open, $n = strlen($sql); $i < $n; $i++) {
            if ($sql[$i] === '(') $depth++;
            elseif ($sql[$i] === ')') {
                $depth--;
                if ($depth === 0) { $end = $i; break; }
            }
        }
        if ($end === null) continue;

        // Strip -- and /* */ comments before splitting on commas. A comment in
        // the middle of a column list is normal - there is one in games, right
        // above the BIGINT stamp - and it contains a comma ("gone in 2038, and
        // ..."), so splitting first invents columns called "not" and "and" and
        // loses the real column that follows the comment. A checker that is
        // wrong in a way that produces failures gets ignored; this one has to be
        // right about the DDL before it is allowed to judge the SQL.
        $body = substr($sql, $open + 1, $end - $open - 1);
        $body = preg_replace('/--[^\n]*/', '', $body) ?? $body;
        $body = preg_replace('#/\*.*?\*/#s', '', $body) ?? $body;

        $cols = [];
        foreach (explode(',', $body) as $part) {
            $part = trim($part);
            if ($part === '') continue;
            $first = preg_split('/\s+/', $part)[0];
            $first = trim($first, '`');
            // CONSTRAINT / PRIMARY / UNIQUE / KEY / INDEX / FOREIGN / CHECK are
            // not columns, and treating them as columns is how a checker like this
            // ends up passing a table it never actually read
            if (preg_match('/^(CONSTRAINT|PRIMARY|UNIQUE|KEY|INDEX|FOREIGN|CHECK)$/i', $first)) continue;
            $cols[strtolower($first)] = true;
        }
        $out[$table] = $cols;
    }
    return $out;
}

$columns = columnsFromDdl();

group('the DDL has columns to check');
foreach ($columns as $table => $cols) {
    check(count($cols) > 0, "{$table} parses into a column list", (string)count($cols));
}

// -- collect the SQL out of the PHP ------------------------------------------
$apiDir  = dirname(__DIR__, 2) . '/api';
$phpFiles = [];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($apiDir, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    if ($f->isFile() && $f->getExtension() === 'php') $phpFiles[] = $f->getPathname();
}
sort($phpFiles);

/** Every single-quoted or double-quoted PHP string that looks like SQL. */
/**
 * Every quoted PHP string that looks like SQL.
 *
 * The obvious way to do this is one big regex over the whole file looking for
 * SQL inside quotes, and that is exactly what was here first. It hit PCRE's
 * backtrack limit on GameRepo.php - the largest file, with the most concatenated
 * SQL - and preg_match_all returned FALSE, which an `if (preg_match_all(...))`
 * treats as "no matches". So the file with the MOST queries was the one file
 * quietly skipped, and the suite reported green the whole time.
 *
 * Two changes, both about not lying:
 *   - pull the quoted strings out with a linear pattern (no backtracking), then
 *     decide which ones are SQL. A regex that cannot fail halfway cannot fail
 *     silently halfway.
 *   - glued literals first, so 'SELECT ' . self::COLUMNS . ' FROM games' is read
 *     as one statement. Concatenated SQL is how this codebase writes its longer
 *     queries, and not joining it up would skip precisely the statements worth
 *     checking.
 *
 * @return array<int,string>
 */
function sqlStrings(string $source): array
{
    // ' . ' -> nothing, so a concatenated statement reads as one string
    $glued = preg_replace("/'\\s*\\.\\s*'/", '', $source) ?? $source;

    $out = [];
    $count = preg_match_all('/\'(?:\\\\.|[^\'\\\\])*\'|"(?:\\\\.|[^"\\\\])*"/s', $glued, $m);
    if ($count === false) {
        echo "  FAIL the string scanner itself failed: " . preg_last_error_msg() . "\n";
        $GLOBALS['failed']++;
        return [];
    }
    foreach ($m[0] as $literal) {
        $body = substr($literal, 1, -1);
        if (preg_match('/\b(?:SELECT|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/i', $body)) {
            $out[] = $body;
        }
    }
    return $out;
}

group('every column a query names exists in that table');

$problems = [];
$checked  = 0;
$perFile  = [];

/**
 * Every table a statement mentions, with a single SELECT/UPDATE against it.
 *
 * A JOIN names two tables and a column can belong to either of them, so a
 * checker that takes the first FROM and calls it a day reports `rating` as a
 * missing column of `friends` the moment somebody writes a join - which is how a
 * checker like this gets switched off instead of fixed.
 *
 * @param array<string,array<string,true>> $columns
 * @return array{0:array<string,true>,1:array<int,string>} the union of known columns, and the tables
 */
function tablesIn(string $sql, array $columns): array
{
    $names = [];
    if (preg_match_all('/\b(?:FROM|JOIN|INTO|UPDATE)\s+`?(\w+)`?/i', $sql, $m)) {
        foreach ($m[1] as $t) $names[strtolower($t)] = true;
    }
    $known = [];
    $used  = [];
    foreach (array_keys($names) as $t) {
        if (isset($columns[$t])) { $known += $columns[$t]; $used[] = $t; }
    }
    return [$known, $used];
}

/** Is this identifier a column of any table this statement touches? */
function hasColumn(array $known, array $columns, array $used, string $name): bool
{
    if (isset($known[strtolower($name)])) return true;
    return false;
}

foreach ($phpFiles as $file) {
    $rel  = str_replace('\\', '/', substr($file, strlen(dirname($apiDir, 1)) + 1));
    $src  = (string)file_get_contents($file);

    foreach (sqlStrings($src) as $sql) {
        $sql = preg_replace('/\s+/', ' ', $sql);
        $perFile[$rel] = ($perFile[$rel] ?? 0) + 1;
        if (str_contains($rel, 'GameRepo')) { echo "DEBUG GameRepo strings: " . count(sqlStrings($src)) . " src bytes=" . strlen($src) . "
"; }
        [$known, $used] = tablesIn($sql, $columns);
        if ($known === []) continue;            // nothing of ours in this string

        // -- SELECT <list> FROM ... ----------------------------------------
        if (preg_match('/\bSELECT\s+(.+?)\s+FROM\s+/is', $sql, $m)) {
            $list = $m[1];
            foreach (explode(',', $list) as $item) {
                $item = trim($item);
                if ($item === '' || str_contains($item, '*')) continue;
                if (str_contains($item, '(')) continue;  // COUNT(*), SUM(..)
                // "u.username AS x" / "t.id AS token_id" / "id" / "id AS y"
                $bare = trim(preg_replace('/\s+AS\s+.*$/i', '', $item));
                $bare = trim($bare, '`');
                if ($bare === '' || !preg_match('/^[a-z_][a-z0-9_]*$/i', $bare)) continue;
                $checked++;
                if (!hasColumn($known, $columns, $used, $bare)) {
                    $problems[] = "{$rel}: SELECT {$bare} - not a column of " . implode('/', $used);
                }
            }
        }

        // -- UPDATE <table> SET a =, b = ----------------------------------
        if (preg_match('/\bUPDATE\s+`?(\w+)`?\s+SET\s+(.+?)(?:\s+WHERE|$)/is', $sql, $m)) {
            foreach (explode(',', $m[2]) as $item) {
                if (!preg_match('/^\s*`?([a-z_][a-z0-9_]*)`?\s*=/i', $item, $c)) continue;
                $checked++;
                if (!hasColumn($known, $columns, $used, $c[1])) {
                    $problems[] = "{$rel}: UPDATE {$m[1]} SET {$c[1]} - not a column of " . implode('/', $used);
                }
            }
        }

        // -- INSERT INTO <table> (a, b, c) --------------------------------
        if (preg_match('/\bINSERT\s+INTO\s+`?(\w+)`?\s*\(([^)]*)\)/is', $sql, $m)) {
            foreach (explode(',', $m[2]) as $item) {
                $col = trim(trim($item), '`');
                if ($col === '' || !preg_match('/^[a-z_][a-z0-9_]*$/i', $col)) continue;
                $checked++;
                if (!hasColumn($known, $columns, $used, $col)) {
                    $problems[] = "{$rel}: INSERT INTO {$m[1]} ({$col}) - not a column of " . implode('/', $used);
                }
            }
        }

        // -- ORDER BY / GROUP BY / HAVING -----------------------------------
        // This is where wins_ms lived. A column that only appears in a sort is
        // still a column: MySQL rejects it exactly as hard, with the same
        // message, and the query is still the most-visited page on the site.
        if (preg_match('/\b(?:ORDER\s+BY|GROUP\s+BY|HAVING)\s+(.+?)(?:\s+LIMIT|$)/is', $sql, $m)) {
            foreach (explode(',', $m[1]) as $item) {
                $bare = trim(preg_replace('/\s+(?:ASC|DESC)$/i', '', trim($item)));
                $bare = trim((string)preg_replace('/^[\w]+\./', '', $bare));   // drop u. / t. qualifiers
                $bare = trim($bare, '`');
                if ($bare === '' || !preg_match('/^[a-z_][a-z0-9_]*$/i', $bare)) continue;
                $checked++;
                if (!hasColumn($known, $columns, $used, $bare)) {
                    $problems[] = "{$rel}: ORDER BY {$bare} - not a column of " . implode('/', $used);
                }
            }
        }
    }
}

echo "  ..   {$checked} column references checked\n";
check($checked > 40, 'the scraper actually found columns to check', (string)$checked);
foreach ($problems as $p) {
    check(false, $p);
}
if ($problems === []) {
    check(true, 'no query names a column the DDL does not have');
}

// The coverage line matters as much as the result. A checker that silently reads
// half the queries is worse than none, because it reports green.
echo "  --   SQL strings seen per file: ";
ksort($perFile);
$parts = [];
foreach ($perFile as $f => $n) $parts[] = basename($f) . "={$n}";
echo implode(' ', $parts) . "\n";
check(count($perFile) >= 6, 'the scraper read most of the API, not a corner of it',
    implode(' ', $parts));

echo "\n" . str_repeat('=', 60) . "\n";
printf("%s - %d assertions\n", $failed === 0 ? 'ALL GREEN' : "{$failed} FAILED", $passed + $failed);
exit($failed === 0 ? 0 : 1);
