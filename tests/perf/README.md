# perf

`scripts/perf.mjs` takes the measurements and compares them with the baselines in this directory (ROADMAP.md 6.5, perf gate).

- `baseline/<package version>.json` - one baseline per version. `--check` compares against the file with the highest version.
- Deterministic metrics (hard gate): Redis commands per request (legacy hit `/docs/guide/doc-0`, use-cache page `/dyn/1`),
  and the `MEMORY USAGE` sum of one static-site build (within +5%, only when the Redis minor version matches).
- Timing metrics (`--time`, autocannon for 10 seconds): p50/p99/req/s. More than +20% only warns.
- `1.0.6.json` was measured locally on 2026-09-29 (Windows, Docker Desktop Redis 8.4.7, Next 16.3.6).
  Command counts and memory are platform-independent (171 bytes difference between two runs); timing metrics are for reference only.

Update a baseline only for an intended change: run `node scripts/perf.mjs --update-baseline --time` and explain why in the commit message.
While preparing a release (the working tree version is still the previous one), pick the file name with `--as <new version>`; the JSON then also records `packageVersionField` (the actual package.json value).

## Baseline history

| File | Legacy hit | use-cache page | One static-site build | Why it changed |
|---|---|---|---|---|
| `1.0.6.json` | 3 commands | 8 commands | 123 keys, 116,060,896 B | Initial baseline |
| `1.1.0.json` | 3 commands | 8 commands | 178 keys, 149,519,924 B (+28.8%) | 7-4 prewarm fix: entries 1.0.6 used to miss are now stored - 129 page segments (`/<page>/__PAGE__`) +29.8 MB (243 in 1.0.6, 372 in 1.1.0), 52 APP_ROUTE entries (OG images, icon) +0.77 MB, and `/index`, `/_not-found`, `/_global-error`. Commands per request and the key format are unchanged |
