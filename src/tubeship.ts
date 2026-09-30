// The programmatic API. Every write goes through here; the CLI only adds
// plans, confirmation and printing. The YouTube client is injectable, so
// tests run against a fake.

import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import { youtube, type youtube_v3 } from "@googleapis/youtube";
import { authorizedClient, type ProfileOptions } from "./auth.js";
import type { LoadedManifest, Privacy, VideoManifest } from "./manifest.js";

export type YouTube = youtube_v3.Youtube;

/** YouTube said the daily quota is used up (resets at midnight Pacific time). */
export class QuotaExceededError extends Error {
  constructor(cause?: unknown) {
    super("YouTube API quota exceeded for today (it resets at midnight Pacific time)", { cause });
    this.name = "QuotaExceededError";
  }
}

const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "uploadLimitExceeded"]);

/** Runs a request, turning quota errors into QuotaExceededError and API errors into readable ones. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { errors?: { reason?: string; message?: string }[]; message?: string; code?: number };
    const reason = e.errors?.[0]?.reason;
    if (reason && QUOTA_REASONS.has(reason)) throw new QuotaExceededError(err);
    if (e.errors?.[0]?.message) throw new Error(e.errors[0].message, { cause: err });
    throw err;
  }
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska" };
const mime = (f: string) => MIME[extname(f).toLowerCase()] ?? "application/octet-stream";

export interface ChannelInfo {
  id: string;
  title: string;
  handle?: string;
  subscribers?: string;
  videos?: string;
}

export interface ChannelFields {
  description?: string;
  keywords?: string;
  country?: string;
  defaultLanguage?: string;
}

export interface PlaylistInfo {
  id: string;
  title: string;
  itemCount: number;
  privacy: string;
}

export interface UploadOptions {
  /** Upload progress, 0-1. */
  onProgress?: (fraction: number) => void;
  /** Called as soon as the video exists (before captions etc.), e.g. to record its id. */
  onCreated?: (videoId: string) => void;
  /** Create playlists that don't exist yet (default false: warn and skip). */
  createPlaylists?: boolean;
}

export interface UploadResult {
  videoId: string;
  url: string;
  /** Steps that didn't happen (missing playlist, failed caption...); the video itself is up. */
  warnings: string[];
}

export interface SyncOptions {
  /** Replace caption tracks that already exist (default: only add missing languages). */
  replaceCaptions?: boolean;
  /** Upload the thumbnail again (it can't be compared, so this is opt-in). */
  thumbnail?: boolean;
  createPlaylists?: boolean;
}

export interface SyncPlan {
  videoId: string;
  /** Human-readable changes; empty when the video already matches. */
  changes: string[];
  /** Applies the changes. */
  apply(): Promise<void>;
}

function effectivePrivacy(m: VideoManifest): Privacy {
  return m.publishAt ? "private" : (m.privacy ?? "private");
}

function snippetFor(m: VideoManifest): youtube_v3.Schema$VideoSnippet {
  return {
    title: m.title,
    description: m.description ?? "",
    tags: m.tags ?? [],
    categoryId: m.categoryId ?? "22",
    ...(m.defaultLanguage && { defaultLanguage: m.defaultLanguage }),
    ...(m.defaultAudioLanguage && { defaultAudioLanguage: m.defaultAudioLanguage }),
  };
}

function statusFor(m: VideoManifest): youtube_v3.Schema$VideoStatus {
  return {
    privacyStatus: effectivePrivacy(m),
    ...(m.publishAt && { publishAt: new Date(m.publishAt).toISOString() }),
    selfDeclaredMadeForKids: m.madeForKids ?? false,
    ...(m.containsSyntheticMedia !== undefined && { containsSyntheticMedia: m.containsSyntheticMedia }),
  };
}

export class Tubeship {
  private playlistCache?: PlaylistInfo[];

  constructor(readonly yt: YouTube) {}

