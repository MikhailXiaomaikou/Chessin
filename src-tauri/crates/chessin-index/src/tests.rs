//! End-to-end tests on a synthetic `.db3` with the app's schema, checked
//! against a brute-force reference computed from the generator's own
//! positions (not from decoding the blobs again).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use rusqlite::Connection;
use shakmaty::{fen::Fen, Chess, EnPassantMode, Position};

use crate::build::pawn_home;
use crate::hash::{pawn_hash, position_hash, BLOOM_PLIES};
use crate::moves::rng::{random_game, Rng};
use crate::moves::{
    encode_move, COMMENT_MARKER, NAG_MARKER, VARIATION_END_MARKER, VARIATION_START_MARKER,
};
use crate::{
    build, sidecar_path, update, BuildOptions, Error, Filter, GameMeta, GameResult, Index,
    MoveStats, Order, Posting, MAX_SEGMENTS, NO_MOVE,
};

/// `src-tauri/src/db/create.sql`, verbatim.
const SCHEMA: &str = r#"
CREATE TABLE Info (
    Name TEXT UNIQUE NOT NULL,
    Value TEXT
);

CREATE TABLE Events (
    ID INTEGER PRIMARY KEY AUTOINCREMENT,
    Name TEXT UNIQUE
);

CREATE TABLE Sites (
    ID INTEGER PRIMARY KEY AUTOINCREMENT,
    Name TEXT UNIQUE
);

CREATE TABLE Players (
    ID INTEGER PRIMARY KEY,
    Name TEXT UNIQUE,
    Elo INTEGER
);

CREATE TABLE Games (
    ID INTEGER PRIMARY KEY AUTOINCREMENT,
    EventID INTEGER,
    SiteID INTEGER,
    Date TEXT,
    UTCTime TEXT,
    Round INTEGER,
    WhiteID INTEGER,
    WhiteElo INTEGER,
    BlackID INTEGER,
    BlackElo INTEGER,
    WhiteMaterial INTEGER,
    BlackMaterial INTEGER,
    Result INTEGER,
    TimeControl TEXT,
    ECO TEXT,
    PlyCount INTEGER,
    FEN TEXT,
    Moves BLOB,
    PawnHome BLOB,
    FOREIGN KEY(EventID) REFERENCES Events,
    FOREIGN KEY(SiteID) REFERENCES Sites,
    FOREIGN KEY(WhiteID) REFERENCES Players,
    FOREIGN KEY(BlackID) REFERENCES Players
);

INSERT INTO Players (ID, Name, Elo) VALUES (0, 'Unknown', NULL);
INSERT INTO Events (ID, Name) VALUES (0, 'Unknown');
INSERT INTO Sites (ID, Name) VALUES (0, 'Unknown');
"#;

/// A generated game: what goes into the database and what the index must
/// say about it.
pub(crate) struct SynthGame {
    id: u32,
    fen: Option<String>,
    /// The `Moves` blob, decorated with variations, comments and NAGs.
    blob: Vec<u8>,
    /// The clean main-line codes.
    codes: Vec<u8>,
    /// `positions[p]` is the position after `p` plies.
    positions: Vec<Chess>,
    /// The blob has a code that does not decode: the index must skip it.
    broken: bool,
    result: Option<&'static str>,
    white_elo: Option<i64>,
    black_elo: Option<i64>,
    date: Option<String>,
}

impl SynthGame {
    fn meta(&self) -> GameMeta {
        GameMeta {
            result: GameResult::from_pgn(self.result),
            white_elo: self.white_elo.unwrap_or(0) as u16,
            black_elo: self.black_elo.unwrap_or(0) as u16,
            year: self
                .date
                .as_deref()
                .and_then(|d| d.get(..4)?.parse().ok())
                .unwrap_or(0),
        }
    }

    fn postings(&self, max_ply: u16) -> Vec<Posting> {
        self.positions
            .iter()
            .take(usize::from(max_ply) + 1)
            .enumerate()
            .map(|(ply, pos)| Posting {
                hash: position_hash(pos),
                game_id: self.id,
                ply: ply as u16,
                next_move: self.codes.get(ply).copied().unwrap_or(NO_MOVE),
            })
            .collect()
    }

