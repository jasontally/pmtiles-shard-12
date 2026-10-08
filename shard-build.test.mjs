/**
 * Tests for the shard build. Run with: node shard-build.test.mjs
 *
 * The extractor writes 10 GB of parts per build from a stream it never stores.
 * A byte written to the wrong part is a corrupted tile in production, and the
 * shard boundary arithmetic decides which host holds which byte. These tests
 * build small archives, run the real extractor over a stream with awkward chunk
 * sizes, and compare every part with the source byte for byte.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PartExtractor, groupRuns, shardParts } from "./build.mjs";

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

const HEAD_BYTES = 16_384;

function makeArchive({ tileLength, metaLength, leafLength }) {
  const tileOffset = HEAD_BYTES;
  const metaOffset = tileOffset + tileLength;
  const leafOffset = metaOffset + metaLength;
  const total = leafOffset + leafLength;

  const header = new Uint8Array(127);
  header.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]);
  header[7] = 3;
  const view = new DataView(header.buffer);
  const u64 = (off, value) => view.setBigUint64(off, BigInt(value), true);
  u64(8, 127);
  u64(16, 100);
  u64(24, metaOffset);
  u64(32, metaLength);
  u64(40, leafOffset);
  u64(48, leafLength);
  u64(56, tileOffset);
  u64(64, tileLength);
  header[96] = 1;
  header[97] = 2;
  header[98] = 2;
  header[99] = 1;
  header[100] = 0;
  header[101] = 15;

  const bytes = new Uint8Array(total);
  bytes.set(header, 0);
  for (let i = 127; i < total; i++) bytes[i] = (i * 37 + (i >> 5)) & 0xff;
  return { bytes, total };
}

function headerOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 127);
  const u64 = (off) => Number(view.getBigUint64(off, true));
  return {
    rootDirOffset: u64(8), rootDirLength: u64(16),
    metadataOffset: u64(24), metadataLength: u64(32),
    leafDirOffset: u64(40), leafDirLength: u64(48),
    tileDataOffset: u64(56), tileDataLength: u64(64),
    minZoom: bytes[100], maxZoom: bytes[101],
  };
}

/** Every file under dir, keyed by its relative path. */
function readTree(dir, base = dir, out = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) readTree(full, base, out);
    else out[full.slice(base.length + 1).replace(/\\/g, "/")] = readFileSync(full);
  }
  return out;
}

/**
 * Run the real extractor over the archive, delivered in fixed size chunks.
 * A real download never aligns to a part boundary, so the chunk size must not
 * share a factor with the part size or the test proves nothing.
 */
/**
 * Feed the extractor the way the build does: a Range request from the first
 * part to the last. `whole` instead feeds the entire archive from byte 0, which
 * is what happens if the source ignores the Range header.
 */
async function extract(archive, parts, outDir, chunkSize, whole = false) {
  const first = whole ? 0 : parts[0].start;
  const last = parts.at(-1);
  const end = whole ? archive.bytes.length : last.start + last.length;
  const extractor = new PartExtractor(parts, outDir, first);
  async function* chunks() {
    for (let i = first; i < end; i += chunkSize) {
      yield archive.bytes.subarray(i, Math.min(i + chunkSize, end));
    }
  }
  return extractor.consume(chunks());
}

// 600,000 / 100,000 = 6 tile parts, so 3 shards at 2 parts each are all
// non-empty. A 4 part fixture leaves the third shard empty.
const SMALL = { tileLength: 600_000, metaLength: 1_160, leafLength: 50_000 };
const TILE_SHARD = 100_000;
const LEAF_SHARD = 16_384;

function planFor(archive, shardIndex, shardCount) {
  const header = headerOf(archive.bytes);
  const tileParts = Math.ceil(header.tileDataLength / TILE_SHARD);
  const tilePartsPerShard = Math.ceil(tileParts / shardCount);
  const parts = shardParts({
    header, total: archive.total, shardIndex, shardCount,
    tileShard: TILE_SHARD, leafShard: LEAF_SHARD, tilePartsPerShard,
  });
  return { header, parts, tilePartsPerShard };
}

await check("shard 0 owns the head, metadata, leaves, and the first tile parts", () => {
  const archive = makeArchive(SMALL);
  const names = planFor(archive, 0, 3).parts.map((p) => p.name);
  assert.ok(names.includes("head.bin"), "no head.bin");
  assert.ok(names.includes("meta.bin"), "no meta.bin");
  assert.ok(names.some((n) => n.startsWith("leaf/")), "no leaf parts");
  assert.ok(names.includes("tile/000000.bin"), "no first tile part");
});

