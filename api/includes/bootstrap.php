<?php
declare(strict_types=1);

/**
 * The one file an endpoint requires.
 *
 * Load order is the order of the dependency arrows: Config knows nothing,
 * Db reads Config, Http reads Config and Db, Auth reads all of them, GameState
 * needs nothing but the engine, and the game's repository is the only thing that
 * knows the schema.
 *
 * @author DALI951
 */

require_once __DIR__ . '/Engine.php';
require_once __DIR__ . '/GameState.php';
require_once __DIR__ . '/Config.php';
require_once __DIR__ . '/Db.php';
require_once __DIR__ . '/Http.php';
require_once __DIR__ . '/Auth.php';
require_once __DIR__ . '/GameRepo.php';
require_once __DIR__ . '/Chat.php';