    fn pawn_hashes(&self) -> Vec<u64> {
        BLOOM_PLIES
            .iter()
            .filter_map(|ply| self.positions.get(usize::from(*ply)))
            .map(|pos| pawn_hash(pos.board()))
            .collect()
    }
}

fn decorate(rng: &mut Rng, codes: &[u8]) -> Vec<u8> {
    let mut blob = Vec::new();
    for code in codes {
        blob.push(*code);
        match rng.below(20) {
            0..=2 => {
                let len = rng.below(12);
                blob.push(COMMENT_MARKER);
                blob.extend_from_slice(&(len as u16).to_le_bytes());
                blob.extend((0..len).map(|_| b'a' + rng.below(26) as u8));
            }
            3 => {
                blob.push(NAG_MARKER);
                blob.extend_from_slice(&2u16.to_le_bytes());
                blob.extend_from_slice(b"$1");
            }
            4..=5 => {
                blob.push(VARIATION_START_MARKER);
                for _ in 0..rng.below(6) {
                    blob.push(rng.below(252) as u8);
                }
                if rng.below(3) == 0 {
                    blob.push(VARIATION_START_MARKER);
                    blob.push(rng.below(252) as u8);
                    blob.push(VARIATION_END_MARKER);
                }
                blob.push(VARIATION_END_MARKER);
            }
            _ => {}
        }
    }
    blob
}

pub(crate) fn random_games(rng: &mut Rng, ids: impl IntoIterator<Item = u32>) -> Vec<SynthGame> {
    ids.into_iter()
        .map(|id| {
            let kind = rng.below(100);
            let (fen, start) = if kind < 10 {
                let pre_plies = 6 + rng.below(15);
                let pre = random_game(rng, &Chess::default(), pre_plies);
                let mut pos = Chess::default();
                for (_, m) in &pre {
                    pos.play_unchecked(m);
                }
                let fen = Fen::from_setup(pos.clone().into_setup(EnPassantMode::Legal)).to_string();
                (Some(fen), pos)
            } else {
                (None, Chess::default())
            };
            let game_plies = rng.below(90);
            let plies = random_game(rng, &start, game_plies);
            let mut positions = vec![start.clone()];
            let mut codes = Vec::with_capacity(plies.len());
            for (pos, m) in &plies {
                codes.push(encode_move(m, pos).unwrap());
                let mut next = pos.clone();
                next.play_unchecked(m);
                positions.push(next);
            }
            let broken = kind >= 95 && !codes.is_empty();
            let mut blob_codes = codes.clone();
            if broken {
                let k = rng.below(codes.len());
                blob_codes[k] = plies[k].0.legal_moves().len() as u8;
            }
            SynthGame {
                id,
                fen,
                blob: decorate(rng, &blob_codes),
                codes,
                positions,
                broken,
                result: match rng.below(6) {
                    0 | 5 => Some("1-0"),
                    1 => Some("0-1"),
                    2 => Some("1/2-1/2"),
                    3 => Some("*"),
                    _ => None,
                },
                white_elo: (rng.below(10) < 7).then(|| 1000 + rng.below(1900) as i64),
                black_elo: (rng.below(10) < 7).then(|| 1000 + rng.below(1900) as i64),
                date: match rng.below(10) {
                    0..=6 => Some(format!(
                        "{}.{:02}.{:02}",
                        1950 + rng.below(75),
                        1 + rng.below(12),
                        1 + rng.below(28)
                    )),
                    7 => Some("????.??.??".to_string()),
                    _ => None,
                },
            }
        })
        .collect()
}

/// A game that repeats its start position (1. Nf3 Nf6 2. Ng1 Ng8 3. e4).
fn repetition_game(id: u32) -> SynthGame {
    let ucis = ["g1f3", "g8f6", "f3g1", "f6g8", "e2e4"];
    let mut pos = Chess::default();
    let mut positions = vec![pos.clone()];
    let mut codes = Vec::new();
    for uci in ucis {
        let m = uci
            .parse::<shakmaty::uci::UciMove>()
            .unwrap()
            .to_move(&pos)
            .unwrap();
        codes.push(encode_move(&m, &pos).unwrap());
        pos.play_unchecked(&m);
        positions.push(pos.clone());
    }
    SynthGame {
        id,
        fen: None,
        blob: codes.clone(),
        codes,
        positions,
        broken: false,
        result: Some("1/2-1/2"),
        white_elo: Some(2800),
        black_elo: Some(2790),
        date: Some("2024.01.01".into()),
    }
}

