//! End-to-end tests: write a database with the test encoder, read it back,
//! compare the PGN.

use super::annotations::testutil::{sized, text};
use super::testenc::{packed_date, Kind, TestDb, TestGame};
use super::{
    convert_2cbh_to_pgn, convert_database_to_pgn, detect_format, read_2cbh_database, DbFormat,
};
use crate::{CbhImportReport, Error};

fn s(v: &str) -> String {
    v.to_string()
}

fn convert(db: &TestDb) -> (CbhImportReport, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = db.write(dir.path());
    let out = dir.path().join("out.pgn");
    let report = convert_2cbh_to_pgn(&path, &out).unwrap();
    let pgn = std::fs::read_to_string(&out).unwrap();
    (report, pgn)
}

fn movetext(pgn: &str) -> String {
    pgn.split("\n\n")
        .nth(1)
        .unwrap_or("")
        .trim()
        .replace('\n', " ")
}

fn one(game: TestGame) -> TestDb {
    TestDb {
        games: vec![game],
        ..TestDb::default()
    }
}

#[test]
fn annotated_game_with_variations_round_trips() {
    let mut eval = Vec::new();
    eval.extend_from_slice(&35i16.to_le_bytes());
    eval.extend_from_slice(&0i16.to_le_bytes());
    eval.extend_from_slice(&22i16.to_le_bytes());
    let game = TestGame {
        white: (s("Carlsen"), s("Magnus")),
        black: (s("Nakamura"), s("Hikaru")),
        white_elo: 2830,
        black_elo: 2789,
        event: s("Norway Chess"),
        site: s("Stavanger"),
        event_date: packed_date(2024, 5, 27),
        round: 3,
        subround: 1,
        date: packed_date(2024, 5, 29),
        result: 2,
        eco: (112 + 1) * 128 + 3, // B12
        annotator: (s("Annotator"), s("A")),
        source: s("Chessin tests"),
        // PGN order: e4 0, c5 1, c6 2, d4 3, Nf6 4, e5 5, Nf3 6, d6 7, Nc6 8, Bb5 9, d4 10
        moves: "e4 c5 ( c6 d4 ) ( Nf6 e5 ) Nf3 d6 ( Nc6 Bb5 ) d4".into(),
        annotations: vec![
            (-1, 0x02, text("Game-level note")),
            (-1, 0x16, 360_000i32.to_le_bytes().to_vec()),
            (-1, 0x22, vec![0, 0, 0, 1]),
            (0, 0x82, text("Before e4")),
            (0, 0x03, vec![1, 0, 0]),
            (0, 0x02, text("Best by test")),
            (0, 0x04, sized(&[2, 37, 4, 29])), // Ge5 Rd5
            (1, 0x05, sized(&[2, 36, 38])),    // e4 -> e6
            (1, 0x21, eval),
            (2, 0x02, text("Caro-Kann")),
            (
                4,
                0x09,
                vec![
                    1, 1, 1, 0, 0, 0, 30, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                ],
            ),
            (5, 0x03, vec![0, 14, 0]),
            (6, 0x18, vec![1]),
            (7, 0x07, vec![0, 30, 1, 0]),
        ],
        ..TestGame::default()
    };
    let (report, pgn) = convert(&one(game));
    assert_eq!(
        pgn,
        "[Event \"Norway Chess\"]\n\
         [Site \"Stavanger\"]\n\
         [Date \"2024.05.29\"]\n\
         [Round \"3.1\"]\n\
         [White \"Carlsen, Magnus\"]\n\
         [Black \"Nakamura, Hikaru\"]\n\
         [Result \"1-0\"]\n\
         [WhiteElo \"2830\"]\n\
         [BlackElo \"2789\"]\n\
         [ECO \"B12\"]\n\
         [EventDate \"2024.05.27\"]\n\
         [Annotator \"Annotator, A\"]\n\
         [Source \"Chessin tests\"]\n\
         \n\
         {Game-level note [%clk 1:00:00]} {Before e4} 1. e4 $1\n\
         {Best by test [%csl Ge5,Rd5]} 1... c5 {[%cal Ge4e6] [%eval 0.35]} (1... c6\n\
         {Caro-Kann} 2. d4) (1... Nf6 {[%train AQEBAAAAHgAAAAUAAAAAAAAAAAAA]} 2. e5 $14)\n\
         2. Nf3 {[%crit opening]} 2... d6 {[%emt 0:01:30]} (2... Nc6 3. Bb5) 3. d4 1-0\n\n"
    );
    assert_eq!(report.games, 1);
    assert_eq!(report.exported, 1);
    assert_eq!(report.skipped, 0);
    assert_eq!(report.annotated, 1);
    assert_eq!(report.unsupported.len(), 1);
    assert_eq!(report.unsupported[0].kind, "medals (22)");
    assert_eq!(report.unsupported[0].count, 1);
    assert_eq!(report.encoding, "ascii");
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
}

