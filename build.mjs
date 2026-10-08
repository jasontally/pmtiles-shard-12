#!/usr/bin/env node
/**
 * Build one shard of a PMTiles archive: download this shard's bytes, cut them
 * into Static Asset part files, and let wrangler upload them.
 *
 * The archive is 118 GiB and a Workers Builds container has 20 GB of disk, so
 * the archive is split across several shard repos. This script handles one.
 * See sharding.md in pmtiles-cf-snippet for the plan and the arithmetic.
 *
 * Disk use is the parts only, about 10 GB. The raw slice is never written: the
 * download is a stream and each part is written as it completes, then the
 * stream advances. Storing the slice as well would need 20 GB and hit the
 * limit exactly.
 *
 * The archive comes from archive.json in this repo, not from the environment.
 * That is deliberate: a GitHub Actions workflow refreshes this shard by committing
 * that file, the commit triggers this build, and nothing outside Cloudflare needs
 * a credential. Cloudflare injects its own token.
 *
 * Required environment:
 *   SHARD_INDEX     which shard this repo builds, 0 to 12
 *
 * Optional environment:
 *   ARCHIVE_URL     override archive.json, for a one-off build
 *   ARCHIVE_NAME    archive name in the asset paths (default: basemap)
 *   TILE_SHARD      bytes per tile part (default: 2000000)
 *   LEAF_SHARD      bytes per leaf part (default: 160000)
 *   SKIP_DOWNLOAD   1 to reuse the parts already in public/ (default: 0)
 *   DRY_RUN         1 to read the header and print the plan, download nothing
 *
 * The shard index alone decides which parts this repo writes, so a shard's part
 * numbers match the ones the reader snippet computes. Part N of the tile section
 * belongs to shard floor(N / tilePartsPerShard).
 */

import { spawnSync } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

const HEAD_BYTES = 16_384;

const env = (key, fallback) => {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
};

function fail(message) {
  console.error(`build failed: ${message}`);
  process.exit(1);
}

/** The 127 byte PMTiles v3 header. */
function parseHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (off) => Number(view.getBigUint64(off, true));
  if (String.fromCharCode(...bytes.slice(0, 7)) !== "PMTiles") {
    throw new Error("not a PMTiles archive");
  }
  if (bytes[7] !== 3) throw new Error(`unsupported version ${bytes[7]}`);
  const header = {
    rootDirOffset: u64(8),
    rootDirLength: u64(16),
    metadataOffset: u64(24),
    metadataLength: u64(32),
    leafDirOffset: u64(40),
    leafDirLength: u64(48),
    tileDataOffset: u64(56),
    tileDataLength: u64(64),
    minZoom: bytes[100],
    maxZoom: bytes[101],
  };
  const rootEnd = header.rootDirOffset + header.rootDirLength;
  if (rootEnd > HEAD_BYTES) {
    throw new Error(`root directory ends at ${rootEnd}, past the first ${HEAD_BYTES}`);
  }
  return header;
}

/**
 * Which parts this shard owns, as absolute archive byte ranges.
 *
 * Shard 0 also owns the head, the metadata, and the leaf directories, because
 * together they are 324.9 MB and much smaller than one tile part. Every other
 * shard is pure tile data, so its whole slice is one contiguous Range request.
 *
 * @returns {Array<{name: string, start: number, length: number}>}
 */
export function shardParts({ header, total, shardIndex, shardCount, tileShard, leafShard, tilePartsPerShard }) {
  const tileParts = Math.ceil(header.tileDataLength / tileShard);
  const first = shardIndex * tilePartsPerShard;
  const last = Math.min(first + tilePartsPerShard, tileParts);
  const parts = [];

  if (shardIndex === 0) {
    parts.push({ name: "head.bin", start: 0, length: Math.min(HEAD_BYTES, total) });
  }

  for (let part = first; part < last; part++) {
    const start = header.tileDataOffset + part * tileShard;
    const sectionEnd = header.tileDataOffset + header.tileDataLength;
    parts.push({
      name: `tile/${String(part).padStart(6, "0")}.bin`,
      start,
      length: Math.min(tileShard, sectionEnd - start),
    });
  }

  if (shardIndex === 0) {
    parts.push({
      name: "meta.bin",
      start: header.metadataOffset,
      length: header.metadataLength,
    });
    const leafParts = Math.ceil(header.leafDirLength / leafShard);
    for (let part = 0; part < leafParts; part++) {
      const start = header.leafDirOffset + part * leafShard;
      parts.push({
        name: `leaf/${String(part).padStart(6, "0")}.bin`,
        start,
        length: Math.min(leafShard, header.leafDirOffset + header.leafDirLength - start),
      });
    }
  }

  // Guard against a bad SHARD_COUNT producing overlapping or missing parts.
  if (parts.length === 0) {
    throw new Error(
      `shard ${shardIndex} of ${shardCount} owns no parts. ` +
      `Check SHARD_COUNT and TILE_SHARD against the archive.`
    );
  }
  for (const part of parts) {
    if (part.start + part.length > total) {
      throw new Error(
        `part ${part.name} ends at ${part.start + part.length}, past the archive end ${total}`
      );
    }
  }
  return parts;
}

