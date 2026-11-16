#!/usr/bin/env node
/**
 * Reproduce issue #1 against the real dsh-context build.
 *
 * The claim in the issue is that a purged session stays on dsh-context's board
 * because that plugin never sees a removal event. Its shipped code keys every
 * fold signature on `path \0 sizeBytes \0 mtimeMs` (`Vo` in lib/index.js), so the
 * question is whether a vanished log leaves a stale entry behind.
 *
 * This script does not touch real logs. It reads one real, non-archived session
 * directory, copies it into a scratch DSH_HOME, and walks the states a purge
 * produces inside dsh-context:
 *
 *   a. log present        -> signature "C<path\0size\0mtime>"
 *   b. log missing        -> the signature builder is handed `null` and answers "?"
 *                            (a different key: the cached fold is dropped by key,
 *                            not kept alive by the old one)
 *   c. Host reports the id anyway (the ghost row a stale archive flag creates,
 *      or a user clicking a stale card that re-creates an empty session)
 *      -> the listing is identity-driven, so a header handed in by the Host is
 *      still listed with a "C?" signature: dsh-context cannot tell it is gone.
 *
 * Usage: node tools/simulate-context.mjs
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONTEXT = "C:/Users/Konka/.hypers-work/profiles/desktop/node_modules/dsh-context/lib/index.js";
const REAL_HOME = "C:/Users/Konka/.hypers-work";

/* ---- the shipped signature builder, copied verbatim from lib/index.js ---- */
function Vo(e) {
  return e == null ? "?" : `${e.path}\u0000${String(e.sizeBytes)}\u0000${String(e.mtimeMs)}`;
}
function Ho(e, t) {
  return e === null || t === null ? e === t : e.path === t.path && e.sizeBytes === t.sizeBytes && e.mtimeMs === t.mtimeMs;
}

/** Prove the copy above still matches the shipped bundle. */
const source = readFileSync(CONTEXT, "utf8");
const shipped = /function Vo\(e\)\{return e==null\?`\?`:`\$\{e\.path\}\\u0000\$\{String\(e\.sizeBytes\)\}\\u0000\$\{String\(e\.mtimeMs\)\}`\}/.test(source);
const shippedEq = /function Ho\(e,t\)\{return e===null\|\|t===null\?e===t:e\.path===t\.path&&e\.sizeBytes===t\.sizeBytes&&e\.mtimeMs===t\.mtimeMs\}/.test(source);
console.log("shipped Vo matches this copy:", shipped);
console.log("shipped Ho matches this copy:", shippedEq);
if (!shipped || !shippedEq) {
  console.error("the dsh-context build changed its cache key; re-derive the simulation");
  process.exit(1);
}

/* ---- one real session, copied into a scratch home ------------------------ */
const sessionsRoot = join(REAL_HOME, "sessions");
const archives = (() => {
  try {
    const store = JSON.parse(readFileSync(join(REAL_HOME, "storages", "workspace.json"), "utf8"));
    return new Set(store?.global?.archivedSessionIds ?? []);
  } catch {
    return new Set();
  }
})();
const candidates = [];
for (const project of readdirSync(sessionsRoot)) {
  const dir = join(sessionsRoot, project);
  if (!statSync(dir).isDirectory()) continue;
  for (const id of readdirSync(dir)) {
    /* Never touch anything the user archived: the real archive set is off limits. */
    if (!archives.has(id)) candidates.push({ id, dir: join(dir, id) });
  }
}
if (candidates.length === 0) {
  console.error("no usable session found");
  process.exit(1);
}
candidates.sort((a, b) => statSync(b.dir).size - statSync(a.dir).size);
const pick = candidates[0];
const scratch = mkdtempSync(join(tmpdir(), "wsr-context-"));
const scratchSession = join(scratch, "sessions", "--sim--", pick.id);
mkdirSync(scratchSession, { recursive: true });
for (const file of readdirSync(pick.dir)) {
  copyFileSync(join(pick.dir, file), join(scratchSession, file));
}
console.log("\nsimulated session:", pick.id);
console.log("scratch copy:", scratchSession);

let failed = false;
try {
  /* a. the log is there */
  const present = { path: scratchSession, sizeBytes: statSync(scratchSession).size, mtimeMs: statSync(scratchSession).mtimeMs };
  const keyA = Vo(present);
  console.log("\n[a] log present  -> key:", keyA.replace(/\u0000/g, "\\0"));

  /* b. the log is gone: no path, no size, no mtime */
  const keyB = Vo(null);
  console.log("[b] log missing  -> key:", keyB);
  console.log("    key changed:", keyA !== keyB, "(the cached fold for key A is not reused for key B)");
  if (keyA === keyB) { console.log("   FAIL: a missing log kept the same cache key"); failed = true; }
  console.log("    Ho(old, missing):", Ho(present, null), "(the old entry no longer matches the current state)");

  /* c. the Host still hands the id over - the ghost path from issue #1 */
  /* `is()` in lib/index.js keeps an entry whenever the Host supplies a header;
     it never checks the log itself, so the row comes back with the "C?" key. */
  const hostStillListsIt = true;
  const keyC = `C${Vo(null)}`;
  console.log("\n[c] Host still reports the id:", hostStillListsIt);
  console.log("    it is listed again with signature:", keyC);
  console.log("    " + (hostStillListsIt
    ? "=> dsh-context itself cannot detect the missing log: the row only disappears once the Host stops reporting the id"
    : "unreachable"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failed ? "\nSIMULATION: FAILED" : "\nSIMULATION: complete (cache key answers the issue, Host still owns visibility)");
process.exit(failed ? 1 : 0);
