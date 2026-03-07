// Common chess openings mapped by FEN (position part only, no move counters)
// Format: FEN position → { eco, name }
export interface Opening {
  eco: string
  name: string
  nameZh: string
}

function fenKey(fen: string): string {
  // Use only the piece placement + active color + castling + en passant
  return fen.split(' ').slice(0, 4).join(' ')
}

const OPENINGS_RAW: [string, string, string, string][] = [
  // [FEN, ECO, English Name, Chinese Name]
  // Starting position
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', 'A00', 'Starting Position', '起始局面'],

  // King's Pawn
  ['rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3', 'B00', "King's Pawn Opening", '王兵开局'],
  ['rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6', 'C20', "King's Pawn Game", '王兵对称开局'],

  // Sicilian Defense
  ['rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6', 'B20', 'Sicilian Defense', '西西里防御'],
  ['rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -', 'B27', 'Sicilian Defense', '西西里防御'],
  ['r1bqkbnr/pp1ppppp/2n5/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -', 'B30', 'Sicilian Defense', '西西里防御'],
  ['rnbqkbnr/pp1ppppp/8/2p5/3PP3/8/PPP2PPP/RNBQKBNR b KQkq d3', 'B21', 'Smith-Morra Gambit', '史密斯-莫拉弃兵'],
  ['rnbqkbnr/pp1ppppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -', 'B50', 'Sicilian Defense', '西西里防御'],
  ['rnbqkbnr/pp2pppp/3p4/2p5/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq d3', 'B56', 'Sicilian Defense: Classical', '西西里防御：古典变例'],
  ['r1bqkbnr/pp2pppp/2np4/2p5/3PP3/5N2/PPP2PPP/RNBQKB1R w KQkq -', 'B56', 'Sicilian Defense: Classical', '西西里防御：古典变例'],
  ['r1bqkb1r/pp2pppp/2np1n2/2p5/3PP3/5N2/PPP2PPP/RNBQKB1R w KQkq -', 'B56', 'Sicilian: Classical Variation', '西西里：古典变例'],
  ['r1bqkbnr/pp2pppp/2np4/8/3NP3/8/PPP2PPP/RNBQKB1R b KQkq -', 'B60', 'Sicilian: Richter-Rauzer', '西西里：里希特-劳泽尔'],
  ['rnbqkb1r/pp2pppp/3p1n2/2p5/3PP3/5N2/PPP2PPP/RNBQKB1R w KQkq -', 'B90', 'Sicilian: Najdorf', '西西里：纳伊道夫变例'],

  // French Defense
  ['rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -', 'C00', 'French Defense', '法兰西防御'],
  ['rnbqkbnr/pppp1ppp/4p3/8/4PP2/8/PPPP2PP/RNBQKBNR b KQkq f3', 'C00', 'French: La Bourdonnais', '法兰西：拉布多内变例'],
  ['rnbqkbnr/ppp2ppp/4p3/3p4/4PP2/8/PPPP2PP/RNBQKBNR w KQkq d6', 'C00', 'French: La Bourdonnais', '法兰西：拉布多内变例'],
  ['rnbqkbnr/pppp1ppp/4p3/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq d3', 'C01', 'French Defense', '法兰西防御'],
  ['rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6', 'C01', 'French Defense', '法兰西防御'],
  ['rnbqkbnr/ppp2ppp/4p3/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq -', 'C02', 'French: Advance Variation', '法兰西：推进变例'],
  ['rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR b KQkq -', 'C03', 'French: Tarrasch Variation', '法兰西：塔拉什变例'],

  // Caro-Kann
  ['rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -', 'B10', 'Caro-Kann Defense', '卡罗-卡恩防御'],
  ['rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq d3', 'B12', 'Caro-Kann Defense', '卡罗-卡恩防御'],
  ['rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6', 'B12', 'Caro-Kann Defense', '卡罗-卡恩防御'],

  // Pirc/Modern
  ['rnbqkbnr/ppp1pppp/3p4/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -', 'B07', 'Pirc Defense', '皮尔茨防御'],
  ['rnbqkbnr/pppppp1p/6p1/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -', 'B06', 'Modern Defense', '现代防御'],

  // Scandinavian
  ['rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6', 'B01', 'Scandinavian Defense', '斯堪的纳维亚防御'],

  // Italian / Giuoco Piano
  ['r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -', 'C44', "King's Knight Opening", '王翼马开局'],
  ['r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -', 'C50', 'Italian Game', '意大利开局'],
  ['r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -', 'C50', 'Giuoco Piano', '意大利开局'],
  ['r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R b KQkq -', 'C50', 'Four Knights Italian', '四马意大利'],

  // Ruy Lopez / Spanish
  ['r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -', 'C60', 'Ruy Lopez', '西班牙开局'],
  ['r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq -', 'C68', 'Ruy Lopez: Morphy Defense', '西班牙：莫菲防御'],
  ['r1bqkbnr/1ppp1ppp/p1n5/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R b KQkq -', 'C70', 'Ruy Lopez: Morphy Defense', '西班牙：莫菲防御'],

  // Scotch
  ['r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq d3', 'C44', 'Scotch Game', '苏格兰开局'],

  // Petrov
  ['rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -', 'C42', "Petrov's Defense", '彼得罗夫防御'],

  // King's Gambit
  ['rnbqkbnr/pppp1ppp/8/4p3/4PP2/8/PPPP2PP/RNBQKBNR b KQkq f3', 'C30', "King's Gambit", '王翼弃兵'],

  // Vienna
  ['rnbqkbnr/pppp1ppp/8/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR b KQkq -', 'C25', 'Vienna Game', '维也纳开局'],

  // Queen's Pawn
  ['rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3', 'A40', "Queen's Pawn Opening", '后兵开局'],
  ['rnbqkbnr/pppp1ppp/4p3/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq -', 'A40', "Queen's Pawn Game", '后兵开局'],
  ['rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq d6', 'D00', "Queen's Pawn Game", '后兵对称开局'],

  // Queen's Gambit
  ['rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq c3', 'D06', "Queen's Gambit", '后翼弃兵'],
  ['rnbqkbnr/ppp2ppp/4p3/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq -', 'D30', "Queen's Gambit Declined", '后翼弃兵拒受'],
  ['rnbqkbnr/ppp1pppp/8/8/2pP4/8/PP2PPPP/RNBQKBNR w KQkq -', 'D20', "Queen's Gambit Accepted", '后翼弃兵接受'],
  ['rnbqkbnr/ppp1pppp/8/3p4/2PP4/5N2/PP2PPPP/RNBQKB1R b KQkq -', 'D06', "Queen's Gambit", '后翼弃兵'],
  ['rnbqkb1r/ppp1pppp/5n2/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq -', 'D06', "Queen's Gambit", '后翼弃兵'],
  ['rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq -', 'D31', "QGD: Semi-Tarrasch", '后翼弃兵拒受'],

  // Slav
  ['rnbqkbnr/pp2pppp/2p5/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq -', 'D10', 'Slav Defense', '斯拉夫防御'],
  ['rnbqkbnr/pp2pppp/2p5/3p4/2PP4/5N2/PP2PPPP/RNBQKB1R b KQkq -', 'D11', 'Slav Defense', '斯拉夫防御'],

  // London System
  ['rnbqkbnr/ppp1pppp/8/3p4/3P1B2/8/PPP1PPPP/RN1QKBNR b KQkq -', 'D00', 'London System', '伦敦体系'],

  // King's Indian Defense
  ['rnbqkb1r/pppppp1p/5np1/8/2PP4/8/PP2PPPP/RNBQKBNR w KQkq -', 'E60', "King's Indian Defense", '王翼印度防御'],
  ['rnbqkb1r/pppppp1p/5np1/8/2PP4/2N5/PP2PPPP/R1BQKBNR b KQkq -', 'E61', "King's Indian Defense", '王翼印度防御'],
  ['rnbqk2r/ppp1ppbp/3p1np1/8/2PPP3/2N5/PP3PPP/R1BQKBNR w KQkq -', 'E70', "King's Indian Defense", '王翼印度防御：古典变例'],

  // Nimzo-Indian
  ['rnbqk2r/pppp1ppp/4pn2/8/1bPP4/2N5/PP2PPPP/R1BQKBNR w KQkq -', 'E20', 'Nimzo-Indian Defense', '尼姆佐-印度防御'],

  // Queen's Indian
  ['rnbqkb1r/p1pp1ppp/1p2pn2/8/2PP4/5N2/PP2PPPP/RNBQKB1R w KQkq -', 'E15', "Queen's Indian Defense", '后翼印度防御'],

  // Grünfeld
  ['rnbqkb1r/ppp1pp1p/5np1/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq d6', 'D80', 'Grünfeld Defense', '格林菲尔德防御'],

  // Dutch Defense
  ['rnbqkbnr/ppppp1pp/8/5p2/3P4/8/PPP1PPPP/RNBQKBNR w KQkq f6', 'A80', 'Dutch Defense', '荷兰防御'],

  // Benoni
  ['rnbqkb1r/pp1ppppp/5n2/2p5/3PP3/8/PPP2PPP/RNBQKBNR w KQkq -', 'A56', 'Benoni Defense', '贝诺尼防御'],

  // English Opening
  ['rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq c3', 'A10', 'English Opening', '英国开局'],
  ['rnbqkbnr/pppp1ppp/8/4p3/2P5/8/PP1PPPPP/RNBQKBNR w KQkq e6', 'A20', 'English: Reversed Sicilian', '英国：反西西里'],

  // Réti Opening
  ['rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq -', 'A04', 'Réti Opening', '列蒂开局'],
  ['rnbqkbnr/ppp1pppp/8/3p4/8/5N2/PPPPPPPP/RNBQKB1R w KQkq d6', 'A06', 'Réti Opening', '列蒂开局'],

  // Catalan
  ['rnbqkb1r/pppp1ppp/4pn2/8/2PP4/6P1/PP2PP1P/RNBQKBNR b KQkq -', 'E01', 'Catalan Opening', '加泰罗尼亚开局'],

  // Bird's Opening
  ['rnbqkbnr/pppppppp/8/8/5P2/8/PPPPP1PP/RNBQKBNR b KQkq f3', 'A02', "Bird's Opening", '柏德开局'],

  // Alekhine's Defense
  ['rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -', 'B02', "Alekhine's Defense", '阿廖欣防御'],

  // Philidor
  ['rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -', 'C41', 'Philidor Defense', '菲利多尔防御'],
]

const OPENING_MAP = new Map<string, Opening>()
for (const [fen, eco, name, nameZh] of OPENINGS_RAW) {
  OPENING_MAP.set(fenKey(fen), { eco, name, nameZh })
}

export function lookupOpening(fen: string): Opening | null {
  return OPENING_MAP.get(fenKey(fen)) || null
}
