<?php
declare(strict_types=1);

/**
 * The .env parser, tested against the exact shape of the real password.
 *
 * Every rule here exists because of a way this went wrong, and the one that
 * matters most is the first: the production database password ends in "!#", so
 * a parser that treats everything after a # as a comment hands MySQL a
 * truncated password and answers "Access denied for user 'modali'" for a
 * password that looks completely correct in the file. That is a miserable thing
 * to debug, because the file and the database disagree and neither of them is
 * obviously lying.
 *
 * The value below is a STAND-IN with the same awkward shape, not the real
 * password - a test fixture is a committed file, and the whole point of the
 * rules above is that secrets do not end up in committed files.
 *
 * @author DALI951
 */

require_once dirname(__DIR__, 2) . '/api/includes/Config.php';

$passed = 0;
$failed = 0;
function check(bool $ok, string $what, string $extra = ''): void
{
    global $passed, $failed;
    if ($ok) { $passed++; echo "  ok   {$what}\n"; }
    else { $failed++; echo "  FAIL {$what}" . ($extra !== '' ? "  -> {$extra}" : '') . "\n"; }
}

/** @param array<string,string> $expect */
function envCase(string $name, string $text, array $expect): void
{
    $got = Config::parseDotEnv($text);
    foreach ($expect as $k => $want) {
        $have = $got[$k] ?? null;
        check($have === $want, "{$name} [{$k}]", "got " . var_export($have, true) . ', want ' . var_export($want, true));
    }
}

// A stand-in with the same shape: random passwords very often end in punctuation
// like #, and that is the case the parser rules exist for. NOT the real value.
$REAL = 'Pa55word!#';

echo "\n-- a # in a value is not a comment " . str_repeat('-', 33) . "\n";
envCase('quoted, the way the real file writes it', "CHESS_DB_PASS=\"{$REAL}\"", ['CHESS_DB_PASS' => $REAL]);
envCase('unquoted still survives', "CHESS_DB_PASS={$REAL}", ['CHESS_DB_PASS' => $REAL]);
envCase('hash glued to text is kept', 'X=abc#def', ['X' => 'abc#def']);
envCase('a comment needs whitespace before the #', 'X=abc # comment', ['X' => 'abc']);

echo "\n-- quotes " . str_repeat('-', 52) . "\n";
envCase('single quotes hold spaces and hashes', "X='a b#c'", ['X' => 'a b#c']);
envCase('escaped double quotes inside', 'X="say \"hi\" # now"', ['X' => 'say "hi" # now']);
envCase('an unterminated quote is taken literally', 'X="oops', ['X' => '"oops']);
envCase('the other quote char inside doubles', 'X="it\'s # fine"', ['X' => "it's # fine"]);

echo "\n-- lines that are not settings " . str_repeat('-', 36) . "\n";
envCase('blank and comment lines are skipped', "\n\n# a comment\nA=1\n\nB=2", ['A' => '1', 'B' => '2']);
envCase('a line with no = is skipped, not guessed', "garbage\nA=2", ['A' => '2']);
envCase('empty value is allowed', 'X=', ['X' => '']);
envCase('whitespace around the = is trimmed', '  X  =  val  ', ['X' => 'val']);
envCase('a key that is not an identifier is skipped', 'not a key=1', []);
envCase('a value may contain =', 'X=a=b=c', ['X' => 'a=b=c']);
envCase('CRLF line endings work', "A=1\r\nB=2\r\n", ['A' => '1', 'B' => '2']);

echo "\n-- a whole realistic .env " . str_repeat('-', 38) . "\n";
$env = <<<ENV
# SHATRANGI production values. Never commit this file.
CHESS_DB_HOST=localhost
CHESS_DB_PORT=3306
CHESS_DB_NAME=modalidb
CHESS_DB_USER=modali
CHESS_DB_PASS="{$REAL}"
CHESS_DB_CHARSET=utf8mb4

# where the site lives, no trailing slash
CHESS_SITE_ORIGIN=https://modali.powerpme.com/chess
CHESS_COOKIE_SECURE=true
CHESS_SETUP_TOKEN=abc123
ENV;
$parsed = Config::parseDotEnv($env);
check(count($parsed) === 9, 'nine settings, none lost to a comment', (string)count($parsed));
check(($parsed['CHESS_DB_PASS'] ?? '') === $REAL, 'the password survived the file');
check(($parsed['CHESS_COOKIE_SECURE'] ?? '') === 'true', 'a boolean stays a readable string here');
check(($parsed['CHESS_SITE_ORIGIN'] ?? '') === 'https://modali.powerpme.com/chess', 'the origin has no trailing slash');

echo "\n" . str_repeat('=', 60) . "\n";
printf("%s - %d assertions\n", $failed === 0 ? 'ALL GREEN' : "{$failed} FAILED", $passed + $failed);
exit($failed === 0 ? 0 : 1);
