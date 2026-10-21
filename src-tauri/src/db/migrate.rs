//! Schema versioning for `.db3` game databases, driven by `PRAGMA user_version`.
//!
//! Version 1 is the schema in `create.sql`, unchanged from En Croissant.
//! Databases written by En Croissant carry `user_version = 0`; they are
//! recognised by their tables and stamped to version 1 without touching any
//! row. Later schema changes append an entry to [`MIGRATIONS`]; on open, every
//! entry above the stored version runs, in order, inside one write
//! transaction that also bumps `user_version`, so a crash mid-migration leaves
//! the database at its previous version.

use diesel::{
    connection::SimpleConnection,
    prelude::*,
    result::DatabaseErrorKind,
    sql_query,
    sql_types::{BigInt, Integer},
};
use log::warn;

use crate::error::Error;

/// Schema version written by this build.
pub const CURRENT_VERSION: u32 = 1;

/// `(version, sql)` pairs; each `sql` brings a database from `version - 1` up
/// to `version`. Append new versions at the end and bump [`CURRENT_VERSION`].
/// Statements must be additive (new tables, nullable columns, indexes) so that
/// En Croissant keeps reading the core tables.
pub const MIGRATIONS: &[(u32, &str)] = &[(1, super::CREATE_TABLES_SQL)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// The file had no tables: the full schema was created and stamped.
    Created,
    /// An En Croissant database without a `user_version` stamp: stamped to 1
    /// (and upgraded further if needed), rows untouched.
    Stamped,
    /// Ran the migrations above `from` up to [`CURRENT_VERSION`].
    Upgraded { from: u32 },
    /// Already at [`CURRENT_VERSION`].
    UpToDate,
    /// Needs stamping or upgrading but the file is read-only; left as is.
    ReadOnly { version: u32 },
}

#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error(transparent)]
    Diesel(#[from] diesel::result::Error),

    #[error(
        "database created by a newer Chessin (schema version {found}, this build supports up to {supported}); update Chessin to open it"
    )]
    NewerDatabase { found: i64, supported: u32 },

    #[error("not a Chessin or En Croissant game database (it has tables, but no Games table)")]
    NotAGameDatabase,
}

impl From<MigrationError> for Error {
    fn from(value: MigrationError) -> Self {
        match value {
            MigrationError::Diesel(e) => Self::Diesel(Box::new(e)),
            // `Error` has no migration variant yet; surface the message through
            // the diesel variant so it reaches the frontend unchanged.
            other => Self::Diesel(Box::new(diesel::result::Error::DatabaseError(
                DatabaseErrorKind::Unknown,
                Box::new(other.to_string()),
            ))),
        }
    }
}

/// Brings `conn`'s database up to [`CURRENT_VERSION`].
///
/// Safe to call from several connections at once: the version is re-checked
/// under the write lock, so only the first caller does any work.
pub fn migrate(conn: &mut SqliteConnection) -> Result<MigrationOutcome, MigrationError> {
    // Cheap read first, so an up-to-date database never takes a write lock
    // (and opens fine from read-only media).
    let found = checked_version(read_user_version(conn)?)?;
    if found == CURRENT_VERSION {
        return Ok(MigrationOutcome::UpToDate);
    }

    let result = conn.immediate_transaction(|conn| {
        // Another connection may have migrated between the read above and
        // acquiring the write lock.
        let found = checked_version(read_user_version(conn)?)?;
        if found == CURRENT_VERSION {
            return Ok(MigrationOutcome::UpToDate);
        }

        if found == 0 {
            if has_table(conn, "Games")? {
                set_user_version(conn, 1)?;
                apply_migrations_above(conn, 1)?;
                return Ok(MigrationOutcome::Stamped);
            }
            if has_any_table(conn)? {
                return Err(MigrationError::NotAGameDatabase);
            }
            apply_migrations_above(conn, 0)?;
            return Ok(MigrationOutcome::Created);
        }

        apply_migrations_above(conn, found)?;
        Ok(MigrationOutcome::Upgraded { from: found })
    });

    match result {
        Err(MigrationError::Diesel(e)) if is_readonly_error(&e) => {
            warn!(
                "database is read-only; leaving it at schema version {found} (current is {CURRENT_VERSION})"
            );
            Ok(MigrationOutcome::ReadOnly { version: found })
        }
        other => other,
    }
}

/// True for SQLite's "attempt to write a readonly database".
pub fn is_readonly_error(e: &diesel::result::Error) -> bool {
    matches!(
        e,
        diesel::result::Error::DatabaseError(_, info) if info.message().contains("readonly")
    )
}

fn checked_version(raw: i32) -> Result<u32, MigrationError> {
    match u32::try_from(raw) {
        Ok(version) if version <= CURRENT_VERSION => Ok(version),
        _ => Err(MigrationError::NewerDatabase {
            found: i64::from(raw),
            supported: CURRENT_VERSION,
        }),
    }
}

fn apply_migrations_above(conn: &mut SqliteConnection, from: u32) -> QueryResult<()> {
    for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version > from) {
        conn.batch_execute(sql)?;
        set_user_version(conn, *version)?;
    }
    Ok(())
}