pub(crate) fn create_db(path: &Path) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
}

pub(crate) fn insert_games(path: &Path, games: &[SynthGame]) {
    let mut conn = Connection::open(path).unwrap();
    let tx = conn.transaction().unwrap();
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO Games (ID, EventID, SiteID, Date, Round, WhiteID, WhiteElo, BlackID, \
                 BlackElo, WhiteMaterial, BlackMaterial, Result, PlyCount, FEN, Moves, PawnHome) \
                 VALUES (?1, 0, 0, ?2, 1, 0, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )
            .unwrap();
        for g in games {
            let board = g.positions.last().unwrap().board();
            let material = board.material();
            let weighted = |m: shakmaty::ByRole<u8>| -> i64 {
                i64::from(m.pawn)
                    + 3 * i64::from(m.knight + m.bishop)
                    + 5 * i64::from(m.rook)
                    + 9 * i64::from(m.queen)
            };
            stmt.execute(rusqlite::params![
                i64::from(g.id),
                g.date,
                g.white_elo,
                g.black_elo,
                weighted(material.white),
                weighted(material.black),
                g.result,
                g.codes.len() as i64,
                g.fen,
                g.blob,
                i64::from(pawn_home(board)),
            ])
            .unwrap();
        }
    }
    tx.commit().unwrap();
}

fn no_cancel() -> AtomicBool {
    AtomicBool::new(false)
}

fn opts(max_ply: u16) -> BuildOptions<fn(u64, u64)> {
    BuildOptions::new(max_ply)
}

/// The reference "tree" of a position: first occurrence per game, filtered.
fn ref_tree(games: &[SynthGame], max_ply: u16, hash: u64, filter: &Filter) -> Vec<MoveStats> {
    let mut acc: BTreeMap<u8, MoveStats> = BTreeMap::new();
    for g in games.iter().filter(|g| !g.broken) {
        let meta = g.meta();
        if !filter.accepts(&meta) {
            continue;
        }
        let Some(p) = g.postings(max_ply).into_iter().find(|p| p.hash == hash) else {
            continue;
        };
        let s = acc.entry(p.next_move).or_insert_with(|| MoveStats {
            move_code: p.next_move,
            ..MoveStats::default()
        });
        s.games += 1;
        match meta.result {
            GameResult::WhiteWin => s.white += 1,
            GameResult::BlackWin => s.black += 1,
            _ => s.draw += 1,
        }
        let known: Vec<u64> = [meta.white_elo, meta.black_elo]
            .into_iter()
            .filter(|e| *e > 0)
            .map(u64::from)
            .collect();
        if !known.is_empty() {
            s.elo_sum += known.iter().sum::<u64>() / known.len() as u64;
            s.elo_games += 1;
        }
        s.last_year = s.last_year.max(meta.year);
    }
    let mut out: Vec<MoveStats> = acc.into_values().collect();
    out.sort_by(|a, b| b.games.cmp(&a.games).then(a.move_code.cmp(&b.move_code)));
    out
}

fn ref_samples(
    games: &[SynthGame],
    max_ply: u16,
    hash: u64,
    filter: &Filter,
    limit: usize,
    order: Order,
) -> Vec<Posting> {
    let mut rows: Vec<(u32, u32, Posting)> = games
        .iter()
        .filter(|g| !g.broken && filter.accepts(&g.meta()))
        .filter_map(|g| {
            let p = g.postings(max_ply).into_iter().find(|p| p.hash == hash)?;
            let meta = g.meta();
            let key = match order {
                Order::ByElo => u32::from(meta.white_elo.max(meta.black_elo)),
                Order::ByYear => u32::from(meta.year),
            };
            Some((key, g.id, p))
        })
        .collect();
    rows.sort_by_key(|r| std::cmp::Reverse((r.0, r.1)));
    rows.into_iter().take(limit).map(|(_, _, p)| p).collect()
}

