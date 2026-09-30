#!/usr/bin/env node
// tubeship: a publishing CLI for YouTube. Every command that changes a
// channel prints a plan and asks first (--yes skips, --dry-run only prints).

import { existsSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import pkg from "../package.json" with { type: "json" };
import { profileDir, signIn } from "./auth.js";
import { loadManifest, recordUpload, validateManifest, type LoadedManifest, type Privacy } from "./manifest.js";
import { scheduleTimes } from "./schedule.js";
import { QuotaExceededError, Tubeship } from "./tubeship.js";

interface Globals {
  profile?: string;
  yes?: boolean;
  dryRun?: boolean;
}

const program = new Command()
  .name("tubeship")
  .description("A publishing CLI for YouTube: manifests in, videos out. Not affiliated with YouTube or Google.")
  .version(pkg.version)
  .option("-p, --profile <name>", "channel profile (credentials in ~/.config/tubeship/<name>/)", process.env.TUBESHIP_PROFILE)
  .option("-y, --yes", "don't ask before changing the channel")
  .option("--dry-run", "only print what would change")
  .showHelpAfterError();

const globals = (): Globals => program.opts<Globals>();
const connect = () => Tubeship.connect({ ...(globals().profile && { profile: globals().profile }) });

async function confirm(plan: string): Promise<boolean> {
  console.log(plan);
  if (globals().dryRun) {
    console.log("\n(dry run: nothing changed)");
    return false;
  }
  if (globals().yes) return true;
  if (!process.stdin.isTTY) throw new Error("not a terminal: pass --yes to confirm, or --dry-run");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("\nProceed? (y/N) ");
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Manifest paths from files and folders (a folder means every *.json in it, sorted). */
function manifestPaths(inputs: string[]): string[] {
  return inputs.flatMap((p) =>
    statSync(p).isDirectory()
      ? readdirSync(p)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => join(p, f))
      : [p],
  );
}

program
  .command("auth")
  .description("sign in (opens Google's sign-in page in your browser)")
  .action(async () => {
    await signIn({ ...(globals().profile && { profile: globals().profile }) });
    const me = await connect().whoami();
    console.log(`${me.title} ${me.handle ?? ""}`);
  });

program
  .command("whoami")
  .description("show the signed-in channel")
  .action(async () => {
    const me = await connect().whoami();
    console.log(`profile ${profileDir({ ...(globals().profile && { profile: globals().profile }) })}`);
    console.log(`${me.title}  ${me.handle ?? ""}  (${me.subscribers ?? "hidden"} subscribers, ${me.videos ?? 0} videos)`);
    console.log(`https://www.youtube.com/channel/${me.id}`);
  });

program
  .command("channel")
  .description("update the channel description, keywords, country, language")
  .option("--description <text>")
  .option("--keywords <text>", 'space separated; quote phrases: \'gate "gate cs"\'')
  .option("--country <code>", "e.g. IN, US")
  .option("--language <code>", "default language, e.g. en")
  .action(async (o: { description?: string; keywords?: string; country?: string; language?: string }) => {
    const ts = connect();
    const fields = {
      ...(o.description !== undefined && { description: o.description }),
      ...(o.keywords !== undefined && { keywords: o.keywords }),
      ...(o.country !== undefined && { country: o.country }),
      ...(o.language !== undefined && { defaultLanguage: o.language }),
    };
    const { title, changes } = await ts.channelChanges(fields);
    if (!changes.length) return console.log("Nothing to change.");
    const plan = [`Update channel "${title}":`, ...changes.map(([k, a, b]) => `  ${k}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`)].join("\n");
    if (await confirm(plan)) {
      await ts.updateChannel(fields);
      console.log("Channel updated.");
    }
  });

program
  .command("banner <image>")
  .description("upload the channel banner (2560x1440, max 6 MB)")
  .action(async (image: string) => {
    const ts = connect();
    const me = await ts.whoami();
    if (await confirm(`Set ${image} (${(statSync(image).size / 1e6).toFixed(1)} MB) as the banner of "${me.title}".`)) {
      await ts.setBanner(image);
      console.log("Banner updated (YouTube can take a few minutes to show it).");
    }
  });

program
  .command("playlists")
  .description("list playlists, or create missing ones")
  .option("--create <titles...>", "create these playlists if they don't exist")
  .option("--description <text>", "description for created playlists", "")
  .addOption(new Option("--privacy <privacy>", "privacy for created playlists").choices(["public", "unlisted", "private"]).default("public"))
  .action(async (o: { create?: string[]; description: string; privacy: Privacy }) => {
    const ts = connect();
    const list = await ts.playlists();
    for (const p of list) console.log(`${p.title}  (${p.itemCount} videos, ${p.privacy})  ${p.id}`);
    if (!list.length) console.log("No playlists yet.");
    const missing = (o.create ?? []).filter((t) => !list.some((p) => p.title === t));
    if (!missing.length) return;
    if (await confirm(`\nCreate ${missing.length} ${o.privacy} playlist(s):\n${missing.map((t) => `  ${t}`).join("\n")}`)) {
      for (const t of missing) console.log(`Created "${t}"  ${(await ts.createPlaylist(t, { description: o.description, privacy: o.privacy })).id}`);
    }
  });

program
  .command("upload <manifests...>")
  .description("upload videos from manifests (files or folders); resumes where it stopped")
  .option("--file <video>", "video file (one manifest only; overrides \"file\")")
  .addOption(new Option("--privacy <privacy>", "override privacy").choices(["private", "unlisted", "public"]))
  .option("--publish-at <time>", "publish at this ISO time (one manifest)")
  .option("--schedule <start>", "spread publish times: first at <start> (ISO), then every --every")
  .option("--every <interval>", "interval for --schedule: 1d, 12h, 90m, 1w", "1d")
  .option("--thumbnail <image>", "override thumbnail (one manifest)")
  .option("--playlist <titles...>", "override playlists")
  .option("--create-playlists", "create playlists that don't exist")
  .action(async (inputs: string[], o: { file?: string; privacy?: Privacy; publishAt?: string; schedule?: string; every: string; thumbnail?: string; playlist?: string[]; createPlaylists?: boolean }) => {
    const all = manifestPaths(inputs).map(loadManifest);
    const single = all.length === 1;
    if (!single && (o.file || o.publishAt || o.thumbnail)) throw new Error("--file, --publish-at and --thumbnail work with one manifest; use --schedule for several");
    const done = all.filter((m) => m.videoId);
    const todo = all.filter((m) => !m.videoId);
    for (const m of done) console.log(`skip ${m.path}: already uploaded (https://youtu.be/${m.videoId})`);
    if (!todo.length) return console.log("Nothing to upload.");
    for (const m of todo) {
      if (o.file) m.file = resolve(o.file);
      if (o.privacy) m.privacy = o.privacy;
      if (o.publishAt) m.publishAt = o.publishAt;
      if (o.thumbnail) m.thumbnail = resolve(o.thumbnail);
      if (o.playlist) m.playlists = o.playlist;
    }
    if (o.schedule) scheduleTimes(todo, o.schedule, o.every).forEach((t, i) => (todo[i]!.publishAt = t));
    const invalid = todo.map((m) => [m, validateManifest(m)] as const).filter(([, e]) => e.length);
    if (invalid.length) {
      for (const [m, errs] of invalid) console.error(`${m.path}:\n${errs.map((e) => `  - ${e}`).join("\n")}`);
      throw new Error(`${invalid.length} manifest(s) need fixing (nothing was uploaded)`);
    }
    const plan = [
      `Upload ${todo.length} video(s)${done.length ? ` (${done.length} already done)` : ""}:`,
      ...todo.map((m) => {
        const privacy = m.publishAt ? `private until ${m.publishAt}` : (m.privacy ?? "private");
        return [
          `  ${m.title}`,
          `    ${m.file} (${(statSync(m.file!).size / 1e6).toFixed(1)} MB), ${privacy}`,
          `    captions: ${(m.captions ?? []).map((c) => c.name).join(", ") || "none"}; thumbnail: ${m.thumbnail ? "yes" : "YouTube's pick"}; playlists: ${m.playlists?.join(", ") || "none"}`,
        ].join("\n");
      }),
      "",
      `Quota: about ${todo.length * 1600 + todo.reduce((n, m) => n + (m.captions?.length ?? 0) * 400 + (m.playlists?.length ?? 0) * 50, 0)} of 10,000 daily units.`,
      "Note: uploads from an unaudited Google Cloud project stay private until the project passes YouTube's API audit.",
    ].join("\n");
    if (!(await confirm(plan))) return;
    // Keep the scheduled slots, so a resumed batch publishes on the same days.
    if (o.schedule) for (const m of todo) persist(m, { publishAt: m.publishAt });
    const ts = connect();
    let uploaded = 0;
    for (const m of todo) {
      try {
        const r = await ts.upload(m, {
          ...(o.createPlaylists && { createPlaylists: true }),
          onProgress: (f) => process.stdout.write(`\r  ${m.title}: ${Math.round(f * 100)}%`),
          onCreated: (id) => recordUpload(m, id),
        });
        uploaded++;
        console.log(`\r  ${m.title}: ${r.url}`);
        for (const w of r.warnings) console.log(`    warning: ${w}`);
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          console.error(`\n${err.message}. Uploaded ${uploaded} of ${todo.length}; run the same command after the reset to continue.`);
          process.exitCode = 2;
          return;
        }
        throw err;
      }
    }
  });

