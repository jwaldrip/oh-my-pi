/**
 * A realistic session corpus, shared by the model tests and the render test.
 *
 * The contract found 305 sessions across 93 directories on a real machine.
 * This fixture is smaller for test speed but keeps the shape that matters:
 * many directories, an uneven number of sessions per directory, and every
 * sort dimension deliberately out of alignment with the others so a test
 * cannot pass by coincidentally sorting on the wrong field.
 */

import type { BrowserSession, SessionStatus } from "../../src/session/browser.ts";

let seq = 0;

export function makeSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  seq += 1;
  return {
    id: `sess_${seq}`,
    title: `session ${seq}`,
    cwd: "/Users/op/dev/src/github.com/op/repo-a",
    status: "dormant",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    messageCount: 10,
    sizeBytes: 1024,
    ...overrides,
  };
}

const STATUSES: readonly SessionStatus[] = ["live-tui", "live-ompd", "dormant", "archived"];

/** `dirCount` directories, 1 to 6 sessions each: a realistic, uneven corpus. */
export function makeSessionCorpus(dirCount = 12): BrowserSession[] {
  const dirs = Array.from({ length: dirCount }, (_, i) => `/Users/op/dev/src/github.com/op/repo-${i}`);
  const rows: BrowserSession[] = [];
  for (let d = 0; d < dirs.length; d++) {
    const dir = dirs[d] as string;
    const count = 1 + (d % 6);
    for (let i = 0; i < count; i++) {
      rows.push(
        makeSession({
          cwd: dir,
          status: STATUSES[(d + i) % STATUSES.length] as SessionStatus,
          title: `${dir.split("/").pop()} turn ${i + 1}`,
          createdAt: new Date(2026, 0, 1 + ((d * 7 + i) % 60)).toISOString(),
          lastActiveAt: new Date(2026, 1, 1 + ((d * 3 + i * 5) % 60)).toISOString(),
          messageCount: ((d * 13 + i * 29) % 200) + 1,
          sizeBytes: ((d * 4099 + i * 733) % 500_000) + 100,
        }),
      );
    }
  }
  return rows;
}