fn all_postings(games: &[SynthGame], max_ply: u16) -> BTreeMap<u64, Vec<Posting>> {
    let mut by_hash: BTreeMap<u64, Vec<Posting>> = BTreeMap::new();
    for g in games.iter().filter(|g| !g.broken) {
        for p in g.postings(max_ply) {
            by_hash.entry(p.hash).or_default().push(p);
        }
    }
    for v in by_hash.values_mut() {
        v.sort();
    }
    by_hash
}

fn assert_index_matches(index: &Index, games: &[SynthGame], max_ply: u16) {
    let by_hash = all_postings(games, max_ply);
    assert_eq!(
        index.status().postings,
        by_hash.values().map(|v| v.len() as u64).sum::<u64>()
    );
    for (hash, expect) in &by_hash {
        assert_eq!(
            &index.lookup(*hash).collect::<Vec<_>>(),
            expect,
            "hash {hash:#x}"
        );
    }
    for g in games {
        let got = index.meta(g.id);
        if g.broken {
            assert_eq!(got, None, "broken game {} must be skipped", g.id);
        } else {
            assert_eq!(got, Some(g.meta()), "game {}", g.id);
        }
    }
}

fn filters() -> Vec<Filter> {
    vec![
        Filter::default(),
        Filter {
            min_elo: Some(2000),
            ..Filter::default()
        },
        Filter {
            max_elo: Some(2200),
            ..Filter::default()
        },
        Filter {
            min_elo: Some(1500),
            max_elo: Some(2600),
            result: Some(GameResult::WhiteWin),
            ..Filter::default()
        },
        Filter {
            year_from: Some(1990),
            year_to: Some(2010),
            ..Filter::default()
        },
        Filter {
            result: Some(GameResult::Draw),
            year_to: Some(2000),
            ..Filter::default()
        },
    ]
}

struct Fixture {
    _dir: tempfile::TempDir,
    db: PathBuf,
}

fn fixture(name: &str) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join(format!("{name}.db3"));
    create_db(&db);
    Fixture { _dir: dir, db }
}

fn scratch_files(db: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(db.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".cpi"))
        .collect();
    names.sort();
    names
}

