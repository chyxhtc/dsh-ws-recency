#!/usr/bin/env node
/**
 * Publish gate.
 *
 * Publishing leaves a version behind that other people can install, and npm
 * staging can make a "failed" publish appear later anyway. So this script runs
 * nothing unless the version is named twice: once as the argument and once with
 * --approved, which is the mark that the change was verified outside this tool.
 *
 *   node tools/publish.mjs 0.36.0 --approved
 *   node tools/publish.mjs 0.36.0 --approved --no-github
 *
 * It runs the suites, publishes, waits for the registry to serve the version, and
 * then creates the GitHub release. It refuses on a dirty tree or a version that
 * does not match package.json.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const version = args.find((arg) => /^\d+\.\d+\.\d+$/.test(arg));
const approved = args.includes("--approved");
const wantGithub = !args.includes("--no-github");

if (version === undefined || !approved) {
  console.log("Refusing to publish.");
  console.log("");
  console.log("Publishing is gated on a human check: commit the change locally, verify it in");
  console.log("the app, then run this with the version and --approved.");
  console.log("");
  console.log("  node tools/publish.mjs " + (version ?? "<version>") + " --approved");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.version !== version) {
  console.error(`package.json says ${pkg.version}, the argument says ${version}. Bump it first.`);
  process.exit(1);
}

const run = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, {
    stdio: "inherit",
    cwd: new URL("..", import.meta.url),
    /* npm is a .cmd shim on Windows and is only found through the shell. */
    shell: process.platform === "win32",
    ...options,
  });

const status = execFileSync("git", ["status", "--porcelain"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});
if (status.trim() !== "") {
  console.error("The tree is dirty; commit first so the published tarball matches a commit.");
  console.error(status);
  process.exit(1);
}

/* 1. The suites, every one of them. */
const suites = ["selfcheck", "stats", "search", "move", "trash", "archive", "archive-page", "handoff"];
for (const suite of suites) {
  console.log(`\n--- tests/${suite}.cjs ---`);
  run("node", [`tests/${suite}.cjs`]);
}

/* 2. Publish, then wait until the registry actually serves it. */
console.log("\n--- npm publish ---");
run("npm", ["publish"]);

const waitForRegistry = async () => {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/${version}`, {
      headers: { "cache-control": "no-cache" },
    });
    if (res.status === 200) return true;
    console.log(`registry says ${res.status}; waiting 20s`);
    await new Promise((resolve) => setTimeout(resolve, 20000));
  }
  return false;
};
if (!(await waitForRegistry())) {
  console.error("The registry never served this version. Check npm before announcing it.");
  process.exit(1);
}
console.log(`\nnpm serves ${pkg.name}@${version}`);

/* 3. The GitHub release, with the same tarball. */
if (wantGithub) {
  const token = process.env.GH_TOKEN;
  if (token === undefined || token === "") {
    console.log("\nGH_TOKEN is not set; skipping the GitHub release.");
    console.log("Run: $env:GH_TOKEN=...; node tools/release.mjs v" + version + ' "' + version + '" HANDOFF.md dsh-ws-recency-' + version + ".tgz");
  } else {
    console.log("\n--- github release ---");
    run("npm", ["pack"]);
    run("node", ["tools/release.mjs", `v${version}`, version, "HANDOFF.md", `${pkg.name}-${version}.tgz`]);
  }
}

console.log("\nDone. Packaging the tarball is the last step; remember to delete the local .tgz.");
