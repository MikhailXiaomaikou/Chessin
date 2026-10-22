//! Syzygy endgame tablebases: WDL/DTZ probes and best-first move ordering.
//!
//! Values are integers from the side to move's point of view:
//!
//! * `wdl`: `-2` loss, `-1` blessed loss (a loss the 50-move rule saves, or
//!   one that may be saved: DTZ rounding leaves that open), `0` draw, `1`
//!   cursed win (or one that may be frustrated), `2` win.
//! * `dtz`: distance to zeroing in plies, sign as `wdl`; `None` when only
//!   WDL tables are present.
//!
//! For a move, both describe the position *after* it as seen by the side
//! that moved (so `wdl: 2` is a winning move and `dtz` is how far the
//! opponent is from the next zeroing move, negated). Checkmating,
//! stalemating and dead-material moves are evaluated without tables.

use std::path::{Path, PathBuf};

use shakmaty::{san::SanPlus, CastlingMode, Chess, Position};
use shakmaty_syzygy::{AmbiguousWdl, Metric, SyzygyError, Tablebase, Wdl};

use crate::{parse_fen, Error};

/// Largest number of pieces Syzygy tables exist for.
pub const MAX_PIECES: usize = 7;

/// What a tablebase directory offers.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type,
)]
pub struct TablebaseStatus {
    /// Pieces of the largest table found (0 when none).
    pub pieces: u8,
    /// Table files found (`.rtbw` and `.rtbz`).
    pub files: u32,
}

/// WDL/DTZ of a position from the side to move's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Eval {
    pub wdl: i8,
    pub dtz: Option<i32>,
}

/// A legal move with the tablebase result of the position after it, from
/// the mover's point of view.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct TablebaseMove {
    pub uci: String,
    pub san: String,
    pub wdl: i8,
    pub dtz: Option<i32>,
    /// A capture or pawn move: resets the 50-move counter.
    pub zeroing: bool,
    pub checkmate: bool,
    pub stalemate: bool,
    pub insufficient_material: bool,
}

/// The result of probing a position.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct TablebaseProbe {
    pub wdl: i8,
    pub dtz: Option<i32>,
    pub checkmate: bool,
    pub stalemate: bool,
    pub insufficient_material: bool,
    /// Every legal move whose outcome the tables know, best first (see
    /// [`order_moves`]); empty for a finished game.
    pub best: Vec<TablebaseMove>,
}

/// The name the S4 contract uses.
pub type Probe = TablebaseProbe;

/// Something that can evaluate positions: the real [`Tables`], or a mock in
/// tests of the ordering logic.
pub trait Prober {
    /// WDL/DTZ of `pos` for the side to move; `None` when no table covers
    /// the position (too many pieces, castling rights, missing table).
    fn eval(&self, pos: &Chess) -> Result<Option<Eval>, Error>;
    /// Pieces of the largest table; positions above are skipped unprobed.
    fn max_pieces(&self) -> usize;
}

/// The tables of one directory. Files are listed at [`Tables::open`] and
/// opened lazily by the first probe that needs each of them, so keep the
/// value around to keep that cache.
pub struct Tables {
    tb: Tablebase<Chess>,
    dir: PathBuf,
    files: u32,
}

impl std::fmt::Debug for Tables {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tables")
            .field("dir", &self.dir)
            .field("files", &self.files)
            .field("pieces", &self.tb.max_pieces())
            .finish()
    }
}

