# Upstash Box for Orca (experimental)

Run each [Orca](https://www.onorca.dev) workspace in its own [Upstash Box](https://upstash.com/docs/box).
Orca connects to the box over SSH and runs your coding agent there.

Status: experimental. Tested with Orca 1.4.245 on macOS.

## Requirements

- Orca 1.4.245 or later, with Settings > Experimental > Cloud VM turned on
- Node.js 20 or later, `git` and `ssh`
- An Upstash Box API key from the [Upstash Console](https://console.upstash.com)
- A git repository with a remote

## Set up

```bash
npx -y @upstash/box-orca@0.1.0 setup
```

Setup asks for your API key (or reads `UPSTASH_BOX_API_KEY`), then:

- stores it in `~/.upstash/box-orca/config.json` (mode 600)
- creates an SSH key at `~/.upstash/box-orca/id_ed25519` and registers it on your account
- adds the Upstash Box SSH gateway host key to `~/.ssh/known_hosts`
- installs the adapter at `~/.upstash/box-orca/bin/box-orca`, so Orca can run it without your shell `PATH`

Check it with `~/.upstash/box-orca/bin/box-orca doctor`.

Options: `--size small|medium|large`, `--snapshot <snapshot-id>` to create boxes from a specific
snapshot, `--snapshot none` to stop using one.

## Install the plugin

In Orca, open Settings > Plugins > Install from git URL and paste:

```
https://github.com/upstash/box-orca-plugin.git#v0.1.0
```

Then create a workspace and pick **Upstash Box** under Run on > Per-Workspace Environment.

## What happens

On create:

1. A new box is created (or restored from your snapshot).
2. The exact commit Orca selected is bundled on your machine and uploaded, so no git token reaches the box.
3. The box checks out the workspace branch at `/workspace/home/repo`, with your git name and email.
4. Orca connects over SSH.

On destroy, the box is deleted. If create fails at any step, the box it made is deleted.

Closing Orca does not stop anything: agents keep working in the box, and Orca reattaches when you
open it again.

Claude Code and Codex are preinstalled in every box. Log in to your agent the first time you run it.

## Faster workspaces with a snapshot

The first time Orca connects to a box, it uploads its remote runtime (about 100 MB) from your
machine. That can take several minutes, and each new box repeats it. You can skip it, and the
agent login, by snapshotting a box Orca has already set up:

1. Create one workspace on Upstash Box and wait until it connects.
2. In its terminal, log in to your agents (`claude`, `codex`). If you haven't connected GitHub in
   the Upstash Console, also log in to GitHub (see [Pushing to GitHub](#pushing-to-github)).
3. Run:

   ```bash
   ~/.upstash/box-orca/bin/box-orca snapshot
   ```

New workspaces then start from that snapshot, with Orca's runtime installed and your agents
logged in. In our test, a new workspace was usable in about 40 seconds instead of several minutes.

When a box starts from the snapshot, the adapter removes the snapshot's Orca identity (`~/.orca`)
and its old checkout, so every workspace gets its own identity and a fresh checkout.

Good to know:

- The snapshot is a copy of that box. Anything else in its home directory comes along too, such as
  a `gh` login or shell history. Snapshot a box you only used for setup if you want it clean.
- Orca's runtime is tied to the Orca version. After you update Orca, the adapter prints a warning
  when it creates a box. Run `box-orca snapshot` again after the next workspace connects.
- With more than one Orca box running, pick one: `box-orca snapshot --box <box-id>`. Taking a new
  snapshot deletes the previous one.

## Pushing to GitHub

The box gets your code without any GitHub credentials. To push and open pull requests from a
workspace, the box needs a GitHub login. There are two ways:

- **Connect GitHub in the Upstash Console** (Box > Settings). Every new box, including boxes
  started from your snapshot, then gets GitHub credentials for `git` and `gh` automatically. The
  token is written when the box is created and is not renewed inside the box, so a workspace open
  for many hours may need `gh auth login` to push again.
- **Log in inside the box:** run `gh auth login` and `gh auth setup-git` in the workspace's
  terminal. To avoid repeating it, do it before taking a snapshot. If GitHub is also connected in
  the Upstash Console, Box replaces this login with the console's token on every new box.

## Limits

- Workspaces can't be put to sleep from Orca yet. Each workspace runs until you delete it, or
  until Upstash Box pauses it for being idle (below). Sleep needs a change in Orca or Box: after a
  sleep, Orca keeps reconnecting, and each reconnect wakes the box.

- Upstash Box pauses idle boxes on its own after a while (1 hour on the free plan, 6 hours on paid
  plans) when nothing is connected. Orca doesn't know about that pause, and its reconnect does not
  wake the box, so the workspace stays on "Reconnecting". Wake it with
  `ssh -i ~/.upstash/box-orca/id_ed25519 <box-id>@us-east-1.box.upstash.com true`, and Orca
  reconnects on its own.
- Pushing needs a GitHub login in the box. See [Pushing to GitHub](#pushing-to-github).
- Without a snapshot, the first connection to each new box installs Orca's remote runtime, which
  can take several minutes.

## Uninstall

Remove the plugin in Orca, delete `~/.upstash/box-orca`, remove the `orca …` SSH key in the
Upstash Console under Box > Settings > SSH Keys, and delete the `box-orca-…` snapshot if you made
one.