/**
 * Split parts into maximal runs of adjacent bytes, one Range request each.
 *
 * Shards 1 to 12 are a single run, so they use one request. Shard 0 has two:
 * the head and the first tile parts, then the metadata and leaves, with the
 * other 12 shards' tile data in the gap between. A single request spanning the
 * first and last part would ask for the whole 118 GiB archive.
 *
 * @returns {Array<{start: number, end: number, parts: Array}>}
 */
export function groupRuns(parts) {
  const runs = [];
  for (const part of parts) {
    const open = runs[runs.length - 1];
    if (open && open.end === part.start) {
      open.end = part.start + part.length;
      open.parts.push(part);
    } else {
      runs.push({ start: part.start, end: part.start + part.length, parts: [part] });
    }
  }
  return runs;
}

/**
 * Read a byte range from a stream, discarding everything outside it.
 *
 * Deliberately not a stream Transform. An async _transform deadlocks node's
 * stream machinery, because the implementation does not await the returned
 * promise, so the write queue stalls and the pipeline never finishes. This
 * pulls chunks with `for await` instead, which is sequential, obvious, and
 * cannot interleave two writes to the same file.
 *
 * The parts of a shard arrive in ascending order, so the position only moves
 * forward.
 */
export class PartExtractor {
  /**
   * @param {Array} parts wanted ranges, ascending and contiguous
   * @param {string} outDir where the part files are written
   * @param {number} streamStart the archive offset the first chunk carries.
   *   A Range request starts at parts[0].start, but a server that ignores the
   *   Range and sends the whole file starts at 0, so this is explicit rather
   *   than assumed.
   */
  constructor(parts, outDir, streamStart = parts.length ? parts[0].start : 0) {
    this.parts = parts;
    this.outDir = outDir;
    this.index = 0;
    this.position = streamStart;
    this.written = 0;
    this.open = new Map();
  }

  async #append(part, data) {
    const file = join(this.outDir, part.name);
    await mkdir(dirname(file), { recursive: true });
    let handle = this.open.get(part.name);
    if (!handle) {
      // "w" the first time a part is written and "a" after, so a part split
      // across chunks is appended rather than truncated.
      handle = createWriteStream(file, { flags: "w" });
      this.open.set(part.name, handle);
      await new Promise((resolve, reject) => {
        handle.once("open", resolve);
        handle.once("error", reject);
      });
    }
    if (!handle.write(data)) {
      await new Promise((resolve) => handle.once("drain", resolve));
    }
  }

  /** Take one chunk from the stream. */
  async push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.index >= this.parts.length) return;

      const part = this.parts[this.index];
      const partEnd = part.start + part.length;

      // Wholly before this part: skip it all.
      if (this.position + (chunk.length - offset) <= part.start) {
        this.position += chunk.length - offset;
        return;
      }
      // Before this part but the chunk reaches it: skip up to it.
      if (this.position < part.start) {
        const skip = Math.min(part.start - this.position, chunk.length - offset);
        this.position += skip;
        offset += skip;
        continue;
      }

      // Inside this part, possibly crossing into the next.
      const take = Math.min(partEnd - this.position, chunk.length - offset);
      await this.#append(part, chunk.subarray(offset, offset + take));
      offset += take;
      this.position += take;
      this.written += take;
      if (this.position >= partEnd) this.index++;
    }
  }

  /** Close every file handle. Must be awaited before reading the parts back. */
  async close() {
    for (const handle of this.open.values()) {
      await new Promise((resolve, reject) => {
        handle.end(() => resolve());
        handle.once("error", reject);
      });
    }
    this.open.clear();
  }

  /** Pull the whole stream through. */
  async consume(iterable) {
    for await (const chunk of iterable) {
      await this.push(Buffer.from(chunk));
    }
    await this.close();
    return this;
  }

  /** True when every wanted part has been fully written. */
  get complete() {
    return this.index >= this.parts.length;
  }
}