  /** Signs in with a saved profile (see `tubeship auth`). */
  static connect(profile: ProfileOptions = {}): Tubeship {
    return new Tubeship(youtube({ version: "v3", auth: authorizedClient(profile) }));
  }

  private async channel(): Promise<youtube_v3.Schema$Channel> {
    const { data } = await call(() => this.yt.channels.list({ part: ["snippet", "brandingSettings", "statistics"], mine: true }));
    const ch = data.items?.[0];
    if (!ch?.id) throw new Error("This Google account has no YouTube channel yet. Create it in YouTube Studio first.");
    return ch;
  }

  async whoami(): Promise<ChannelInfo> {
    const ch = await this.channel();
    return {
      id: ch.id!,
      title: ch.snippet?.title ?? "",
      ...(ch.snippet?.customUrl && { handle: ch.snippet.customUrl }),
      ...(ch.statistics?.subscriberCount && { subscribers: ch.statistics.subscriberCount }),
      ...(ch.statistics?.videoCount && { videos: ch.statistics.videoCount }),
    };
  }

  /** What `updateChannel` would change: [field, from, to] for each difference. */
  async channelChanges(fields: ChannelFields): Promise<{ title: string; changes: [keyof ChannelFields, string, string][] }> {
    const ch = await this.channel();
    const cur = (ch.brandingSettings?.channel ?? {}) as Record<string, string | undefined>;
    const changes: [keyof ChannelFields, string, string][] = [];
    for (const k of ["description", "keywords", "country", "defaultLanguage"] as const) {
      const next = fields[k];
      if (next !== undefined && next !== (cur[k] ?? "")) changes.push([k, cur[k] ?? "", next]);
    }
    return { title: ch.snippet?.title ?? "", changes };
  }

