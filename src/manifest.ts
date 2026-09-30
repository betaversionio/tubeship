// The video manifest: one JSON file per video. Loaded with paths resolved
// against the file's folder, and validated against YouTube's limits before
// anything is sent.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Privacy = "private" | "unlisted" | "public";

export interface CaptionTrack {
  /** BCP-47 language, e.g. "en", "hi", "hi-Latn". */
  language: string;
  /** Track name shown to viewers, e.g. "English". */
  name: string;
  /** Caption file (WebVTT, SRT, ...), relative to the manifest. */
  file: string;
}

export interface VideoManifest {
  /** Video file, relative to the manifest (optional if given on the command line). */
  file?: string;
  title: string;
  description?: string;
  tags?: string[];
  /** YouTube category id (e.g. "27" Education, "22" People & Blogs). Default "22". */
  categoryId?: string;
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
  /** Default "private". A `publishAt` forces private until then. */
  privacy?: Privacy;
  /** ISO time; YouTube publishes the video then. */
  publishAt?: string;
  /** Default false. */
  madeForKids?: boolean;
  /** Disclose realistic altered or synthetic content. */
  containsSyntheticMedia?: boolean;
  /** Playlist titles to add the video to. (`playlist` is accepted too.) */
  playlists?: string[];
  /** Custom thumbnail (JPEG/PNG, max 2 MB), relative to the manifest. */
  thumbnail?: string;
  captions?: CaptionTrack[];
  /** Written by tubeship after upload; its presence makes `upload` skip the video. */
  videoId?: string;
  uploadedAt?: string;
}

/** A manifest with absolute paths and the file it came from. */
export interface LoadedManifest extends VideoManifest {
  path: string;
}

export function loadManifest(path: string): LoadedManifest {
  const abs = resolve(path);
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  const dir = dirname(abs);
  const at = (p: string | undefined) => (p ? resolve(dir, p) : undefined);
  // Accept "playlist" (string or array) for older manifests.
  const playlists = [raw.playlists ?? raw.playlist ?? []].flat().filter(Boolean);
  const m: LoadedManifest = { ...raw, path: abs, playlists };
  delete (m as { playlist?: unknown }).playlist;
  if (raw.file) m.file = at(raw.file);
  if (raw.thumbnail) m.thumbnail = at(raw.thumbnail);
  m.captions = (raw.captions ?? []).map((c: CaptionTrack) => ({ ...c, file: at(c.file)! }));
  return m;
}

/** Records the upload in the manifest file, so reruns skip it (and `sync` can update it). */
export function recordUpload(m: LoadedManifest, videoId: string, now = new Date()): void {
  const raw = JSON.parse(readFileSync(m.path, "utf8"));
  raw.videoId = videoId;
  raw.uploadedAt = now.toISOString();
  writeFileSync(m.path, JSON.stringify(raw, null, 2) + "\n");
  m.videoId = videoId;
  m.uploadedAt = raw.uploadedAt;
}

const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** YouTube counts tags with spaces as quoted, plus a separator between tags. */
export function tagsLength(tags: readonly string[]): number {
  return tags.reduce((n, t) => n + t.length + (t.includes(" ") ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

/**
 * Problems that would make YouTube reject the video (or tubeship fail midway).
 * `needFile`: the video file must exist (uploads; not sync).
 */
export function validateManifest(m: LoadedManifest | VideoManifest, { needFile = true, now = new Date() } = {}): string[] {
  const errors: string[] = [];
  if (!m.title?.trim()) errors.push("title is required");
  else {
    if (m.title.length > 100) errors.push(`title is ${m.title.length} characters (max 100)`);
    if (/[<>]/.test(m.title)) errors.push("title can't contain < or >");
  }
  if (m.description) {
    if (utf8Bytes(m.description) > 5000) errors.push(`description is ${utf8Bytes(m.description)} bytes (max 5000)`);
    if (/[<>]/.test(m.description)) errors.push("description can't contain < or >");
  }
  if (m.tags && tagsLength(m.tags) > 500) errors.push(`tags total ${tagsLength(m.tags)} characters (max 500)`);
  if (m.categoryId && !/^\d+$/.test(m.categoryId)) errors.push(`categoryId "${m.categoryId}" should be a number, e.g. "27"`);
  if (m.privacy && !["private", "unlisted", "public"].includes(m.privacy)) errors.push(`privacy "${m.privacy}" should be private, unlisted or public`);
  if (m.publishAt) {
    const t = Date.parse(m.publishAt);
    if (Number.isNaN(t)) errors.push(`publishAt "${m.publishAt}" isn't a valid time`);
    else if (t <= now.getTime() && !m.videoId) errors.push(`publishAt ${m.publishAt} is in the past`);
  }
  if (needFile) {
    if (!m.file) errors.push("no video file (set \"file\" in the manifest or pass it on the command line)");
    else if (!existsSync(m.file)) errors.push(`video file not found: ${m.file}`);
  }
  if (m.thumbnail) {
    if (!existsSync(m.thumbnail)) errors.push(`thumbnail not found: ${m.thumbnail}`);
    else {
      if (!/\.(jpe?g|png)$/i.test(m.thumbnail)) errors.push("thumbnail should be JPEG or PNG");
      if (statSync(m.thumbnail).size > 2 * 1024 * 1024) errors.push("thumbnail is over 2 MB");
    }
  }
  const langs = new Set<string>();
  for (const c of m.captions ?? []) {
    if (!c.language || !c.name || !c.file) errors.push("each caption needs language, name and file");
    else if (!existsSync(c.file)) errors.push(`caption file not found: ${c.file}`);
    if (langs.has(c.language)) errors.push(`two caption tracks for "${c.language}"`);
    langs.add(c.language);
  }
  return errors;
}
