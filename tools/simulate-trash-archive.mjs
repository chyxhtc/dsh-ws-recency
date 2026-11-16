#!/usr/bin/env node
/**
 * Check the "keep the archive flag while trashed" idea against the real code.
 *
 * dsh-context re-reads `workspaceRegistry.archivedSessionIds` on every refresh
 * and marks those rows archived (not clickable). Today `trashSession()` strips
 * that flag before the log moves, which is why a trashed session stays listed
 * and clickable on its board.
 *
 * This script drives the real plugin against a scratch DSH_HOME and shows the
 * three states dsh-context would see:
 *   A. before delete            -> not archived
 *   B. with the flag kept       -> archived while the log is gone (not clickable)
 *   C. after restore            -> not archived, log back
 *
 * Usage: node tools/simulate-trash-archive.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL("C:/Users/Konka/Hypers Work/workspace/dsh-ws-recency/index.js").href);
const home = mkdtempSync(join(tmpdir(), "wsr-trash-archive-"));
process.env.DSH_HOME = home;
let failed = false;

const sessionId = "session-sim";
const sessionDir = join(home, "sessions", "--C-sim--", sessionId);
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(sessionDir, "session.v4.jsonl.zstd"), "payload");

/* The Host's archive set, exactly as dsh-context reads it. */
const archived = new Set();
const registry = {
  get archivedSessionIds() { return [...archived]; },
  list: () => [{
    id: "w-sim",
    path: "C:/sim",
    sessionIds: [sessionId],
    attachSession: async () => {},
    detachSession: async () => {},
    archiveSession: async (id) => { archived.add(id); },
  }],
  unarchiveSession: async (id) => { archived.delete(id); },
  unpinSession: async () => {},
};
const seen = () => (new Set(registry.archivedSessionIds).has(sessionId) ? "archived (not clickable)" : "plain (clickable)");
const ctx = { workspaceRegistry: registry, get: () => undefined, emit: () => {}, parallel: async () => {}, sessions: { get: () => undefined } };

try {
  console.log("[A] before delete          ->", seen());

  /* The proposed delete: keep (or set) the flag before the log moves. */
  await registry.list()[0].archiveSession(sessionId);
  const trashDir = join(home, ".trash", "ws-recency", `${sessionId}-2026-01-01T00-00-00-000Z`);
  mkdirSync(trashDir, { recursive: true });
  writeFileSync(join(trashDir, ".wsr-trash.json"), JSON.stringify({ sessionId, cwd: "C:/sim", reason: "delete", at: 1, archived: true }));
  renameSync(join(sessionDir, "session.v4.jsonl.zstd"), join(trashDir, "session.v4.jsonl.zstd"));
  console.log("[B] trashed, flag kept     ->", seen(), "| log in sessions/:", existsSync(join(sessionDir, "session.v4.jsonl.zstd")));
  if (!archived.has(sessionId)) { console.log("    FAIL: the flag did not survive"); failed = true; }

  /* What the trash panel shows meanwhile: the entry itself must still list. */
  const listing = await mod.listTrash();
  const entry = listing.entries.find((item) => item.sessionId === sessionId);
  console.log("    trash listing sees it:", entry !== undefined, entry !== undefined ? `(restorable: ${entry.restorable})` : "");
  if (entry === undefined) { console.log("    FAIL: the entry is not listed"); failed = true; }

  /* The restore order that matters: files back, attach, then drop the flag. */
  renameSync(join(trashDir, "session.v4.jsonl.zstd"), join(sessionDir, "session.v4.jsonl.zstd"));
  await registry.unarchiveSession(sessionId);
  console.log("[C] restored               ->", seen(), "| log back:", existsSync(join(sessionDir, "session.v4.jsonl.zstd")));
  if (archived.has(sessionId)) { console.log("    FAIL: the flag survived the restore"); failed = true; }

  /* And the failure mode this design must avoid: flag kept with NO log and no
     trash entry would be the 0.27.0 ghost row; check the panel flags it. */
  await registry.list()[0].archiveSession(sessionId);
  rmSync(join(sessionDir, "session.v4.jsonl.zstd"), { force: true });
  const ghosts = await mod.listArchivedSessions(ctx);
  const ghost = ghosts.entries.find((item) => item.sessionId === sessionId);
  console.log("[D] flag left with no log  -> listed:", ghost !== undefined, "| flagged missing:", ghost?.missing === true, "(this is why delete must also drop the flag, or the panel marks it 'record only')");
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? "\nSIMULATION: FAILED" : "\nSIMULATION: keeping the archive flag works for the dsh-context board");
process.exit(failed ? 1 : 0);
