#!/usr/bin/env node
// Orca VM recipe adapter for Upstash Box (experimental).
//
// Commands:
//   setup    store the API key, create and register an SSH key, trust the gateway host key,
//            and install this adapter at a fixed path the recipe can call
//   create   Orca `create` phase (provisioned-root, SSH mode): one box per workspace
//   destroy  Orca `destroy` phase: delete the box named in the lifecycle payload
//   doctor   check local setup without creating anything
//
// Contract: only the recipe-result JSON goes to stdout. Everything else goes to stderr.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Box } from "@upstash/box";

const VERSION = "0.1.0";
const HOME_DIR = path.join(os.homedir(), ".upstash", "box-orca");
const CONFIG_PATH = path.join(HOME_DIR, "config.json");
const KEY_PATH = path.join(HOME_DIR, "id_ed25519");
const APP_DIR = path.join(HOME_DIR, "app");
const BIN_PATH = path.join(HOME_DIR, "bin", "box-orca");
const DEFAULT_BASE_URL = "https://us-east-1.box.upstash.com";
const PROJECT_ROOT = "/workspace/home/repo";
const BUNDLE_PATH = "/workspace/home/.box-orca/repo.bundle";
// Run in a box restored from a snapshot, before Orca connects.
const SNAPSHOT_RESET = [
  `rm -rf "$HOME/.orca" ${PROJECT_ROOT}`,
  `find "$HOME/.orca-remote" -maxdepth 2 \\( -name '.orcad-pid' -o -name '.orcad-pid-machine' -o -name '.orcad-readiness' -o -name '.orcad-startup-qualified' -o -name 'orcad.log' \\) -delete 2>/dev/null || true`,
];
// Host key of the Upstash Box SSH gateway (us-east-1). Pinned so setup never trusts a key
// fetched over the network.
const GATEWAY_HOST_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDQwt9fucfueVHWq9IQBXEPgXSGOADd51v0p4zW/m31XxQ6rf1yW4tEHG2+Cbg2Br1P1Hdy0u05khmUOnB/aY2HjED2L9XhaEzFJMAELcNOqr/u44RIfcZIi+HtdQCVv6ZkRPK2wC/BRmH+y2NktlD1QolIZUaLuR9EDtj1CVQTVBoW+Oqgq5DdrC5vQHj2J+Gh8iUUgDRbLvA2/Ex/nRHpvsgdeGmIy+Wn0eeQIkYRF6IFEvmDsn5/pmYR09VU99AzY0yDBr2kAkCu+YfCSy/TKiHfWp8/ceCxJDKi/8iD3JWA9WMdCutfOetGnkfXuy0WbndqhOkYqDPblaKfNbbh5VZRfJnHVush+LK2Rv1R2V/au8NllQZVkOUCWz4qp1xPQXO1F0weEh7nPm8jzTjEfV+ZnBX0AhJHFKHkvVdGMg07NrsqQN5NPKYAZfbVBGPpSuya+eu3jVg14AiYe7MThD/yqGWrjilF11OmWTOm2PGyA/wo1zNOt+Zf1CQJfj+kZViQ8MYTe/snEq1v8TYagTh40GDerxHZ+0IxEsbOnvbXkGPIDVMg44++fWyZyGb7EZsKrGe5bPO8+SApG+p3E+t2FASwnQgsGsShUHhfPNchR+1he20ZbXUPpSUa2n1caVK5CwtrsJITsAscjaK3DY2MD9WcHyj9FOBsfWHQ3Q==";

// Keep stdout clean for the recipe result, even if a dependency logs.
const writeResult = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
console.log = (...a) => console.error(...a);
const log = (...a) => console.error("[box-orca]", ...a);

class UserError extends Error {}

// One line per lifecycle call in ~/.upstash/box-orca/lifecycle.log, for debugging what Orca ran.
// Never logs secrets: box ids, timings, and the shape of Orca's payload only.
const LIFECYCLE = new Set(["create", "suspend", "resume", "destroy"]);
function trace(fields) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ t: new Date().toISOString(), cmd: process.argv[2], pid: process.pid, ...fields });
    fs.appendFileSync(path.join(HOME_DIR, "lifecycle.log"), line + "\n", { mode: 0o600 });
  } catch {}
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  return r;
}

