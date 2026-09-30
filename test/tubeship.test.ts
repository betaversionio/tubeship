import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifest } from "../src/manifest.js";
import { QuotaExceededError, Tubeship, type YouTube } from "../src/tubeship.js";

/** A fake YouTube client: records calls, answers from simple state. */
function fakeYouTube(state: { playlists?: { id: string; title: string }[]; video?: object; captions?: object[]; inPlaylist?: string[]; quotaOn?: string } = {}) {
  const calls: [string, any][] = [];
  const rec = (name: string, data: object = {}) => async (params: any) => {
    calls.push([name, params]);
    if (state.quotaOn === name) throw Object.assign(new Error("quota"), { errors: [{ reason: "quotaExceeded", message: "quota" }] });
    return { data };
  };
  const yt = {
    channels: { list: rec("channels.list", { items: [{ id: "UC1", snippet: { title: "Chan", customUrl: "@chan" }, brandingSettings: { channel: { description: "old" } }, statistics: { subscriberCount: "3", videoCount: "2" } }] }), update: rec("channels.update") },
    channelBanners: { insert: rec("channelBanners.insert", { url: "https://banner" }) },
    playlists: { list: rec("playlists.list", { items: (state.playlists ?? []).map((p) => ({ id: p.id, snippet: { title: p.title }, contentDetails: { itemCount: 0 }, status: { privacyStatus: "public" } })) }), insert: rec("playlists.insert", { id: "PLnew" }) },
    videos: { insert: rec("videos.insert", { id: "vid1" }), list: rec("videos.list", { items: state.video ? [state.video] : [] }), update: rec("videos.update") },
    captions: { insert: rec("captions.insert"), list: rec("captions.list", { items: state.captions ?? [] }), delete: rec("captions.delete") },
    thumbnails: { set: rec("thumbnails.set") },
    playlistItems: { insert: rec("playlistItems.insert"), list: async (p: any) => (calls.push(["playlistItems.list", p]), { data: { items: state.inPlaylist?.includes(p.playlistId) ? [{ id: "x" }] : [] } }) },
  };
  return { yt: yt as unknown as YouTube, calls, names: () => calls.map(([n]) => n) };
}

function manifest(extra: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tubeship-"));
  writeFileSync(join(dir, "v.mp4"), "fake video");
  writeFileSync(join(dir, "v.en.vtt"), "WEBVTT\n");
  writeFileSync(join(dir, "v.hi.vtt"), "WEBVTT\n");
  const path = join(dir, "v.json");
  writeFileSync(path, JSON.stringify({ file: "v.mp4", title: "Q21", description: "d", tags: ["gate"], categoryId: "27", captions: [{ language: "en", name: "English", file: "v.en.vtt" }, { language: "hi-Latn", name: "Hinglish", file: "v.hi.vtt" }], ...extra }));
  return loadManifest(path);
}

describe("Tubeship", () => {
  it("uploads the video, captions and playlists; reports missing playlists as warnings", async () => {
    const f = fakeYouTube({ playlists: [{ id: "PL1", title: "GATE" }] });
    const created: string[] = [];
    const r = await new Tubeship(f.yt).upload(manifest({ playlists: ["GATE", "Nope"], publishAt: "2030-01-01T12:00:00Z" }), { onCreated: (id) => created.push(id) });
    expect(r.videoId).toBe("vid1");
    expect(created).toEqual(["vid1"]);
    expect(f.names()).toEqual(["videos.insert", "captions.insert", "captions.insert", "playlists.list", "playlistItems.insert"]);
    const insert = f.calls[0]![1];
    expect(insert.requestBody.status).toMatchObject({ privacyStatus: "private", publishAt: "2030-01-01T12:00:00.000Z", selfDeclaredMadeForKids: false });
    expect(insert.requestBody.snippet).toMatchObject({ title: "Q21", categoryId: "27", tags: ["gate"] });
    expect(insert.notifySubscribers).toBe(false);
    expect(r.warnings).toEqual(['playlist "Nope" not found (create it, or pass createPlaylists)']);
  });

  it("turns quota errors into QuotaExceededError", async () => {
    const f = fakeYouTube({ quotaOn: "videos.insert" });
    await expect(new Tubeship(f.yt).upload(manifest())).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("plans a sync: metadata, missing playlist and caption, then applies it", async () => {
    const f = fakeYouTube({
      playlists: [{ id: "PL1", title: "GATE" }, { id: "PL2", title: "Networks" }],
      inPlaylist: ["PL1"],
      video: { id: "vid1", snippet: { title: "Old title", description: "d", tags: ["gate"], categoryId: "27" }, status: { privacyStatus: "private" } },
      captions: [{ id: "cap1", snippet: { language: "en", trackKind: "standard" } }],
    });
    const plan = await new Tubeship(f.yt).syncPlan(manifest({ videoId: "vid1", playlists: ["GATE", "Networks"] }));
    expect(plan.changes).toEqual(['title: "Old title" -> "Q21"', 'add to playlist "Networks"', 'add captions "Hinglish" (hi-Latn)']);
    await plan.apply();
    const update = f.calls.find(([n]) => n === "videos.update")![1];
    expect(update.part).toEqual(["snippet"]);
    expect(update.requestBody.snippet.title).toBe("Q21");
    expect(f.names().filter((n) => n.endsWith(".insert"))).toEqual(["playlistItems.insert", "captions.insert"]);
  });

  it("treats reordered tags as unchanged (YouTube returns them sorted)", async () => {
    const f = fakeYouTube({ video: { id: "vid1", snippet: { title: "Q21", description: "d", tags: ["b tag", "a"], categoryId: "27" }, status: { privacyStatus: "private" } } });
    const plan = await new Tubeship(f.yt).syncPlan(manifest({ videoId: "vid1", tags: ["a", "b tag"], captions: [] }));
    expect(plan.changes).toEqual([]);
  });

  it("reports and updates channel fields", async () => {
    const f = fakeYouTube();
    const ts = new Tubeship(f.yt);
    expect(await ts.whoami()).toEqual({ id: "UC1", title: "Chan", handle: "@chan", subscribers: "3", videos: "2" });
    expect((await ts.channelChanges({ description: "new", country: "IN" })).changes).toEqual([["description", "old", "new"], ["country", "", "IN"]]);
    await ts.updateChannel({ description: "new" });
    expect(f.calls.at(-1)![1].requestBody.brandingSettings.channel).toEqual({ description: "new" });
  });
});