impl Tables {
    /// Lists the table files of `dir`; an error when it is not a readable
    /// directory or a table file is visibly corrupt.
    pub fn open(dir: &Path) -> Result<Tables, Error> {
        let mut tb = Tablebase::new();
        let files = tb.add_directory(dir)?;
        Ok(Tables {
            tb,
            dir: dir.to_path_buf(),
            files: u32::try_from(files).unwrap_or(u32::MAX),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn status(&self) -> TablebaseStatus {
        TablebaseStatus {
            pieces: u8::try_from(self.tb.max_pieces()).unwrap_or(u8::MAX),
            files: self.files,
        }
    }

    /// Probes `pos` and orders its moves; `None` when the tables do not
    /// cover the position.
    pub fn probe(&self, pos: &Chess) -> Result<Option<TablebaseProbe>, Error> {
        probe_with(pos, self)
    }

    /// [`Tables::probe`] of a FEN.
    pub fn probe_fen(&self, fen: &str) -> Result<Option<TablebaseProbe>, Error> {
        self.probe(&parse_fen(fen)?)
    }
}

fn wdl_to_i8(wdl: Wdl) -> i8 {
    match wdl {
        Wdl::Loss => -2,
        Wdl::BlessedLoss => -1,
        Wdl::Draw => 0,
        Wdl::CursedWin => 1,
        Wdl::Win => 2,
    }
}

fn ambiguous_to_i8(wdl: AmbiguousWdl) -> i8 {
    match wdl {
        AmbiguousWdl::Loss => -2,
        AmbiguousWdl::MaybeLoss | AmbiguousWdl::BlessedLoss => -1,
        AmbiguousWdl::Draw => 0,
        AmbiguousWdl::CursedWin | AmbiguousWdl::MaybeWin => 1,
        AmbiguousWdl::Win => 2,
    }
}

fn uncovered(e: SyzygyError) -> Result<Option<Eval>, Error> {
    match e {
        SyzygyError::Castling | SyzygyError::TooManyPieces | SyzygyError::MissingTable { .. } => {
            Ok(None)
        }
        SyzygyError::ProbeFailed { .. } => Err(Error::Syzygy(e.to_string())),
    }
}

impl Prober for Tables {
    fn eval(&self, pos: &Chess) -> Result<Option<Eval>, Error> {
        match self.tb.probe_dtz(pos) {
            Ok(dtz) => Ok(Some(Eval {
                wdl: ambiguous_to_i8(AmbiguousWdl::from_dtz_and_halfmoves(dtz, pos.halfmoves())),
                dtz: Some(dtz.ignore_rounding().0),
            })),
            // WDL tables without their DTZ siblings still tell the outcome.
            Err(SyzygyError::MissingTable {
                metric: Metric::Dtz,
                ..
            }) => match self.tb.probe_wdl_after_zeroing(pos) {
                Ok(wdl) => Ok(Some(Eval {
                    wdl: wdl_to_i8(wdl),
                    dtz: None,
                })),
                Err(e) => uncovered(e),
            },
            Err(e) => uncovered(e),
        }
    }

    fn max_pieces(&self) -> usize {
        self.tb.max_pieces()
    }
}

/// Opens the tables of `dir` and probes `fen`: for one-off use; callers that
/// probe repeatedly keep a [`Tables`].
pub fn probe(dir: &Path, fen: &str) -> Result<Option<TablebaseProbe>, Error> {
    Tables::open(dir)?.probe_fen(fen)
}

/// The value of a finished position, which needs no table.
fn terminal_eval(pos: &Chess) -> Option<Eval> {
    if pos.is_checkmate() {
        Some(Eval {
            wdl: -2,
            dtz: Some(0),
        })
    } else if pos.is_stalemate() || pos.is_insufficient_material() {
        Some(Eval {
            wdl: 0,
            dtz: Some(0),
        })
    } else {
        None
    }
}

/// Probes `pos` with `prober` and orders its moves. `None` when the
/// position is not covered; a finished game is covered with no moves.
pub fn probe_with(pos: &Chess, prober: &impl Prober) -> Result<Option<TablebaseProbe>, Error> {
    let terminal = terminal_eval(pos);
    let root = match terminal {
        Some(eval) => eval,
        None => {
            if pos.board().occupied().count() > prober.max_pieces() {
                return Ok(None);
            }
            match prober.eval(pos)? {
                Some(eval) => eval,
                None => return Ok(None),
            }
        }
    };
    let best = if terminal.is_some() {
        Vec::new()
    } else {
        order_moves(pos, prober)?
    };
    Ok(Some(TablebaseProbe {
        wdl: root.wdl,
        dtz: root.dtz,
        checkmate: pos.is_checkmate(),
        stalemate: pos.is_stalemate(),
        insufficient_material: pos.is_insufficient_material(),
        best,
    }))
}

/// Every legal move of `pos` whose outcome `prober` knows, best first for
/// the side to move: wins before draws before losses; among wins a
/// checkmate first, then the shortest distance to zeroing; among losses the
/// longest; unknown distances last in their group; then by UCI.
pub fn order_moves(pos: &Chess, prober: &impl Prober) -> Result<Vec<TablebaseMove>, Error> {
    let mut moves = Vec::new();
    for m in pos.legal_moves() {
        let mut after = pos.clone();
        after.play_unchecked(&m);
        let (eval, finished) = match terminal_eval(&after) {
            Some(eval) => (eval, true),
            None => match prober.eval(&after)? {
                Some(eval) => (eval, false),
                None => continue,
            },
        };
        moves.push(TablebaseMove {
            uci: m.to_uci(CastlingMode::Standard).to_string(),
            san: SanPlus::from_move(pos.clone(), &m).to_string(),
            wdl: -eval.wdl,
            dtz: eval.dtz.map(|d| -d),
            zeroing: m.is_zeroing(),
            checkmate: finished && after.is_checkmate(),
            stalemate: finished && after.is_stalemate(),
            insufficient_material: finished && after.is_insufficient_material(),
        });
    }
    moves.sort_by(|a, b| rank(b).cmp(&rank(a)).then_with(|| a.uci.cmp(&b.uci)));
    Ok(moves)
}

/// Higher is better for the mover.
fn rank(m: &TablebaseMove) -> (i8, i64) {
    const UNKNOWN: i64 = i64::MIN / 2;
    let distance = m.dtz.map(|d| i64::from(d.abs()));
    let secondary = if m.wdl > 0 {
        if m.checkmate {
            i64::MAX
        } else {
            distance.map(|d| -d).unwrap_or(UNKNOWN)
        }
    } else if m.wdl < 0 {
        distance.unwrap_or(UNKNOWN)
    } else {
        0
    };
    (m.wdl, secondary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use shakmaty::{Color, Square};

    struct Mock<F: Fn(&Chess) -> Option<Eval>> {
        max: usize,
        f: F,
    }

    impl<F: Fn(&Chess) -> Option<Eval>> Prober for Mock<F> {
        fn eval(&self, pos: &Chess) -> Result<Option<Eval>, Error> {
            Ok((self.f)(pos))
        }
        fn max_pieces(&self) -> usize {
            self.max
        }
    }

    fn white_king(pos: &Chess) -> Square {
        pos.board().king_of(Color::White).unwrap()
    }

    fn ucis(moves: &[TablebaseMove]) -> Vec<&str> {
        moves.iter().map(|m| m.uci.as_str()).collect()
    }

    #[test]
    fn a_directory_without_tables_covers_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"not a table").unwrap();
        let tables = Tables::open(dir.path()).unwrap();
        assert_eq!(
            tables.status(),
            TablebaseStatus {
                pieces: 0,
                files: 0
            }
        );
        assert_eq!(tables.dir(), dir.path());
        // KQvK is a 3-piece position: no table, no answer, no error.
        assert_eq!(
            tables.probe_fen("8/8/8/8/8/4k3/8/4K2Q w - - 0 1").unwrap(),
            None
        );
        assert_eq!(
            probe(dir.path(), "8/8/8/8/8/4k3/8/4K2Q w - - 0 1").unwrap(),
            None
        );
        // Even a checkmate is reported through the terminal path.
        let mate = tables
            .probe_fen("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1")
            .unwrap()
            .unwrap();
        assert!(mate.checkmate && mate.wdl == -2 && mate.best.is_empty());
        assert!(matches!(
            Tables::open(&dir.path().join("missing")),
            Err(Error::Io(_))
        ));
        assert!(matches!(tables.probe_fen("garbage"), Err(Error::Fen(_))));
    }

    /// A file named like a table with a plausible size is listed (the
    /// library opens tables lazily) and fails when probed: an error, not a
    /// silent `None`, so the UI can point at the bad download.
    #[test]
    fn a_corrupt_table_is_an_error_when_probed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("KQvK.rtbw"), [0u8; 16]).unwrap();
        let tables = Tables::open(dir.path()).unwrap();
        assert_eq!(
            tables.status(),
            TablebaseStatus {
                pieces: 3,
                files: 1
            }
        );
        assert!(matches!(
            tables.probe_fen("8/8/8/8/8/4k3/8/4K2Q w - - 0 1"),
            Err(Error::Syzygy(_))
        ));
        // Four pieces exceed the largest table: skipped, no error.
        assert_eq!(
            tables.probe_fen("8/8/8/8/8/4k3/8/3RK2Q w - - 0 1").unwrap(),
            None
        );
    }

