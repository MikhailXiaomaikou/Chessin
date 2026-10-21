//! End-to-end tests: write a database with the test encoder, read it back,
//! compare the PGN.

use crate::testenc::{packed_date, TestDb, TestGame};
use crate::{convert_to_pgn, read_database, Error};

fn b(s: &str) -> Vec<u8> {
    s.as_bytes().to_vec()
}

fn text(s: &str) -> Vec<u8> {
    let mut v = vec![0u8, 0u8];
    v.extend_from_slice(s.as_bytes());
    v
}

fn convert(db: &TestDb) -> (crate::CbhImportReport, String) {
    let dir = tempfile::tempdir().unwrap();
    let cbh = db.write(dir.path());
    let out = dir.path().join("out.pgn");
    let report = convert_to_pgn(&cbh, &out).unwrap();
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

#[test]
fn annotated_game_with_variations_round_trips() {
    let mut eval = Vec::new();
    eval.extend_from_slice(&35i16.to_le_bytes());
    eval.extend_from_slice(&0i16.to_le_bytes());
    eval.extend_from_slice(&22i16.to_le_bytes());
    let game = TestGame {
        white: (b("Carlsen"), b("Magnus")),
        black: (b("Nakamura"), b("Hikaru")),
        white_elo: 2830,
        black_elo: 2789,
        event: b("Norway Chess"),
        site: b("Stavanger"),
        event_date: packed_date(2024, 5, 27),
        round: 3,
        subround: 1,
        date: packed_date(2024, 5, 29),
        result: 2,
        eco: (112 + 1) * 128 + 3, // B12
        annotator: b("Annotator, A"),
        source: b("Chessin tests"),
        // stream order: e4 0, c5 1, Nf3 2, d6 3, d4 4, Nc6 5, Bb5 6, c6 7, d4 8, Nf6 9, e5 10
        moves: "e4 c5 ( c6 d4 ) ( Nf6 e5 ) Nf3 d6 ( Nc6 Bb5 ) d4".into(),
        annotations: vec![
            (-1, 0x02, text("Game-level note")),
            (-1, 0x16, 360_000i32.to_be_bytes().to_vec()),
            (-1, 0x22, vec![0, 0, 0, 1]),
            (0, 0x82, text("Before e4")),
            (0, 0x03, vec![1]),
            (0, 0x02, text("Best by test")),
            (0, 0x04, vec![2, 37, 4, 29]), // Ge5 Rd5 (1-based: e5 = 4*8+4+1 = 37, d5 = 3*8+4+1 = 29)
            (1, 0x05, vec![2, 36, 38]),    // e4 (36) -> e6 (38)
            (1, 0x21, eval),
            (2, 0x18, vec![1]),
            (3, 0x07, vec![0, 1, 30, 0]),
            (7, 0x02, text("Caro-Kann")),
            (9, 0x09, vec![1, 0, 1, 2, 0, 30, 0, 0, 0, 5, 0]),
            (10, 0x03, vec![0, 14]),
        ],
        ..TestGame::default()
    };
    let (report, pgn) = convert(&TestDb {
        games: vec![game],
        ..TestDb::default()
    });
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
         {Caro-Kann} 2. d4) (1... Nf6 {[%train AQABAgAeAAAABQA=]} 2. e5 $14) 2. Nf3\n\
         {[%crit opening]} 2... d6 {[%emt 0:01:30]} (2... Nc6 3. Bb5) 3. d4 1-0\n\n"
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
fn promotion_uses_the_two_byte_escape_and_pieces_renumber() {
    // After bxa8=Q white has a second queen, whose moves (Qxc8) use the
    // 2nd-queen block.
    let promotion = "e4 d5 exd5 c6 dxc6 Nf6 cxb7 Nbd7 bxa8=Q Nb6 Qxc8 Qxc8";
    // Nxd5 captures white's first knight, so the f3 knight becomes the first
    // knight and Nxd4 is written in the 1st-knight block; black's first knight
    // is captured in turn.
    let renumber = "e4 e5 Nf3 Nc6 Nc3 Nf6 Nd5 Nxd5 exd5 Nd4 Nxd4 exd4 Qh5 Qe7+ Be2 Qxe2+ Qxe2+ Be7";
    let games = vec![
        TestGame {
            moves: promotion.into(),
            ..TestGame::default()
        },
        TestGame {
            moves: renumber.into(),
            ..TestGame::default()
        },
    ];
    let db = TestDb {
        games,
        ..TestDb::default()
    };
    let dir = tempfile::tempdir().unwrap();
    let cbh = db.write(dir.path());
    // First record: 12 moves, one of them in three bytes, plus the end marker.
    let cbg = std::fs::read(cbh.with_extension("cbg")).unwrap();
    let size = u32::from_be_bytes([0, cbg[27], cbg[28], cbg[29]]);
    assert_eq!(size, 4 + 12 + 2 + 1);
    let mut db = read_database(&cbh).unwrap();
    for (id, expected) in [(1, promotion), (2, renumber)] {
        let game = db.read_game(id).unwrap();
        let sans: Vec<&str> = game.nodes[1..].iter().map(|n| n.san.as_str()).collect();
        assert_eq!(sans.join(" "), expected);
    }
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
    let (report, pgn) = convert(&TestDb {
        games: vec![game],
        ..TestDb::default()
    });
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
    let (_, pgn) = convert(&TestDb {
        games: vec![game],
        ..TestDb::default()
    });
    assert_eq!(movetext(&pgn), "30... Kd7 31. Qh7+ Kd6 *");
}

#[test]
fn names_in_windows_1252_and_utf8() {
    let games = vec![
        TestGame {
            white: (b("Lazard"), b"Fr\xe9d\xe9ric".to_vec()),
            black: ("丁立人".as_bytes().to_vec(), Vec::new()),
            event: b"M\xfcnchen Open".to_vec(),
            moves: "d4".into(),
            annotations: vec![
                (0, 0x02, text("Die Er\u{f6}ffnung")),
                (0, 0x82, {
                    let mut v = vec![0u8, 0u8];
                    v.extend_from_slice(b"caf\xe9");
                    v
                }),
            ],
            ..TestGame::default()
        },
        TestGame {
            white: (Vec::new(), Vec::new()),
            black: (b("Only"), b("First")),
            moves: String::new(),
            ..TestGame::default()
        },
    ];
    let (report, pgn) = convert(&TestDb {
        games,
        ..TestDb::default()
    });
    assert_eq!(report.encoding, "windows-1252 (with some utf-8)");
    assert!(pgn.contains("[White \"Lazard, Frédéric\"]"), "{pgn}");
    assert!(pgn.contains("[Black \"丁立人\"]"), "{pgn}");
    assert!(pgn.contains("[Event \"München Open\"]"), "{pgn}");
    assert!(pgn.contains("{café} 1. d4 {Die Eröffnung} *"), "{pgn}");
    assert!(
        pgn.contains("[White \"?\"]\n[Black \"Only, First\"]"),
        "{pgn}"
    );
    assert!(pgn.contains("[Event \"?\"]\n[Site \"?\"]\n[Date \"????.??.??\"]\n[Round \"?\"]"));
    assert_eq!(report.exported, 2);
}

#[test]
fn all_utf8_database_reports_utf8() {
    let game = TestGame {
        white: ("王皓".as_bytes().to_vec(), Vec::new()),
        black: ("Müller".as_bytes().to_vec(), b("Jörg")),
        moves: "e4".into(),
        ..TestGame::default()
    };
    let (report, pgn) = convert(&TestDb {
        games: vec![game],
        ..TestDb::default()
    });
    assert_eq!(report.encoding, "utf-8");
    assert!(
        pgn.contains("[White \"王皓\"]\n[Black \"Müller, Jörg\"]"),
        "{pgn}"
    );
}

#[test]
fn deleted_games_and_guiding_texts_are_skipped() {
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
            guiding_text: true,
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
    assert_eq!((report.games, report.exported, report.skipped), (4, 2, 2));
    assert_eq!(
        report.warnings,
        vec!["1 deleted game(s) skipped", "1 guiding text(s) skipped"]
    );
    assert_eq!(pgn.matches("[Event ").count(), 2);
    assert!(pgn.contains("1. e4 e5 0-1"));
    assert!(pgn.contains("[Result \"1-0\"]\n[Termination \"forfeit\"]"));
    let dir = tempfile::tempdir().unwrap();
    let cbh = TestDb {
        games: vec![
            TestGame::default(),
            TestGame {
                deleted: true,
                ..TestGame::default()
            },
            TestGame {
                guiding_text: true,
                ..TestGame::default()
            },
        ],
        ..TestDb::default()
    }
    .write(dir.path());
    let mut db = read_database(&cbh).unwrap();
    assert!(matches!(db.read_game(2), Err(Error::Deleted { id: 2 })));
    assert!(matches!(db.read_game(3), Err(Error::GuidingText { id: 3 })));
    assert!(matches!(db.read_game(4), Err(Error::Game { id: 4, .. })));
    assert!(matches!(db.read_game(0), Err(Error::Game { id: 0, .. })));
    assert_eq!(db.games().count(), 3);
}

#[test]
fn null_move_and_unfinished_line_evaluation() {
    let game = TestGame {
        moves: "e4 -- Nf3 Nc6".into(),
        result: 3,
        line_eval: 14,
        ..TestGame::default()
    };
    let (_, pgn) = convert(&TestDb {
        games: vec![game],
        ..TestDb::default()
    });
    assert_eq!(movetext(&pgn), "1. e4 -- 2. Nf3 Nc6 $14 *");
}

#[test]
fn simple_and_post_encoders_give_the_same_tree() {
    let moves = "e4 c5 ( c6 d4 ) ( Nf6 e5 ) Nf3 d6 ( Nc6 Bb5 ) d4 -- Qd3 h6";
    let expected = "1. e4 c5 (1... c6 2. d4) (1... Nf6 2. e5) 2. Nf3 d6 (2... Nc6 3. Bb5) 3. d4 -- 4. Qd3 h6 *";
    for mode in [0u8, 4, 5] {
        let game = TestGame {
            moves: moves.into(),
            mode,
            ..TestGame::default()
        };
        let (report, pgn) = convert(&TestDb {
            games: vec![game],
            ..TestDb::default()
        });
        assert_eq!(movetext(&pgn), expected, "mode {mode}");
        assert!(
            report.warnings.is_empty(),
            "mode {mode}: {:?}",
            report.warnings
        );
    }
}

#[test]
fn promotion_in_the_simple_encoder() {
    let game = TestGame {
        fen: Some("8/1P6/8/8/8/8/8/k6K w - - 0 1".into()),
        moves: "b8=N ( b8=R Ka2 ) Ka2".into(),
        mode: 5,
        ..TestGame::default()
    };
    let (_, pgn) = convert(&TestDb {
        games: vec![game],
        ..TestDb::default()
    });
    assert_eq!(movetext(&pgn), "1. b8=N (1. b8=R Ka2) 1... Ka2 *");
}

#[test]
fn unsupported_encoding_mode_is_skipped_with_a_warning() {
    let games = vec![
        TestGame {
            moves: "e4".into(),
            mode: 0,
            ..TestGame::default()
        },
        TestGame {
            moves: "e4".into(),
            mode: 0,
            ..TestGame::default()
        },
    ];
    let dir = tempfile::tempdir().unwrap();
    // Mode 1 has no table, so the encoder cannot write it; patch the flags
    // byte of the second game's record to mode 1 instead.
    let cbh = TestDb {
        games,
        ..TestDb::default()
    }
    .write(dir.path());
    let cbg_path = cbh.with_extension("cbg");
    let mut cbg = std::fs::read(&cbg_path).unwrap();
    // First record: 4 + 1 move + 1 end marker = 6 bytes after the 26-byte header.
    cbg[26 + 6] = 1;
    std::fs::write(&cbg_path, cbg).unwrap();
    let out = dir.path().join("out.pgn");
    let report = convert_to_pgn(&cbh, &out).unwrap();
    assert_eq!((report.exported, report.skipped), (1, 1));
    assert_eq!(report.warnings.len(), 1);
    assert!(report.warnings[0].starts_with("game 2 skipped: move encoding mode 1 is not supported"));
}

#[test]
fn chess960_castling_is_written_in_two_bytes() {
    let game = TestGame {
        fen: Some("rk2r3/pppppppp/8/8/8/8/PPPPPPPP/RK2R3 w KQkq - 0 1".into()),
        moves: "O-O O-O-O Kh1".into(),
        mode: 10,
        eco: 64576 + 100,
        ..TestGame::default()
    };
    let (report, pgn) = convert(&TestDb {
        games: vec![game],
        ..TestDb::default()
    });
    assert!(
        pgn.contains("[Variant \"Chess960\"]\n[SetUp \"1\"]\n[FEN \""),
        "{pgn}"
    );
    assert_eq!(movetext(&pgn), "1. O-O O-O-O 2. Kh1 *");
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
}

#[test]
fn entity_files_with_32_byte_headers_and_shared_entities() {
    let games = vec![
        TestGame {
            white: (b("Same"), b("Player")),
            black: (b("Other"), Vec::new()),
            event: b("Club"),
            moves: "e4".into(),
            ..TestGame::default()
        },
        TestGame {
            white: (b("Other"), Vec::new()),
            black: (b("Same"), b("Player")),
            event: b("Club"),
            moves: "d4".into(),
            ..TestGame::default()
        },
    ];
    let (report, pgn) = convert(&TestDb {
        games,
        extra_entity_header: true,
    });
    assert_eq!(report.exported, 2);
    assert!(pgn.contains("[White \"Same, Player\"]\n[Black \"Other\"]"));
    assert!(pgn.contains("[White \"Other\"]\n[Black \"Same, Player\"]"));
    assert_eq!(pgn.matches("[Event \"Club\"]").count(), 2);
}

#[test]
fn missing_optional_files_only_warn() {
    let dir = tempfile::tempdir().unwrap();
    let cbh = TestDb {
        games: vec![TestGame {
            moves: "e4".into(),
            annotations: vec![(0, 0x02, text("hi"))],
            ..TestGame::default()
        }],
        ..TestDb::default()
    }
    .write(dir.path());
    std::fs::remove_file(cbh.with_extension("cba")).unwrap();
    std::fs::remove_file(cbh.with_extension("cbs")).unwrap();
    let out = dir.path().join("out.pgn");
    let report = convert_to_pgn(&cbh, &out).unwrap();
    assert_eq!(report.exported, 1);
    assert_eq!(report.annotated, 0);
    assert_eq!(report.warnings.len(), 2, "{:?}", report.warnings);
    assert!(report.warnings[0].contains("annotations will be missing"));
    assert!(report.warnings[1].contains("sources will be blank"));
    let pgn = std::fs::read_to_string(&out).unwrap();
    assert_eq!(movetext(&pgn), "1. e4 *");
    // Without the moves file nothing can be read.
    std::fs::remove_file(cbh.with_extension("cbg")).unwrap();
    assert!(matches!(read_database(&cbh), Err(Error::Io { .. })));
}

#[test]
fn evaluation_list_and_time_control_on_the_game() {
    let mut evals = Vec::new();
    evals.extend_from_slice(&3u16.to_be_bytes());
    evals.extend_from_slice(&[0, 20, 0, 25]);
    evals.extend_from_slice(&[0, 20, 0, 30]);
    evals.extend_from_slice(&[0, 20, 0xff, 0xf0]); // -0.16
    let mut tc = Vec::new();
    for (initial, inc, moves, kind) in [
        (540_000i32, 3000i32, 40u16, 1u8),
        (180_000, 3000, 1000, 3),
        (0, 0, 1000, 5),
    ] {
        tc.extend_from_slice(&initial.to_be_bytes());
        tc.extend_from_slice(&inc.to_be_bytes());
        tc.extend_from_slice(&moves.to_be_bytes());
        tc.push(kind);
    }
    let game = TestGame {
        moves: "e4 e5 ( c5 )".into(),
        annotations: vec![(-1, 0x26, evals), (-1, 0x24, tc)],
        ..TestGame::default()
    };
    let (_, pgn) = convert(&TestDb {
        games: vec![game],
        ..TestDb::default()
    });
    assert!(
        pgn.contains("[TimeControl \"40/5400+30:1800+30\"]"),
        "{pgn}"
    );
    assert_eq!(
        movetext(&pgn),
        "1. e4 {[%eval 0.30]} 1... e5 {[%eval -0.16]} (1... c5) *"
    );
}
