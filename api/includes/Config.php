<?php
declare(strict_types=1);

/**
 * Config loading.
 *
 * The real values live in a .env file, which NEVER lives in the repository:
 *
 *     CHESS_DB_HOST=localhost
 *     CHESS_DB_NAME=modalidb
 *     CHESS_DB_USER=modali
 *     CHESS_DB_PASS="Pa55word!#"
 *
 * Quote any value that contains a space, a #, or a quote. See parseDotEnv().
 *
 * .env is looked for in two places: inside the project (handy locally) and in
 * the account home (outside the web root on a host that does not chroot SFTP).
 * On THIS host the SFTP account is chrooted to public_html, so there is nowhere
 * above the app to write, which means it has to sit in the app directory - and
 * that is still safe, because the .htaccess next to it denies the filename, so
 * the answer is 403 whether or not the file exists.
 *
 * Three sources, lowest priority last: .env, then config.local.php (the older
 * PHP-array format, still supported so an existing deployment keeps booting),
 * then real environment variables, which always win. On a host where you cannot
 * write a file with a password in it but you can set one variable, that is what
 * the variable is for.
 *
 * @author DALI951
 */
final class Config
{
    private static ?array $data = null;

    /**
     * .env key => dotted config key.
     *
     * @var array<string,string>
     */
    private const DOTENV = [
        'CHESS_DB_HOST'       => 'db.host',
        'CHESS_DB_PORT'       => 'db.port',
        'CHESS_DB_NAME'       => 'db.name',
        'CHESS_DB_USER'       => 'db.user',
        'CHESS_DB_PASS'       => 'db.pass',
        'CHESS_DB_CHARSET'    => 'db.charset',
        'CHESS_SITE_NAME'     => 'site.name',
        'CHESS_SITE_ORIGIN'   => 'site.origin',
        'CHESS_COOKIE_SECURE' => 'session.secure',
        'CHESS_SETUP_TOKEN'   => 'setup_token',
    ];

    /** Defaults, so a missing key is never an undefined index further down. */
    private const DEFAULTS = [
        'db' => [
            'host'    => 'localhost',
            'port'    => 3306,
            'name'    => '',
            'user'    => '',
            'pass'    => '',
            'charset' => 'utf8mb4',
        ],
        'site' => [
            'name'   => 'SHATRANGI',
            'origin' => '',
        ],
        'session' => [
            'secure' => false,
        ],
    ];

    public static function load(): array
    {
        if (self::$data !== null) return self::$data;

        $data = self::DEFAULTS;
        $found = [];

        // 1. .env, in either of the two places it might live.
        foreach (self::candidatePaths('.env') as $path) {
            if (!is_file($path)) continue;
            $text = @file_get_contents($path);
            if ($text === false) continue;
            foreach (self::parseDotEnv($text) as $k => $v) {
                if (isset(self::DOTENV[$k])) {
                    $data = self::setPath($data, self::DOTENV[$k], $v);
                }
            }
            $found[] = $path;
            break;
        }

        // 2. the older PHP-array config, so a deployment that only has this one
        //    keeps booting. Anything it defines that .env did not wins over the
        //    defaults, and .env above wins over this.
        foreach (self::candidatePaths('config.local.php') as $path) {
            if (!is_file($path)) continue;
            $legacy = require $path;
            if (!is_array($legacy)) {
                throw new RuntimeException('config.local.php must return an array');
            }
            $data = self::mergeDeep($data, $legacy);
            $found[] = $path;
            break;
        }

        // 3. real environment variables, which beat both files.
        foreach (self::DOTENV as $env => $key) {
            $v = getenv($env);
            if ($v === false || $v === '') continue;
            $data = self::setPath($data, $key, $v);
        }

        if (isset($data['db']['port'])) {
            $data['db']['port'] = is_numeric($data['db']['port']) ? (int)$data['db']['port'] : 3306;
        }
        // "true"/"1"/"yes" from .env, not the string "false" being truthy
        if (isset($data['session']['secure'])) {
            $data['session']['secure'] = self::boolish($data['session']['secure']);
        }

        if ($data['db']['name'] === '' || $data['db']['user'] === '') {
            throw new RuntimeException(
                "No database configured. " . ($found === [] ? 'Neither .env nor config.local.php was found. Looked in:'
                    : 'Found ' . implode(', ', $found) . ' but it is missing the database name or user.') . "\n"
                . "Copy .env.example to .env and fill in the values."
            );
        }

        self::$data = $data;
        return $data;
    }