    #[test]
    fn positions_above_the_table_size_are_not_probed() {
        let mock = Mock {
            max: 3,
            f: |_| panic!("must not probe"),
        };
        // Four pieces.
        let pos = parse_fen("8/8/8/8/8/4k3/8/3RK2Q w - - 0 1").unwrap();
        assert_eq!(probe_with(&pos, &mock).unwrap(), None);
    }

    #[test]
    fn finished_games_need_no_tables() {
        let mock = Mock {
            max: 7,
            f: |_| panic!("must not probe"),
        };
        let mate = parse_fen("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1").unwrap();
        let probe = probe_with(&mate, &mock).unwrap().unwrap();
        assert_eq!(
            (probe.wdl, probe.dtz, probe.checkmate, probe.stalemate),
            (-2, Some(0), true, false)
        );
        assert!(probe.best.is_empty());

        let stalemate = parse_fen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1").unwrap();
        let probe = probe_with(&stalemate, &mock).unwrap().unwrap();
        assert_eq!((probe.wdl, probe.stalemate), (0, true));

        let dead = parse_fen("7k/8/6K1/8/8/8/8/8 w - - 0 1").unwrap();
        let probe = probe_with(&dead, &mock).unwrap().unwrap();
        assert_eq!((probe.wdl, probe.insufficient_material), (0, true));
    }