  async updateChannel(fields: ChannelFields): Promise<void> {
    const ch = await this.channel();
    const channel = { ...(ch.brandingSettings?.channel ?? {}), ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    await call(() => this.yt.channels.update({ part: ["brandingSettings"], requestBody: { id: ch.id!, brandingSettings: { channel } } }));
  }

  /** Uploads a banner image (2560x1440, max 6 MB) and sets it on the channel. */
  async setBanner(file: string): Promise<void> {
    const ch = await this.channel();
    const { data } = await call(() => this.yt.channelBanners.insert({ media: { mimeType: mime(file), body: createReadStream(file) } }));
    await call(() =>
      this.yt.channels.update({
        part: ["brandingSettings"],
        requestBody: { id: ch.id!, brandingSettings: { channel: ch.brandingSettings?.channel ?? {}, image: { bannerExternalUrl: data.url ?? null } } },
      }),
    );
  }

  async playlists(): Promise<PlaylistInfo[]> {
    if (this.playlistCache) return this.playlistCache;
    const out: PlaylistInfo[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await call(() => this.yt.playlists.list({ part: ["snippet", "status", "contentDetails"], mine: true, maxResults: 50, ...(pageToken && { pageToken }) }));
      for (const p of data.items ?? []) {
        out.push({ id: p.id!, title: p.snippet?.title ?? "", itemCount: p.contentDetails?.itemCount ?? 0, privacy: p.status?.privacyStatus ?? "" });
      }
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    this.playlistCache = out;
    return out;
  }

  async createPlaylist(title: string, { description = "", privacy = "public" as Privacy } = {}): Promise<PlaylistInfo> {
    const { data } = await call(() => this.yt.playlists.insert({ part: ["snippet", "status"], requestBody: { snippet: { title, description }, status: { privacyStatus: privacy } } }));
    const p: PlaylistInfo = { id: data.id!, title, itemCount: 0, privacy };
    this.playlistCache?.push(p);
    return p;
  }

  /** Playlist ids for titles; missing ones are created (if asked) or reported. */
  private async resolvePlaylists(titles: readonly string[], create: boolean): Promise<{ ids: [string, string][]; missing: string[] }> {
    const have = await this.playlists();
    const ids: [string, string][] = [];
    const missing: string[] = [];
    for (const t of titles) {
      const found = have.find((p) => p.title === t) ?? (create ? await this.createPlaylist(t) : undefined);
      if (found) ids.push([t, found.id]);
      else missing.push(t);
    }
    return { ids, missing };
  }

  /** Uploads a video from a loaded manifest, then its captions, thumbnail and playlists. */
  async upload(m: LoadedManifest, o: UploadOptions = {}): Promise<UploadResult> {
    if (!m.file) throw new Error(`${m.path}: no video file`);
    const size = statSync(m.file).size;
    const { data } = await call(() =>
      this.yt.videos.insert(
        {
          part: ["snippet", "status"],
          notifySubscribers: effectivePrivacy(m) === "public",
          requestBody: { snippet: snippetFor(m), status: statusFor(m) },
          media: { mimeType: mime(m.file!), body: createReadStream(m.file!) },
        },
        { onUploadProgress: (e: { bytesRead: number }) => o.onProgress?.(Math.min(1, e.bytesRead / size)) },
      ),
    );
    const videoId = data.id!;
    o.onCreated?.(videoId);
    const warnings: string[] = [];
    // The video is up; everything else is best-effort, reported as warnings (fix later with `sync`).
    for (const c of m.captions ?? []) {
      try {
        await this.addCaption(videoId, c.language, c.name, c.file);
      } catch (err) {
        if (err instanceof QuotaExceededError) throw err;
        warnings.push(`captions "${c.name}": ${(err as Error).message}`);
      }
    }
    if (m.thumbnail) {
      try {
        await call(() => this.yt.thumbnails.set({ videoId, media: { mimeType: mime(m.thumbnail!), body: createReadStream(m.thumbnail!) } }));
      } catch (err) {
        if (err instanceof QuotaExceededError) throw err;
        warnings.push(`thumbnail: ${(err as Error).message} (custom thumbnails need a phone-verified channel)`);
      }
    }
    if (m.playlists?.length) {
      const { ids, missing } = await this.resolvePlaylists(m.playlists, o.createPlaylists ?? false);
      for (const [, playlistId] of ids) await this.addToPlaylist(playlistId, videoId);
      for (const t of missing) warnings.push(`playlist "${t}" not found (create it, or pass createPlaylists)`);
    }
    return { videoId, url: `https://youtu.be/${videoId}`, warnings };
  }

  private async addCaption(videoId: string, language: string, name: string, file: string): Promise<void> {
    await call(() => this.yt.captions.insert({ part: ["snippet"], requestBody: { snippet: { videoId, language, name } }, media: { mimeType: "application/octet-stream", body: createReadStream(file) } }));
  }

  private async addToPlaylist(playlistId: string, videoId: string): Promise<void> {
    await call(() => this.yt.playlistItems.insert({ part: ["snippet"], requestBody: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } } }));
  }

