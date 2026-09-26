<?php
declare(strict_types=1);

/**
 * PHP TEST RUNNER — 40 lines instead of a PHPUnit dependency.
 *
 *   php tests/php/run.php            # everything
 *   php tests/php/run.php --quick    # skip the slow perft depths
 *
 * @author DALI951
 */

final class T
{
    public static int $pass = 0;
    public static int $fail = 0;
    /** @var array<int,string> */
    public static array $failures = [];
    public static string $group = '';

    public static function group(string $name): void
    {
        self::$group = $name;
    }

    public static function ok(bool $cond, string $what, string $detail = ''): bool
    {
        if ($cond) {
            self::$pass++;
            return true;
        }
        self::$fail++;
        self::$failures[] = self::$group . ' :: ' . $what . ($detail !== '' ? "\n      {$detail}" : '');
        return false;
    }

    public static function same($expected, $actual, string $what): bool
    {
        return self::ok(
            $expected === $actual,
            $what,
            $expected === $actual ? '' : 'expected: ' . self::show($expected) . "\n      actual:   " . self::show($actual)
        );
    }

    public static function show($v): string
    {
        if (is_string($v)) return "'" . (strlen($v) > 200 ? substr($v, 0, 200) . '...' : $v) . "'";
        if (is_array($v)) return 'array(' . count($v) . ') ' . json_encode(array_slice($v, 0, 12));
        return var_export($v, true);
    }

    public static function summary(): int
    {
        $total = self::$pass + self::$fail;
        echo "\n";
        if (self::$fail === 0) {
            echo "ALL GREEN - {$total} assertions\n";
            return 0;
        }
        echo self::$fail . " FAILED of {$total} assertions:\n";
        foreach (self::$failures as $f) {
            echo "  x {$f}\n";
        }
        return 1;
    }
}
