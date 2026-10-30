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

Options: `--size small|medium|large`, `--snapshot <snapshot-id>` to create boxes from a snapshot
(for example one with your agent already logged in), `--snapshot none` to clear it.

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

Claude Code and Codex are preinstalled in every box. Log in to your agent the first time you run it.

## Limits

- Suspend and resume are not declared yet. Each workspace is create and destroy.
- Pushing from the box needs git credentials in the box, for example `gh auth login` there.
- The first connection to a new box installs Orca's remote runtime, which can take several minutes.

## Uninstall

Remove the plugin in Orca, delete `~/.upstash/box-orca`, and remove the `orca …` SSH key in the
Upstash Console under Box > Settings > SSH Keys.