#[test]
fn promotions_captures_en_passant_and_castling() {
    let promotion = "e4 d5 exd5 c6 dxc6 Nf6 cxb7 Nbd7 bxa8=Q Nb6 Qxc8 Qxc8";
    let en_passant = "e4 Nf6 e5 d5 exd6 exd6 Nf3 Be7 Bc4 O-O O-O Nc6";
    let underpromotion = "a4 b5 axb5 Nc6 b6 Rb8 bxa7 Nf6 axb8=N Nxb8";
    let games = vec![
        TestGame {
            moves: promotion.into(),
            ..TestGame::default()
        },
        TestGame {
            moves: en_passant.into(),
            ..TestGame::default()
        },
        TestGame {
            moves: underpromotion.into(),
            ..TestGame::default()
        },
    ];
    let db = TestDb {
        games,
        ..TestDb::default()
    };
    let dir = tempfile::tempdir().unwrap();
    let path = db.write(dir.path());
    let mut db = read_2cbh_database(&path).unwrap();
    assert!(db.warnings().is_empty(), "{:?}", db.warnings());
    for (id, expected) in [(1, promotion), (2, en_passant), (3, underpromotion)] {
        let game = db.read_game(id).unwrap();
        let sans: Vec<&str> = game.nodes[1..].iter().map(|n| n.san.as_str()).collect();
        assert_eq!(sans.join(" "), expected);
        assert!(game.warnings.is_empty(), "{:?}", game.warnings);
    }
    assert_eq!(db.games().count(), 3);
}

#[test]
fn setup_position_with_en_passant_and_castling() {
    let fen = "r3k2r/pp3ppp/8/2pP4/8/8/PP3PPP/R3K2R w KQkq c6 0 12";
    let game = TestGame {
        fen: Some(fen.into()),
        moves: "dxc6 O-O-O O-O Rd2".into(),
        result: 1,
        ..TestGame::default()
    };
    let (report, pgn) = convert(&one(game));
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    assert!(
        pgn.contains(
            "[SetUp \"1\"]\n[FEN \"r3k2r/pp3ppp/8/2pP4/8/8/PP3PPP/R3K2R w KQkq c6 0 12\"]\n"
        ),
        "{pgn}"
    );
    assert_eq!(movetext(&pgn), "12. dxc6 O-O-O 13. O-O Rd2 1/2-1/2");
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
}

#[test]
fn black_to_move_setup_numbers_moves_correctly() {
    let game = TestGame {
        fen: Some("4k3/8/8/8/8/8/4K3/7Q b - - 0 30".into()),
        moves: "Kd7 Qh7+ Kd6".into(),
        ..TestGame::default()
    };
    let (_, pgn) = convert(&one(game));
    assert_eq!(movetext(&pgn), "30... Kd7 31. Qh7+ Kd6 *");
}