#[test]
fn build_on_a_synthetic_database_matches_brute_force() {
    let f = fixture("games");
    let mut rng = Rng(2024);
    // 200 games with a gap in the ids, plus a game that repeats a position.
    let mut games = random_games(&mut rng, (1..=120).chain(131..=210));
    games.push(repetition_game(211));
    insert_games(&f.db, &games);
    let broken = games.iter().filter(|g| g.broken).count() as u32;
    assert!(
        broken > 0,
        "the generator must produce some undecodable games"
    );
    assert!(games.iter().any(|g| g.fen.is_some()));

    let stats = build(&f.db, opts(40), &no_cancel()).unwrap();
    assert_eq!(stats.games, games.len() as u32 - broken);
    assert_eq!(stats.skipped, broken);
    assert_eq!(stats.max_game_id, 211);
    assert_eq!(stats.segments, 1);
    assert_eq!(stats.max_ply, 40);
    assert_eq!(
        stats.bytes,
        std::fs::metadata(sidecar_path(&f.db)).unwrap().len()
    );
    assert!(stats.built_at > 1_700_000_000);
    assert_eq!(scratch_files(&f.db), vec!["games.db3.cpi".to_string()]);

    let index = Index::open(&f.db).unwrap();
    assert_eq!(index.status(), stats);
    assert_index_matches(&index, &games, 40);
    for _ in 0..20 {
        assert!(index.lookup(rng.next_u64()).next().is_none());
    }
    assert_eq!(index.meta(125), None, "an id in the gap");
    assert_eq!(index.meta(0), None);
    assert_eq!(index.meta(999), None);

    // Signatures.
    for g in games.iter().filter(|g| !g.broken) {
        let sig = index.signature(g.id).unwrap();
        let board = g.positions.last().unwrap().board();
        let m = board.material();
        assert_eq!(
            sig.pieces[0],
            [
                m.white.pawn,
                m.white.knight,
                m.white.bishop,
                m.white.rook,
                m.white.queen,
                m.white.king
            ]
        );
        assert_eq!(
            sig.pieces[1],
            [
                m.black.pawn,
                m.black.knight,
                m.black.bishop,
                m.black.rook,
                m.black.queen,
                m.black.king
            ]
        );
        assert_eq!(sig.pawn_home, pawn_home(board));
        assert_eq!(usize::from(sig.final_ply), g.codes.len());
        for h in g.pawn_hashes() {
            assert!(sig.bloom.may_contain(h));
            assert!(index.pawn_candidates(h).any(|id| id == g.id));
        }
        if g.codes.len() < 10 {
            assert!(sig.bloom.is_empty());
        }
    }
    assert!(index.signature(125).is_none());
    let start_pawns = pawn_hash(Chess::default().board());
    let candidates: Vec<u32> = index.pawn_candidates(start_pawns).collect();
    let expect: Vec<u32> = games
        .iter()
        .filter(|g| !g.broken && g.pawn_hashes().contains(&start_pawns))
        .map(|g| g.id)
        .collect();
    assert!(expect.iter().all(|id| candidates.contains(id)));
    assert!(candidates.windows(2).all(|w| w[0] < w[1]), "ascending ids");

    // Trees, counts and samples against the reference, on the most shared
    // positions and on some rare ones.
    let by_hash = all_postings(&games, 40);
    let mut hashes: Vec<(usize, u64)> = by_hash.iter().map(|(h, v)| (v.len(), *h)).collect();
    hashes.sort_by(|a, b| b.cmp(a));
    let probe: Vec<u64> = hashes
        .iter()
        .take(40)
        .chain(hashes.iter().rev().take(10))
        .map(|(_, h)| *h)
        .collect();
    for hash in probe {
        for filter in filters() {
            let expect = ref_tree(&games, 40, hash, &filter);
            assert_eq!(
                index.tree(hash, &filter),
                expect,
                "tree {hash:#x} {filter:?}"
            );
            assert_eq!(
                index.count(hash, &filter),
                expect.iter().map(|s| s.games).sum::<u32>()
            );
            for order in [Order::ByElo, Order::ByYear] {
                for limit in [0, 1, 5, 1000] {
                    assert_eq!(
                        index.sample_games(hash, &filter, limit, order),
                        ref_samples(&games, 40, hash, &filter, limit, order),
                        "samples {hash:#x} {filter:?} {order:?} {limit}"
                    );
                }
            }
        }
    }

    // The repetition game is listed twice for the start position (ply 0 and
    // 4) but counted once, with the move from the first occurrence.
    let start = position_hash(&Chess::default());
    let plies: Vec<u16> = index
        .lookup(start)
        .filter(|p| p.game_id == 211)
        .map(|p| p.ply)
        .collect();
    assert_eq!(plies, vec![0, 4]);
    let only_211 = Filter {
        min_elo: Some(2790),
        ..Filter::default()
    };
    let tree = index.tree(start, &only_211);
    assert_eq!(tree.len(), 1);
    assert_eq!(
        (tree[0].games, tree[0].move_code),
        (1, games.last().unwrap().codes[0])
    );
    assert_eq!(tree[0].avg_elo(), 2795);
    assert_eq!(
        index.sample_games(start, &only_211, 10, Order::ByElo).len(),
        1
    );
}

