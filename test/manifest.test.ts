import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifest, recordUpload, tagsLength, validateManifest } from "../src/manifest.js";
import { parseInterval, scheduleTimes } from "../src/schedule.js";

function fixture(manifest: object) {
  const dir = mkdtempSync(join(tmpdir(), "tubeship-"));
  writeFileSync(join(dir, "video.mp4"), "fake");
  writeFileSync(join(dir, "video.en.vtt"), "WEBVTT\n");
  const path = join(dir, "video.json");
  writeFileSync(path, JSON.stringify(manifest));
  return { dir, path };
}

describe("manifest", () => {
  it("resolves paths against the manifest and accepts the old `playlist` field", () => {
    const { dir, path } = fixture({ file: "video.mp4", title: "T", playlist: "A", captions: [{ language: "en", name: "English", file: "video.en.vtt" }] });
    const m = loadManifest(path);
    expect(m.file).toBe(join(dir, "video.mp4"));
    expect(m.captions?.[0]?.file).toBe(join(dir, "video.en.vtt"));
    expect(m.playlists).toEqual(["A"]);
    expect(validateManifest(m)).toEqual([]);
  });

  it("reports what YouTube would reject", () => {
    const { path } = fixture({ file: "missing.mp4", title: "x".repeat(101), description: "<b>", tags: ["a".repeat(501)], privacy: "secret", publishAt: "2020-01-01T00:00:00Z", categoryId: "Education", captions: [{ language: "en", name: "E", file: "nope.vtt" }] });
    const errs = validateManifest(loadManifest(path), { now: new Date("2026-01-01") });
    expect(errs.join("\n")).toMatch(/title is 101 characters/);
    expect(errs.join("\n")).toMatch(/can't contain < or >/);
    expect(errs.join("\n")).toMatch(/tags total 501/);
    expect(errs.join("\n")).toMatch(/privacy "secret"/);
    expect(errs.join("\n")).toMatch(/in the past/);
    expect(errs.join("\n")).toMatch(/categoryId/);
    expect(errs.join("\n")).toMatch(/video file not found/);
    expect(errs.join("\n")).toMatch(/caption file not found/);
  });

  it("counts tags the way YouTube does", () => {
    expect(tagsLength(["gate", "gate cs"])).toBe(4 + 9 + 1);
  });

  it("records the upload in the file", () => {
    const { path } = fixture({ file: "video.mp4", title: "T" });
    const m = loadManifest(path);
    recordUpload(m, "abc123", new Date("2026-10-01T00:00:00Z"));
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw).toMatchObject({ file: "video.mp4", videoId: "abc123", uploadedAt: "2026-10-01T00:00:00.000Z" });
  });
});

describe("schedule", () => {
  it("spreads publish times and keeps existing ones", () => {
    expect(parseInterval("12h")).toBe(43_200_000);
    expect(() => parseInterval("tomorrow")).toThrow(/use a number/);
    const times = scheduleTimes([{}, { publishAt: "2026-12-25T10:00:00.000Z" }, {}], "2026-10-05T18:00:00+05:30", "1d");
    expect(times).toEqual(["2026-10-05T12:30:00.000Z", "2026-12-25T10:00:00.000Z", "2026-10-06T12:30:00.000Z"]);
  });
});