function shOk(cmd, args, opts = {}) {
  const r = sh(cmd, args, opts);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout.trim();
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=", 2);
    flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
  }
  return flags;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new UserError(`Not set up. Run: npx -y @upstash/box-orca@${VERSION} setup`);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!cfg.apiKey) throw new UserError(`${CONFIG_PATH} has no apiKey. Run setup again.`);
  return { baseUrl: DEFAULT_BASE_URL, size: "small", ...cfg };
}

function writeConfig(cfg) {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
}

const sshHost = (cfg) => new URL(cfg.baseUrl).hostname;

function sshArgs(cfg, boxId) {
  return [
    "-i", KEY_PATH,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=15",
    `${boxId}@${sshHost(cfg)}`,
  ];
}

// ---------- setup ----------

async function readSecretFromStdin(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stderr.write(prompt);
  const r = sh("sh", ["-c", "stty -echo; IFS= read -r k; stty echo; printf '%s' \"$k\""], {
    stdio: ["inherit", "pipe", "inherit"],
  });
  process.stderr.write("\n");
  return (r.stdout || "").trim();
}

function ensureKnownHost(host) {
  const sshDir = path.join(os.homedir(), ".ssh");
  const knownHosts = path.join(sshDir, "known_hosts");
  const found = sh("ssh-keygen", ["-F", host, "-f", knownHosts]);
  const existing = (found.stdout || "")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/).slice(1, 3).join(" "));
  if (existing.includes(GATEWAY_HOST_KEY)) return "already trusted";
  if (existing.some((k) => k.startsWith("ssh-rsa "))) {
    throw new UserError(
      `~/.ssh/known_hosts has a different ssh-rsa key for ${host}. Remove it with ` +
        `\`ssh-keygen -R ${host}\` only if you know why it changed, then run setup again.`,
    );
  }
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(knownHosts, `${host} ${GATEWAY_HOST_KEY}\n`, { mode: 0o600 });
  return "added";
}

async function registerSSHKey(cfg) {
  const publicKey = fs.readFileSync(`${KEY_PATH}.pub`, "utf8").trim();
  const name = `orca ${os.hostname()}`.replace(/[^A-Za-z0-9 ._@-]/g, "-").slice(0, 64);
  const res = await fetch(`${cfg.baseUrl}/v2/box/settings/ssh-keys`, {
    method: "POST",
    headers: { "X-Box-Api-Key": cfg.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ name, public_key: publicKey }),
  });
  if (res.status === 201) return "registered";
  if (res.status === 409) return "already registered";
  throw new UserError(`Registering the SSH key failed (${res.status}): ${await res.text()}`);
}

