export const IPC = {
  // Engine channels
  ENGINE_ADD: 'engine:add',
  ENGINE_REMOVE: 'engine:remove',
  ENGINE_START_ANALYSIS: 'engine:start-analysis',
  ENGINE_STOP_ANALYSIS: 'engine:stop-analysis',
  ENGINE_SET_OPTION: 'engine:set-option',
  ENGINE_GET_OPTIONS: 'engine:get-options',
  ENGINE_OUTPUT: 'engine:output',
  ENGINE_BEST_MOVE: 'engine:best-move',

  // File channels
  FILE_OPEN_PGN: 'file:open-pgn',
  FILE_READ: 'file:read',
  FILE_SAVE_PGN: 'file:save-pgn',
  FILE_OPEN_DATABASE: 'file:open-database',
  FILE_SELECT_ENGINE: 'file:select-engine',

  // Database channels
  DATABASE_OPEN: 'database:open',
  DATABASE_SEARCH: 'database:search',
  DATABASE_GET_GAME: 'database:get-game',
  DATABASE_GET_OPENING_STATS: 'database:get-opening-stats',
  DATABASE_POSITION_GAMES: 'database:position-games',
  DATABASE_ADD_GAME: 'database:add-game',
  DATABASE_DELETE_GAME: 'database:delete-game',
  DATABASE_PLAYER_SUGGEST: 'database:player-suggest',
  DATABASE_IMPORT_PROGRESS: 'database:import-progress',

  // Opening book channels
  BOOK_OPEN_DIALOG: 'book:open-dialog',
  BOOK_LOAD: 'book:load',
  BOOK_LOOKUP: 'book:lookup',
  BOOK_CLOSE: 'book:close',
  BOOK_EXPORT: 'book:export',

  // Tablebase
  TABLEBASE_PROBE: 'tablebase:probe'
} as const
