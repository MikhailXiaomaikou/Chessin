//! The `jobs` table: the persisted side of the frontend's background job
//! runner (`src/chessin/jobs/queue.ts`).
//!
//! The runner owns the records and writes every transition through
//! [`Library::job_upsert`]; the store keeps them across restarts, lists them for
//! the task centre and trims the finished ones. A job still `running` when the
//! app died is put back to `queued` when the library is opened.

use rusqlite::{params, Connection};

use super::{Error, Library};

/// Statuses of a job that is over; [`Library::job_prune`] trims these.
pub const FINISHED_JOB_STATUSES: [&str; 3] = ["done", "failed", "cancelled"];

/// One row of `jobs`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct JobRecord {
    pub id: String,
    /// `review`, `sync`, `import`, …; the runner dispatches on it.
    pub kind: String,
    pub title: String,
    /// `queued`, `running`, `done`, `failed` or `cancelled`.
    pub status: String,
    /// JSON, opaque to the store.
    pub payload: String,
    /// `0.0` to `1.0`.
    pub progress: f64,
    /// JSON, set when `done`.
    pub result: Option<String>,
    /// The message, set when `failed`.
    pub error: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub updated_at: i64,
}

const COLUMNS: &str =
    "id, kind, title, status, payload, progress, result, error, created_at, updated_at";

fn read_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<JobRecord> {
    Ok(JobRecord {
        id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        status: r.get(3)?,
        payload: r.get(4)?,
        progress: r.get(5)?,
        result: r.get(6)?,
        error: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
    })
}

