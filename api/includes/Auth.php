<?php
declare(strict_types=1);

/**
 * Accounts: passwords in, session cookie out.
 *
 * Passwords use password_hash() with the default algorithm and NOTHING else -
 * no hand-rolled salt, no md5, no "hash then trim to 16 chars because the old
 * site did". The only knob worth touching is the cost, and it is left at the
 * PHP default on purpose: a 16-year-old's 1650 cannot do anything clever about
 * a hash rate, and a rate set to stop an attacker on fast hardware stops nobody
 * on slow hardware.
 *
 * @author DALI951
 */
final class Auth
{
    private const MIN_PASSWORD = 8;
    private const MAX_PASSWORD = 200;   // bcrypt only reads 72 bytes; be honest about it

    /** @return array<string,mixed> the user row */
    public static function register(string $username, string $password, ?string $displayName = null): array
    {
        $username = self::normaliseUsername($username);
        $displayName = self::cleanName($displayName !== null && trim($displayName) !== '' ? $displayName : $username);

        if (!preg_match('/^[a-z0-9_]{3,20}$/', $username)) {
            throw new HttpError('bad_username', 'Username must be 3-20 characters: a-z, 0-9, underscore.', 422);
        }
        self::assertPassword($password);

        // Reject names that are already taken as subdomains or paths later, and
        // anything that could be confused with a system name.
        if (in_array($username, ['api', 'admin', 'assets', 'www', 'shatrangi', 'root', 'null', 'me'], true)) {
            throw new HttpError('bad_username', 'That name is reserved.', 422);
        }

        try {
            $id = Db::tx(static function () use ($username, $displayName, $password) {
                Db::run(
                    'INSERT INTO users (username, display_name, pass_hash, rating, created_ms, last_seen_ms)
                          VALUES (:u, :d, :h, 1500, :now, :now)',
                    ['u' => $username, 'd' => $displayName, 'h' => self::hash($password), 'now' => Db::nowMs()]
                );
                return (int)Db::conn()->lastInsertId();
            });
        } catch (PDOException $e) {
            // 23000 is an integrity constraint. The only one this INSERT can hit
            // is the unique username, so the message can say so honestly instead
            // of a generic "registration failed".
            if ($e->getCode() === '23000') {
                throw new HttpError('username_taken', 'That username is taken.', 409);
            }
            throw $e;
        }
        return self::login($id);
    }

    /** @return array<string,mixed> the user row */
    public static function login(string $username, string $password): array
    {
        $username = mb_strtolower(trim($username));
        $user = Db::one('SELECT * FROM users WHERE username = :u', ['u' => $username]);

        // hash the password even when there is no such user, so a stranger
        // cannot tell "no such account" from "wrong password" by how long the
        // response took
        $hash = (string)($user['pass_hash'] ?? '$2y$10$usesomesillystringforsaltusesomesillystringfors.');
        $ok = password_verify($password, $hash);
        if ($user === null || !$ok) {
            throw new HttpError('bad_login', 'Wrong username or password.', 401);
        }
        return self::establishSession((int)$user['id']);
    }

    /**
     * Log in by token instead of password: the Remember-me checkbox.
     *
     * The token is 32 random bytes, stored HASHED, so that a dump of the table is
     * not a list of working logins. The plain token exists only in the cookie
     * the player already has, and only until they are next seen.
     */
    public static function loginWithToken(string $token): array
    {
        $hash = self::tokenHash($token);
        $row = Db::one(
            'SELECT u.*, t.id AS token_id, t.expires_ms
               FROM remember_tokens t
               JOIN users u ON u.id = t.user_id
              WHERE t.token_hash = :h AND t.expires_ms > :now',
            ['h' => $hash, 'now' => Db::nowMs()]
        );
        if ($row === null) {
            throw new HttpError('bad_token', 'That login has expired.', 401);
        }
        // one use per token: a stolen cookie is only good until the real player
        // next logs in, and this is also the rollover
        Db::run('DELETE FROM remember_tokens WHERE id = :id', ['id' => (int)$row['token_id']]);
        return self::establishSession((int)$row['id']);
    }

