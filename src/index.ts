// tubeship: a publishing library and CLI for YouTube (YouTube Data API v3).
// Not affiliated with YouTube or Google.

export { Tubeship, QuotaExceededError, type YouTube, type ChannelInfo, type ChannelFields, type PlaylistInfo, type UploadOptions, type UploadResult, type SyncOptions, type SyncPlan } from "./tubeship.js";
export { authorizedClient, signIn, profileDir, SCOPES, type ProfileOptions } from "./auth.js";
export { loadManifest, recordUpload, validateManifest, tagsLength, type VideoManifest, type LoadedManifest, type CaptionTrack, type Privacy } from "./manifest.js";
export { scheduleTimes, parseInterval } from "./schedule.js";