impl Library {
    /// Inserts or replaces the job, every column included (`created_at` too:
    /// the runner's record is the source of truth).
    pub fn job_upsert(&self, job: &JobRecord) -> Result<(), Error> {
        self.conn.execute(
            "INSERT INTO jobs (id, kind, title, status, payload, progress, result, error,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, title = excluded.title,
                 status = excluded.status, payload = excluded.payload,
                 progress = excluded.progress, result = excluded.result,
                 error = excluded.error, created_at = excluded.created_at,
                 updated_at = excluded.updated_at",
            params![
                job.id,
                job.kind,
                job.title,
                job.status,
                job.payload,
                job.progress,
                job.result,
                job.error,
                job.created_at,
                job.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Jobs with `status` (every status when `None`): the running ones first,
    /// then the queued ones, then the finished ones; newest (`created_at`)
    /// first within each group.
    pub fn job_list(&self, status: Option<&str>) -> Result<Vec<JobRecord>, Error> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM jobs WHERE ?1 IS NULL OR status = ?1
             ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                 created_at DESC, id"
        ))?;
        let rows = stmt.query_map([status], read_job)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Deletes a job; a missing one is not an error.
    pub fn job_delete(&self, id: &str) -> Result<(), Error> {
        self.conn.execute("DELETE FROM jobs WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Keeps the `keep_finished` most recently updated done/failed/cancelled
    /// jobs, deletes the other finished ones and returns how many went. Queued
    /// and running jobs are never touched.
    pub fn job_prune(&self, keep_finished: u32) -> Result<u32, Error> {
        let deleted = self.conn.execute(
            "DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled') AND id NOT IN (
                 SELECT id FROM jobs WHERE status IN ('done', 'failed', 'cancelled')
                 ORDER BY updated_at DESC, created_at DESC, id LIMIT ?1)",
            [i64::from(keep_finished)],
        )?;
        Ok(u32::try_from(deleted).unwrap_or(u32::MAX))
    }
}

/// Puts every `running` job back to `queued` (the app was not shut down
/// cleanly, so none of them is still running); returns how many were reset.
/// The progress is kept for display; the runner starts the job over.
pub(super) fn requeue_running(conn: &Connection, now_ms: i64) -> Result<usize, Error> {
    Ok(conn.execute(
        "UPDATE jobs SET status = 'queued', updated_at = ?1 WHERE status = 'running'",
        [now_ms],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, status: &str, created_at: i64) -> JobRecord {
        JobRecord {
            id: id.to_string(),
            kind: "review".to_string(),
            title: format!("Job {id}"),
            status: status.to_string(),
            payload: "{}".to_string(),
            progress: 0.0,
            result: None,
            error: None,
            created_at,
            updated_at: created_at,
        }
    }

    fn ids(jobs: &[JobRecord]) -> Vec<&str> {
        jobs.iter().map(|j| j.id.as_str()).collect()
    }

    #[test]
    fn job_lifecycle_round_trips_every_column() {
        let lib = Library::open_in_memory().unwrap();
        assert!(lib.job_list(None).unwrap().is_empty());

        let queued = JobRecord {
            payload: "{\"gameKey\":\"file:/a.pgn#1\"}".to_string(),
            ..job("j1", "queued", 1_000)
        };
        lib.job_upsert(&queued).unwrap();
        assert_eq!(lib.job_list(None).unwrap(), vec![queued.clone()]);

        let running = JobRecord {
            status: "running".to_string(),
            progress: 0.5,
            updated_at: 2_000,
            ..queued.clone()
        };
        lib.job_upsert(&running).unwrap();
        assert_eq!(
            lib.job_list(Some("running")).unwrap(),
            vec![running.clone()]
        );
        assert!(lib.job_list(Some("queued")).unwrap().is_empty());

        let done = JobRecord {
            status: "done".to_string(),
            progress: 1.0,
            result: Some("{\"accuracy\":91}".to_string()),
            updated_at: 3_000,
            ..running
        };
        lib.job_upsert(&done).unwrap();
        let failed = JobRecord {
            error: Some("engine not found".to_string()),
            ..job("j2", "failed", 1_500)
        };
        lib.job_upsert(&failed).unwrap();
        assert_eq!(
            lib.job_list(None).unwrap(),
            vec![failed.clone(), done.clone()]
        );
        assert_eq!(lib.job_list(Some("done")).unwrap(), vec![done]);
        assert_eq!(lib.job_list(Some("failed")).unwrap(), vec![failed]);
        assert!(lib.job_list(Some("nope")).unwrap().is_empty());

        lib.job_delete("j1").unwrap();
        assert_eq!(ids(&lib.job_list(None).unwrap()), ["j2"]);
        // Deleting a missing job is fine.
        lib.job_delete("j1").unwrap();
    }

    #[test]
    fn list_puts_running_then_queued_first_and_newest_first_within() {
        let lib = Library::open_in_memory().unwrap();
        lib.job_upsert(&job("old-done", "done", 100)).unwrap();
        lib.job_upsert(&job("old-queued", "queued", 200)).unwrap();
        lib.job_upsert(&job("running", "running", 300)).unwrap();
        lib.job_upsert(&job("new-done", "cancelled", 400)).unwrap();
        lib.job_upsert(&job("new-queued", "queued", 500)).unwrap();
        lib.job_upsert(&job("failed", "failed", 600)).unwrap();

        assert_eq!(
            ids(&lib.job_list(None).unwrap()),
            [
                "running",
                "new-queued",
                "old-queued",
                "failed",
                "new-done",
                "old-done"
            ]
        );
        assert_eq!(
            ids(&lib.job_list(Some("queued")).unwrap()),
            ["new-queued", "old-queued"]
        );
    }

    #[test]
    fn running_jobs_are_requeued_on_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.sqlite");
        {
            let lib = Library::open(&path).unwrap();
            lib.job_upsert(&JobRecord {
                progress: 0.4,
                ..job("r", "running", 1_000)
            })
            .unwrap();
            lib.job_upsert(&job("q", "queued", 2_000)).unwrap();
            lib.job_upsert(&job("d", "done", 3_000)).unwrap();
        }
        let lib = Library::open(&path).unwrap();
        let jobs = lib.job_list(None).unwrap();
        assert_eq!(ids(&jobs), ["q", "r", "d"]);
        let r = &jobs[1];
        assert_eq!(r.status, "queued");
        assert_eq!(r.progress, 0.4, "the progress is kept for display");
        assert!(r.updated_at > 1_000, "the reset bumps updated_at");
        assert_eq!(jobs[0].status, "queued");
        assert_eq!(jobs[2].status, "done");
        assert!(lib.job_list(Some("running")).unwrap().is_empty());

        // Nothing to do on a clean file.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(super::super::MIGRATIONS.concat().as_str())
            .unwrap();
        assert_eq!(requeue_running(&conn, 0).unwrap(), 0);
    }

    #[test]
    fn prune_keeps_the_most_recently_updated_finished_jobs() {
        let lib = Library::open_in_memory().unwrap();
        lib.job_upsert(&job("queued", "queued", 1)).unwrap();
        lib.job_upsert(&job("running", "running", 2)).unwrap();
        let [done, failed, cancelled] = FINISHED_JOB_STATUSES;
        for (i, status) in [done, failed, cancelled, done, done].iter().enumerate() {
            let created_at = 100 + i as i64;
            lib.job_upsert(&JobRecord {
                // Finished in reverse creation order: f0 finished last.
                updated_at: 1_000 - created_at,
                ..job(&format!("f{i}"), status, created_at)
            })
            .unwrap();
        }

        assert_eq!(lib.job_prune(10).unwrap(), 0, "nothing beyond the cap");
        assert_eq!(lib.job_prune(2).unwrap(), 3);
        let jobs = lib.job_list(None).unwrap();
        let mut left = ids(&jobs);
        left.sort_unstable();
        assert_eq!(
            left,
            ["f0", "f1", "queued", "running"],
            "the two most recently finished stay, active jobs are untouched"
        );
        assert_eq!(lib.job_prune(0).unwrap(), 2);
        assert_eq!(ids(&lib.job_list(None).unwrap()), ["running", "queued"]);
        assert_eq!(lib.job_prune(0).unwrap(), 0);
    }
}
