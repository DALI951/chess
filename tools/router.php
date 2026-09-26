<?php
/**
 * Router for PHP's built-in server, used by tools/serve.mjs.
 *
 * It exists for exactly one reason: the built-in server has no idea what a .wasm
 * file is, so Stockfish's WebAssembly binary arrives as
 * application/octet-stream and WebAssembly.instantiateStreaming refuses it with
 * a MIME type error. The deployed host gets the same fix from .htaccess
 * (AddType application/wasm .wasm); this is the local half of that pair.
 *
 * Everything else is handed straight back to the server by returning false, so
 * the SPA, api/*.php and the PHP router in index.php behave exactly as before.
 *
 * @author DALI951
 */
declare(strict_types=1);

$path = parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
if (substr($path, -5) !== '.wasm') {
    return false;   // not ours: let the built-in server handle it
}

$root = realpath(__DIR__ . DIRECTORY_SEPARATOR . '..');
$file = realpath($root . DIRECTORY_SEPARATOR . ltrim($path, '/'));
if ($root === false || $file === false || !is_file($file) || strpos($file, $root) !== 0) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo "not found\n";
    return true;
}

header('Content-Type: application/wasm');
header('Content-Length: ' . (string)filesize($file));
// the engine is 640KB of immutable binary; let the browser keep it
header('Cache-Control: public, max-age=31536000, immutable');
readfile($file);
return true;