#[test]
fn update_appends_segments_and_merges_them() {
    let f = fixture("inc");
    let fresh = fixture("fresh");
    let mut rng = Rng(77);
    let mut games = random_games(&mut rng, 1..=120);
    insert_games(&f.db, &games);
    let first = build(&f.db, opts(40), &no_cancel()).unwrap();
    assert_eq!(first.segments, 1);

    // Nothing new: the index is returned as is.
    assert_eq!(update(&f.db, opts(40), &no_cancel()).unwrap(), first);

    let mut rounds = 0;
    let mut expect_segments = 1usize;
    for (lo, hi) in [(121, 170), (171, 180), (185, 190), (191, 200), (201, 230)] {
        let more = random_games(&mut rng, lo..=hi);
        insert_games(&f.db, &more);
        games.extend(more);
        let stats = update(&f.db, opts(40), &no_cancel()).unwrap();
        rounds += 1;
        assert_eq!(stats.max_game_id, hi);
        assert_eq!(
            stats.games,
            games.iter().filter(|g| !g.broken).count() as u32
        );
        // One segment per update, merged back into one past MAX_SEGMENTS.
        expect_segments = if expect_segments + 1 > MAX_SEGMENTS {
            1
        } else {
            expect_segments + 1
        };
        assert_eq!(stats.segments as usize, expect_segments, "round {rounds}");
        let index = Index::open(&f.db).unwrap();
        assert_index_matches(&index, &games, 40);
        assert_eq!(scratch_files(&f.db), vec!["inc.db3.cpi".to_string()]);
    }
    assert!(rounds > MAX_SEGMENTS, "the loop must trigger a merge");

    // The updated index equals a fresh build over the same games, posting
    // for posting, and answers the same queries.
    insert_games(&fresh.db, &games);
    let fresh_stats = build(&fresh.db, opts(40), &no_cancel()).unwrap();
    let (a, b) = (Index::open(&f.db).unwrap(), Index::open(&fresh.db).unwrap());
    assert_eq!(a.status().postings, fresh_stats.postings);
    assert_eq!(a.status().games, fresh_stats.games);
    let start = position_hash(&Chess::default());
    for filter in filters() {
        assert_eq!(a.tree(start, &filter), b.tree(start, &filter));
        assert_eq!(
            a.sample_games(start, &filter, 7, Order::ByYear),
            b.sample_games(start, &filter, 7, Order::ByYear)
        );
    }
    assert_eq!(
        a.pawn_candidates(pawn_hash(Chess::default().board()))
            .collect::<Vec<_>>(),
        b.pawn_candidates(pawn_hash(Chess::default().board()))
            .collect::<Vec<_>>()
    );

    // A different depth is a full rebuild.
    let stats = update(&f.db, opts(30), &no_cancel()).unwrap();
    assert_eq!((stats.max_ply, stats.segments), (30, 1));
    assert_index_matches(&Index::open(&f.db).unwrap(), &games, 30);
}

#[test]
fn update_of_a_corrupt_or_missing_sidecar_is_a_full_build() {
    let f = fixture("rebuild");
    let games = random_games(&mut Rng(5), 1..=40);
    insert_games(&f.db, &games);
    let stats = update(&f.db, opts(40), &no_cancel()).unwrap();
    assert_eq!(stats.segments, 1);
    std::fs::write(sidecar_path(&f.db), b"CPI1 but garbage").unwrap();
    assert!(matches!(Index::open(&f.db), Err(Error::Corrupt(_))));
    let again = update(&f.db, opts(40), &no_cancel()).unwrap();
    assert_eq!((again.games, again.postings), (stats.games, stats.postings));
    assert_index_matches(&Index::open(&f.db).unwrap(), &games, 40);
}

#[test]
fn corrupt_and_short_files_are_rejected() {
    let f = fixture("bad");
    let games = random_games(&mut Rng(9), 1..=60);
    insert_games(&f.db, &games);
    build(&f.db, opts(40), &no_cancel()).unwrap();
    let sidecar = sidecar_path(&f.db);
    let good = std::fs::read(&sidecar).unwrap();
    let open = |bytes: &[u8]| {
        std::fs::write(&sidecar, bytes).unwrap();
        Index::open(&f.db)
    };
    let corrupt = |r: crate::Result<Index>, what: &str| {
        assert!(
            matches!(r, Err(Error::Corrupt(_))),
            "{what} must be rejected"
        );
    };
    corrupt(open(&good[..10]), "a 10-byte file");
    corrupt(open(&good[..63]), "a 63-byte file");
    corrupt(open(&good[..good.len() - 1]), "a truncated file");
    corrupt(
        open(&[good.clone(), vec![0]].concat()),
        "a file with trailing bytes",
    );
    let mut magic = good.clone();
    magic[1] = b'X';
    corrupt(open(&magic), "a bad magic");
    let mut header = good.clone();
    header[12] ^= 0x40;
    corrupt(open(&header), "a damaged header");
    let mut table = good.clone();
    let n = table.len();
    table[n - 30] ^= 0x01;
    corrupt(open(&table), "a damaged segment table");
    // A damaged directory is only found when it is read: no panic, fewer hits.
    let mut dir = good.clone();
    dir[n - 100 - 20] = 0xFF;
    std::fs::write(&sidecar, &dir).unwrap();
    if let Ok(index) = Index::open(&f.db) {
        for hash in all_postings(&games, 40).keys() {
            let _ = index.lookup(*hash).count();
            let _ = index.tree(*hash, &Filter::default());
        }
    }
    std::fs::remove_file(&sidecar).unwrap();
    assert!(matches!(Index::open(&f.db), Err(Error::Missing)));
    assert!(matches!(
        build(Path::new("/nonexistent/x.db3"), opts(40), &no_cancel()),
        Err(Error::Io { .. })
    ));
    assert!(matches!(
        build(&f.db, opts(300), &no_cancel()),
        Err(Error::InvalidArgument(_))
    ));
}