program
  .command("sync <manifests...>")
  .description("update uploaded videos to match their manifests (metadata, playlists, captions)")
  .option("--replace-captions", "replace caption tracks that already exist")
  .option("--thumbnail", "upload the thumbnail again")
  .option("--create-playlists", "create playlists that don't exist")
  .action(async (inputs: string[], o: { replaceCaptions?: boolean; thumbnail?: boolean; createPlaylists?: boolean }) => {
    const ts = connect();
    const plans: { m: LoadedManifest; apply: () => Promise<void> }[] = [];
    const lines: string[] = [];
    for (const m of manifestPaths(inputs).map(loadManifest)) {
      if (!m.videoId) {
        console.log(`skip ${m.path}: not uploaded yet`);
        continue;
      }
      const errs = validateManifest(m, { needFile: false });
      if (errs.length) throw new Error(`${m.path}:\n${errs.map((e) => `  - ${e}`).join("\n")}`);
      const p = await ts.syncPlan(m, { ...(o.replaceCaptions && { replaceCaptions: true }), ...(o.thumbnail && { thumbnail: true }), ...(o.createPlaylists && { createPlaylists: true }) });
      if (!p.changes.length) continue;
      plans.push({ m, apply: p.apply });
      lines.push(`  ${m.title} (https://youtu.be/${p.videoId})`, ...p.changes.map((c) => `    ${c}`));
    }
    if (!plans.length) return console.log("Everything matches.");
    if (!(await confirm(`Update ${plans.length} video(s):\n${lines.join("\n")}`))) return;
    for (const p of plans) {
      await p.apply();
      console.log(`  updated ${p.m.title}`);
    }
  });

/** Writes fields back into a manifest file (keeping everything else as written). */
function persist(m: LoadedManifest, fields: Record<string, unknown>): void {
  if (!existsSync(m.path)) return;
  const raw = JSON.parse(readFileSync(m.path, "utf8"));
  writeFileSync(m.path, JSON.stringify({ ...raw, ...fields }, null, 2) + "\n");
}

try {
  await program.parseAsync();
} catch (err) {
  console.error(`\nError: ${(err as Error).message}`);
  process.exit(1);
}