    public static function logout(bool $forgetToken = true): void
    {
        if ($forgetToken && isset($_COOKIE['shatrangi_token'])) {
            Db::run('DELETE FROM remember_tokens WHERE token_hash = :h', ['h' => self::tokenHash((string)$_COOKIE['shatrangi_token'])]);
            self::clearTokenCookie();
        }
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires'  => time() - 42000,
                'path'     => $p['path'],
                'domain'   => $p['domain'],
                'secure'   => $p['secure'],
                'httponly' => $p['httponly'],
                'samesite' => $p['samesite'] ?? 'Lax',
            ]);
        }
    }

    /**
     * Who is this request from, if anyone?
     *
     * Returns null rather than throwing, because "not logged in" is a normal
     * answer to "what is the public state of this game" and the endpoints decide
     * for themselves whether that is allowed.
     *
     * @return array<string,mixed>|null
     */
    public static function user(): ?array
    {
        if (isset($_SESSION['uid'])) {
            $row = Db::one('SELECT * FROM users WHERE id = :id', ['id' => (int)$_SESSION['uid']]);
            if ($row !== null) return self::touch($row);
            unset($_SESSION['uid']);   // the account was deleted underneath us
        }
        $token = (string)($_COOKIE['shatrangi_token'] ?? '');
        if ($token !== '' && preg_match('/^[a-f0-9]{64}$/', $token)) {
            try {
                return self::loginWithToken($token);
            } catch (HttpError) {
                self::clearTokenCookie();
            }
        }
        return null;
    }

    /** @return array<string,mixed> */
    public static function requireUser(): array
    {
        $u = self::user();
        if ($u === null) throw new HttpError('not_logged_in', 'Log in first.', 401);
        return $u;
    }

    /**
     * @param  array<string,mixed> $row
     * @return array<string,mixed>
     */
    public static function publicUser(array $row, ?int $nowMs = null): array
    {
        $now = $nowMs ?? Db::nowMs();
        $seen = (int)($row['last_seen_ms'] ?? 0);
        return [
            'id'           => (int)$row['id'],
            'username'     => (string)$row['username'],
            'display_name' => (string)($row['display_name'] ?? $row['username']),
            'rating'       => (int)($row['rating'] ?? 1500),
            'online'       => ($seen > 0 && ($now - $seen) <= 45_000),
            'last_seen_ms' => $seen,
        ];
    }

    // -- internals ------------------------------------------------------------

    /** @return array<string,mixed> */
    private static function establishSession(int $userId): array
    {
        // A new id on every login: this is what stops a session fixed before login
        // from being a session fixed after it.
        session_regenerate_id(true);
        $_SESSION['uid'] = $userId;
        Db::run('UPDATE users SET last_seen_ms = :now WHERE id = :id', ['now' => Db::nowMs(), 'id' => $userId]);
        $row = Db::one('SELECT * FROM users WHERE id = :id', ['id' => $userId]);
        if ($row === null) throw new HttpError('bad_login', 'Account not found.', 401);
        return $row;
    }

    public static function issueRememberToken(int $userId): string
    {
        $token = bin2hex(random_bytes(32));
        $expires = Db::nowMs() + 1000 * 60 * 60 * 24 * 30;   // a month
        Db::run(
            'INSERT INTO remember_tokens (user_id, token_hash, expires_ms, created_ms)
                  VALUES (:u, :h, :e, :now)',
            ['u' => $userId, 'h' => self::tokenHash($token), 'e' => $expires, 'now' => Db::nowMs()]
        );
        setcookie('shatrangi_token', $token, [
            'expires'  => time() + 60 * 60 * 24 * 30,
            'path'     => '/',
            'httponly' => true,
            'secure'   => Config::boolish(Config::get('session.secure', false)),
            'samesite' => 'Lax',
        ]);
        return $token;
    }

    public static function clearTokenCookie(): void
    {
        setcookie('shatrangi_token', '', [
            'expires'  => time() - 42000,
            'path'     => '/',
            'httponly' => true,
            'secure'   => Config::boolish(Config::get('session.secure', false)),
            'samesite' => 'Lax',
        ]);
    }

    public static function hash(string $password): string
    {
        return password_hash($password, PASSWORD_DEFAULT);
    }

    public static function tokenHash(string $token): string
    {
        // hash('sha256', ...) is right here even though plain SHA is wrong for
        // passwords: a remember token is 32 bytes of CSPRNG output, not something
        // a human chose, so there is no dictionary to slow down
        return hash('sha256', $token);
    }

    public static function normaliseUsername(string $u): string
    {
        return mb_strtolower(trim($u));
    }

    private static function cleanName(string $n): string
    {
        // Arabic and Latin both allowed, no control characters, no angle brackets:
        // display names are echoed into the page, and a name is the one field
        // every other player sees
        $n = preg_replace('/[\x00-\x1F\x7F<>]/u', '', trim($n)) ?? '';
        $n = preg_replace('/\s+/u', ' ', $n) ?? $n;
        return mb_substr($n, 0, 32);
    }

    private static function assertPassword(string $p): void
    {
        $len = mb_strlen($p);
        if ($len < self::MIN_PASSWORD) {
            throw new HttpError('weak_password', 'Password must be at least 8 characters.', 422);
        }
        if ($len > self::MAX_PASSWORD) {
            throw new HttpError('long_password', 'That password is too long.', 422);
        }
    }

    /**
     * @param  array<string,mixed> $row
     * @return array<string,mixed>
     */
    private static function touch(array $row): array
    {
        $now = Db::nowMs();
        $last = (int)($row['last_seen_ms'] ?? 0);
        if ($now - $last > 15_000) {
            Db::run('UPDATE users SET last_seen_ms = :now WHERE id = :id', ['now' => $now, 'id' => (int)$row['id']]);
            $row['last_seen_ms'] = $now;
        }
        return $row;
    }
}
