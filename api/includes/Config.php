<?php
declare(strict_types=1);

/**
 * Config loading.
 *
 * The real file is config.local.php and it NEVER lives in the repository. It is
 * looked for in two places: inside the project (handy locally) and one level up
 * (the server keeps it outside the web root, which is the whole point of putting
 * a password in a file in the first place).
 *
 * Environment variables win over the file. On a host where you cannot write a
 * file with a password in it but you can set one variable, that is what the
 * variable is for.
 *
 * @author DALI951
 */
final class Config
{
    private static ?array $data = null;

    /** @var array<string,string> dot key => env var */
    private const ENV = [
        'db.host'     => 'CHESS_DB_HOST',
        'db.port'     => 'CHESS_DB_PORT',
        'db.name'     => 'CHESS_DB_NAME',
        'db.user'     => 'CHESS_DB_USER',
        'db.pass'     => 'CHESS_DB_PASS',
        'site.origin' => 'CHESS_SITE_ORIGIN',
        'session.secure' => 'CHESS_COOKIE_SECURE',
    ];

    public static function load(): array
    {
        if (self::$data !== null) return self::$data;

        $candidates = [
            dirname(__DIR__, 2) . '/config.local.php',   // project root
            dirname(__DIR__, 3) . '/config.local.php',   // one above the web root
        ];
        $file = null;
        foreach ($candidates as $c) {
            if (is_file($c)) { $file = $c; break; }
        }
        if ($file === null) {
            throw new RuntimeException(
                "config.local.php not found. Looked in:\n  " . implode("\n  ", $candidates)
                . "\nCopy config.example.php to config.local.php and fill in the values. "
                . 'On the server it should sit OUTSIDE the web root.'
            );
        }
        $data = require $file;
        if (!is_array($data)) {
            throw new RuntimeException('config.local.php must return an array');
        }

        foreach (self::ENV as $key => $env) {
            $v = getenv($env);
            if ($v === false || $v === '') continue;
            $data = self::setPath($data, $key, $v);
        }
        // "true"/"1"/"yes" from the environment, not the string "false" being truthy
        if (isset($data['session']['secure'])) {
            $data['session']['secure'] = self::boolish($data['session']['secure']);
        }
        self::$data = $data;
        return $data;
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