    #[test]
    fn an_uncovered_root_is_none() {
        let mock = Mock {
            max: 7,
            f: |_| None,
        };
        // The h3 pawn keeps the material sufficient; White has king moves only.
        let pos = parse_fen("k7/8/8/8/8/7p/8/K7 w - - 0 1").unwrap();
        assert_eq!(probe_with(&pos, &mock).unwrap(), None);
    }

    /// The mock answers for the position *after* each king move (the side
    /// to move there is Black), so the values flip for White.
    #[test]
    fn moves_are_ordered_wins_draws_losses() {
        let mock = Mock {
            max: 7,
            f: |pos| {
                if pos.turn() == Color::White {
                    return Some(Eval {
                        wdl: 2,
                        dtz: Some(9),
                    });
                }
                Some(match white_king(pos) {
                    Square::A2 => Eval {
                        wdl: -2,
                        dtz: Some(-10),
                    },
                    Square::B1 => Eval {
                        wdl: 0,
                        dtz: Some(0),
                    },
                    Square::B2 => Eval {
                        wdl: 2,
                        dtz: Some(5),
                    },
                    other => panic!("unexpected king square {other}"),
                })
            },
        };
        // The h3 pawn keeps the material sufficient; White has king moves only.
        let pos = parse_fen("k7/8/8/8/8/7p/8/K7 w - - 0 1").unwrap();
        let probe = probe_with(&pos, &mock).unwrap().unwrap();
        assert_eq!((probe.wdl, probe.dtz), (2, Some(9)));
        assert_eq!(ucis(&probe.best), ["a1a2", "a1b1", "a1b2"]);
        assert_eq!(
            probe
                .best
                .iter()
                .map(|m| (m.wdl, m.dtz))
                .collect::<Vec<_>>(),
            [(2, Some(10)), (0, Some(0)), (-2, Some(-5))]
        );
        assert_eq!(probe.best[0].san, "Ka2");
        assert!(!probe.best[0].zeroing);
    }

    #[test]
    fn wins_prefer_the_fastest_and_losses_the_slowest_unknown_last() {
        let mock = Mock {
            max: 7,
            f: |pos| {
                if pos.turn() == Color::White {
                    return Some(Eval {
                        wdl: 2,
                        dtz: Some(1),
                    });
                }
                Some(match white_king(pos) {
                    // Winning moves: dtz 3, dtz 1, and one with WDL only.
                    Square::A2 => Eval {
                        wdl: -2,
                        dtz: Some(-3),
                    },
                    Square::C2 => Eval {
                        wdl: -2,
                        dtz: Some(-1),
                    },
                    Square::A1 => Eval { wdl: -2, dtz: None },
                    // Losing moves: slow and quick.
                    Square::B2 => Eval {
                        wdl: 2,
                        dtz: Some(20),
                    },
                    Square::C1 => Eval {
                        wdl: 2,
                        dtz: Some(2),
                    },
                    other => panic!("unexpected king square {other}"),
                })
            },
        };
        let pos = parse_fen("k7/8/8/8/8/7p/8/1K6 w - - 0 1").unwrap();
        let moves = order_moves(&pos, &mock).unwrap();
        assert_eq!(ucis(&moves), ["b1c2", "b1a2", "b1a1", "b1b2", "b1c1"]);
        assert_eq!(moves[2].dtz, None);
    }