#[derive(QueryableByName)]
struct UserVersionRow {
    #[diesel(sql_type = Integer)]
    user_version: i32,
}

pub fn read_user_version(conn: &mut SqliteConnection) -> QueryResult<i32> {
    sql_query("PRAGMA user_version;")
        .get_result::<UserVersionRow>(conn)
        .map(|row| row.user_version)
}

fn set_user_version(conn: &mut SqliteConnection, version: u32) -> QueryResult<()> {
    conn.batch_execute(&format!("PRAGMA user_version = {version};"))
}

#[derive(QueryableByName)]
struct CountRow {
    #[diesel(sql_type = BigInt)]
    n: i64,
}

fn has_table(conn: &mut SqliteConnection, name: &str) -> QueryResult<bool> {
    let row: CountRow =
        sql_query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?;")
            .bind::<diesel::sql_types::Text, _>(name)
            .get_result(conn)?;
    Ok(row.n > 0)
}

fn has_any_table(conn: &mut SqliteConnection) -> QueryResult<bool> {
    let row: CountRow = sql_query(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';",
    )
    .get_result(conn)?;
    Ok(row.n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        models::Player,
        ops::create_player,
        schema::{info, players},
        set_info_value, CREATE_TABLES_SQL, DATABASE_VERSION,
    };

    fn memory_db() -> SqliteConnection {
        SqliteConnection::establish(":memory:").unwrap()
    }

    #[test]
    fn migrations_are_contiguous_and_end_at_current_version() {
        let versions: Vec<u32> = MIGRATIONS.iter().map(|(v, _)| *v).collect();
        let expected: Vec<u32> = (1..=CURRENT_VERSION).collect();
        assert_eq!(versions, expected);
        assert_eq!(MIGRATIONS[0].1, CREATE_TABLES_SQL);
    }

    #[test]
    fn fresh_database_is_created_and_stamped() {
        let mut conn = memory_db();
        assert_eq!(read_user_version(&mut conn).unwrap(), 0);

        assert_eq!(migrate(&mut conn).unwrap(), MigrationOutcome::Created);
        assert_eq!(
            read_user_version(&mut conn).unwrap(),
            CURRENT_VERSION as i32
        );

        // The schema (and its sentinel rows) exists.
        let unknown: Player = players::table.find(0).first(&mut conn).unwrap();
        assert_eq!(unknown.name.as_deref(), Some("Unknown"));

        // A second run is a no-op.
        assert_eq!(migrate(&mut conn).unwrap(), MigrationOutcome::UpToDate);
    }

    #[test]
    fn en_croissant_database_is_stamped_without_changes() {
        let mut conn = memory_db();
        conn.batch_execute(CREATE_TABLES_SQL).unwrap();
        set_info_value(&mut conn, "Version", DATABASE_VERSION).unwrap();
        let magnus = create_player(&mut conn, "Magnus").unwrap();
        assert_eq!(read_user_version(&mut conn).unwrap(), 0);

        assert_eq!(migrate(&mut conn).unwrap(), MigrationOutcome::Stamped);
        assert_eq!(read_user_version(&mut conn).unwrap(), 1);

        let still_there: Player = players::table.find(magnus.id).first(&mut conn).unwrap();
        assert_eq!(still_there.name.as_deref(), Some("Magnus"));
        let version: Option<String> = info::table
            .filter(info::name.eq("Version"))
            .select(info::value)
            .first(&mut conn)
            .unwrap();
        assert_eq!(version.as_deref(), Some(DATABASE_VERSION));

        assert_eq!(migrate(&mut conn).unwrap(), MigrationOutcome::UpToDate);
    }

    #[test]
    fn newer_database_is_refused() {
        let mut conn = memory_db();
        conn.batch_execute(CREATE_TABLES_SQL).unwrap();
        conn.batch_execute(&format!("PRAGMA user_version = {};", CURRENT_VERSION + 1))
            .unwrap();

        let err = migrate(&mut conn).unwrap_err();
        assert!(
            matches!(err, MigrationError::NewerDatabase { found, supported }
                if found == i64::from(CURRENT_VERSION) + 1 && supported == CURRENT_VERSION),
            "{err:?}"
        );
        let message = Error::from(err).to_string();
        assert!(message.contains("newer Chessin"), "{message}");

        // Nothing was touched.
        assert_eq!(
            read_user_version(&mut conn).unwrap(),
            CURRENT_VERSION as i32 + 1
        );
    }

    #[test]
    fn foreign_sqlite_file_is_refused_and_untouched() {
        let mut conn = memory_db();
        conn.batch_execute("CREATE TABLE Something (x INTEGER);")
            .unwrap();

        let err = migrate(&mut conn).unwrap_err();
        assert!(matches!(err, MigrationError::NotAGameDatabase), "{err:?}");
        assert_eq!(read_user_version(&mut conn).unwrap(), 0);
        assert!(!has_table(&mut conn, "Games").unwrap());
    }
}
