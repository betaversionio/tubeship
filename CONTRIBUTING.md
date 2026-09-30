# Contributing

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
node dist/cli.js --help
```

- Code is TypeScript (ESM), built with tsdown; the CLI uses commander.
- API calls go through the `Tubeship` class (`src/tubeship.ts`), which takes
  an injectable YouTube client: add tests with the fake in `test/tubeship.test.ts`
  rather than hitting the real API.
- Anything that changes a channel must show a plan and respect `--dry-run` / `--yes`.
- Releases: bump `version` in package.json, add a CHANGELOG entry, then push a
  tag `vX.Y.Z`; the release workflow publishes to npm and creates the GitHub release.