/**
 * The archive this shard should hold, and where that was decided.
 *
 * The answer lives in archive.json, in this repo, not in a Cloudflare build
 * variable. That is what lets a plain GitHub Actions workflow refresh a shard by
 * committing a file: the commit is the trigger, the file is the payload, and
 * nothing outside Cloudflare has to hold a credential. Cloudflare injects its own
 * token into the build.
 *
 * ARCHIVE_URL still overrides, for a one-off build against something else. It is
 * only for that, and the value that is really used is logged, because a stale
 * variable that silently does nothing is worse than one that is clearly ignored.
 */
function archiveConfig() {
  const file = join(process.cwd(), "archive.json");
  let fromFile = null;
  try {
    fromFile = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    // Only a missing file is allowed to fall through to the error below. A typo or
    // a bad import would otherwise look the same as "not configured", and the
    // build would fail with a message pointing at the wrong thing.
    if (error.code !== "ENOENT") {
      fail(`could not read ${file}: ${error.message}`);
    }
  }

  const override = env("ARCHIVE_URL", "");
  if (override) {
    console.log(`archive   ${override}  (from the ARCHIVE_URL variable, overriding archive.json)`);
    if (fromFile?.url && fromFile.url !== override) {
      console.log(`          archive.json says ${fromFile.url}, which is being ignored`);
    }
    return { url: override, key: fromFile?.key || override };
  }

  if (!fromFile || !fromFile.url) {
    fail("archive.json is missing or has no url. It names the archive this shard holds.");
  }
  console.log(`archive   ${fromFile.url}  (from archive.json, key ${fromFile.key || "unknown"})`);
  return { url: fromFile.url, key: fromFile.key || fromFile.url };
}