#[test]
fn chess960_games_from_a_position_number_and_from_a_set_up() {
    // Position 100 is QBBNRNKR: the king on g1 castles with the h1 rook once
    // the f1 knight is out of the way.
    let game = TestGame {
        chess960: Some(100),
        moves: "e4 e5 Ng3 Ng6 O-O O-O".into(),
        ..TestGame::default()
    };
    let (report, pgn) = convert(&one(game));
    assert!(
        pgn.contains("[Variant \"Chess960\"]\n[SetUp \"1\"]\n[FEN \"qbbnrnkr/pppppppp/8/8/8/8/PPPPPPPP/QBBNRNKR w KQkq - 0 1\"]"),
        "{pgn}"
    );
    assert_eq!(movetext(&pgn), "1. e4 e5 2. Ng3 Ng6 3. O-O O-O *");
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    let dir = tempfile::tempdir().unwrap();
    let path = one(TestGame {
        chess960: Some(100),
        moves: "e4".into(),
        ..TestGame::default()
    })
    .write(dir.path());
    let game = read_2cbh_database(&path).unwrap().read_game(1).unwrap();
    assert_eq!(game.headers.chess960_position, Some(100));
    assert!(game.chess960);
    // A set-up position in a Chess960 game: the 1000 prefix.
    let game = TestGame {
        chess960: Some(100),
        fen: Some("rk2r3/pppppppp/8/8/8/8/PPPPPPPP/RK2R3 w KQkq - 0 1".into()),
        moves: "O-O O-O-O Kh1".into(),
        ..TestGame::default()
    };
    let (report, pgn) = convert(&one(game));
    assert!(
        pgn.contains("[Variant \"Chess960\"]\n[SetUp \"1\"]\n[FEN \""),
        "{pgn}"
    );
    assert_eq!(movetext(&pgn), "1. O-O O-O-O 2. Kh1 *");
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
}

#[test]
fn names_placeholders_teams_board_and_encoding() {
    let games = vec![
        TestGame {
            white: (s("Lazard"), s("Fr\u{e9}d\u{e9}ric")),
            black: (s("\u{4e01}\u{7acb}\u{4eba}"), String::new()),
            event: s("M\u{fc}nchen Open"),
            white_team: Some(s("Bayern")),
            black_team: Some(s("Shenzhen")),
            board: 3,
            moves: "d4".into(),
            annotations: vec![
                (0, 0x02, text("Die Er\u{f6}ffnung")),
                (0, 0x82, {
                    let mut v = vec![0u8, 0, 1, 0, 4, 0, 0, 0];
                    v.extend_from_slice(b"caf\xe9");
                    v
                }),
            ],
            ..TestGame::default()
        },
        TestGame {
            white: (String::new(), String::new()),
            black: (s("Only"), s("First")),
            moves: String::new(),
            ..TestGame::default()
        },
    ];
    let (report, pgn) = convert(&TestDb {
        games,
        deleted_player: true,
        ..TestDb::default()
    });
    assert_eq!(report.encoding, "utf-8");
    assert!(pgn.contains("[White \"Lazard, Frédéric\"]"), "{pgn}");
    assert!(pgn.contains("[Black \"丁立人\"]"), "{pgn}");
    assert!(pgn.contains("[Event \"München Open\"]"), "{pgn}");
    assert!(
        pgn.contains("[WhiteTeam \"Bayern\"]\n[BlackTeam \"Shenzhen\"]\n[Board \"3\"]"),
        "{pgn}"
    );
    assert!(pgn.contains("{café} 1. d4 {Die Eröffnung} *"), "{pgn}");
    assert!(
        pgn.contains("[White \"?\"]\n[Black \"Only, First\"]"),
        "{pgn}"
    );
    assert!(pgn.contains("[Event \"?\"]\n[Site \"?\"]\n[Date \"????.??.??\"]\n[Round \"?\"]"));
    assert!(!pgn.contains("[Annotator"));
    assert!(!pgn.contains("[Source"));
    assert_eq!(report.exported, 2);
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
}

