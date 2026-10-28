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
  'import.invalidPgn': 'No legal moves could be read from this PGN',

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
  'game.round': 'Round',

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
  'comment.add': 'Add comment',
  'comment.edit': 'Edit comment',

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
  'db.supportedFormatsWeb': 'PGN, or a ChessBase database: select its .cbh, .cbg and .cba files together',
  'db.open': 'Open...',
  'db.loading': 'Loading...',
  'db.importing': 'Importing & indexing…',
  'db.prev': 'Prev',
  'db.next': 'Next',
  'db.skipped': 'Not imported',
  'db.skip.guiding-text': 'guiding texts',
  'db.skip.deleted': 'deleted games',
  'db.skip.unsupported-encoding': 'Chess960 / variant games',
  'db.skip.corrupt': 'damaged records',

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

  // Opening book
  'book.title': 'Opening Book',
  'book.load': 'Load book…',
  'book.change': 'Change',
  'book.close': 'Close',
  'book.none': 'Load a Polyglot (.bin) book to see its moves here.',
  'book.noMoves': 'Out of book',
  'book.entries': 'entries',
  'book.export': 'Export book',
  'book.exported': 'Book exported',

  // Tablebase
  'tb.title': 'Tablebase',
  'tb.source': 'Lichess · Syzygy',
  'tb.enable': 'Turn on',
  'tb.disable': 'Turn off',
  'tb.off': 'Online lookups are off. Positions with up to 7 pieces can be solved by the Lichess tablebase.',
  'tb.loading': 'Looking up…',
  'tb.rateLimited': 'Too many lookups — try again in a moment.',
  'tb.unavailable': 'Tablebase unavailable. Check your internet connection.',
  'tb.whiteWins': 'White wins',
  'tb.blackWins': 'Black wins',
  'tb.draw': 'Draw',
  'tb.drawn50': 'Draw by the 50-move rule',
  'tb.checkmate': 'Checkmate',
  'tb.stalemate': 'Stalemate',
  'tb.win': 'Win',
  'tb.loss': 'Loss',
  'tb.maybeWin': 'Win?',
  'tb.maybeLoss': 'Loss?',
  'tb.cursedWin': 'Win, but 50-move draw',
  'tb.blessedLoss': 'Loss, but 50-move draw',
  'tb.drawShort': 'Draw',
  'tb.unknownShort': 'Unknown',

  // Variations
  'variation.promote': 'Promote to main line',
  'variation.delete': 'Delete variation',
  'variation.deleteFromHere': 'Delete from here',

  // Training
  'tab.training': 'Training',
  'train.intro':
    'Save the game on the board, with its variations, as a repertoire, then drill it: the trainer plays the replies and asks for your moves. Moves you know come back less and less often; mistakes come back soon.',
  'train.namePlaceholder': 'Repertoire name',
  'train.side': 'I play',
  'train.white': 'White',
  'train.black': 'Black',
  'train.save': 'Save as repertoire',
  'train.noMoves': 'First play or load the lines to learn on the board.',
  'train.noPositions': 'This repertoire has no moves for your side.',
  'train.start': 'Train',
  'train.update': 'Update',
  'train.updateHint': 'Replace with the game on the board, keeping your progress',
  'train.delete': 'Delete',
  'train.confirmDelete': 'Delete this repertoire and its progress?',
  'train.due': 'due',
  'train.new': 'new',
  'train.learned': 'learned',
  'train.yourMove': 'Your move',
  'train.newMove': 'New move: play the arrow',
  'train.thinking': '…',
  'train.correct': 'Correct',
  'train.wrong': 'Not your repertoire move. It is',
  'train.lineEnd': 'Line complete',
  'train.done': 'All done for now',
  'train.paused': 'Paused: go back to the training board',
  'train.hint': 'Show answer',
  'train.stop': 'Stop',
  'train.close': 'Close',
  'train.answered': 'answered',
  'train.mistakes': 'mistakes',
  'train.tabName': 'Training'
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
  'import.invalidPgn': '无法从该 PGN 中读取任何合法着法',

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
  'game.round': '轮次',

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
  'comment.add': '添加评注',
  'comment.edit': '编辑评注',

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
  'db.supportedFormatsWeb': '支持 PGN；ChessBase 数据库请同时选中它的 .cbh、.cbg 和 .cba 文件',
  'db.open': '打开...',
  'db.loading': '加载中...',
  'db.importing': '正在导入并建立索引…',
  'db.prev': '上一页',
  'db.next': '下一页',
  'db.skipped': '未导入',
  'db.skip.guiding-text': '引导文本',
  'db.skip.deleted': '已删除对局',
  'db.skip.unsupported-encoding': 'Chess960 / 变体对局',
  'db.skip.corrupt': '损坏记录',

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

  // Opening book
  'book.title': '开局书',
  'book.load': '加载开局书…',
  'book.change': '更换',
  'book.close': '关闭',
  'book.none': '加载 Polyglot (.bin) 开局书后，这里会显示书内着法。',
  'book.noMoves': '已出书',
  'book.entries': '条',
  'book.export': '导出开局书',
  'book.exported': '开局书已导出',

  // Tablebase
  'tb.title': '残局库',
  'tb.source': 'Lichess · Syzygy',
  'tb.enable': '开启',
  'tb.disable': '关闭',
  'tb.off': '在线查询已关闭。7 子以内的局面可由 Lichess 残局库给出完美着法。',
  'tb.loading': '查询中…',
  'tb.rateLimited': '查询过于频繁，请稍后再试。',
  'tb.unavailable': '无法连接残局库，请检查网络。',
  'tb.whiteWins': '白方胜',
  'tb.blackWins': '黑方胜',
  'tb.draw': '和棋',
  'tb.drawn50': '50 回合规则下和棋',
  'tb.checkmate': '将杀',
  'tb.stalemate': '逼和',
  'tb.win': '胜',
  'tb.loss': '负',
  'tb.maybeWin': '可能胜',
  'tb.maybeLoss': '可能负',
  'tb.cursedWin': '胜（超 50 回合判和）',
  'tb.blessedLoss': '负（超 50 回合判和）',
  'tb.drawShort': '和',
  'tb.unknownShort': '未知',

  // Variations
  'variation.promote': '提升为主线',
  'variation.delete': '删除变着',
  'variation.deleteFromHere': '从此处删除',

  // Training
  'tab.training': '训练',
  'train.intro':
    '把棋盘上的对局（含变着）存为开局库，然后反复练习：电脑走对方的着法，你来走自己的。熟悉的着法复习间隔越来越长，出错的着法很快会再出现。',
  'train.namePlaceholder': '开局库名称',
  'train.side': '我执',
  'train.white': '白方',
  'train.black': '黑方',
  'train.save': '存为开局库',
  'train.noMoves': '请先在棋盘上走出或导入要练习的变化。',
  'train.noPositions': '这个开局库里没有你这一方的着法。',
  'train.start': '开始练习',
  'train.update': '更新',
  'train.updateHint': '用棋盘上的对局替换，保留练习进度',
  'train.delete': '删除',
  'train.confirmDelete': '删除这个开局库及其练习进度？',
  'train.due': '待复习',
  'train.new': '新',
  'train.learned': '已掌握',
  'train.yourMove': '轮到你走',
  'train.newMove': '新着法：按箭头走',
  'train.thinking': '…',
  'train.correct': '正确',
  'train.wrong': '不是开局库中的着法，应为',
  'train.lineEnd': '本变化完成',
  'train.done': '今天的练习完成了',
  'train.paused': '已暂停：回到训练棋盘继续',
  'train.hint': '显示答案',
  'train.stop': '停止',
  'train.close': '关闭',
  'train.answered': '已答',
  'train.mistakes': '错误',
  'train.tabName': '训练'
}

export const locales = { en, zh } as const
export type Locale = keyof typeof locales
export type TranslationKey = keyof typeof en