#[test]
fn cancel_stops_the_build_and_leaves_no_scratch_files() {
    let f = fixture("cancel");
    let games = random_games(&mut Rng(1), 1..=80);
    insert_games(&f.db, &games);

    let cancelled = AtomicBool::new(true);
    assert!(matches!(
        build(&f.db, opts(40), &cancelled),
        Err(Error::Cancelled)
    ));
    assert!(scratch_files(&f.db).is_empty());

    // Cancelled from the progress callback, with an existing sidecar to keep.
    build(&f.db, opts(40), &no_cancel()).unwrap();
    let before = std::fs::read(sidecar_path(&f.db)).unwrap();
    let cancel = AtomicBool::new(false);
    let opts = BuildOptions::new(20).with_progress(|_, _| cancel.store(true, Ordering::Relaxed));
    assert!(matches!(build(&f.db, opts, &cancel), Err(Error::Cancelled)));
    assert_eq!(scratch_files(&f.db), vec!["cancel.db3.cpi".to_string()]);
    assert_eq!(std::fs::read(sidecar_path(&f.db)).unwrap(), before);
}

#[test]
fn progress_counts_games_and_ends_complete() {
    let f = fixture("progress");
    let games = random_games(&mut Rng(3), 1..=50);
    insert_games(&f.db, &games);
    let mut seen: Vec<(u64, u64)> = Vec::new();
    let opts = BuildOptions::new(40).with_progress(|done, total| seen.push((done, total)));
    build(&f.db, opts, &no_cancel()).unwrap();
    assert_eq!(seen.last(), Some(&(50, 50)));
    assert!(seen.iter().all(|(_, t)| *t == 50));
    assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0));
}

#[test]
fn an_empty_database_builds_an_empty_index() {
    let f = fixture("empty");
    let stats = build(&f.db, opts(40), &no_cancel()).unwrap();
    assert_eq!(
        (
            stats.games,
            stats.postings,
            stats.segments,
            stats.max_game_id
        ),
        (0, 0, 0, 0)
    );
    let index = Index::open(&f.db).unwrap();
    assert!(index
        .lookup(position_hash(&Chess::default()))
        .next()
        .is_none());
    assert!(index.tree(0, &Filter::default()).is_empty());
    assert!(index.pawn_candidates(0).next().is_none());
    assert_eq!(update(&f.db, opts(40), &no_cancel()).unwrap(), stats);
    // Games arriving later go into the first real segment.
    insert_games(&f.db, &random_games(&mut Rng(8), 1..=5));
    let stats = update(&f.db, opts(40), &no_cancel()).unwrap();
    assert_eq!(stats.max_game_id, 5);
}

