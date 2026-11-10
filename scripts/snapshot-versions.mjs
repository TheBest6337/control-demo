#!/usr/bin/env node
// Snapshot of qitechgmbh/control's versions for the demo's Update page:
// tags, branches, the last 1000 master commits and CHANGELOG.md at each of them,
// the same lists control's updater shows (electron/src/helpers/ipc/update/git-fetch-utils.ts).
// The demo makes no network requests, so the page reads this file instead.
//
//   node scripts/snapshot-versions.mjs [path/to/control]   (default: ../control)
//
// Run by scripts/sync-ui.sh; reads the control checkout after a `git fetch`.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const control = path.resolve(process.argv[2] ?? path.join(here, "..", "control"));
const out = path.join(here, "ui", "src", "demo", "control-versions.json");

const git = (...args) =>
  execFileSync("git", ["-C", control, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
const lines = (s) => s.split("\n").filter(Boolean);

git("fetch", "--prune", "--tags", "origin");

// "%(refname:short)" of refs/remotes/origin/x is "origin/x"
const branches = lines(
  git(
    "for-each-ref",
    "refs/remotes/origin",
    "--sort=-committerdate",
    "--format=%(objectname)|%(refname:short)|%(committerdate:iso-strict)",
  ),
)
  .map((l) => l.split("|"))
  .filter(([, name]) => name !== "origin/HEAD" && name !== "origin")
  .map(([hash, name, date]) => ({ hash, name: name.replace(/^origin\//, ""), date }));

// newest version first; release candidates sort below their release
const tags = lines(
  git(
    "-c",
    "versionsort.suffix=-",
    "for-each-ref",
    "refs/tags",
    "--sort=-version:refname",
    "--format=%(objectname)|%(refname:short)|%(creatordate:iso-strict)|%(*objectname)",
  ),
).map((l) => {
  const [object, name, date, peeled] = l.split("|");
  return { hash: peeled || object, name, date };
});

const commits = lines(
  git("log", "origin/master", "--max-count=1000", "--pretty=format:%H|%cI|%f"),
).map((l) => {
  const [hash, date, name] = l.split("|");
  return { hash, name, date };
});

// CHANGELOG.md per ref, stored once per distinct content
const changelogs = [];
const blobIndex = new Map();
const refs = {};
const addRef = (key, rev) => {
  let blob;
  try {
    blob = git("rev-parse", "-q", "--verify", `${rev}:CHANGELOG.md`).trim();
  } catch {
    return; // no changelog at this ref; the page shows git's error like control
  }
  if (!blobIndex.has(blob)) {
    blobIndex.set(blob, changelogs.length);
    changelogs.push(git("cat-file", "blob", blob));
  }
  refs[key] = blobIndex.get(blob);
};
for (const t of tags) addRef(t.name, t.hash);
for (const b of branches) addRef(b.name, b.hash);
for (const c of commits) addRef(c.hash, c.hash);

// the version the vendored UI comes from (ui/UPSTREAM)
const upstream = readFileSync(path.join(here, "ui", "UPSTREAM"), "utf8").trim();
addRef(upstream, upstream);
const current = {
  commit: upstream,
  timestamp: git("show", "-s", "--format=%cI", upstream).trim(),
  abbreviation: "master",
};

const snapshot = {
  source: { githubRepoOwner: "qitechgmbh", githubRepoName: "control" },
  createdAt: new Date().toISOString(),
  current,
  tags,
  branches,
  commits,
  refs,
  changelogs,
};
writeFileSync(out, JSON.stringify(snapshot));
console.log(
  `${path.relative(here, out)}: ${tags.length} tags, ${branches.length} branches, ` +
    `${commits.length} commits, ${changelogs.length} changelogs`,
);