function installSelf() {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (path.resolve(pkgRoot) === path.resolve(APP_DIR)) return "already installed";
  const npm = path.join(path.dirname(process.execPath), "npm");
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
  for (const f of ["package.json", "bin", "orca-plugin.json", "vm-recipe.json"]) {
    const src = path.join(pkgRoot, f);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(APP_DIR, f), { recursive: true });
  }
  shOk(fs.existsSync(npm) ? npm : "npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  fs.mkdirSync(path.dirname(BIN_PATH), { recursive: true });
  // Absolute node path: Orca launched from the Dock does not inherit the shell PATH.
  fs.writeFileSync(
    BIN_PATH,
    `#!/bin/sh\nexec ${q(process.execPath)} ${q(path.join(APP_DIR, "bin", "box-orca.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  return BIN_PATH;
}

async function cmdSetup(flags) {
  const prev = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
  const apiKey =
    (typeof flags["api-key"] === "string" && flags["api-key"]) ||
    process.env.UPSTASH_BOX_API_KEY ||
    prev.apiKey ||
    (await readSecretFromStdin("Upstash Box API key: "));
  if (!apiKey) throw new UserError("No API key given.");
  const cfg = {
    apiKey,
    baseUrl: flags["base-url"] || prev.baseUrl || DEFAULT_BASE_URL,
    size: flags.size || prev.size || "small",
  };
  const snapshot = flags.snapshot ?? prev.snapshotId;
  if (snapshot && snapshot !== true && snapshot !== "none") cfg.snapshotId = snapshot;

  log("Checking the API key…");
  await Box.list({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  writeConfig(cfg);
  log(`Config saved to ${CONFIG_PATH} (mode 600)`);

  if (!fs.existsSync(KEY_PATH)) {
    shOk("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `box-orca@${os.hostname()}`, "-f", KEY_PATH]);
    log(`SSH key created at ${KEY_PATH}`);
  }
  log(`SSH key: ${await registerSSHKey(cfg)}`);
  log(`Gateway host key: ${ensureKnownHost(sshHost(cfg))}`);
  log(`Adapter: ${installSelf()}`);
  log("Done. In Orca: Settings > Plugins > Install from git URL, then pick Upstash Box under Run on.");
}

// ---------- create ----------

// Best effort: the newest remote runtime Orca has cached on this Mac, named like the folder Orca
// installs on the box (orcad-<version>). Returns undefined where it cannot tell.
function currentOrcaRuntime() {
  const base = path.join(os.homedir(), "Library", "Application Support", "Orca", "orcad-artifacts");
  try {
    const versions = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "node")
      .flatMap((d) =>
        fs.readdirSync(path.join(base, d.name)).map((v) => ({
          v,
          mtime: fs.statSync(path.join(base, d.name, v)).mtimeMs,
        })),
      )
      .sort((a, b) => b.mtime - a.mtime);
    return versions.length ? `orcad-${versions[0].v}` : undefined;
  } catch {
    return undefined;
  }
}

function prepareBundle(head) {
  const ref = `refs/box-orca/tmp-${process.pid}-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-orca-"));
  const file = path.join(dir, "repo.bundle");
  shOk("git", ["update-ref", ref, head]);
  try {
    shOk("git", ["bundle", "create", file, ref], { stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    sh("git", ["update-ref", "-d", ref]);
  }
  return { file, ref, dir };
}

async function waitForSSH(cfg, boxId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const r = sh("ssh", [...sshArgs(cfg, boxId), `test -d ${q(PROJECT_ROOT + "/.git")} && echo ready`]);
    if (r.status === 0 && r.stdout.includes("ready")) return;
    last = (r.stderr || r.stdout || "").trim();
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`SSH to ${boxId} did not become ready: ${last}`);
}

async function cmdCreate() {
  const cfg = readConfig();
  const env = process.env;
  if (env.ORCA_RECIPE_RESULT_SCHEMA_VERSION !== "2") {
    throw new UserError(
      `This recipe needs provisioned-root (schema 2); Orca asked for schema ` +
        `${env.ORCA_RECIPE_RESULT_SCHEMA_VERSION ?? "(unset)"}. Update Orca to >=1.4.245.`,
    );
  }
  if (env.ORCA_REPO_PATH) process.chdir(env.ORCA_REPO_PATH);
  // A real workspace create passes the pinned source. `orca vm recipe doctor --provision` passes
  // these empty, so fall back to the local checkout's HEAD and origin.
  const fromOrca = Boolean(env.ORCA_REPO_REF_HEAD);
  const head = env.ORCA_REPO_REF_HEAD || shOk("git", ["rev-parse", "HEAD"]);
  const repoUrl = env.ORCA_REPO_URL || sh("git", ["remote", "get-url", "origin"]).stdout.trim();
  const repoRef = env.ORCA_REPO_REF || "HEAD";
  const branch =
    env.ORCA_REPO_BRANCH ||
    `orca-${(env.ORCA_VM_INSTANCE_ID || String(Date.now())).replace(/^orca-/, "").slice(0, 12)}`;
  if (!fromOrca) log(`No pinned source from Orca (self-test?); using local HEAD ${head.slice(0, 12)} on ${branch}`);
  if (!repoUrl) throw new UserError("The repository has no remote. Orca needs one to match the workspace: git remote add origin <url>");

  // The pinned commit must be in the local repo; fetch it with the user's local git auth if not.
  if (sh("git", ["cat-file", "-e", `${head}^{commit}`]).status !== 0) {
    log(`Fetching ${repoRef} from ${repoUrl}…`);
    shOk("git", ["fetch", repoUrl, repoRef], { stdio: ["ignore", "pipe", "pipe"] });
    shOk("git", ["cat-file", "-e", `${head}^{commit}`]);
  }
  const userName = sh("git", ["config", "user.name"]).stdout.trim();
  const userEmail = sh("git", ["config", "user.email"]).stdout.trim();

  log(`Bundling ${head.slice(0, 12)}…`);
  const bundle = prepareBundle(head);
  log(`Bundle: ${(fs.statSync(bundle.file).size / 1e6).toFixed(1)} MB`);

  const name = `orca-${branch}`.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 48);
  const boxOpts = { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, name, labels: ["orca"], size: cfg.size };
  if (!cfg.snapshotId) boxOpts.runtime = "node";

  if (cfg.snapshotId && cfg.snapshotRuntime) {
    const current = currentOrcaRuntime();
    if (current && current !== cfg.snapshotRuntime) {
      log(`Your snapshot has Orca runtime ${cfg.snapshotRuntime}, but this Orca uses ${current}. ` +
        "This workspace will reinstall it on first connect. Afterwards run `box-orca snapshot` to refresh.");
    }
  }
  log(cfg.snapshotId ? `Creating box from snapshot ${cfg.snapshotId}…` : "Creating box…");
  const box = cfg.snapshotId ? await Box.fromSnapshot(cfg.snapshotId, boxOpts) : await Box.create(boxOpts);
  log(`Box ${box.id} is up`);

  let cleaned = false;
  const cleanup = async (why) => {
    if (cleaned) return;
    cleaned = true;
    log(`Create failed (${why}); deleting box ${box.id}…`);
    try {
      await box.delete();
      log(`Deleted ${box.id}`);
    } catch (e) {
      log(`Could not delete ${box.id}: ${e.message}. Delete it in the Upstash console or with: ` +
        `npx @upstash/box-cli delete ${box.id}`);
    }
  };
  const onSignal = (sig) => {
    cleanup(sig).finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await box.files.mkdir(path.posix.dirname(BUNDLE_PATH), { parents: true });
    log("Uploading repository…");
    await box.files.upload([{ path: bundle.file, destination: BUNDLE_PATH }]);

    const script = [
      "set -e",
      // From a snapshot: give this workspace its own Orca identity and a fresh checkout, but keep the
      // installed Orca runtime (~/.orca-remote) and agent logins. Never reuse ~/.orca across boxes.
      ...(cfg.snapshotId ? SNAPSHOT_RESET : []),
      // A bundle clone copies only branches and tags, so fetch the temporary ref explicitly.
      `git init --quiet ${q(PROJECT_ROOT)}`,
      `cd ${q(PROJECT_ROOT)}`,
      `git fetch --quiet ${q(BUNDLE_PATH)} ${q(`${bundle.ref}:refs/box-orca/source`)}`,
      `git remote add origin ${q(repoUrl)}`,
      `git checkout --quiet -B ${q(branch)} ${q(head)}`,
      "git update-ref -d refs/box-orca/source",
      userName ? `git config user.name ${q(userName)}` : "true",
      userEmail ? `git config user.email ${q(userEmail)}` : "true",
      `rm -f ${q(BUNDLE_PATH)}`,
      "git rev-parse HEAD",
    ].join("\n");
    const run = await box.exec.command(`bash -c ${q(script)}`);
    if (run.exitCode !== 0) {
      throw new Error(`Checkout in box failed (${run.exitCode}): ${(run.stderr || run.result || "").trim()}`);
    }
    const got = String(run.result ?? run.stdout ?? "").trim().split("\n").pop();
    if (got !== head) throw new Error(`Checkout landed on ${got}, expected ${head}`);

    log("Waiting for SSH…");
    await waitForSSH(cfg, box.id);

    writeResult(recipeResult(cfg, box.id));
  } catch (e) {
    await cleanup(e.message);
    throw e;
  } finally {
    fs.rmSync(bundle.dir, { recursive: true, force: true });
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

// ---------- destroy ----------

// The SSH connection Orca dials. create and resume both print it.
function recipeResult(cfg, boxId) {
  return {
    schemaVersion: 2,
    checkoutMode: "provisioned-root",
    connection: {
      type: "ssh",
      projectRoot: PROJECT_ROOT,
      target: {
        label: `Upstash Box ${boxId}`,
        host: sshHost(cfg),
        port: 22,
        username: boxId,
        identityFile: KEY_PATH,
        identitiesOnly: true,
      },
    },
    userData: { provider: "upstash-box", resourceId: boxId },
  };
}

// suspend, resume and destroy get Orca's lifecycle payload on stdin.
async function payloadBoxId() {
  const chunks = [];
  if (!process.stdin.isTTY) for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  let id = process.env.REMOTE_WORKSPACE_ID;
  let payload;
  if (raw) {
    payload = JSON.parse(raw);
    id = payload?.recipeResult?.userData?.resourceId ?? id;
  }
  // Record the payload's shape (keys only, no values) to debug Orca contract changes.
  const shape = (v, d = 0) =>
    v && typeof v === "object" && d < 3
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, d + 1)]))
      : typeof v;
  trace({ payload: payload ? shape(payload) : raw ? "unparsed" : "empty", resourceId: id ?? null });
  if (!id) throw new UserError("No resourceId in the lifecycle payload.");
  return id;
}

