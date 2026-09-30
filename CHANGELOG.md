# Changelog

## 0.1.0

First release.

- `upload`: one JSON manifest per video (captions, thumbnail, playlists, schedule); folders upload in order and resume (the video id is written back to each manifest); `--schedule <start> --every 1d` spreads a batch; quota errors stop cleanly.
- `sync`: update uploaded videos to match their manifests (metadata, privacy/publish time, playlists, missing caption languages; `--replace-captions`, `--thumbnail`).
- `channel`, `banner`, `playlists`, `whoami`, `auth` (desktop OAuth with PKCE, per-channel profiles).
- Plans and confirmation for every change; `--dry-run`, `--yes`.
- Manifest validation against YouTube's limits before anything is sent.
- Library API: `Tubeship`, `loadManifest`, `validateManifest`, `scheduleTimes`, `QuotaExceededError`.
