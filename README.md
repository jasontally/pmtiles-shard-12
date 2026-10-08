# pmtiles-shard-12

One shard of the Protomaps basemap. The archive is 118 GiB and a Workers
Builds container has 20 GB of disk, so the archive is split across 13 of these
repos. This one holds shard 12, tile parts 58368 to 63231.

Shard 0 also holds `head.bin`, `meta.bin`, and the leaf directories, which
together are 324.9 MB. Every other shard is pure tile data.

Read the design and the arithmetic in
[pmtiles-cf-snippet](https://github.com/jasontally/pmtiles-cf-snippet), file
`sharding.md`.

## Deploy

`wrangler.jsonc` names the Worker `pmtiles-shard-12`, which must match the Worker in
the Cloudflare dashboard.

Set these as build variables in the Cloudflare dashboard:

| Variable | Value |
|---|---|
| `SHARD_INDEX` | `12` |
| `SHARD_COUNT` | `13` |

The archive itself comes from `archive.json` in this repo, not from a build
variable. That is deliberate: `.github/workflows/refresh.yml` commits a newer
Protomaps build there, the commit starts this build, and nothing outside
Cloudflare needs a credential. See refresh.md in pmtiles-cf-snippet.

Set these commands under **Settings > Build**:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |

This shard's refresh slot is **6:00 UTC on Sunday**.

The build command downloads only this shard's bytes and writes them to
`public/`. The deploy command uploads them with wrangler, which skips any part
whose content hash Cloudflare already holds.

## Check the plan without downloading

```sh
npm run dry-run
```

Prints the part count, the byte range, and the first three parts. Downloads
nothing.