/// `cargo test -p chessin-index --release -- --ignored perf --nocapture`
#[test]
#[ignore = "timing only; prints build and lookup times for 20k games"]
fn perf_build_and_lookups_on_20k_games() {
    let f = fixture("perf");
    let mut rng = Rng(20_000);
    let games = random_games(&mut rng, 1..=20_000);
    insert_games(&f.db, &games);
    let t = Instant::now();
    let stats = build(&f.db, opts(40), &no_cancel()).unwrap();
    let build_time = t.elapsed();
    let index = Index::open(&f.db).unwrap();
    let by_hash = all_postings(&games, 40);
    let mut hashes: Vec<(usize, u64)> = by_hash.iter().map(|(h, v)| (v.len(), *h)).collect();
    hashes.sort_by(|a, b| b.cmp(a));
    let probe: Vec<u64> = hashes.iter().take(100).map(|(_, h)| *h).collect();
    let t = Instant::now();
    let mut total = 0u64;
    for hash in &probe {
        total += index
            .tree(*hash, &Filter::default())
            .iter()
            .map(|s| u64::from(s.games))
            .sum::<u64>();
        total += index
            .sample_games(*hash, &Filter::default(), 50, Order::ByElo)
            .len() as u64;
    }
    let lookups = t.elapsed();
    println!(
        "perf: {} games, {} postings, {} bytes ({:.1} bytes/game); build {:?}; 100 tree+sample lookups {:?} ({:?} each, {total} rows)",
        stats.games,
        stats.postings,
        stats.bytes,
        stats.bytes as f64 / f64::from(stats.games),
        build_time,
        lookups,
        lookups / 100,
    );
}

#[test]
fn load_games_reads_rows_in_the_requested_order() {
    let f = fixture("rows");
    let mut games = random_games(&mut Rng(31), 1..=20);
    games.push(repetition_game(21));
    insert_games(&f.db, &games);
    let conn = Connection::open(&f.db).unwrap();
    conn.execute_batch(
        "INSERT INTO Players (ID, Name, Elo) VALUES (7, 'Carlsen, Magnus', 2830); \
         INSERT INTO Events (ID, Name) VALUES (3, 'Tata Steel'); \
         INSERT INTO Sites (ID, Name) VALUES (4, 'Wijk aan Zee'); \
         UPDATE Games SET WhiteID = 7, EventID = 3, SiteID = 4, ECO = 'C20' WHERE ID = 21",
    )
    .unwrap();
    drop(conn);

    let rows = crate::load_games(&f.db, &[21, 999, 3, 21]).unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![21, 3, 21],
        "requested order, missing ids skipped"
    );
    let rep = &rows[0];
    assert_eq!(rep.white, "Carlsen, Magnus");
    assert_eq!(rep.black, "Unknown");
    assert_eq!((rep.white_elo, rep.black_elo), (Some(2800), Some(2790)));
    assert_eq!(rep.result, "1/2-1/2");
    assert_eq!(rep.date.as_deref(), Some("2024.01.01"));
    assert_eq!(
        (rep.event.as_str(), rep.site.as_str()),
        ("Tata Steel", "Wijk aan Zee")
    );
    assert_eq!(rep.eco.as_deref(), Some("C20"));
    assert_eq!(rep.ply_count, Some(5));
    assert_eq!(rep.fen, None);
    assert_eq!(rep.moves, "1. Nf3 Nf6 2. Ng1 Ng8 3. e4");

    // Every generated game renders its main line, and a broken one is empty.
    let ids: Vec<u32> = games.iter().map(|g| g.id).collect();
    let all = crate::load_games(&f.db, &ids).unwrap();
    assert_eq!(all.len(), games.len());
    for (row, g) in all.iter().zip(&games) {
        assert_eq!(row.id, g.id);
        assert_eq!(row.fen, g.fen);
        assert_eq!(row.ply_count, Some(g.codes.len() as u32));
        assert_eq!(row.result, GameResult::from_pgn(g.result).as_pgn());
        if g.broken {
            assert_eq!(row.moves, "", "game {}", g.id);
        } else {
            assert_eq!(
                row.moves,
                crate::moves::mainline_movetext(g.fen.as_deref(), &g.codes).unwrap()
            );
            assert_eq!(row.moves.is_empty(), g.codes.is_empty());
        }
    }
    // The cap: only the first MAX_GAMES ids are read.
    let many: Vec<u32> = std::iter::repeat_n(21u32, crate::MAX_GAMES + 5).collect();
    assert_eq!(
        crate::load_games(&f.db, &many).unwrap().len(),
        crate::MAX_GAMES
    );
    assert!(crate::load_games(Path::new("/nonexistent/x.db3"), &[1]).is_err());
}