    #[test]
    fn cursed_wins_rank_below_wins_and_uncovered_moves_are_dropped() {
        let mock = Mock {
            max: 7,
            f: |pos| {
                if pos.turn() == Color::White {
                    return Some(Eval {
                        wdl: 1,
                        dtz: Some(101),
                    });
                }
                match white_king(pos) {
                    Square::A2 => Some(Eval {
                        wdl: -1,
                        dtz: Some(-100),
                    }),
                    Square::B1 => Some(Eval {
                        wdl: -2,
                        dtz: Some(-40),
                    }),
                    Square::B2 => None,
                    other => panic!("unexpected king square {other}"),
                }
            },
        };
        // The h3 pawn keeps the material sufficient; White has king moves only.
        let pos = parse_fen("k7/8/8/8/8/7p/8/K7 w - - 0 1").unwrap();
        let moves = order_moves(&pos, &mock).unwrap();
        assert_eq!(ucis(&moves), ["a1b1", "a1a2"]);
        assert_eq!((moves[0].wdl, moves[1].wdl), (2, 1));
    }

    #[test]
    fn a_checkmating_move_ranks_first_among_wins() {
        let mock = Mock {
            max: 7,
            f: |pos| {
                Some(if pos.turn() == Color::White {
                    Eval {
                        wdl: 2,
                        dtz: Some(1),
                    }
                } else {
                    // Every other move also wins in one zeroing ply.
                    Eval {
                        wdl: -2,
                        dtz: Some(-1),
                    }
                })
            },
        };
        let pos = parse_fen("7k/8/6K1/8/8/8/8/5Q2 w - - 0 1").unwrap();
        let moves = order_moves(&pos, &mock).unwrap();
        assert_eq!(moves[0].uci, "f1f8");
        assert_eq!(moves[0].san, "Qf8#");
        assert!(moves[0].checkmate);
        assert_eq!((moves[0].wdl, moves[0].dtz), (2, Some(0)));
        // Stalemating moves (Qf7, Qc4, …) are draws, below every win.
        let stalemates: Vec<&TablebaseMove> = moves.iter().filter(|m| m.stalemate).collect();
        assert!(stalemates.iter().any(|m| m.uci == "f1f7"), "{stalemates:?}");
        assert!(stalemates.iter().all(|m| m.wdl == 0 && m.dtz == Some(0)));
        let first_draw = moves.iter().position(|m| m.wdl == 0).unwrap();
        assert!(moves[..first_draw].iter().all(|m| m.wdl == 2));
        assert!(moves[first_draw..].iter().all(|m| m.wdl == 0));
    }

    #[test]
    fn captures_and_pawn_moves_are_zeroing() {
        let mock = Mock {
            max: 7,
            f: |_| {
                Some(Eval {
                    wdl: 0,
                    dtz: Some(0),
                })
            },
        };
        // Black rook h2 takes b2 away from the king; the b3 pawn can be captured.
        let pos = parse_fen("k7/8/8/8/8/1p6/P6r/K7 w - - 0 1").unwrap();
        let moves = order_moves(&pos, &mock).unwrap();
        assert_eq!(moves.len(), 4);
        let by_uci = |uci: &str| moves.iter().find(|m| m.uci == uci).unwrap();
        assert!(by_uci("a2b3").zeroing);
        assert!(by_uci("a2a3").zeroing);
        assert!(by_uci("a2a4").zeroing);
        assert!(!by_uci("a1b1").zeroing);
    }

    #[test]
    fn wdl_mappings_follow_the_sign_convention() {
        assert_eq!(wdl_to_i8(Wdl::Loss), -2);
        assert_eq!(wdl_to_i8(Wdl::BlessedLoss), -1);
        assert_eq!(wdl_to_i8(Wdl::Draw), 0);
        assert_eq!(wdl_to_i8(Wdl::CursedWin), 1);
        assert_eq!(wdl_to_i8(Wdl::Win), 2);
        assert_eq!(ambiguous_to_i8(AmbiguousWdl::MaybeLoss), -1);
        assert_eq!(ambiguous_to_i8(AmbiguousWdl::MaybeWin), 1);
        assert_eq!(ambiguous_to_i8(AmbiguousWdl::Win), 2);
    }
}