const boxStatus = async (box) => (await box.getStatus()).status;

// ---------- suspend / resume ----------
// Not declared in vm-recipe.json yet. After a suspend, Orca keeps reconnecting to the workspace,
// and the Box SSH gateway wakes a paused box on any new SSH login, so the box is running again
// within about 30 seconds. Declare these once Orca stops reconnecting to suspended workspaces, or
// Box can turn off wake-on-SSH for a box.
// Pausing stops the box's processes but keeps its files. On reconnect Orca restarts its daemon and
// resumes the agent conversation from its saved history; a command running at pause time is lost.

async function cmdSuspend() {
  const cfg = readConfig();
  const id = await payloadBoxId();
  const box = await Box.get(id, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  if ((await boxStatus(box)) === "paused") {
    log(`Box ${id} is already paused`);
    return;
  }
  await box.pause();
  log(`Paused box ${id}`);
}

async function cmdResume() {
  const cfg = readConfig();
  const id = await payloadBoxId();
  const box = await Box.get(id, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  const status = await boxStatus(box);
  if (status === "paused") {
    log(`Resuming box ${id}…`);
    await box.resume();
  } else {
    log(`Box ${id} is ${status}`);
  }
  await waitForSSH(cfg, id);
  writeResult(recipeResult(cfg, id));
}

// ---------- destroy ----------

async function cmdDestroy() {
  const cfg = readConfig();
  const id = await payloadBoxId();

  // destroy must be safe to repeat: a box that is already gone counts as success.
  const gone = (e) => e?.statusCode === 404 || /not found|been deleted|already deleted/i.test(e?.message ?? "");
  try {
    const box = await Box.get(id, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    await box.delete();
    log(`Deleted box ${id}`);
  } catch (e) {
    if (!gone(e)) throw e;
    log(`Box ${id} is already gone`);
  }
}

// ---------- snapshot ----------
// Snapshot a workspace box Orca has already set up, so later workspaces skip the runtime install.
// `create` removes the snapshot's Orca identity and checkout from every box restored from it.

async function cmdSnapshot(flags) {
  const cfg = readConfig();
  let boxId = typeof flags.box === "string" ? flags.box : undefined;
  if (!boxId) {
    const boxes = await Box.list({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, label: "orca" });
    const live = boxes.filter((b) => b.status !== "deleted");
    if (live.length !== 1) {
      throw new UserError(
        live.length
          ? `Found ${live.length} Orca boxes (${live.map((b) => b.id).join(", ")}); pick one with --box <id>.`
          : "No Orca workspace box found. Create one workspace in Orca on Upstash Box first, then run this.",
      );
    }
    boxId = live[0].id;
  }
  const box = await Box.get(boxId, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  const check = await box.exec.command(
    `bash -c ${q('ls -d "$HOME"/.orca-remote/orcad-*/.install-complete 2>/dev/null | head -1 | xargs -r dirname | xargs -r basename')}`,
  );
  const runtime = String(check.result ?? check.stdout ?? "").trim();
  if (!runtime) {
    throw new UserError(`Orca's runtime is not installed on ${boxId} yet. Wait until the workspace has connected, then retry.`);
  }
  const logins = await box.exec.command(
    `bash -c ${q(
      '[ -s "$HOME/.claude/.credentials.json" ] && echo claude; ' +
        '[ -s "$HOME/.codex/auth.json" ] && echo codex; ' +
        'gh auth status >/dev/null 2>&1 && echo gh; true',
    )}`,
  );
  const found = String(logins.result ?? logins.stdout ?? "").trim().split("\n").filter(Boolean);
  const loggedIn = found.filter((n) => n !== "gh");
  const ghLoggedIn = found.includes("gh");

  log(`Snapshotting ${boxId} (Orca runtime ${runtime})…`);
  const snap = await box.snapshot({ name: `box-orca-${runtime}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60) });
  const previous = cfg.snapshotId;
  writeConfig({ ...cfg, snapshotId: snap.id, snapshotRuntime: runtime });
  log(`Saved snapshot ${snap.id}. New workspaces start from it.`);
  log(loggedIn.length ? `Agent logins included: ${loggedIn.join(", ")}` :
    "No agent logins found in the box; agents will ask you to log in in each workspace.");
  if (!ghLoggedIn) {
    log("No GitHub login in the box. To push from workspaces, connect GitHub in the Upstash Console " +
      "(Box > Settings), or run `gh auth login` and `gh auth setup-git` in the box and snapshot again.");
  }
  if (previous && previous !== snap.id) {
    try {
      await box.deleteSnapshot(previous);
      log(`Deleted the previous snapshot ${previous}`);
    } catch (e) {
      log(`Could not delete the previous snapshot ${previous}: ${e.message}`);
    }
  }
}

// ---------- doctor ----------

async function cmdDoctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  let cfg;
  try {
    cfg = readConfig();
    add("config", true, CONFIG_PATH);
  } catch (e) {
    add("config", false, e.message);
  }
  add("ssh key", fs.existsSync(KEY_PATH), KEY_PATH);
  add("adapter installed", fs.existsSync(BIN_PATH), BIN_PATH);
  if (cfg) {
    try {
      await Box.list({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
      add("api key", true, "valid");
    } catch (e) {
      add("api key", false, e.message);
    }
    const kh = sh("ssh-keygen", ["-F", sshHost(cfg)]).stdout || "";
    add("gateway host key trusted", kh.includes(GATEWAY_HOST_KEY.split(" ")[1]), sshHost(cfg));
  }
  for (const c of checks) log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

// ---------- main ----------

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  setup: cmdSetup,
  create: cmdCreate,
  suspend: cmdSuspend,
  resume: cmdResume,
  destroy: cmdDestroy,
  snapshot: cmdSnapshot,
  doctor: cmdDoctor,
};
if (cmd === "--version" || cmd === "version") {
  console.error(VERSION);
} else if (!commands[cmd]) {
  console.error(`box-orca ${VERSION}\nUsage: box-orca <setup|create|suspend|resume|destroy|snapshot|doctor>`);
  process.exitCode = 2;
} else {
  const started = Date.now();
  if (LIFECYCLE.has(cmd)) {
    trace({ start: true, vmMode: process.env.ORCA_VM_MODE ?? null, instance: process.env.ORCA_VM_INSTANCE_ID ?? null });
  }
  commands[cmd](parseFlags(rest))
    .then(() => LIFECYCLE.has(cmd) && trace({ ok: true, ms: Date.now() - started }))
    .catch((e) => {
      const userFacing = e instanceof UserError || e?.name === "BoxError";
      log(userFacing ? e.message : e.stack || e.message);
      if (LIFECYCLE.has(cmd)) trace({ ok: false, ms: Date.now() - started, error: e.message });
      process.exit(1);
    });
}
