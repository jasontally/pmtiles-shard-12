/**
 * Tests for the shard slots and the shard check. Run with: node shard-repo/verify-shard.test.mjs
 *
 * The slots decide when each shard builds. If two of them share a minute, the
 * builds start together and the ones at the back of the queue can run out of
 * time. Three of 25 did on 18 October 2026.
 *
 * The check is what notices a shard that failed. It must find a shard that
 * holds the old archive, and it must not complain about one that holds the
 * right archive.
 *
 * Nothing here touches the network or needs a credential.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ORDER, slotFor, verifyFor } from "./render-workflow.mjs";
import { checkShard, partsFor, partOffset, partUrl } from "./verify-shard.mjs";

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

const HEAD_BYTES = 16384;

/** A PMTiles v3 header for an archive with the given tile length. */
function headerOf(tileLength) {
  const bytes = new Uint8Array(HEAD_BYTES);
  bytes.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]);
  bytes[7] = 3;
  const view = new DataView(bytes.buffer);
  const u64 = (off, value) => view.setBigUint64(off, BigInt(value), true);
  u64(8, 127);
  u64(16, 100);
  u64(24, 200000);
  u64(32, 1180);
  u64(40, 201180);
  u64(48, 500000);
  u64(56, HEAD_BYTES);
  u64(64, tileLength);
  bytes[100] = 0;
  bytes[101] = 15;
  return bytes;
}

await check("every shard has its own slot", () => {
  const slots = ORDER.map((index) => slotFor(index).cron);
  assert.equal(slots.length, 25, "the order must name 25 shards");
  assert.equal(new Set(slots).size, 25, "two shards share a slot");
});

await check("the slots run in order and shard 0 is last", () => {
  const times = ORDER.map((index) => {
    const slot = slotFor(index);
    return slot.hour * 60 + slot.minute;
  });
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], `slot ${i} is not after slot ${i - 1}`);
  }
  assert.equal(ORDER[ORDER.length - 1], 0, "shard 0 must be last");
});

await check("the slots sit inside the quiet window", () => {
  // Protomaps has never published between 00:16 and 07:34 UTC.
  for (const index of ORDER) {
    const slot = slotFor(index);
    const minutes = slot.hour * 60 + slot.minute;
    assert.ok(minutes >= 16, `shard ${index} starts before the window opens`);
    assert.ok(minutes <= 7 * 60 + 34, `shard ${index} starts after the window closes`);
  }
});

await check("the verify workflow checks the shard and commits", () => {
  const workflow = verifyFor(16);
  assert.ok(workflow.includes("node verify-shard.mjs 16"), "the check is missing");
  assert.ok(workflow.includes("git commit"), "the commit is missing");
  assert.ok(workflow.includes("git push"), "the push is missing");
  assert.ok(workflow.includes("permissions:\n  contents: write"), "it cannot commit");
  assert.ok(!workflow.includes("secrets."), "it must not need a secret");
});

await check("the parts of a shard follow the archive", () => {
  const header = { tileDataOffset: HEAD_BYTES, tileDataLength: 138_588_222_487 };
  const { first, last, tilePartsPerShard } = partsFor(header, 16);
  assert.equal(tilePartsPerShard, 5544, "the parts per shard");
  assert.equal(first, 16 * 5544, "the first part");
  assert.equal(last, 17 * 5544 - 1, "the last part");
  assert.equal(partOffset(header, first), HEAD_BYTES + first * 1_000_000, "the offset");
  assert.ok(partUrl(16, last).endsWith("/tile/094247.bin"), "the part url");
});

/**
 * The archive bytes, with the header at the front and the part under test at
 * its own offset.
 */
function archiveWith(header, part) {
  const offset = partOffset(header, part);
  const bytes = new Uint8Array(offset + 8192);
  bytes.set(headerOf(30_000_000).subarray(0, 127), 0);
  for (let i = offset; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  return bytes;
}

/** A fetch that serves the archive and a shard, both from memory. */
function fakeFetch({ archiveBytes, shardBytes, shardStatus = 200, shardBody = null }) {
  return async (url, init) => {
    const range = init && init.headers && init.headers.Range;
    if (!range) {
      if (shardStatus !== 200) return new Response("missing", { status: shardStatus });
      return new Response(shardBytes, { status: 200 });
    }
    const match = /bytes=(\d+)-(\d+)/.exec(range);
    const from = Number(match[1]);
    const to = Number(match[2]);
    return new Response(archiveBytes.subarray(from, to + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${from}-${to}/${archiveBytes.length}` },
    });
  };
}

await check("a shard that holds the archive passes the check", async () => {
  const header = { tileDataOffset: HEAD_BYTES, tileDataLength: 30_000_000 };
  const archiveBytes = archiveWith(header, 3);
  const offset = partOffset(header, 3);
  const shardBytes = archiveBytes.slice(offset, offset + 4096);
  const result = await checkShard({
    shardIndex: 1,
    header,
    archiveUrl: "https://example.test/archive",
    fetchImpl: fakeFetch({
      archiveBytes,
      shardBytes,
    }),
  });
  assert.ok(result.ok, `the check failed: ${result.reason}`);
});

await check("a shard that does not have the part fails the check", async () => {
  const header = { tileDataOffset: HEAD_BYTES, tileDataLength: 30_000_000 };
  const archiveBytes = archiveWith(header, 3);
  const result = await checkShard({
    shardIndex: 1,
    header,
    archiveUrl: "https://example.test/archive",
    fetchImpl: fakeFetch({ archiveBytes, shardBytes: new Uint8Array(0), shardStatus: 404 }),
  });
  assert.ok(!result.ok, "the check passed a shard that serves nothing");
  assert.ok(/does not serve part/.test(result.reason), result.reason);
});

await check("a shard with the wrong bytes fails the check", async () => {
  const header = { tileDataOffset: HEAD_BYTES, tileDataLength: 30_000_000 };
  const archiveBytes = archiveWith(header, 3);
  const result = await checkShard({
    shardIndex: 1,
    header,
    archiveUrl: "https://example.test/archive",
    fetchImpl: fakeFetch({
      archiveBytes,
      shardBytes: new Uint8Array(4096).fill(9),
    }),
  });
  assert.ok(!result.ok, "the check passed a shard with the wrong bytes");
  assert.ok(/does not hold the archive bytes/.test(result.reason), result.reason);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
