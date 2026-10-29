#!/usr/bin/env node
/**
 * Check that this shard holds the archive it should, and start a rebuild if not.
 *
 *   node verify-shard.mjs 16
 *
 * A shard build can fail. The download can die, the build can hit its 30
 * minute limit, and the upload can run out of time. When that happens the shard
 * keeps the old archive. The reader then asks it for parts it does not have,
 * and the map loses every tile in that shard's range.
 *
 * On 18 October 2026 three of 25 shards failed, and nothing noticed for a day.
 * This is what notices.
 *
 * HOW THE CHECK WORKS
 *
 * The archive's own header says which parts belong to this shard. The last
 * part of that range is the one to ask for. A shard that still holds the old
 * archive has no such part, because the old archive had fewer parts per shard,
 * so the range ended earlier. A shard that holds the new archive has it.
 *
 * The bytes are compared as well, so a shard that has the file but not the
 * right content is caught.
 *
 * WHAT IT DOES WHEN THE SHARD IS STALE
 *
 * It writes archive.json with the attempt count up by one. The workflow commits
 * that file, and the commit is what starts the build. The count stops the loop:
 * a shard that cannot be built is left alone after a few tries, and the check
 * says so.
 *
 * It holds no credentials and needs none. The archive header is read over
 * plain HTTP, and the shard is read over plain HTTP.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseHeader } from "./build.mjs";

const TILE_SHARD = 1_000_000;
const SHARD_COUNT = 25;
const MAX_ATTEMPTS = 3;
const COMPARE_BYTES = 4096;

/** The host that holds each shard. The pattern is the reader's. */
export function partUrl(shardIndex, part) {
  const file = `tile/${String(part).padStart(6, "0")}.bin`;
  return `https://s.tiles${shardIndex}.jasontally.com/s/basemap/${file}`;
}

/** The parts this shard should own, from the archive's own header. */
export function partsFor(header, shardIndex, shardCount = SHARD_COUNT, tileShard = TILE_SHARD) {
  const tileParts = Math.ceil(header.tileDataLength / tileShard);
  const tilePartsPerShard = Math.ceil(tileParts / shardCount);
  const first = shardIndex * tilePartsPerShard;
  const last = Math.min(first + tilePartsPerShard, tileParts) - 1;
  return { first, last, tileParts, tilePartsPerShard };
}

/** The archive offset of the first byte of a tile part. */
export function partOffset(header, part, tileShard = TILE_SHARD) {
  return header.tileDataOffset + part * tileShard;
}

/** Read the archive header over a ranged request. */
export async function readHeader(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { Range: "bytes=0-16383" } });
  if (response.status !== 206) {
    throw new Error(`${url} returned ${response.status} for a Range request`);
  }
  return parseHeader(new Uint8Array(await response.arrayBuffer()));
}

/**
 * Is this shard holding the archive?
 *
 * The last part of the shard's range is the one to ask for, and its first
 * bytes must match the archive. A shard that still holds the old archive has
 * no such part.
 */
export async function checkShard({ shardIndex, header, archiveUrl, fetchImpl = fetch }) {
  const { first, last } = partsFor(header, shardIndex);
  const url = partUrl(shardIndex, last);

  const response = await fetchImpl(url);
  if (response.status === 404) {
    return { ok: false, part: last, reason: `the shard does not serve part ${last}` };
  }
  if (!response.ok) {
    return { ok: false, part: last, reason: `the shard answered ${response.status} for part ${last}` };
  }
  const served = new Uint8Array(await response.arrayBuffer());

  const offset = partOffset(header, last);
  const source = await fetchImpl(archiveUrl, {
    headers: { Range: `bytes=${offset}-${offset + COMPARE_BYTES - 1}` },
  });
  if (source.status !== 206) {
    return { ok: false, part: last, reason: `the archive answered ${source.status} for byte ${offset}` };
  }
  const expected = new Uint8Array(await source.arrayBuffer());

  const length = Math.min(served.length, expected.length, COMPARE_BYTES);
  for (let i = 0; i < length; i++) {
    if (served[i] !== expected[i]) {
      return { ok: false, part: last, reason: `part ${last} does not hold the archive bytes` };
    }
  }
  return { ok: true, part: last, first, bytes: served.length };
}

/** The archive this shard should hold, from archive.json. */
export function readArchive(file = join(process.cwd(), "archive.json")) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (!doc.url) throw new Error(`${file} has no url`);
  return { key: doc.key || "unknown", url: doc.url, attempts: Number(doc.attempts || 0) };
}

async function main() {
  const shardIndex = Number(process.argv[2]);
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= SHARD_COUNT) {
    console.error(`give the shard index: node verify-shard.mjs ${shardIndex}`);
    process.exit(1);
  }

  const archive = readArchive();
  const header = await readHeader(archive.url);
  const result = await checkShard({ shardIndex, header, archiveUrl: archive.url });

  if (result.ok) {
    console.log(`shard ${shardIndex} holds ${archive.key}. Part ${result.part} is right.`);
    return;
  }

  console.log(`shard ${shardIndex} does not hold ${archive.key}: ${result.reason}`);

  if (archive.attempts >= MAX_ATTEMPTS) {
    console.log(
      `already tried ${archive.attempts} times, so the shard is left alone. ` +
      `A person has to look at it.`
    );
    return;
  }

  // The file changes, so the commit is a change, and a change starts the build.
  const file = join(process.cwd(), "archive.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.attempts = archive.attempts + 1;
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`archive.json now records attempt ${doc.attempts}. The commit starts the build.`);
}

if (process.argv[1] && process.argv[1].endsWith("verify-shard.mjs")) {
  await main();
}