await check("a middle shard owns only tile parts", () => {
  const archive = makeArchive(SMALL);
  const parts = planFor(archive, 1, 3).parts;
  assert.ok(
    parts.every((p) => p.name.startsWith("tile/")),
    `a middle shard owns more than tiles: ${parts.map((p) => p.name).slice(0, 3)}`
  );
});

await check("every tile part belongs to exactly one shard, with no gap or overlap", () => {
  const archive = makeArchive({ tileLength: 1_000_000, metaLength: 100, leafLength: 1_000 });
  const header = headerOf(archive.bytes);
  const tileParts = Math.ceil(header.tileDataLength / TILE_SHARD);
  const shardCount = 3;

  const seen = new Map();
  for (let shard = 0; shard < shardCount; shard++) {
    const { parts } = planFor(archive, shard, shardCount);
    for (const part of parts) {
      if (!part.name.startsWith("tile/")) continue;
      assert.ok(!seen.has(part.name), `${part.name} was claimed twice`);
      seen.set(part.name, part);
    }
  }
  assert.equal(seen.size, tileParts, `${seen.size} of ${tileParts} tile parts were claimed`);

  const sorted = [...seen.values()].sort((x, y) => x.start - y.start);
  assert.equal(sorted[0].start, header.tileDataOffset, "coverage does not start at the tile data");
  assert.equal(
    sorted.at(-1).start + sorted.at(-1).length,
    header.tileDataOffset + header.tileDataLength,
    "coverage does not reach the end of the tile data"
  );
  for (let i = 1; i < sorted.length; i++) {
    assert.equal(
      sorted[i].start,
      sorted[i - 1].start + sorted[i - 1].length,
      `gap or overlap before ${sorted[i].name}`
    );
  }
});

await check("shards 1 and up download in one Range request", () => {
  const archive = makeArchive(SMALL);
  for (const shardIndex of [1, 2]) {
    const { parts } = planFor(archive, shardIndex, 3);
    const runs = groupRuns(parts);
    assert.equal(
      runs.length,
      1,
      `shard ${shardIndex} needs ${runs.length} requests, expected 1`
    );
  }
});

await check("shard 0 downloads in two requests, not one over the whole archive", () => {
  // The regression this guards: shard 0 owns the head, the first tile parts, and
  // the tail, with the other shards' tile data in the gap. One request spanning
  // its first and last part asks for every byte between them, which for the
  // real archive is all 118 GiB and cannot finish inside the 20 minute build.
  const archive = makeArchive(SMALL);
  const { parts } = planFor(archive, 0, 3);
  const runs = groupRuns(parts);
  assert.equal(runs.length, 2, `shard 0 needs ${runs.length} requests, expected 2`);

  const partBytes = parts.reduce((sum, part) => sum + part.length, 0);
  const runBytes = runs.reduce((sum, run) => sum + run.end - run.start, 0);
  assert.equal(runBytes, partBytes, "the runs must cover exactly the shard's own bytes");

  // The span from the first part to the last must be much larger, which is the
  // request we are avoiding.
  const span = parts.at(-1).start + parts.at(-1).length - parts[0].start;
  assert.ok(span > runBytes, "the fixture has no gap, so it proves nothing");
  // Every part lands in exactly one run, with no duplicates.
  const inRuns = runs.flatMap((run) => run.parts);
  assert.equal(inRuns.length, parts.length);
  assert.equal(new Set(inRuns.map((p) => p.name)).size, parts.length);
});

await check("shardParts refuses a shard index outside the range", () => {
  const archive = makeArchive(SMALL);
  assert.throws(() => planFor(archive, 9, 3), /owns no parts/);
});

await check("shardParts clamps the last part instead of overrunning", () => {
  // SMALL divides evenly by TILE_SHARD, so use a section that does not.
  const archive = makeArchive({ tileLength: 650_000, metaLength: 100, leafLength: 1_000 });
  const header = headerOf(archive.bytes);
  const tileParts = Math.ceil(header.tileDataLength / TILE_SHARD);
  const parts = shardParts({
    header, total: archive.total, shardIndex: 0, shardCount: 1,
    tileShard: TILE_SHARD, leafShard: LEAF_SHARD,
    tilePartsPerShard: tileParts,
  });
  const tiles = parts.filter((p) => p.name.startsWith("tile/"));
  const last = tiles.at(-1);
  const sectionEnd = header.tileDataOffset + header.tileDataLength;
  assert.ok(
    last.start + last.length <= sectionEnd,
    `the last tile part ends at ${last.start + last.length}, past ${sectionEnd}`
  );
  assert.ok(
    last.length < TILE_SHARD,
    `the last part is ${last.length}, expected it to be short of ${TILE_SHARD}`
  );
  // And the shortfall must equal the remainder, so no byte is dropped.
  assert.equal(
    last.length,
    header.tileDataLength - (tileParts - 1) * TILE_SHARD
  );
});

