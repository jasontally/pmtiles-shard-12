/**
 * Tests for the shard refresh decision. Run with: node shard-repo/refresh.test.mjs
 *
 * Each shard repo runs this independently and none of them can talk to the
 * others, so the rule has to give the same answer in all of them no matter which
 * minute of the window each one fires at. That is the property these tests exist
 * to pin down: a shard refreshing 30 seconds before another must not pick a
 * different Protomaps build, because half the shards would then hold one archive
 * and half another and the reader could not tell.
 *
 * Nothing here touches the network or needs a credential.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { windowOpen, pickTarget, archiveUrl, archiveFile, wouldDowngrade } from "./refresh.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

const at = (iso) => new Date(iso);

// A history with releases on both sides of the first Sunday in it.
const BUILDS = [
  { key: "20260920.pmtiles", uploaded: "2026-09-20T09:00:00Z", size: 130e9 },
  { key: "20260927.pmtiles", uploaded: "2026-09-27T09:00:00Z", size: 131e9 },
  { key: "20261001.pmtiles", uploaded: "2026-10-01T08:00:00Z", size: 132e9 },
  { key: "20261002.pmtiles", uploaded: "2026-10-02T09:00:00Z", size: 133e9 },
  { key: "20261003.pmtiles", uploaded: "2026-10-03T09:01:00Z", size: 138.5e9 },
  // Published after the first Sunday. Must be ignored until November.
  { key: "20261010.pmtiles", uploaded: "2026-10-10T09:00:00Z", size: 139e9 },
  { key: "20261012.pmtiles", uploaded: "2026-10-12T09:00:00Z", size: 140e9 },
];

await check("the anchor is the first Sunday of the month at 00:30", () => {
  // 2026-10-04 is the first Sunday of October 2026.
  assert.equal(windowOpen(at("2026-10-04T00:31:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
  assert.equal(windowOpen(at("2026-10-04T23:59:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
  // The fourth Sunday of the same month must not move the anchor.
  assert.equal(windowOpen(at("2026-10-25T12:00:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
});

await check("the first Sunday is the 1st or the 7th when the month starts there", () => {
  // February 2026 starts on a Sunday, so the anchor is the 1st.
  assert.equal(windowOpen(at("2026-02-20T12:00:00Z")).toISOString(), "2026-02-01T00:30:00.000Z");
  // June 2026 starts on a Monday, so the anchor is the 7th.
  assert.equal(windowOpen(at("2026-06-20T12:00:00Z")).toISOString(), "2026-06-07T00:30:00.000Z");
});

await check("on any other weekday the anchor is the first Sunday of that month", () => {
  assert.equal(windowOpen(at("2026-10-05T03:00:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
  assert.equal(windowOpen(at("2026-10-07T09:00:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
  // 2026-09-06 is the first Sunday of September.
  assert.equal(windowOpen(at("2026-09-03T12:00:00Z")).toISOString(), "2026-08-02T00:30:00.000Z");
  assert.equal(windowOpen(at("2026-09-08T12:00:00Z")).toISOString(), "2026-09-06T00:30:00.000Z");
});

await check("before the first Sunday it uses the previous month, never the future", () => {
  const october = windowOpen(at("2026-10-01T00:10:00Z"));
  assert.equal(october.toISOString(), "2026-09-06T00:30:00.000Z");
  assert.ok(october.getTime() < at("2026-10-01T00:10:00Z").getTime(), "the anchor is in the future");
  // November 2026 starts on a Sunday. Ten minutes earlier the anchor is still
  // October's, which is what keeps a run from picking a build published today.
  assert.equal(windowOpen(at("2026-11-01T00:10:00Z")).toISOString(), "2026-10-04T00:30:00.000Z");
  // And January rolls back across the year boundary.
  assert.equal(windowOpen(at("2027-01-01T00:00:00Z")).toISOString(), "2026-12-06T00:30:00.000Z");
});

await check("every shard in one month picks the same build", () => {
  // The property the design rests on: many repos, many different minutes, one
  // answer. These are the slot times of the 13 shards sampled for speed.
  const minutes = [
    "2026-10-04T00:31:00Z", "2026-10-04T01:00:00Z", "2026-10-04T01:30:00Z",
    "2026-10-04T02:00:00Z", "2026-10-04T02:30:00Z", "2026-10-04T03:00:00Z",
    "2026-10-04T03:30:00Z", "2026-10-04T04:00:00Z", "2026-10-04T04:30:00Z",
    "2026-10-04T05:00:00Z", "2026-10-04T05:30:00Z", "2026-10-04T06:00:00Z",
    "2026-10-04T06:30:00Z",
  ];
  const targets = new Set(minutes.map((iso) => pickTarget(BUILDS, at(iso)).key));
  assert.equal(targets.size, 1, `the sampled shards chose ${[...targets].join(", ")}`);
  assert.equal([...targets][0], "20261003.pmtiles");
});

await check("a build published after the first Sunday waits for next month", () => {
  // 20261010 and 20261012 are after the October anchor, so the next three
  // Sundays must still choose the October target. That is the monthly cadence.
  assert.equal(pickTarget(BUILDS, at("2026-10-11T06:30:00Z")).key, "20261003.pmtiles");
  assert.equal(pickTarget(BUILDS, at("2026-10-31T23:00:00Z")).key, "20261003.pmtiles");
  // 2026-11-01 is the first Sunday of November, so the anchor moves and takes
  // the newest build published before it.
  assert.equal(pickTarget(BUILDS, at("2026-11-01T00:31:00Z")).key, "20261012.pmtiles");
});

await check("the anchor is the only thing that moves the target", () => {
  const before = pickTarget(BUILDS, at("2026-10-04T00:31:00Z")).key;
  const after = pickTarget(BUILDS, at("2026-10-31T23:00:00Z")).key;
  assert.equal(before, after);
});

await check("a build published exactly at the anchor is excluded", () => {
  // Strictly before the anchor. A build landing at 00:30 on the first Sunday
  // must not be picked by a shard that fires at 00:31, or the answer would
  // depend on the minute a repo happened to run at.
  const edge = [
    { key: "20261003.pmtiles", uploaded: "2026-10-03T09:01:00Z", size: 138.5e9 },
    { key: "20261004.pmtiles", uploaded: "2026-10-04T00:30:00Z", size: 139e9 },
  ];
  assert.equal(pickTarget(edge, at("2026-10-04T00:31:00Z")).key, "20261003.pmtiles",
    "a shard firing just after the anchor must not take a build that landed on it");
  assert.equal(pickTarget(edge, at("2026-10-31T23:00:00Z")).key, "20261003.pmtiles",
    "nor may a later shard in the same month");
  assert.equal(pickTarget(edge, at("2026-11-01T06:00:00Z")).key, "20261004.pmtiles",
    "next month it is eligible, because the anchor has moved past it");
});

await check("a shard never moves to an older build", () => {
  // The monthly anchor can point behind what a shard holds, for example on a
  // mid-month dispatch. Rebuilding 25 Workers with older data would cost a full
  // refresh and churn the cache for nothing.
  assert.equal(wouldDowngrade("20261024.pmtiles", "20260811.pmtiles"), true);
  assert.equal(wouldDowngrade("20260811.pmtiles", "20261024.pmtiles"), false);
  assert.equal(wouldDowngrade("20261024.pmtiles", "20261024.pmtiles"), false);
  assert.equal(wouldDowngrade(null, "20260811.pmtiles"), false);
});

await check("no eligible build is reported, not guessed", () => {
  // Every build is newer than the anchor, so there is nothing to hold. Guessing
  // here would cut shards from an archive that is still being written.
  const future = [{ key: "20270101.pmtiles", uploaded: "2027-01-01T09:00:00Z", size: 1e11 }];
  assert.equal(pickTarget(future, at("2026-10-04T06:00:00Z")), null);
});

await check("the url and file name are the ones Protomaps serves", () => {
  assert.equal(archiveFile("20261003"), "20261003.pmtiles");
  assert.equal(archiveUrl("20261003"), "https://build.protomaps.com/20261003.pmtiles");
  // The shape builds.json actually returns. Every key in the 62 listed builds
  // ends in ".pmtiles", so this is the input the refresh really gets. Appending
  // again here produced 20261010.pmtiles.pmtiles, which 404s, and that 404 is
  // what failed all 13 shard builds on Sunday 2026-10-11.
  assert.equal(archiveFile("20261003.pmtiles"), "20261003.pmtiles");
  assert.equal(archiveUrl("20261003.pmtiles"), "https://build.protomaps.com/20261003.pmtiles");
});

await check("a plan run writes nothing", () => {
  const fs = execFileSync(process.execPath, [join(HERE, "refresh.mjs"), "--plan"], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.ok(fs.includes("archive.json") || fs.includes("no change"), fs.slice(0, 300));
  const after = execFileSync(process.execPath, [join(HERE, "refresh.mjs"), "--plan"], {
    encoding: "utf8",
    timeout: 120000,
  });
  // A plan run must be repeatable, so it must not consume the change it found.
  assert.equal(
    /no change/.test(fs),
    /no change/.test(after),
    "a plan run consumed the change instead of reporting it"
  );
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);