#[test]
fn deleted_games_texts_and_analyses_are_skipped() {
    let games = vec![
        TestGame {
            moves: "e4 e5".into(),
            result: 0,
            ..TestGame::default()
        },
        TestGame {
            moves: "d4".into(),
            deleted: true,
            ..TestGame::default()
        },
        TestGame {
            kind: Kind::GuidingText,
            ..TestGame::default()
        },
        TestGame {
            kind: Kind::Analysis,
            moves: "c4 e5".into(),
            ..TestGame::default()
        },
        TestGame {
            moves: "c4".into(),
            result: 6,
            ..TestGame::default()
        },
    ];
    let (report, pgn) = convert(&TestDb {
        games,
        ..TestDb::default()
    });
    assert_eq!((report.games, report.exported, report.skipped), (5, 2, 3));
    assert_eq!(
        report.warnings,
        vec![
            "1 deleted game(s) skipped",
            "1 guiding text(s) skipped",
            "1 analysis record(s) skipped"
        ]
    );
    assert_eq!(pgn.matches("[Event ").count(), 2);
    assert!(pgn.contains("1. e4 e5 0-1"));
    assert!(pgn.contains("[Result \"1-0\"]\n[Termination \"forfeit\"]"));
    let dir = tempfile::tempdir().unwrap();
    let path = TestDb {
        games: vec![
            TestGame::default(),
            TestGame {
                deleted: true,
                ..TestGame::default()
            },
            TestGame {
                kind: Kind::GuidingText,
                ..TestGame::default()
            },
            TestGame {
                kind: Kind::Analysis,
                ..TestGame::default()
            },
        ],
        ..TestDb::default()
    }
    .write(dir.path());
    let mut db = read_2cbh_database(&path).unwrap();
    assert!(matches!(db.read_game(2), Err(Error::Deleted { id: 2 })));
    assert!(matches!(db.read_game(3), Err(Error::GuidingText { id: 3 })));
    assert!(matches!(db.read_game(4), Err(Error::Analysis { id: 4 })));
    assert!(matches!(db.read_game(5), Err(Error::Game { id: 5, .. })));
    assert!(matches!(db.read_game(0), Err(Error::Game { id: 0, .. })));
    assert_eq!(db.games().count(), 4);
    assert_eq!(
        db.entities().players.len(),
        3,
        "White, Black and the blank annotator"
    );
}

#[test]
fn null_move_and_unfinished_line_evaluation() {
    let game = TestGame {
        moves: "e4 -- Nf3 Nc6".into(),
        result: 3,
        line_eval: 14,
        ..TestGame::default()
    };
    let (_, pgn) = convert(&one(game));
    assert_eq!(movetext(&pgn), "1. e4 -- 2. Nf3 Nc6 $14 *");
}

#[test]
fn evaluation_list_and_time_control_on_the_game() {
    let mut evals = vec![1u8];
    evals.extend_from_slice(&14i32.to_le_bytes());
    evals.extend_from_slice(&3u16.to_le_bytes());
    evals.extend_from_slice(&[25, 0, 20, 0]);
    evals.extend_from_slice(&[30, 0, 20, 0]);
    evals.extend_from_slice(&[0xf0, 0xff, 20, 0]); // -0.16
    let mut tc = vec![1u8];
    for (initial, inc, moves, kind) in [
        (540_000i32, 3000i32, 40u16, 1u8),
        (180_000, 3000, 1000, 3),
        (0, 0, 0, 0),
    ] {
        tc.extend_from_slice(&initial.to_le_bytes());
        tc.extend_from_slice(&inc.to_le_bytes());
        tc.extend_from_slice(&moves.to_le_bytes());
        tc.push(kind);
    }
    tc.extend_from_slice(&[0; 4]);
    let game = TestGame {
        moves: "e4 e5 ( c5 )".into(),
        annotations: vec![(-1, 0x24, tc), (-1, 0x26, evals)],
        ..TestGame::default()
    };
    let (_, pgn) = convert(&one(game));
    assert!(
        pgn.contains("[TimeControl \"40/5400+30:1800+30\"]"),
        "{pgn}"
    );
    assert_eq!(
        movetext(&pgn),
        "1. e4 {[%eval 0.30]} 1... e5 {[%eval -0.16]} (1... c5) *"
    );
}

#[test]
fn damaged_records_are_skipped_with_a_warning_naming_the_offset() {
    let games = vec![
        TestGame {
            moves: "e4".into(),
            ..TestGame::default()
        },
        TestGame {
            moves: "d4".into(),
            ..TestGame::default()
        },
    ];
    let dir = tempfile::tempdir().unwrap();
    let path = TestDb {
        games,
        ..TestDb::default()
    }
    .write(dir.path());
    let cbg_path = path.with_extension("2cbg");
    let mut cbg = std::fs::read(&cbg_path).unwrap();
    // Game 1's record starts at 12; its content (fffc, e4, ffff) at 12 + 26.
    cbg[12 + 26 + 2] ^= 0x01;
    std::fs::write(&cbg_path, cbg).unwrap();
    let out = dir.path().join("out.pgn");
    let report = convert_2cbh_to_pgn(&path, &out).unwrap();
    assert_eq!((report.exported, report.skipped), (1, 1));
    assert_eq!(
        report.warnings,
        vec!["game 1 skipped: moves: record at offset 12: checksum mismatch (the record is damaged or the offset is wrong)"]
    );
    // A wrong offset lands on something that is not a record.
    let cbh_path = path.clone();
    let mut cbh = std::fs::read(&cbh_path).unwrap();
    cbh[2 * 192 + 0x08..2 * 192 + 0x10].copy_from_slice(&20i64.to_le_bytes());
    std::fs::write(&cbh_path, cbh).unwrap();
    let report = convert_2cbh_to_pgn(&path, &out).unwrap();
    assert_eq!((report.exported, report.skipped), (0, 2));
    assert!(
        report.warnings[1].starts_with("game 2 skipped: moves: record at offset 20: record does not begin with the magic number"),
        "{:?}",
        report.warnings
    );
}