await check("shardParts refuses a part that runs past a shrunken archive", () => {
  // The overrun guard is only reachable when the header claims more than the
  // file holds, which a truncated download would produce.
  const archive = makeArchive(SMALL);
  const header = headerOf(archive.bytes);
  assert.throws(
    () => shardParts({
      header, total: archive.total - 500_000, shardIndex: 0, shardCount: 1,
      tileShard: TILE_SHARD, leafShard: LEAF_SHARD,
      tilePartsPerShard: Math.ceil(header.tileDataLength / TILE_SHARD),
    }),
    /past the archive end/
  );
});

// The real checks: every byte of every part must match the source, at chunk
// sizes that share no factor with the part size.
for (const shardCount of [3, 1]) {
  for (let shardIndex = 0; shardIndex < shardCount; shardIndex++) {
    for (const chunkSize of [65536, 997, 13, 1]) {
      await check(
        `shard ${shardIndex}/${shardCount} extracts byte for byte (chunk ${chunkSize})`,
        async () => {
          const archive = makeArchive(SMALL);
          const { parts } = planFor(archive, shardIndex, shardCount);
          const outDir = mkdtempSync(join(tmpdir(), "shard-"));
          try {
            const extractor = await extract(archive, parts, outDir, chunkSize);
            const expectedBytes = parts.reduce((sum, part) => sum + part.length, 0);
            assert.equal(
              extractor.written,
              expectedBytes,
              `wrote ${extractor.written}, expected ${expectedBytes}`
            );

            const written = readTree(outDir);
            assert.equal(
              Object.keys(written).length,
              parts.length,
              `wrote ${Object.keys(written).length} files, expected ${parts.length}`
            );
            for (const part of parts) {
              assert.ok(existsSync(join(outDir, part.name)), `${part.name} is missing`);
              assert.ok(
                written[part.name].equals(
                  Buffer.from(archive.bytes.subarray(part.start, part.start + part.length))
                ),
                `${part.name} does not match the source`
              );
            }
          } finally {
            rmSync(outDir, { recursive: true, force: true });
          }
        }
      );
    }
  }
}

await check("a shard written twice produces identical bytes", async () => {
  const archive = makeArchive(SMALL);
  const { parts } = planFor(archive, 0, 3);
  const first = mkdtempSync(join(tmpdir(), "shard-a-"));
  const second = mkdtempSync(join(tmpdir(), "shard-b-"));
  try {
    await extract(archive, parts, first, 997);
    await extract(archive, parts, second, 997);
    const a = readTree(first);
    const b = readTree(second);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
    for (const name of Object.keys(a)) {
      assert.ok(a[name].equals(b[name]), `${name} differs between runs`);
    }
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

await check("a source that ignores Range and sends the whole file still works", async () => {
  // If ARCHIVE_URL ignores the Range header, the extractor receives bytes from
  // 0. It must skip to the first part rather than writing archive byte 0 into
  // the wrong file. This is what streamStart exists for.
  const archive = makeArchive(SMALL);
  const { parts } = planFor(archive, 1, 3);
  const outDir = mkdtempSync(join(tmpdir(), "shard-whole-"));
  try {
    const extractor = await extract(archive, parts, outDir, 997, true);
    assert.ok(extractor.complete, "the extractor did not finish");
    const written = readTree(outDir);
    assert.equal(Object.keys(written).length, parts.length);
    for (const part of parts) {
      assert.ok(
        written[part.name].equals(
          Buffer.from(archive.bytes.subarray(part.start, part.start + part.length))
        ),
        `${part.name} does not match the source when fed the whole archive`
      );
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

await check("complete reports whether every part was written", async () => {
  const archive = makeArchive(SMALL);
  const { parts } = planFor(archive, 0, 3);
  const outDir = mkdtempSync(join(tmpdir(), "shard-partial-"));
  try {
    // Feed only half the archive, so the extractor must report incomplete.
    const extractor = new PartExtractor(parts, outDir, parts[0].start);
    let sent = 0;
    async function* half() {
      const end = parts[0].start + Math.floor((parts.at(-1).start - parts[0].start) / 2);
      for (let i = parts[0].start; i < end; i += 4096) {
        sent += Math.min(4096, end - i);
        yield archive.bytes.subarray(i, Math.min(i + 4096, end));
      }
    }
    await extractor.consume(half());
    assert.ok(sent > 0, "nothing was sent");
    assert.equal(extractor.complete, false, "a truncated stream must not report complete");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);