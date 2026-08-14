/**
 * Persistence for evolution proposals.
 *
 * This owns its own `proposals` table with `CREATE TABLE IF NOT EXISTS` against
 * the same SQLite file the rest of the daemon uses. `packages/core/src/store.ts`
 * is frozen, and the evolution loop is exactly the subsystem that should not be
 * able to reach into the shared store's schema to make room for itself.
 *
 * Diffs are stored verbatim rather than redacted. A truncated patch is not an
 * applicable patch, so redaction here would silently produce proposals that can
 * never be evaluated. Audit entries, which are redacted, carry paths and reasons
 * instead of diff bodies.
 */

import { Database } from "bun:sqlite";
import type { Proposal, ProposalState } from "@ompd/core";

const SCHEMA = `
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  diff TEXT NOT NULL,
  touched_paths TEXT NOT NULL,
  state TEXT NOT NULL,
  verdict_passed INTEGER,
  verdict_log TEXT,
  created_at TEXT NOT NULL,
  promoted_commit TEXT
);
CREATE INDEX IF NOT EXISTS proposals_state ON proposals(state, created_at DESC);
`;

interface ProposalRow {
  id: string;
  title: string;
  rationale: string;
  diff: string;
  touched_paths: string;
  state: string;
  verdict_passed: number | null;
  verdict_log: string | null;
  created_at: string;
  promoted_commit: string | null;
}

export class ProposalStore {
  #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true });
    this.#db.run(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  upsert(p: Proposal): void {
    this.#db
      .query(
        `INSERT INTO proposals
         (id,title,rationale,diff,touched_paths,state,verdict_passed,verdict_log,created_at,promoted_commit)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, rationale=excluded.rationale, diff=excluded.diff,
           touched_paths=excluded.touched_paths, state=excluded.state,
           verdict_passed=excluded.verdict_passed, verdict_log=excluded.verdict_log,
           promoted_commit=excluded.promoted_commit`,
      )
      .run(
        p.id,
        p.title,
        p.rationale,
        p.diff,
        JSON.stringify(p.touchedPaths),
        p.state,
        p.verdict === undefined ? null : Number(p.verdict.passed),
        p.verdict?.log ?? null,
        p.createdAt,
        p.promotedCommit ?? null,
      );
  }

  get(id: string): Proposal | null {
    const row = this.#db.query(`SELECT * FROM proposals WHERE id=?`).get(id) as ProposalRow | null;
    if (row === null) return null;
    return rowToProposal(row);
  }

  list(state?: ProposalState): Proposal[] {
    const rows = (
      state === undefined
        ? this.#db.query(`SELECT * FROM proposals ORDER BY created_at DESC`).all()
        : this.#db
            .query(`SELECT * FROM proposals WHERE state=? ORDER BY created_at DESC`)
            .all(state)
    ) as ProposalRow[];
    return rows.map(rowToProposal);
  }
}

function rowToProposal(row: ProposalRow): Proposal {
  const verdict =
    row.verdict_passed === null
      ? undefined
      : { passed: row.verdict_passed === 1, log: row.verdict_log ?? "" };

  return {
    id: row.id,
    title: row.title,
    rationale: row.rationale,
    diff: row.diff,
    touchedPaths: JSON.parse(row.touched_paths),
    state: row.state as ProposalState,
    verdict,
    createdAt: row.created_at,
    promotedCommit: row.promoted_commit ?? undefined,
  };
}
