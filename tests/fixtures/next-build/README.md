# next-build fixture

Part of the build output of `test-apps/static-site` built with Next 16.3.6 (`/`, `/about`, `/_not-found`, `/icon`).
The `registerInitialCache` (prewarm) reproduction tests (7-4) switch `process.cwd()` to this directory and read from it.
`prerender-manifest.json` keeps only the four routes above, and the preview keys are replaced with dummies.

To refresh: run `node scripts/prepare-app.mjs static-site --build A`, then copy the same files from `.work/static-site@next-16.3/builds/A/.next`.
