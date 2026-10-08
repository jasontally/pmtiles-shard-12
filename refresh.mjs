#!/usr/bin/env node
/**
 * Decide whether this shard should be rebuilt against a newer Protomaps build.
 *
 *   node refresh.mjs            update archive.json if a newer build is out
 *   node refresh.mjs --plan     print, change nothing
 *
 * This runs in GitHub Actions, in this repo, with no credentials. It writes
 * archive.json and the workflow commits it. The commit is what triggers the
 * Cloudflare build, which is where the archive is actually fetched, and Cloudflare
 * injects its own token there. Nothing outside Cloudflare ever holds one.
 *
 * WHY EVERY SHARD PICKS THE SAME BUILD WITHOUT TALKING TO EACH OTHER
 *
 * Each of the 13 repos runs this independently, so "the newest build" would give
 * 13 different answers if a Protomaps build landed halfway through the window and
 * some shards had already run. The answer is therefore anchored to a fixed point:
 *
 *   target = the newest Protomaps build published BEFORE the most recent
 *            Sunday 00:30 UTC
 *
 * Every repo computes the same anchor, so every repo computes the same target,
 * whichever minute of the window it happens to run at. A build that appears
 * mid-window is simply ignored until the next week, which is the whole point of
 * scheduling inside the quiet hours in the first place.
 *
 * WHY NOT JUST USE THE NEWEST
 *
 * Because Protomaps lists a build before it has finished writing it. Fetching a
 * half written archive gives parts that are the right length and the wrong bytes,
 * which no size check would catch. Anchoring to a build that has been published
 * for at least MIN_AGE_HOURS removes that.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUILDS_URL = "https://build-metadata.protomaps.dev/builds.json";
const ARCHIVE_BASE = "https://build.protomaps.com/";

/**
 * The quiet window opens Sunday 00:30 UTC. 00:16 to 07:34 UTC is the only span
 * in which Protomaps has not published in 159 weeks of release history.
 */
const WINDOW_HOUR_UTC = 0;
const WINDOW_MINUTE_UTC = 30;

/**
 * A build must have been published this long before we cut parts from it. The
 * anchor already keeps it days old, so this is a second line of defence.
 */
const MIN_AGE_HOURS = 4;

const planOnly = process.argv.includes("--plan");
const force = process.argv.includes("--force");

/** Tell GitHub Actions what happened, so a step can be conditional on it. */
function output(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  writeFileSync(file, `${name}=${value}\n`, { flag: "a" });
}

export function windowOpen(now = new Date()) {
  /**
   * The most recent Sunday 00:30 UTC at or before `now`.
   *
   * Stepping back a whole week if that moment is still ahead of us means the
   * anchor never depends on the clock within a run, so a repo that fires a few
   * minutes early cannot pick a different target from the other twelve.
   */
  const open = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), WINDOW_HOUR_UTC, WINDOW_MINUTE_UTC, 0)
  );
  open.setUTCDate(open.getUTCDate() - open.getUTCDay());
  if (open.getTime() > now.getTime()) open.setUTCDate(open.getUTCDate() - 7);
  return open;
}

/** The newest build published before the anchor. */
export function pickTarget(builds, now = new Date()) {
  const open = windowOpen(now);
  const eligible = builds
    .filter((build) => new Date(build.uploaded).getTime() < open.getTime())
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  if (!eligible.length) return null;
  return { ...eligible[eligible.length - 1], windowOpen: open.toISOString() };
}

export function archiveFile(key) {
  return `${key}.pmtiles`;
}

export function archiveUrl(key) {
  return `${ARCHIVE_BASE}${archiveFile(key)}`;
}

/** Read the key this shard currently holds, or null if it has none. */
export function currentKey(file = join(process.cwd(), "archive.json")) {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return doc.key || null;
  } catch {
    return null;
  }
}

async function main() {
  const response = await fetch(BUILDS_URL);
  if (!response.ok) fail(`${BUILDS_URL} returned ${response.status}`);
  const builds = await response.json();
  if (!Array.isArray(builds) || !builds.length) fail("no builds listed");

  const now = new Date();
  const target = pickTarget(builds, now);
  if (!target) fail("no Protomaps build was published before the window opened");

  const held = currentKey();
  const ageHours = (now.getTime() - new Date(target.uploaded).getTime()) / 3600000;

  console.log(`window    ${target.windowOpen} UTC, the anchor every shard uses`);
  console.log(`newest    ${newestKey(builds)}`);
  console.log(`target    ${target.key}  ${(target.size / 1e9).toFixed(1)} GB  ` +
    `published ${target.uploaded}  ${ageHours.toFixed(1)} h ago`);
  console.log(`holding   ${held ?? "nothing"}`);

  if (ageHours < MIN_AGE_HOURS) {
    // The anchor should make this impossible. If it ever fires, refusing is far
    // better than cutting parts from an archive that is still being written.
    fail(`the target is only ${ageHours.toFixed(1)} h old and the minimum is ${MIN_AGE_HOURS} h`);
  }

  if (held === target.key && !force) {
    console.log("no change, so no commit and no rebuild. That is the common case.");
    output("changed", "false");
    output("key", target.key);
    return;
  }

  if (held === target.key) {
    console.log("forced, so rebuilding against the build this shard already holds");
  }
  console.log(`update    archive.json to ${target.key}`);
  output("changed", "true");
  output("key", target.key);
  if (planOnly) {
    console.log("plan      nothing written");
    return;
  }

  writeFileSync(
    join(process.cwd(), "archive.json"),
    `${JSON.stringify(
      {
        key: target.key,
        url: archiveUrl(target.key),
        note:
          "Which Protomaps Basemap build this shard holds. .github/workflows/refresh.yml " +
          "commits a newer key here, and that commit is what triggers the build. " +
          "Do not hand edit without knowing why.",
      },
      null,
      2
    )}\n`
  );
  console.log("written   the workflow commits it, and the commit starts the build");
}

function newestKey(builds) {
  const sorted = builds.slice().sort((a, b) => (a.key < b.key ? -1 : 1));
  return sorted[sorted.length - 1].key;
}

function fail(message) {
  console.error(`refresh failed: ${message}`);
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("refresh.mjs")) main();