#[test]
fn unknown_annotation_type_drops_the_rest_of_the_record() {
    let game = TestGame {
        moves: "e4 e5 Nf3".into(),
        annotations: vec![
            (0, 0x02, text("kept")),
            (1, 0x20, vec![1, 2, 3]),
            (2, 0x02, text("lost")),
        ],
        ..TestGame::default()
    };
    let (report, pgn) = convert(&one(game));
    assert_eq!(movetext(&pgn), "1. e4 {kept} 1... e5 2. Nf3 *");
    assert_eq!(report.annotated, 1);
    assert_eq!(
        report.warnings,
        vec!["game 1: annotation type 0x20 at position 1 has no known size; the game's later annotations were dropped"]
    );
    // An annotation past the last move is counted, as in CBH.
    let game = TestGame {
        moves: "e4".into(),
        annotations: vec![(0, 0x02, text("ok")), (5, 0x02, text("where?"))],
        ..TestGame::default()
    };
    let (report, pgn) = convert(&one(game));
    assert_eq!(movetext(&pgn), "1. e4 {ok} *");
    assert_eq!(
        report.warnings,
        vec!["game 1: 1 annotation(s) point past the last move"]
    );
}

#[test]
fn missing_optional_files_only_warn() {
    let dir = tempfile::tempdir().unwrap();
    let path = one(TestGame {
        white: (s("Someone"), String::new()),
        moves: "e4".into(),
        annotations: vec![(0, 0x02, text("hi"))],
        ..TestGame::default()
    })
    .write(dir.path());
    std::fs::remove_file(path.with_extension("2cba")).unwrap();
    std::fs::remove_file(path.with_extension("2lid")).unwrap();
    let out = dir.path().join("out.pgn");
    let report = convert_2cbh_to_pgn(&path, &out).unwrap();
    assert_eq!(report.exported, 1);
    assert_eq!(report.annotated, 0);
    assert_eq!(report.warnings.len(), 2, "{:?}", report.warnings);
    assert!(report.warnings[0].contains("annotations will be missing"));
    assert!(report.warnings[1].contains("players, events and sources will be blank"));
    let pgn = std::fs::read_to_string(&out).unwrap();
    assert!(pgn.contains("[White \"?\"]\n[Black \"?\"]"), "{pgn}");
    assert_eq!(movetext(&pgn), "1. e4 *");
    // A truncated stream header is reported, and a shortened entity file too.
    let cbg_path = path.with_extension("2cbg");
    let cbg = std::fs::read(&cbg_path).unwrap();
    std::fs::write(&cbg_path, &cbg[..cbg.len() - 1]).unwrap();
    let report = convert_2cbh_to_pgn(&path, &out).unwrap();
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.contains("the header says") && w.contains("but the file holds")),
        "{:?}",
        report.warnings
    );
    // Without the moves file nothing can be read.
    std::fs::remove_file(&cbg_path).unwrap();
    assert!(matches!(read_2cbh_database(&path), Err(Error::Io { .. })));
    // A header that is not a 2CBH header is a format error.
    std::fs::write(&path, [0u8; 300]).unwrap();
    assert!(matches!(
        read_2cbh_database(&path),
        Err(Error::Format { .. })
    ));
    std::fs::write(&path, [0u8; 10]).unwrap();
    assert!(matches!(
        read_2cbh_database(&path),
        Err(Error::Format { .. })
    ));
}

