# tubeship

**A publishing CLI for YouTube.** Describe each video in a small JSON
manifest (title, description, captions, thumbnail, playlists, schedule) and
ship it with one command. Batches resume where they stopped, `sync` updates
videos that are already up, and nothing changes without showing you a plan
first.

```sh
npx tubeship upload videos/            # every manifest in the folder, in order
npx tubeship upload videos/ --schedule 2026-10-05T18:00:00+05:30 --every 1d
npx tubeship sync videos/              # push manifest edits to uploaded videos
```

tubeship uses the official YouTube Data API v3 with your own Google Cloud
project. It is not affiliated with, endorsed by or sponsored by YouTube or
Google. YouTube is a trademark of Google LLC.

## Why

- **One manifest, one command.** Video, every caption track, thumbnail, several playlists and the publish time go up together.
- **Safe by default.** Every command that changes a channel prints what it will do and asks. `--dry-run` only prints; `--yes` is for scripts and CI.
- **Batches that resume.** After each upload the video id is written into its manifest, so a rerun skips what's done. Hitting the daily quota stops cleanly; run the same command after the reset.
- **Sync.** Edited a title, added a playlist or a new caption language? `sync` compares and updates.
- **Several channels.** Profiles keep each channel's credentials separate.
- **Also a library.** `import { Tubeship } from "tubeship"`.

## Install

```sh
npm install -g tubeship     # or: npx tubeship ...
```

Node.js 20 or newer.

## Setup (once per channel)

1. **Google Cloud project:** in <https://console.cloud.google.com/>, create a project and enable **YouTube Data API v3**.
2. **OAuth consent screen:** user type External; add the channel's Google account under **Test users**.
3. **OAuth client:** Credentials > Create credentials > OAuth client ID > **Desktop app**. Download the JSON.
4. Save it for a profile (pick any name; `default` if you have one channel):
   ```sh
   mkdir -p ~/.config/tubeship/mychannel
   mv ~/Downloads/client_secret_*.json ~/.config/tubeship/mychannel/client_secret.json
   ```
5. Sign in: `tubeship auth --profile mychannel`. Your browser opens Google's page; tubeship never sees your password (PKCE with a loopback redirect). Google warns the app is unverified: it's your own project, continue.

The sign-in is saved to `~/.config/tubeship/<profile>/token.json` (readable only by you).

Things only YouTube Studio can do: create the channel, set its name, handle and picture, and verify your phone number (needed for custom thumbnails and videos over 15 minutes).

## The manifest

```json
{
  "file": "q21.mp4",
  "title": "GATE CS 2026 Q21 Solution | One file, three links",
  "description": "A 4 MB file crosses three links...\n\nChapters\n0:00 Question\n0:33 Solution",
  "tags": ["GATE", "computer networks"],
  "categoryId": "27",
  "defaultLanguage": "en",
  "defaultAudioLanguage": "en",
  "privacy": "private",
  "publishAt": "2026-10-05T18:00:00+05:30",
  "playlists": ["GATE CS 2026 Solutions", "Computer Networks"],
  "thumbnail": "q21.png",
  "captions": [
    { "language": "en", "name": "English", "file": "q21.en.vtt" },
    { "language": "hi-Latn", "name": "Hinglish", "file": "q21.hi-Latn.vtt" }
  ],
  "madeForKids": false,
  "containsSyntheticMedia": false
}
```

Paths are relative to the manifest. Only `title` is required (and a video
file for uploads). tubeship checks YouTube's limits before sending anything:
title up to 100 characters, description up to 5000 bytes, no `<` or `>`,
tags up to 500 characters in total, thumbnail JPEG/PNG under 2 MB, files
present. After upload it adds `videoId` and `uploadedAt` to the file.

## Commands

| Command | |
|---|---|
| `tubeship auth` | Sign in (opens the browser) |
| `tubeship whoami` | Show the signed-in channel |
| `tubeship channel --description ... --keywords ... --country IN --language en` | Update channel details |
| `tubeship banner banner.png` | Set the banner (2560x1440, max 6 MB) |
| `tubeship playlists [--create "A" "B"] [--description ...] [--privacy public]` | List, or create missing playlists |
| `tubeship upload <manifest or folder...>` | Upload; skips manifests that already have a `videoId` |
| `tubeship sync <manifest or folder...>` | Update uploaded videos to match their manifests |

Global options: `--profile <name>` (or `TUBESHIP_PROFILE`), `--yes`, `--dry-run`.

`upload` options: `--file`, `--privacy`, `--publish-at`, `--thumbnail` (one
manifest); `--playlist <titles...>`, `--create-playlists`, `--schedule <start>
--every 1d` (spread a batch; manifests with their own `publishAt` keep it).

`sync` options: `--replace-captions` (default: only add missing languages),
`--thumbnail` (upload it again), `--create-playlists`.

## Library

```ts
import { Tubeship, loadManifest, validateManifest, QuotaExceededError } from "tubeship";

const ts = Tubeship.connect({ profile: "mychannel" });
const m = loadManifest("videos/q21.json");
const errors = validateManifest(m);
if (errors.length) throw new Error(errors.join("\n"));

try {
  const { url, warnings } = await ts.upload(m, { onProgress: (f) => console.log(Math.round(f * 100) + "%") });
  console.log(url, warnings);
} catch (err) {
  if (err instanceof QuotaExceededError) console.log("try again after the reset");
  else throw err;
}

const plan = await ts.syncPlan(m);
console.log(plan.changes);
await plan.apply();
```

`new Tubeship(youtubeClient)` accepts any `youtube_v3.Youtube` client (from
`@googleapis/youtube`), e.g. with a service account or a mock for tests.

## YouTube limits to know

- **Uploads stay private until an API audit.** YouTube locks videos uploaded through a new, unaudited Google Cloud project to private. Publish them in Studio, and request the free audit: <https://support.google.com/youtube/contact/yt_api_form>.
- **Quota:** 10,000 units a day per project, resetting at midnight Pacific time. An upload costs about 1,600 units, a caption track 400, a playlist insert 50. tubeship prints an estimate in every upload plan.
- **Extra audio languages** can't be added through the API (and YouTube only plays the first audio stream of an upload): use Studio's multi-language audio where available, or upload separate videos.

## License

MIT
