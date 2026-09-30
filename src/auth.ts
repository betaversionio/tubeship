// OAuth for the YouTube Data API, desktop-app style: the browser opens
// Google's consent page, Google redirects to a one-off loopback server, and
// the token is saved (owner-only) for later runs. Credentials never pass
// through tubeship: you sign in on Google's page. PKCE protects the code.
//
// One folder per channel ("profile"):
//   ~/.config/tubeship/<profile>/client_secret.json   OAuth client (you download it)
//   ~/.config/tubeship/<profile>/token.json           saved sign-in

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OAuth2Client, type Credentials } from "google-auth-library";

/** force-ssl: channel, playlists, captions; upload: videos and thumbnails. */
export const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl", "https://www.googleapis.com/auth/youtube.upload"];

export interface ProfileOptions {
  /** Profile name (default: $TUBESHIP_PROFILE or "default"). */
  profile?: string;
  /** Folder holding client_secret.json and token.json (default: ~/.config/tubeship/<profile>, or $TUBESHIP_CONFIG). */
  dir?: string;
}

export function profileDir(o: ProfileOptions = {}): string {
  if (o.dir) return o.dir;
  if (process.env.TUBESHIP_CONFIG) return process.env.TUBESHIP_CONFIG;
  return join(homedir(), ".config", "tubeship", o.profile ?? process.env.TUBESHIP_PROFILE ?? "default");
}

const secretPath = (o: ProfileOptions) => process.env.TUBESHIP_CLIENT_SECRET ?? join(profileDir(o), "client_secret.json");
const tokenPath = (o: ProfileOptions) => join(profileDir(o), "token.json");

function clientConfig(o: ProfileOptions): { client_id: string; client_secret: string } {
  const path = secretPath(o);
  if (!existsSync(path)) {
    throw new Error(`No OAuth client at ${path}. Create a "Desktop app" OAuth client in Google Cloud Console and save its JSON there (see the README).`);
  }
  const json = JSON.parse(readFileSync(path, "utf8"));
  const c = json.installed ?? json.web;
  if (!c?.client_id) throw new Error(`${path}: not an OAuth client JSON`);
  return c;
}

function saveToken(o: ProfileOptions, t: Credentials): void {
  const path = tokenPath(o);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(t, null, 2));
  chmodSync(path, 0o600);
}

/** An authorized OAuth client for the profile; throws if you haven't signed in. */
export function authorizedClient(o: ProfileOptions = {}): OAuth2Client {
  const c = clientConfig(o);
  const path = tokenPath(o);
  if (!existsSync(path)) throw new Error(`Not signed in (${profileDir(o)}). Run: tubeship auth${o.profile ? ` --profile ${o.profile}` : ""}`);
  const client = new OAuth2Client({ clientId: c.client_id, clientSecret: c.client_secret });
  client.setCredentials(JSON.parse(readFileSync(path, "utf8")));
  // Keep refreshed tokens.
  client.on("tokens", (t) => saveToken(o, { ...JSON.parse(readFileSync(path, "utf8")), ...t }));
  return client;
}

/** Opens Google's consent page and waits for the redirect; saves the token. */
export async function signIn(o: ProfileOptions = {}, open: (url: string) => void = openBrowser): Promise<void> {
  const c = clientConfig(o);
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new OAuth2Client({ clientId: c.client_id, clientSecret: c.client_secret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, code_challenge: codeChallenge, code_challenge_method: "S256" as never });
  console.log(`Opening your browser to sign in. If it doesn't open, visit:\n${url}\n`);
  open(url);
  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const q = new URL(req.url ?? "/", redirectUri).searchParams;
      const got = q.get("code");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(got ? "<p>Signed in. You can close this tab and go back to the terminal.</p>" : "<p>Sign-in failed. Go back to the terminal.</p>");
      if (got) resolve(got);
      else reject(new Error(`sign-in failed: ${q.get("error") ?? "no code"}`));
    });
  }).finally(() => server.close());
  const { tokens } = await client.getToken({ code, codeVerifier });
  saveToken(o, tokens);
  console.log(`Saved sign-in to ${tokenPath(o)} (readable only by you).`);
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