#[test]
fn non_standard_container_sizes_come_from_the_header() {
    let (report, pgn) = convert(&TestDb {
        games: vec![TestGame {
            white: (s("Ding"), s("Liren")),
            event: s("Candidates"),
            source: s("TWIC"),
            moves: "e4".into(),
            ..TestGame::default()
        }],
        containers: [200, 300, 100, 16, 80, 40],
        ..TestDb::default()
    });
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    assert!(pgn.contains("[White \"Ding, Liren\"]"), "{pgn}");
    assert!(pgn.contains("[Event \"Candidates\"]"), "{pgn}");
    assert!(pgn.contains("[Source \"TWIC\"]"), "{pgn}");
}

#[test]
fn header_count_mismatch_and_empty_database() {
    let (report, pgn) = convert(&TestDb::default());
    assert_eq!((report.games, report.exported), (0, 0));
    assert_eq!(pgn, "");
    let dir = tempfile::tempdir().unwrap();
    let path = one(TestGame {
        moves: "e4".into(),
        ..TestGame::default()
    })
    .write(dir.path());
    let mut cbh = std::fs::read(&path).unwrap();
    cbh[0x10..0x14].copy_from_slice(&9u32.to_le_bytes());
    std::fs::write(&path, cbh).unwrap();
    let db = read_2cbh_database(&path).unwrap();
    assert_eq!(db.game_count(), 1);
    assert_eq!(
        db.warnings(),
        ["the .2cbh header announces 8 games but the file holds 1 records"]
    );
}

#[test]
fn detect_format_sniffs_headers_then_extensions() {
    let dir = tempfile::tempdir().unwrap();
    let v2 = one(TestGame {
        moves: "e4 e5".into(),
        ..TestGame::default()
    })
    .write(dir.path());
    assert_eq!(detect_format(&v2).unwrap(), DbFormat::TwoCbh);
    let v1 = crate::testenc::TestDb {
        games: vec![crate::testenc::TestGame {
            moves: "d4 d5".into(),
            ..crate::testenc::TestGame::default()
        }],
        ..crate::testenc::TestDb::default()
    }
    .write(dir.path());
    assert_eq!(detect_format(&v1).unwrap(), DbFormat::Cbh);
    // The same bytes under the other extension: the header wins.
    let renamed = dir.path().join("renamed.2cbh");
    std::fs::copy(&v1, &renamed).unwrap();
    assert_eq!(detect_format(&renamed).unwrap(), DbFormat::Cbh);
    // Unreadable headers fall back to the extension.
    let junk2 = dir.path().join("junk.2CBH");
    std::fs::write(&junk2, [7u8; 20]).unwrap();
    assert_eq!(detect_format(&junk2).unwrap(), DbFormat::TwoCbh);
    let junk1 = dir.path().join("junk.cbh");
    std::fs::write(&junk1, [7u8; 20]).unwrap();
    assert_eq!(detect_format(&junk1).unwrap(), DbFormat::Cbh);
    let junk = dir.path().join("junk.txt");
    std::fs::write(&junk, [7u8; 20]).unwrap();
    assert!(matches!(detect_format(&junk), Err(Error::Format { .. })));
    assert!(matches!(
        detect_format(dir.path().join("missing.2cbh")),
        Err(Error::Io { .. })
    ));
    assert_eq!(DbFormat::Cbh.as_str(), "cbh");
    assert_eq!(DbFormat::TwoCbh.as_str(), "2cbh");
    // The dispatching converter reads both.
    let out = dir.path().join("out.pgn");
    let report = convert_database_to_pgn(&v2, &out).unwrap();
    assert_eq!(report.exported, 1);
    assert_eq!(
        movetext(&std::fs::read_to_string(&out).unwrap()),
        "1. e4 e5 *"
    );
    let report = convert_database_to_pgn(&v1, &out).unwrap();
    assert_eq!(report.exported, 1);
    assert_eq!(
        movetext(&std::fs::read_to_string(&out).unwrap()),
        "1. d4 d5 *"
    );
    assert!(matches!(
        convert_database_to_pgn(&junk, &out),
        Err(Error::Format { .. })
    ));
}

