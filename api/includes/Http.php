<?php
declare(strict_types=1);

/**
 * The HTTP edge: one way to read a request, one way to answer it, and a rate
 * limiter that works with nothing but MySQL because that is all the server has.
 *
 * Every endpoint is a JSON POST, even the ones that read. That is a deliberate
 * choice: POST is not cached, it is not prefetched, and it cannot be triggered
 * by a link, which matters when the links contain room codes. The cost is that
 * bookmarks do not work, and the benefit is that nothing here can be a drive-by.
 *
 * @author DALI951
 */
final class Http
{
    /** @var array<string,mixed>|null */
    private static ?array $body = null;

    public static function boot(): void
    {
        self::cors();
        self::securityHeaders();
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
            self::fail('use_post', 'This endpoint only speaks POST.', 405);
        }
    }

    private static function cors(): void
    {
        $origin = (string)Config::get('site.origin', '');
        $allow  = $origin !== '' ? $origin : '*';
        header('Access-Control-Allow-Origin: ' . ($origin !== '' ? $origin : $allow));
        header('Vary: Origin');
        header('Access-Control-Allow-Credentials: true');
        header('Access-Control-Allow-Headers: Content-Type, X-Setup-Token');
        header('Access-Control-Allow-Methods: POST, OPTIONS');
        header('Access-Control-Max-Age: 86400');
    }

    private static function securityHeaders(): void
    {
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header('Referrer-Policy: same-origin');
        header('Cache-Control: no-store, no-cache, must-revalidate, private');
        header('Content-Type: application/json; charset=utf-8');
    }

    /**
     * The request body, as an array.
     *
     * A malformed body is a client bug, not a server crash, so it comes back as
     * a normal {ok:false} rather than an uncaught exception.
     *
     * @return array<string,mixed>
     */
    public static function body(): array
    {
        if (self::$body !== null) return self::$body;
        $raw = file_get_contents('php://input');
        if ($raw === false || trim($raw) === '') return self::$body = [];
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            self::fail('bad_json', 'The request body was not a JSON object.', 400);
        }
        return self::$body = $decoded;
    }

    public static function str(string $key, int $max = 200, int $min = 0): string
    {
        $v = self::body()[$key] ?? '';
        if (!is_scalar($v)) return '';
        $v = trim((string)$v);
        if (mb_strlen($v) > $max) $v = mb_substr($v, 0, $max);
        return mb_strlen($v) < $min ? '' : $v;
    }

    public static function int(string $key, int $default = 0): int
    {
        $v = self::body()[$key] ?? $default;
        return is_numeric($v) ? (int)$v : $default;
    }

    public static function bool(string $key): bool
    {
        $v = self::body()[$key] ?? false;
        return is_bool($v) ? $v : (bool)$v;
    }

    public static function has(string $key): bool
    {
        return array_key_exists($key, self::body());
    }

    /**
     * Per-user rate limiting, counted in MySQL.
     *
     * The naive version of this - a table row per request - would be the
     * largest table in the database and would need a cron to clean it. Instead
     * each key gets ONE row that is overwritten, so the table stays the size of
     * the number of users, and the cleanup is a DELETE of anything old enough to
     * be irrelevant.
     *
     * @return array{ok:bool,retry_after:int}
     */
    public static function limit(string $action, int $perMinute, int $burst = 0): array
    {
        $who  = (string)($_SESSION['uid'] ?? 'ip:' . self::ip());
        $key  = $action . ':' . $who;
        $now  = Db::nowMs();
        $cut  = $now - 60_000;
        $ceiling = $perMinute + $burst;

        return Db::tx(static function () use ($key, $now, $cut, $ceiling): array {
            // Every placeholder is named separately, even where the value is the
            // same, because these are NATIVE prepared statements
            // (EMULATE_PREPARES => false in Db) and MySQL refuses to bind one
            // named parameter twice in a single statement. With :now and :cut
            // each written twice this threw SQLSTATE[HY093] "Invalid parameter
            // number" - which is a 500 on every single rate-limited action:
            // register, login, create, move, chat, leaderboard, all of it.
            Db::run(
                'INSERT INTO rate_limits (k, hits, window_start_ms, updated_ms)
                      VALUES (:k, 1, :now, :now2)
                 ON DUPLICATE KEY UPDATE
                    hits = IF(updated_ms < :cut, 1, hits + 1),
                    window_start_ms = IF(updated_ms < :cut2, VALUES(window_start_ms), window_start_ms),
                    updated_ms = VALUES(updated_ms)',
                ['k' => $key, 'now' => $now, 'now2' => $now, 'cut' => $cut, 'cut2' => $cut]
            );
            $row = Db::one('SELECT hits, updated_ms FROM rate_limits WHERE k = :k', ['k' => $key]);
            $hits = (int)($row['hits'] ?? 1);
            if ($hits > $ceiling) {
                return ['ok' => false, 'retry_after' => max(1, (int)ceil(((int)$row['updated_ms'] + 60_000 - $now) / 1000))];
            }
            // one cheap sweep; a row nobody has touched in five minutes is
            // indistinguishable from a row nobody has
            Db::run('DELETE FROM rate_limits WHERE updated_ms < :old', ['old' => $now - 300_000]);
            return ['ok' => true, 'retry_after' => 0];
        });
    }

    public static function throttle(string $action, int $perMinute, int $burst = 0): void
    {
        $r = self::limit($action, $perMinute, $burst);
        if (!$r['ok']) {
            header('Retry-After: ' . $r['retry_after']);
            self::fail('rate_limited', 'Slow down a moment.', 429);
        }
    }

    public static function ip(): string
    {
        // Behind a proxy the leftmost entry is a lie unless the host is trusted
        // to set it, so this is only used for rate limiting and never for auth.
        $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
        return $ip === '' ? '0.0.0.0' : $ip;
    }

    public static function fail(string $code, string $message, int $status = 400): never
    {
        http_response_code($status);
        echo json_encode(['ok' => false, 'error' => $code, 'message' => $message], JSON_UNESCAPED_UNICODE);
        exit;
    }

    public static function done(array $payload = []): never
    {
        echo json_encode(['ok' => true] + $payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        exit;
    }

    /** Run a whole endpoint with the boring failure handling wrapped around it. */
    public static function endpoint(callable $fn): never
    {
        self::boot();
        try {
            self::sessionStart();
            $fn();
            self::done();
        } catch (HttpError $e) {
            self::fail($e->errorCode, $e->getMessage(), $e->status);
        } catch (Throwable $e) {
            error_log('chess endpoint error: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            self::fail('server_error', 'Something went wrong on our side.', 500);
        }
    }

    public static function sessionStart(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) return;
        $secure = Config::boolish(Config::get('session.secure', false));
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => '/',
            'httponly' => true,          // no JavaScript may read the session
            'secure'   => $secure,       // https only in production
            'samesite' => 'Lax',         // survives a normal link, blocks cross-site POST
        ]);
        session_name('shatrangi');
        @session_start();
    }
}

/**
 * A failure an endpoint is allowed to show the client.
 *
 * The property is errorCode and not code because Exception already has a $code,
 * and redeclaring it as readonly is a fatal error rather than a warning. Which is
 * a reminder that "it is just a name" is how a fatal error happens.
 */
final class HttpError extends RuntimeException
{
    public function __construct(public readonly string $errorCode, string $message, public readonly int $status = 400)
    {
        parent::__construct($message);
    }
}
