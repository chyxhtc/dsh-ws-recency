#!/usr/bin/env node
/**
 * Create a GitHub Release for the current version and upload its tarball.
 *
 * The token comes from the environment, and on this machine it is already in
 * Windows Credential Manager:
 *
 *   $out = "protocol=https`nhost=github.com`nusername=chyxhtc`n`n" | git credential fill
 *   $env:GH_TOKEN = (($out | Where-Object { $_ -match "^password=" }) -replace "^password=","")
 *   node tools/release.mjs v1.2.3 "1.2.3" notes.md dsh-ws-recency-1.2.3.tgz
 *
 * `undici` is resolved from the running app because the repo does not depend on
 * it; the proxy is the one this machine uses for api.github.com.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const appRequire = createRequire(process.env.DSH_APP_PACKAGE || "D:/IDE/Hypers Work/resources/app/package.json");
const { ProxyAgent, fetch: ufetch } = appRequire("undici");

const token = process.env.GH_TOKEN || "";
if (token === "") {
  console.error("GH_TOKEN is empty: read it from the credential manager first");
  process.exit(1);
}

const repo = process.env.GH_REPO || "chyxhtc/dsh-ws-recency";
const proxy = process.env.HTTPS_PROXY || "http://127.0.0.1:7897";
const dispatcher = new ProxyAgent(proxy);

const tag = process.argv[2];
const name = process.argv[3] || tag;
const notesFile = process.argv[4];
const asset = process.argv[5];
if (!tag) {
  console.error("usage: node tools/release.mjs <tag> [name] [notes.md] [asset.tgz]");
  process.exit(1);
}

const call = (url, init = {}) => ufetch(url, {
  dispatcher,
  signal: AbortSignal.timeout(120000),
  ...init,
  headers: {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "dsh-ws-recency-release",
    ...(init.headers || {}),
  },
});

let release = null;
const existing = await call(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
if (existing.status === 200) {
  release = await existing.json();
  console.log("release exists:", release.html_url);
} else {
  const body = notesFile !== undefined && existsSync(notesFile) ? readFileSync(notesFile, "utf8") : "";
  const created = await call(`https://api.github.com/repos/${repo}/releases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name, body, draft: false, prerelease: false }),
  });
  const text = await created.text();
  if (created.status !== 201) {
    console.error("create failed", created.status, text.slice(0, 300));
    process.exit(1);
  }
  release = JSON.parse(text);
  console.log("created:", release.html_url);
}

if (asset === undefined || !existsSync(asset)) process.exit(0);

const fileName = asset.split(/[\\/]/).pop();
const listed = await call(`https://api.github.com/repos/${repo}/releases/${release.id}/assets`);
const assets = listed.status === 200 ? await listed.json() : [];
if (assets.some((item) => item.name === fileName)) {
  console.log("asset already present:", fileName);
  process.exit(0);
}

const bytes = readFileSync(asset);
const upload = await call(
  `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`,
  { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) }, body: bytes },
);
const text = await upload.text();
if (upload.status !== 201) {
  console.error("upload failed", upload.status, text.slice(0, 300));
  process.exit(1);
}
const parsed = JSON.parse(text);
console.log("uploaded:", parsed.name, parsed.size, parsed.browser_download_url);
