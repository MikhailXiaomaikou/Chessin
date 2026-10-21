//! Chessin core library.
//!
//! Everything in this crate is independent of Tauri so that it can be reused by
//! the data pipeline services (plan §3.3) and, where useful, contributed upstream.
//! The modules planned in `docs/chessin-on-en-croissant-plan.md` §3.1 are `store`,
//! `jobs`, `cache`, `review`, `explain`, `srs`, `names` and `query`; only `store`
//! exists so far, as a placeholder.

pub mod store;

/// Version of this crate, taken from `Cargo.toml`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Smoke test used by the `chessin_ping` Tauri command.
pub fn ping() -> &'static str {
    "pong"
}

#[cfg(test)]
mod tests {
    use super::{ping, VERSION};

    #[test]
    fn ping_returns_pong_and_version_is_set() {
        assert_eq!(ping(), "pong");
        assert!(!VERSION.is_empty());
    }
}
