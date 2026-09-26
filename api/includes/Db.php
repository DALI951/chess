<?php
declare(strict_types=1);

/**
 * A very small PDO door.
 *
 * The only thing worth being careful about here is that emulated prepares are
 * OFF. With emulation on, PDO quietly interpolates the value into the SQL string
 * and the prepared statement becomes decoration; every "bound parameter" in the
 * app would still be a real injection point. With it off, a value that is not a
 * bound parameter cannot be a bound parameter at all, and a mistake fails loudly
 * instead of quietly.
 *
 * @author DALI951
 */
final class Db
{
    private static ?PDO $pdo = null;

    public static function conn(): PDO
    {
        if (self::$pdo instanceof PDO) return self::$pdo;

        $host = (string)Config::get('db.host', '127.0.0.1');
        $port = Config::int('db.port', 3306);
        $name = (string)Config::get('db.name', '');
        $user = (string)Config::get('db.user', '');
        $pass = (string)Config::get('db.pass', '');
        $cs   = (string)Config::get('db.charset', 'utf8mb4');

        $dsn = "mysql:host={$host};port={$port};dbname={$name};charset={$cs}";
        try {
            self::$pdo = new PDO($dsn, $user, $pass, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
                PDO::ATTR_STRINGIFY_FETCHES  => false,
            ]);
        } catch (PDOException $e) {
            // The message can carry the DSN, which carries the username. Log it,
            // show the operator something they can act on, and never echo the
            // driver's own text to the browser.
            error_log('chess db connect failed: ' . $e->getMessage());
            throw new RuntimeException('database unavailable', 0, $e);
        }
        return self::$pdo;
    }

    public static function isAvailable(): bool
    {
        try { self::conn(); return true; }
        catch (Throwable) { return false; }
    }

    /** @param array<int|string,mixed> $args */
    public static function run(string $sql, array $args = []): PDOStatement
    {
        $st = self::conn()->prepare($sql);
        $st->execute($args);
        return $st;
    }

    /**
     * @param array<int|string,mixed> $args
     * @return array<string,mixed>|null
     */
    public static function one(string $sql, array $args = []): ?array
    {
        $row = self::run($sql, $args)->fetch();
        return $row === false ? null : $row;
    }

    /** @return array<int,array<string,mixed>> */
    public static function all(string $sql, array $args = []): array
    {
        return self::run($sql, $args)->fetchAll();
    }

    public static function value(string $sql, array $args = []): mixed
    {
        $v = self::run($sql, $args)->fetchColumn();
        return $v === false ? null : $v;
    }

    /**
     * Run $fn inside a transaction, rolling back on any throwable.
     *
     * A game is a set of rows that have to move together: the move, the clock,
     * the status. Half of those landing is a game nobody can finish, so this is
     * not optional politeness.
     */
    public static function tx(callable $fn): mixed
    {
        $pdo = self::conn();
        $own = !$pdo->inTransaction();
        if ($own) $pdo->beginTransaction();
        try {
            $out = $fn($pdo);
            if ($own) $pdo->commit();
            return $out;
        } catch (Throwable $e) {
            if ($own && $pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    public static function nowMs(): int
    {
        return (int)round(microtime(true) * 1000);
    }
}