  /** Compares an uploaded video with its manifest and plans the updates. */
  async syncPlan(m: LoadedManifest, o: SyncOptions = {}): Promise<SyncPlan> {
    const videoId = m.videoId;
    if (!videoId) throw new Error(`${m.path}: no videoId (upload it first)`);
    const { data } = await call(() => this.yt.videos.list({ part: ["snippet", "status"], id: [videoId] }));
    const v = data.items?.[0];
    if (!v) throw new Error(`video ${videoId} not found on this channel`);
    const changes: string[] = [];
    const steps: (() => Promise<void>)[] = [];

    const cur = v.snippet ?? {};
    const want = snippetFor(m);
    const snippetDiff: string[] = [];
    if ((cur.title ?? "") !== want.title) snippetDiff.push(`title: "${cur.title ?? ""}" -> "${want.title}"`);
    if ((cur.description ?? "") !== want.description) snippetDiff.push("description");
    // YouTube returns tags sorted, so order doesn't count as a change.
    const sameTags = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((t, i) => t === [...b].sort()[i]);
    if (!sameTags(cur.tags ?? [], want.tags ?? [])) snippetDiff.push(`tags (${(cur.tags ?? []).length} -> ${(want.tags ?? []).length})`);
    if ((cur.categoryId ?? "") !== want.categoryId) snippetDiff.push(`category ${cur.categoryId} -> ${want.categoryId}`);
    for (const k of ["defaultLanguage", "defaultAudioLanguage"] as const) {
      if (want[k] && cur[k] !== want[k]) snippetDiff.push(`${k} ${cur[k] ?? "-"} -> ${want[k]}`);
    }
    const st = v.status ?? {};
    const wantStatus = statusFor(m);
    const statusDiff: string[] = [];
    // Only touch privacy when the manifest says something explicit.
    if ((m.privacy || m.publishAt) && st.privacyStatus !== wantStatus.privacyStatus) statusDiff.push(`privacy ${st.privacyStatus} -> ${wantStatus.privacyStatus}`);
    if (wantStatus.publishAt && st.publishAt && Date.parse(st.publishAt) !== Date.parse(wantStatus.publishAt)) statusDiff.push(`publishAt ${st.publishAt} -> ${wantStatus.publishAt}`);
    if (wantStatus.publishAt && !st.publishAt && st.privacyStatus === "private") statusDiff.push(`publishAt -> ${wantStatus.publishAt}`);
    if (m.containsSyntheticMedia !== undefined && st.containsSyntheticMedia !== m.containsSyntheticMedia) statusDiff.push(`containsSyntheticMedia -> ${m.containsSyntheticMedia}`);

    if (snippetDiff.length || statusDiff.length) {
      changes.push(...snippetDiff, ...statusDiff);
      const parts = [...(snippetDiff.length ? ["snippet"] : []), ...(statusDiff.length ? ["status"] : [])];
      steps.push(async () => {
        await call(() =>
          this.yt.videos.update({
            part: parts,
            requestBody: {
              id: videoId,
              ...(snippetDiff.length && { snippet: { ...cur, ...want } }),
              ...(statusDiff.length && { status: { ...st, ...wantStatus } }),
            },
          }),
        );
      });
    }

    if (m.playlists?.length) {
      const { ids, missing } = await this.resolvePlaylists(m.playlists, o.createPlaylists ?? false);
      for (const [title, playlistId] of ids) {
        const { data: items } = await call(() => this.yt.playlistItems.list({ part: ["id"], playlistId, videoId, maxResults: 1 }));
        if (!items.items?.length) {
          changes.push(`add to playlist "${title}"`);
          steps.push(() => this.addToPlaylist(playlistId, videoId));
        }
      }
      for (const t of missing) changes.push(`(playlist "${t}" not found: skipped)`);
    }

    if (m.captions?.length) {
      const { data: caps } = await call(() => this.yt.captions.list({ part: ["snippet"], videoId }));
      const existing = new Map((caps.items ?? []).filter((c) => c.snippet?.trackKind !== "asr").map((c) => [c.snippet?.language ?? "", c.id!]));
      for (const c of m.captions) {
        const id = existing.get(c.language);
        if (!id) {
          changes.push(`add captions "${c.name}" (${c.language})`);
          steps.push(() => this.addCaption(videoId, c.language, c.name, c.file));
        } else if (o.replaceCaptions) {
          changes.push(`replace captions "${c.name}" (${c.language})`);
          steps.push(async () => {
            await call(() => this.yt.captions.delete({ id }));
            await this.addCaption(videoId, c.language, c.name, c.file);
          });
        }
      }
    }

    if (o.thumbnail && m.thumbnail) {
      changes.push("thumbnail");
      steps.push(async () => {
        await call(() => this.yt.thumbnails.set({ videoId, media: { mimeType: mime(m.thumbnail!), body: createReadStream(m.thumbnail!) } }));
      });
    }

    return {
      videoId,
      changes,
      apply: async () => {
        for (const s of steps) await s();
      },
    };
  }
}