async function main() {
  const { url } = archiveConfig();
  const name = env("ARCHIVE_NAME", "basemap");
  const tileShard = Number(env("TILE_SHARD", "2000000"));
  const leafShard = Number(env("LEAF_SHARD", "160000"));
  const shardCount = Number(env("SHARD_COUNT", "13"));
  const shardIndex = Number(env("SHARD_INDEX", ""));
  const dryRun = env("DRY_RUN", "0") === "1";
  const skipDownload = env("SKIP_DOWNLOAD", "0") === "1";

  if (!url.includes("http")) fail(`the archive url looks wrong: ${url}`);
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    fail(`set SHARD_INDEX to a whole number from 0 to ${shARDCount - 1}`);
  }

  const outDir = join(process.cwd(), "public", "s", name);

  // The header and the total size come from one small ranged request.
  const probe = await fetch(url, { headers: { Range: "bytes=0-16383" } });
  if (probe.status !== 206) {
    fail(`the source returned ${probe.status} for a Range request. It must support Range.`);
  }
  const contentRange = probe.headers.get("content-range") || "";
  const sizeMatch = /\/(\d+)\s*$/.exec(contentRange);
  if (!sizeMatch) fail(`no archive size in Content-Range: ${JSON.stringify(contentRange)}`);
  const total = Number(sizeMatch[1]);
  const header = parseHeader(new Uint8Array(await probe.arrayBuffer()));

  // tilePartsPerShard must match shard-plan.mjs, or the reader will look for a
  // part on the wrong host. Derive it from the shard count so the two cannot
  // disagree.
  const tileParts = Math.ceil(header.tileDataLength / tileShard);
  const tilePartsPerShard = Math.ceil(tileParts / shardCount);

  const parts = shardParts({
    header, total, shardIndex, shardCount,
    tileShard, leafShard, tilePartsPerShard,
  });
  const bytes = parts.reduce((sum, part) => sum + part.length, 0);

  const runs = groupRuns(parts);
  const runBytes = runs.reduce((sum, run) => sum + run.end - run.start, 0);

  console.log(`archive      ${total.toLocaleString()} bytes, maxZoom ${header.maxZoom}`);
  console.log(`shard        ${shardIndex} of ${shardCount}`);
  console.log(`tile parts   ${tileParts.toLocaleString()} total, ${tilePartsPerShard.toLocaleString()} per shard`);
  console.log(`this shard   ${parts.length.toLocaleString()} parts, ${(bytes / 1e9).toFixed(2)} GB`);
  console.log(`downloads    ${runs.length}, covering ${(runBytes / 1e9).toFixed(2)} GB`);
  for (const run of runs) {
    console.log(
      `  bytes ${run.start.toLocaleString()}-${(run.end - 1).toLocaleString()}  ` +
      `${((run.end - run.start) / 1e9).toFixed(2)} GB  ${run.parts.length.toLocaleString()} parts  ` +
      `${run.parts[0].name} .. ${run.parts[run.parts.length - 1].name}`
    );
  }

  if (dryRun) {
    console.log(`\nDRY_RUN: nothing downloaded. First 3 parts:`);
    for (const part of parts.slice(0, 3)) {
      console.log(`  ${part.name} ${part.start.toLocaleString()} +${part.length.toLocaleString()}`);
    }
    return;
  }

  if (skipDownload) {
    console.log("SKIP_DOWNLOAD=1, reusing the parts already in public/");
    return;
  }

  // Download each run of adjacent parts as its own Range request.
  //
  // One request per shard is not possible. Shard 0 holds the head, then the
  // first tile parts, then the metadata and leaves, with the other 12 shards'
  // tile data in between. A single request spanning its first and last part
  // would be the whole 118 GiB archive, which does not fit the 20 minute build.
  // Fetching only the runs keeps shard 0 at its own 10.05 GB.
  console.log(
    `\ndownloading ${(bytes / 1e9).toFixed(2)} GB in ${runs.length} ` +
    `${runs.length === 1 ? "request" : "requests"}`
  );
  const started = Date.now();
  let written = 0;

  for (const run of runs) {
    const response = await fetch(url, {
      headers: { Range: `bytes=${run.start}-${run.end - 1}` },
    });
    if (response.status !== 206) fail(`download returned ${response.status}`);
    if (!response.body) fail("download had no body");

    const extractor = new PartExtractor(run.parts, outDir, run.start);
    await extractor.consume(Readable.fromWeb(response.body));

    if (!extractor.complete) {
      const missing = run.parts[extractor.index];
      fail(
        `the download ended before ${missing.name}. ` +
        `Got ${extractor.written.toLocaleString()} of ` +
        `${(run.end - run.start).toLocaleString()} bytes for this run.`
      );
    }
    written += extractor.written;
  }

  const seconds = (Date.now() - started) / 1000;
  console.log(
    `wrote ${written.toLocaleString()} bytes in ${seconds.toFixed(1)}s ` +
    `(${(written / 1e6 / seconds).toFixed(1)} MB/s)`
  );

  if (written !== bytes) {
    fail(`wrote ${written} bytes, expected ${bytes}. The download was short.`);
  }

  // The parts must exist and be the right size, or the upload silently
  // publishes a Worker with holes in it.
  let checked = 0;
  for (const part of parts) {
    const file = join(outDir, part.name);
    let size;
    try {
      size = (await stat(file)).size;
    } catch {
      fail(`${part.name} was not written`);
    }
    if (size !== part.length) {
      fail(`${part.name} is ${size} bytes, expected ${part.length}`);
    }
    checked++;
  }
  console.log(`verified ${checked.toLocaleString()} part files by size`);

  // _headers keeps the parts in the edge cache. Cloudflare's default for assets
  // is max-age=0, must-revalidate, which would check on every tile request.
  await writeFile(
    join(process.cwd(), "public", "_headers"),
    "/s/*\n" +
      "\tCache-Control: public, max-age=31536000, immutable\n" +
      "\tAccess-Control-Allow-Origin: *\n" +
      "\tAccess-Control-Expose-Headers: Content-Length\n"
  );

  console.log(`\nnext: npx wrangler deploy  (the deploy command in Workers Builds)`);
}

/** Exported so the test can drive the plan and the extractor without running. */
export { main };

// Run only when invoked directly. A test imports this module, and importing it
// must not start a 10 GB download.
const invokedDirectly = process.argv[1] &&
  process.argv[1].endsWith("build.mjs");

if (invokedDirectly) {
  main().catch((error) => fail(error.stack || error.message));
}