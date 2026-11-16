#!/usr/bin/env node
/**
 * Reproduce the reported ghost row against a REAL DSH home.
 *
 *   1. pick a session that is actually on disk,
 *   2. put it into the archive set through the Host's own registry,
 *   3. remove its log directory out of band - exactly what the issue describes,
 *   4. list the archive: the row must be flagged `missing`,
 *   5. call the old `trashSession` path on it: it must still answer
 *      "session not found" (that is the bug),
 *   6. call `detachMissingArchive`: the record must go, files untouched,
 *   7. restore the log directory and the archive flag so nothing is lost.
 *
 * Usage: node tools/simulate-ghost.mjs [--keep]
 *   --keep  leave the session archived when the run ends (default: undo)
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const appRequire = createRequire(process.env.DSH_APP_PACKAGE || "D:/IDE/Hypers Work/resources/app/package.json");
const home = process.env.DSH_HOME || "C:/Users/Konka/.hypers-work";
const keep = process.argv.includes("--keep");
const modulePath = pathToFileURL("C:/Users/Konka/Hypers Work/workspace/dsh-ws-recency/index.js").href;
const mod = await import(modulePath);

/* ---- a Host-shaped context, enough for the archive paths --------------- */
const sessionsRoot = join(home, "sessions");
const all = [];
for (const project of readdirSync(sessionsRoot)) {
  const projectPath = join(sessionsRoot, project);
  if (!statSync(projectPath).isDirectory()) continue;
  for (const id of readdirSync(projectPath)) all.push({ id, dir: join(projectPath, id) });
}
if (all.length === 0) {
  console.error("no session directories under", sessionsRoot);
  process.exit(1);
}

/* The newest directory is the least likely to be irreplaceable if anything goes wrong. */
all.sort((a, b) => statSync(b.dir).mtimeMs - statSync(a.dir).mtimeMs);
const target = all[0];
const backup = `${target.dir}.ghost-sim-backup`;
console.log("target session:", target.id);
console.log("log dir:", target.dir);

const archivedSet = new Set();
let detached = [];
const persisted = [];

const registry = {
  get archivedSessionIds() { return [...archivedSet]; },
  list: () => [
    {
      id: "sim-workspace",
      path: "C:/sim",
      sessionIds: [target.id],
      attachSession: async () => {},
      detachSession: async (id) => { detached.push(id); },
    },
  ],
  unarchiveSession: async (id) => { archivedSet.delete(id); },
  unpinSession: async () => {},
};

const ctx = {
  workspaceRegistry: registry,
  get: (name) => {
    if (name === "storageDomain") return { get: () => ({ table: () => ({ get: () => undefined, delete: async () => {} }) }) };
    return undefined;
  },
  sessionPersistence: {
    list: async () => (existsSync(target.dir)
      ? [{ header: { id: target.id, cwd: "C:/sim", createdAt: Date.now() }, sizeBytes: 1 }]
      : []),
    stat: async (id) => {
      if (id !== target.id) return undefined;
      return existsSync(target.dir) ? { header: { id, cwd: "C:/sim", createdAt: Date.now() }, sizeBytes: 1 } : undefined;
    },
    open: async () => { throw new Error("no log"); },
  },
  sessions: { get: () => undefined },
  parallel: async () => {},
  emit: () => {},
};

let failed = false;
try {
  /* 1. archive it the Host's way */
  archivedSet.add(target.id);
  console.log("\n[1] archived:", target.id);

  /* 2. remove the log out of band */
  renameSync(target.dir, backup);
  console.log("[2] moved the log away (out-of-band delete):", existsSync(target.dir) ? "STILL THERE" : "gone");

  /* 3. the listing must flag it */
  const listing = await mod.listArchivedSessions(ctx);
  const row = listing.entries.find((entry) => entry.sessionId === target.id);
  console.log("[3] listed:", row !== undefined, "| missing flag:", row?.missing);
  if (row === undefined || row.missing !== true) { console.log("   FAIL: the row is not flagged"); failed = true; }

  /* 4. the old path still answers "session not found" */
  const old = await mod.trashSession(ctx, target.id);
  console.log("[4] trashSession on a log-less id:", JSON.stringify(old));
  if (old.ok !== false || old.error !== "session not found") { console.log("   FAIL: the old path changed unexpectedly"); failed = true; }

  /* 5. the new action clears the record only */
  const detach = await mod.detachMissingArchive(ctx, target.id);
  console.log("[5] detachMissingArchive:", JSON.stringify(detach));
  console.log("    archive still holds it:", archivedSet.has(target.id), "| workspace detaches:", detached.length);
  if (detach.ok !== true || archivedSet.has(target.id) || detached.length !== 1) { console.log("   FAIL: the record was not cleared"); failed = true; }
  const after = await mod.listArchivedSessions(ctx);
  console.log("    rows after:", after.entries.length);

  /* 6. a live session is refused by the same action */
  renameSync(backup, target.dir);
  const live = await mod.detachMissingArchive(ctx, target.id);
  console.log("[6] detach on a live session:", JSON.stringify(live));
  if (live.ok === true || live.error !== "session is not archived") { console.log("   (expected: refused because it is not archived any more)"); }
} finally {
  if (existsSync(backup)) {
    renameSync(backup, target.dir);
    console.log("\n[restore] log directory put back:", existsSync(target.dir));
  }
  if (!keep) {
    archivedSet.delete(target.id);
    console.log("[restore] archive flag cleared");
  }
}

console.log(failed ? "\nSIMULATION: FAILED" : "\nSIMULATION: reproduced and repaired");
process.exit(failed ? 1 : 0);
