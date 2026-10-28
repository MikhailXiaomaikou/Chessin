const en = {
  // Tabs
  'tab.new': 'New Tab',
  'tab.close': 'Close Tab',

  // MainLayout
  'tab.moves': 'Moves',
  'tab.database': 'Database',
  'tab.reference': 'Reference',

  // BoardControls
  'board.flip': 'Flip',
  'board.flip.title': 'Flip Board (F)',
  'board.coords': 'Coords',
  'board.coords.title': 'Toggle Coordinates',
  'board.hints': 'Hints',
  'board.hints.title': 'Toggle Legal Moves',
  'board.edit': 'Edit',
  'board.edit.title': 'Board Editor',

  // EvalBar
  'eval.switchToWdl': 'Click to switch to WDL mode',
  'eval.switchToEval': 'Click to switch to Eval mode',
  'eval.wdl': 'WDL',
  'eval.eval': 'Eval',

  // BoardEditor
  'editor.title': 'Board Editor',
  'editor.whitePieces': 'White pieces',
  'editor.blackPieces': 'Black pieces',
  'editor.removePiece': 'Remove piece',
  'editor.clickToPlace': 'Click to place / remove',
  'editor.sideToMove': 'Side to move',
  'editor.white': 'White',
  'editor.black': 'Black',
  'editor.castling': 'Castling',
  'editor.enPassant': 'En passant',
  'editor.fen': 'FEN',
  'editor.invalidPosition': 'Invalid position: ',
  'editor.invalidFen': 'Invalid FEN string',
  'editor.clear': 'Clear',
  'editor.reset': 'Reset',
  'editor.cancel': 'Cancel',
  'editor.apply': 'Apply',

  // GameControls
  'game.new': 'New',
  'game.stop': 'Stop',
  'game.analyze': 'Analyze',
  'game.save': 'Save',
  'game.savePgn': 'Save PGN file',
  'game.saved': 'Saved',
  'game.import': 'Import',
  'game.copyFen': 'Copy FEN',
  'game.copyPgn': 'Copy PGN',

  // Import dialog
  'import.title': 'Import Game',
  'import.import': 'Import',
  'import.pgnPlaceholder': 'Paste PGN here...\n\n1. e4 e5 2. Nf3 Nc6 ...',
  'import.fenPlaceholder': 'Paste FEN here...\n\nrnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'import.openFile': 'Open File...',
  'import.invalidFen': 'Invalid FEN string',

  // Game analysis
  'analysis.analyzeGame': 'Full Analysis',
  'analysis.stop': 'Stop Analysis',
  'analysis.analyzing': 'Analyzing game...',
  'analysis.brilliant': 'Brilliant',
  'analysis.great': 'Great',
  'analysis.best': 'Best',
  'analysis.good': 'Good',
  'analysis.inaccuracy': 'Inaccuracy',
  'analysis.mistake': 'Mistake',
  'analysis.blunder': 'Blunder',
  'analysis.book': 'Book',

  // GameInfo
  'game.checkmateBlackWins': 'Checkmate! Black wins',
  'game.checkmateWhiteWins': 'Checkmate! White wins',
  'game.stalemate': 'Stalemate - Draw',
  'game.draw': 'Draw',
  'game.whiteInCheck': 'White is in check',
  'game.blackInCheck': 'Black is in check',
  'game.moves': 'Moves',
  'game.move': 'Move ',
  'game.ready': 'Ready',

  // NewGameDialog
  'newGame.title': 'New Game',
  'newGame.mode': 'Mode',
  'newGame.analysis': 'Analysis',
  'newGame.vsEngine': 'vs Engine',
  'newGame.engineVsEngine': 'Engine vs Engine',
  'newGame.playAs': 'Play as',
  'newGame.random': 'Random',
  'newGame.engine': 'Engine',
  'newGame.noEngines': 'No engines configured. Add one from the Engine menu.',
  'newGame.timeControl': 'Time Control',
  'newGame.noTime': 'No time',
  'newGame.startGame': 'Start Game',

  // MoveNavigation
  'nav.goToStart': 'Go to start (Home)',
  'nav.goBack': 'Go back (Left)',
  'nav.goForward': 'Go forward (Right)',
  'nav.goToEnd': 'Go to end (End)',

  // MoveList
  'moves.empty': 'No moves yet. Start playing!',

  // CommentEditor
  'comment.placeholder': 'Add a comment...',
  'comment.cancel': 'Cancel',
  'comment.save': 'Save',

  // EnginePanel
  'engine.title': 'Engine',
  'engine.add': '+ Add Engine',
  'engine.noEngine': 'No engine configured. Click "+ Add Engine" to add Stockfish or Leela Chess Zero.',
  'engine.stopAnalysis': 'Stop',
  'engine.startAnalysis': 'Analyze',
  'engine.analyzing': 'Analyzing...',
  'engine.activate': 'Enable engine',
  'engine.deactivate': 'Disable engine',
  'engine.remove': 'Remove engine',
  'engine.config': 'Settings',
  'engine.done': 'Done',
  'engine.showAll': 'Show all options',
  'engine.showLess': 'Show fewer options',

  // EngineLines
  'engine.waiting': 'Waiting for analysis...',

  // EngineStats
  'stats.depth': 'depth ',
  'stats.nodes': ' nodes',
  'stats.nps': ' nps',
  'stats.hash': 'hash ',

  // WdlBar
  'wdl.win': 'Win ',
  'wdl.draw': 'Draw ',
  'wdl.loss': 'Loss ',

  // DatabasePanel
  'db.noDatabase': 'No database open',
  'db.openDatabase': 'Open Database',
  'db.supportedFormats': 'Supports PGN, ChessBase CBH, and CBV formats',
  'db.open': 'Open...',
  'db.loading': 'Loading...',
  'db.importing': 'Importing & indexing…',
  'db.prev': 'Prev',
  'db.next': 'Next',

  // GameList
  'db.headerNum': '#',
  'db.headerWhite': 'White',
  'db.headerBlack': 'Black',
  'db.headerResult': 'Result',
  'db.headerEco': 'ECO',
  'db.headerDate': 'Date',
  'db.noGames': 'No games found',

  // GameFilter
  'filter.white': 'White',
  'filter.black': 'Black',
  'filter.eco': 'ECO',
  'filter.event': 'Event',
  'filter.minElo': 'Min Elo',
  'filter.ignoreColors': 'Either color',
  'filter.anyResult': 'Any result',
  'filter.search': 'Search',
  'filter.clear': 'Clear',

  // Reference / opening tree
  'ref.title': 'Opening Reference',
  'ref.games': 'games',
  'ref.move': 'Move',
  'ref.count': 'Games',
  'ref.results': 'Results (W/D/B)',
  'ref.noDatabase': 'Open a database to see opening statistics for the current position.',
  'ref.noMoves': 'No games reached this position.',
  'ref.gamesAtPosition': 'Games at this position',

  // Variations
  'variation.promote': 'Promote to main line',
  'variation.delete': 'Delete variation'
} as const