/// Converts a real 2CBH database named by `CHESSIN_CB_2CBH_SAMPLE` and
/// requires every game to decode. Run with `--ignored`.
#[test]
#[ignore]
fn real_sample_database_converts_without_game_failures() {
    let Ok(sample) = std::env::var("CHESSIN_CB_2CBH_SAMPLE") else {
        eprintln!("CHESSIN_CB_2CBH_SAMPLE is not set");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("sample.pgn");
    let report = convert_2cbh_to_pgn(&sample, &out).unwrap();
    eprintln!("{report:#?}");
    assert!(report.exported > 0);
    let failures: Vec<&String> = report
        .warnings
        .iter()
        .filter(|w| w.contains("skipped:"))
        .collect();
    assert!(failures.is_empty(), "{failures:#?}");
    if let Ok(keep) = std::env::var("CHESSIN_CB_PGN_OUT") {
        std::fs::copy(&out, keep).unwrap();
    }
}

/// Compares a real 2CBH database (`CHESSIN_CB_2CBH_SAMPLE`) with its CBH twin
/// (`CHESSIN_CB_CBH_TWIN`, the same games under the same ids) move by move.
#[test]
#[ignore]
fn real_sample_matches_its_cbh_twin() {
    let (Ok(sample), Ok(twin)) = (
        std::env::var("CHESSIN_CB_2CBH_SAMPLE"),
        std::env::var("CHESSIN_CB_CBH_TWIN"),
    ) else {
        eprintln!("CHESSIN_CB_2CBH_SAMPLE or CHESSIN_CB_CBH_TWIN is not set");
        return;
    };
    let mut v2 = read_2cbh_database(&sample).unwrap();
    let mut v1 = crate::read_database(&twin).unwrap();
    assert_eq!(v2.game_count(), v1.game_count());
    let mut compared = 0;
    let mut moves = Vec::new();
    let mut headers = Vec::new();
    let mut movetexts = Vec::new();
    for id in 1..=v1.game_count() {
        let (Ok(a), Ok(b)) = (v2.read_game(id), v1.read_game(id)) else {
            continue;
        };
        compared += 1;
        let sans = |g: &crate::Game| {
            g.nodes[1..]
                .iter()
                .map(|n| n.san.clone())
                .collect::<Vec<_>>()
        };
        let (sa, sb) = (sans(&a), sans(&b));
        if sa != sb {
            let i = sa
                .iter()
                .zip(&sb)
                .position(|(x, y)| x != y)
                .unwrap_or(sa.len().min(sb.len()));
            moves.push(format!(
                "game {id}: move {i}: 2cbh {:?} ({} plies) vs cbh {:?} ({} plies)",
                sa.get(i),
                sa.len(),
                sb.get(i),
                sb.len()
            ));
            continue;
        }
        if a.headers != b.headers {
            let (ha, hb) = (format!("{:?}", a.headers), format!("{:?}", b.headers));
            let fields: Vec<String> = ha
                .split(", ")
                .zip(hb.split(", "))
                .filter(|(x, y)| x != y)
                .map(|(x, y)| format!("{x} | {y}"))
                .collect();
            headers.push(format!("game {id}: {}", fields.join("; ")));
        }
        let ma = crate::pgn::movetext(&a);
        let mb = crate::pgn::movetext(&b);
        if ma != mb {
            let la: Vec<&str> = ma.split_whitespace().collect();
            let lb: Vec<&str> = mb.split_whitespace().collect();
            let i = la
                .iter()
                .zip(&lb)
                .position(|(x, y)| x != y)
                .unwrap_or(la.len().min(lb.len()));
            let lo = i.saturating_sub(3);
            movetexts.push(format!(
                "game {id}: token {i}: 2cbh {:?} vs cbh {:?}",
                la[lo..(i + 4).min(la.len())].join(" "),
                lb[lo..(i + 4).min(lb.len())].join(" ")
            ));
        }
    }
    eprintln!(
        "compared {compared} games: {} with different moves, {} with different headers, {} with different movetext",
        moves.len(),
        headers.len(),
        movetexts.len()
    );
    for d in moves
        .iter()
        .take(20)
        .chain(headers.iter().take(8))
        .chain(movetexts.iter().take(40))
    {
        eprintln!("{d}");
    }
    assert!(compared > 0);
    assert!(moves.is_empty());
}
