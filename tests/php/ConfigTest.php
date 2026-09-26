<?php
declare(strict_types=1);

/**
 * config.example.php must not document settings that do nothing.
 *
 * The old example config advertised site.timezone, session.cookie_name,
 * session.lifetime, session.lifetime's 30-day value, a game.poll_ms the client
 * never asked the server for, a whole rate_limit block, and an admins list with
 * no admin area behind it. Six plausible-looking knobs, all of them fiction.
 *
 * The failure mode is slow and nasty: somebody sets poll_ms to 2000, restarts
 * nothing, sees polling still at 500ms, and concludes the server ignores config
 * or the value is in the wrong place. The dead key is the diagnosis, and it
 * points somewhere useless every time.
 *
 * So: load the example, flatten it to dotted paths, and require that every one
 * of them is a key the code actually reads. The reverse direction is not checked
 * and should not be - a key the code reads but the example omits is fine, the
 * code has a default for it.
 *
 * @author DALI951
 */

$passed = 0;
$failed = 0;
function check(bool $ok, string $what, string $extra = ''): void
{
    global $passed, $failed;
    if ($ok) { $passed++; echo "  ok   {$what}\n"; }
    else { $failed++; echo "  FAIL {$what}" . ($extra !== '' ? "  -> {$extra}" : '') . "\n"; }
}
function group(string $name): void { echo "\n-- {$name} " . str_repeat('-', max(0, 58 - strlen($name))) . "\n"; }

/** @return array<int,string> */
function flatten(array $a, string $prefix = ''): array
{
    $out = [];
    foreach ($a as $k => $v) {
        $key = $prefix === '' ? (string)$k : "{$prefix}.{$k}";
        // array_merge and NOT $out += $nested: both sides are numerically
        // indexed lists, and += keeps only the left operand's integer keys, so
        // the nested keys are dropped without a word. The bug reads as "the
        // example has fewer keys than I thought", which is exactly the kind of
        // quiet wrong answer this file is meant to stop.
        $out = array_merge($out, is_array($v) ? flatten($v, $key) : [$key]);
    }
    return $out;
}

$root  = dirname(__DIR__, 2);
$paths = ['api/includes' => [], 'api' => []];
foreach (array_keys($paths) as $dir) {
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator("{$root}/{$dir}", FilesystemIterator::SKIP_DOTS)) as $f) {
        if ($f->isFile() && $f->getExtension() === 'php') $paths[$dir][] = $f->getPathname();
    }
}
$apiSource = '';
foreach ($paths as $files) foreach ($files as $f) $apiSource .= (string)file_get_contents($f);

group('the example config loads and is an array');
$examplePath = "{$root}/config.example.php";
check(is_file($examplePath), 'config.example.php exists');
$example = require $examplePath;
check(is_array($example), 'it returns an array', gettype($example));

// Keys the code reads. Config::get/int are called as Config::get(...) from
// outside and as self::get(...) inside Config.php, so both spellings count -
// matching only the first one reports setup_token as dead when it is the single
// most important key in the file.
$read = [];
foreach ([
    "/\b(?:Config|self)::(?:get|int)\(\s*'([a-z_.]+)'/i",
    "/'([a-z_.]+)'\s*=>/i",                       // the environment map in Config::load()
] as $pattern) {
    if (preg_match_all($pattern, $apiSource, $m)) $read = array_merge($read, $m[1]);
}
$read = array_flip($read);

group('every documented key is one the code reads');
$keys = flatten($example);
sort($keys);
check(count($keys) > 0, 'the example has keys to check', (string)count($keys));
$dead = [];
foreach ($keys as $k) {
    if (!isset($read[$k])) $dead[] = $k;
}
foreach ($dead as $k) check(false, "{$k} is documented", 'no code reads this key');
if ($dead === []) check(true, 'no documented key is fictional');

group('the keys that must be there');
foreach (['db.host', 'db.name', 'db.user', 'db.pass', 'db.port', 'db.charset', 'site.origin', 'site.name', 'session.secure', 'setup_token'] as $k) {
    check(in_array($k, $keys, true), "{$k} is documented");
}

echo "\n" . str_repeat('=', 60) . "\n";
printf("%s - %d assertions\n", $failed === 0 ? 'ALL GREEN' : "{$failed} FAILED", $passed + $failed);
exit($failed === 0 ? 0 : 1);