    /**
     * Parse a .env file.
     *
     * Public and static so the rules below can be tested directly, because every
     * one of them exists because of a way this was wrong:
     *
     *  - # does NOT start a comment mid-value. The real database password ends
     *    in "!#", and a parser that treats everything after a # as a comment
     *    hands the database everything up to the # and reports Access denied
     *    for a password that looks perfectly correct in the file. Inline
     *    comments therefore require whitespace before the #, and only outside
     *    quotes.
     *  - Quoted values are taken whole, so a value may contain spaces, # and
     *    the other quote character.
     *  - An UNTERMINATED quote falls back to the unquoted reading rather than
     *    silently eating the rest of the file.
     *  - Blank lines and #-comment lines are skipped. A line with no = is
     *    skipped rather than guessed at.
     *
     * @return array<string,string>
     */
    public static function parseDotEnv(string $text): array
    {
        $out = [];
        foreach (preg_split('/\R/', $text) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') continue;
            $eq = strpos($line, '=');
            if ($eq === false) continue;
            $k = trim(substr($line, 0, $eq));
            if ($k === '' || !preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $k)) continue;
            $v = trim(substr($line, $eq + 1));

            $q = $v !== '' ? $v[0] : '';
            if ($q === '"' || $q === "'") {
                $end = strrpos($v, $q);
                if ($end !== false && $end > 0) {
                    $inner = substr($v, 1, $end - 1);
                    if ($q === '"') {
                        $inner = strtr($inner, [
                            '\\n' => "\n", '\\r' => "\r", '\\t' => "\t",
                            '\\"' => '"',  '\\\\' => '\\',
                        ]);
                    }
                    $out[$k] = $inner;
                    continue;
                }
                // unterminated quote: fall through and take it literally
            }
            // an inline comment needs whitespace in front of the #, so that a
            // password ending in "!#" survives intact
            if (preg_match('/\s+#/', $v, $m, PREG_OFFSET_CAPTURE)) {
                $v = rtrim(substr($v, 0, $m[0][1]));
            }
            $out[$k] = $v;
        }
        return $out;
    }

    /**
     * The two places a secret file might live, most specific first.
     *
     * @return array<int,string>
     */
    private static function candidatePaths(string $filename): array
    {
        return [
            // The project root, i.e. /public_html/chess. On this host it is the
            // ONLY reachable spot, because the SFTP account is chrooted to
            // public_html. Safe anyway: the .htaccess beside it denies the name.
            dirname(__DIR__, 2) . '/' . $filename,

            // The account home, which on a host that does not chroot SFTP is
            // genuinely outside the document root:
            //   /var/www/modali/public_html/chess/api/includes
            //   4 up -> /var/www/modali          <- not served by Apache
            //
            // 3 up is /public_html, and public_html IS the web root, so a config
            // file written there answered https://modali.powerpme.com/<file>.
            dirname(__DIR__, 4) . '/' . $filename,
        ];
    }

    /** @param array<string,mixed> $base @param array<string,mixed> $over */
    private static function mergeDeep(array $base, array $over): array
    {
        foreach ($over as $k => $v) {
            if (is_array($v) && isset($base[$k]) && is_array($base[$k])) {
                $base[$k] = self::mergeDeep($base[$k], $v);
            } else {
                $base[$k] = $v;
            }
        }
        return $base;
    }


    public static function get(string $key, mixed $default = null): mixed
    {
        $node = self::load();
        foreach (explode('.', $key) as $part) {
            if (!is_array($node) || !array_key_exists($part, $node)) return $default;
            $node = $node[$part];
        }
        return $node;
    }

    public static function int(string $key, int $default = 0): int
    {
        $v = self::get($key, $default);
        return is_numeric($v) ? (int)$v : $default;
    }

    public static function boolish(mixed $v): bool
    {
        if (is_bool($v)) return $v;
        return in_array(strtolower((string)$v), ['1', 'true', 'yes', 'on'], true);
    }

    /**
     * The setup token, from the config file or the environment.
     *
     * Returns null when neither is set, and callers MUST refuse in that case.
     * There is deliberately no default and no fallback: an installer that runs
     * when nobody chose a token is an installer anybody can run.
     */
    public static function setupToken(): ?string
    {
        $t = self::get('setup_token');
        if (is_string($t) && $t !== '' && !str_contains($t, 'CHANGE_ME')) return $t;
        $env = getenv('CHESS_SETUP_TOKEN');
        if (is_string($env) && $env !== '') return $env;
        return null;
    }

    private static function setPath(array $data, string $key, mixed $value): array
    {
        $parts = explode('.', $key);
        $node = &$data;
        foreach ($parts as $i => $part) {
            if ($i === count($parts) - 1) { $node[$part] = $value; break; }
            if (!isset($node[$part]) || !is_array($node[$part])) $node[$part] = [];
            $node = &$node[$part];
        }
        return $data;
    }
}
