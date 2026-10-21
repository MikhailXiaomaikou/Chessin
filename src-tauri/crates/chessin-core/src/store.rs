//! Placeholder for Chessin's own data store, `app-data/chessin/library.sqlite`.
//!
//! Planned contents (plan §2.2 "数据" and §3.1 `chessin-core::store`): workspaces,
//! versions, trash, review cards (FSRS), the evaluation cache keyed by
//! (FEN, engine version, depth, MultiPV), player aliases, sources and settings.
//!
//! Game databases stay in En Croissant's `.db3` format so that En Croissant can
//! still open a Chessin library; anything Chessin adds there goes into `chessin_*`
//! tables with their own migrations, plus the side-car `.cpi` position index.
//!
//! This module will own the schema migrations, crash recovery (WAL plus integrity
//! check on open), rolling backups and the En Croissant → Chessin migrator.
//! Nothing is implemented yet.