type Translations = Record<keyof typeof en, string>

const zh: Translations = {
  // Tabs
  'tab.new': '新标签页',
  'tab.close': '关闭标签页',

  // MainLayout
  'tab.moves': '棋谱',
  'tab.database': '数据库',
  'tab.reference': '参考库',

  // BoardControls
  'board.flip': '翻转',
  'board.flip.title': '翻转棋盘 (F)',
  'board.coords': '坐标',
  'board.coords.title': '显示/隐藏坐标',
  'board.hints': '提示',
  'board.hints.title': '显示/隐藏合法走法',
  'board.edit': '编辑',
  'board.edit.title': '棋盘编辑器',

  // EvalBar
  'eval.switchToWdl': '点击切换到胜率模式',
  'eval.switchToEval': '点击切换到评估模式',
  'eval.wdl': '胜率',
  'eval.eval': '评估',

  // BoardEditor
  'editor.title': '棋盘编辑器',
  'editor.whitePieces': '白方棋子',
  'editor.blackPieces': '黑方棋子',
  'editor.removePiece': '删除棋子',
  'editor.clickToPlace': '点击放置/移除棋子',
  'editor.sideToMove': '行棋方',
  'editor.white': '白方',
  'editor.black': '黑方',
  'editor.castling': '王车易位',
  'editor.enPassant': '吃过路兵',
  'editor.fen': 'FEN',
  'editor.invalidPosition': '无效局面：',
  'editor.invalidFen': '无效的 FEN 字符串',
  'editor.clear': '清空',
  'editor.reset': '重置',
  'editor.cancel': '取消',
  'editor.apply': '应用',

  // GameControls
  'game.new': '新局',
  'game.stop': '停止',
  'game.analyze': '分析',
  'game.save': '保存',
  'game.savePgn': '保存 PGN 文件',
  'game.saved': '已保存',
  'game.import': '导入',
  'game.copyFen': '复制 FEN',
  'game.copyPgn': '复制 PGN',

  // Import dialog
  'import.title': '导入对局',
  'import.import': '导入',
  'import.pgnPlaceholder': '在此粘贴 PGN...\n\n1. e4 e5 2. Nf3 Nc6 ...',
  'import.fenPlaceholder': '在此粘贴 FEN...\n\nrnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'import.openFile': '打开文件...',
  'import.invalidFen': '无效的 FEN 字符串',

  // Game analysis
  'analysis.analyzeGame': '全局分析',
  'analysis.stop': '停止分析',
  'analysis.analyzing': '正在分析对局...',
  'analysis.brilliant': '妙招',
  'analysis.great': '好招',
  'analysis.best': '最佳',
  'analysis.good': '良好',
  'analysis.inaccuracy': '不准确',
  'analysis.mistake': '失误',
  'analysis.blunder': '错着',
  'analysis.book': '定式',

  // GameInfo
  'game.checkmateBlackWins': '将杀！黑方获胜',
  'game.checkmateWhiteWins': '将杀！白方获胜',
  'game.stalemate': '逼和 - 和棋',
  'game.draw': '和棋',
  'game.whiteInCheck': '白方被将',
  'game.blackInCheck': '黑方被将',
  'game.moves': '步',
  'game.move': '第 ',
  'game.ready': '就绪',

  // NewGameDialog
  'newGame.title': '新对局',
  'newGame.mode': '模式',
  'newGame.analysis': '分析',
  'newGame.vsEngine': '对弈引擎',
  'newGame.engineVsEngine': '引擎对弈',
  'newGame.playAs': '执棋',
  'newGame.random': '随机',
  'newGame.engine': '引擎',
  'newGame.noEngines': '未配置引擎，请先在引擎菜单中添加。',
  'newGame.timeControl': '时间控制',
  'newGame.noTime': '无限时',
  'newGame.startGame': '开始对局',

  // MoveNavigation
  'nav.goToStart': '回到开始 (Home)',
  'nav.goBack': '上一步 (Left)',
  'nav.goForward': '下一步 (Right)',
  'nav.goToEnd': '到最后 (End)',

  // MoveList
  'moves.empty': '暂无走子，开始对弈吧！',

  // CommentEditor
  'comment.placeholder': '添加评注...',
  'comment.cancel': '取消',
  'comment.save': '保存',

  // EnginePanel
  'engine.title': '引擎',
  'engine.add': '+ 添加引擎',
  'engine.noEngine': '未配置引擎。点击"+ 添加引擎"来添加 Stockfish 或 Leela Chess Zero。',
  'engine.stopAnalysis': '停止',
  'engine.startAnalysis': '分析',
  'engine.analyzing': '分析中...',
  'engine.activate': '启用引擎',
  'engine.deactivate': '禁用引擎',
  'engine.remove': '移除引擎',
  'engine.config': '设置',
  'engine.done': '完成',
  'engine.showAll': '显示所有选项',
  'engine.showLess': '收起选项',

  // EngineLines
  'engine.waiting': '等待分析结果...',

  // EngineStats
  'stats.depth': '深度 ',
  'stats.nodes': ' 节点',
  'stats.nps': ' nps',
  'stats.hash': '哈希 ',

  // WdlBar
  'wdl.win': '胜 ',
  'wdl.draw': '和 ',
  'wdl.loss': '负 ',

  // DatabasePanel
  'db.noDatabase': '未打开数据库',
  'db.openDatabase': '打开数据库',
  'db.supportedFormats': '支持 PGN、ChessBase CBH 和 CBV 格式',
  'db.open': '打开...',
  'db.loading': '加载中...',
  'db.importing': '正在导入并建立索引…',
  'db.prev': '上一页',
  'db.next': '下一页',

  // GameList
  'db.headerNum': '#',
  'db.headerWhite': '白方',
  'db.headerBlack': '黑方',
  'db.headerResult': '结果',
  'db.headerEco': 'ECO',
  'db.headerDate': '日期',
  'db.noGames': '未找到对局',

  // GameFilter
  'filter.white': '白方',
  'filter.black': '黑方',
  'filter.eco': 'ECO',
  'filter.event': '赛事',
  'filter.minElo': '最低等级分',
  'filter.ignoreColors': '不分先后',
  'filter.anyResult': '所有结果',
  'filter.search': '搜索',
  'filter.clear': '清除',

  // Reference / opening tree
  'ref.title': '开局参考',
  'ref.games': '局',
  'ref.move': '着法',
  'ref.count': '对局数',
  'ref.results': '胜负 (白/和/黑)',
  'ref.noDatabase': '打开数据库后即可查看当前局面的开局统计。',
  'ref.noMoves': '没有对局到达此局面。',
  'ref.gamesAtPosition': '到达此局面的对局',

  // Variations
  'variation.promote': '提升为主线',
  'variation.delete': '删除变着'
}

export const locales = { en, zh } as const
export type Locale = keyof typeof locales
export type TranslationKey = keyof typeof en
