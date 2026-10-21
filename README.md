# Paseo curated plugins

Custom plugins for [Paseo](https://paseo.sh). Each directory is a standalone plugin.

| Plugin | What it does |
| --- | --- |
| [`image-preview`](./image-preview) | Renders inline thumbnails for image files the agent reads, instead of a plain text row. |
| [`system-health`](./system-health) | Sidebar pills for CPU, RAM and disk usage, with a Clean button that prompts a session of your choice. |
| [`ai-accounts`](./ai-accounts) | Sign in several Claude and ChatGPT subscriptions, see their limits, and move conversations between them. |

## Install

Plugins must be enabled once on the daemon. Add this to the top level of `~/.paseo/config.json`:

```json
{
  "version": 1,
  "pluginsEnabled": true
}
```

Then apply it without restarting the daemon:

```bash
paseo reload
```

Clone the repo and install the plugin you want:

```bash
git clone https://github.com/plfavreau/paseo-curated-plugins.git
cd paseo-curated-plugins/image-preview
npm install
paseo plugin install "$PWD"
paseo plugin ls
```

`paseo plugin ls` should show status `running`. Restart the Paseo app to pick up the plugin, because the client bundle is only fetched on a fresh connect.

After editing a plugin's source, run `paseo plugin reload <id>`. Never restart the daemon for this, it would kill running agents.

## image-preview

Any `Read` of a `.png`, `.jpg`, `.gif`, `.webp` and similar becomes a thumbnail in the timeline. Tap it to open a full size view with the file path and a download button. The viewer includes previous/next buttons to browse completed image reads in conversation order; on the web and desktop, the left/right arrow keys also navigate, and Escape closes the viewer. Repeated reads of the same file remain separate slides.

The daemon downscales to 1024px wide and sends a JPEG data URI, so large screenshots stay cheap over the wire.

Requires `ffmpeg` and `ffprobe` on the daemon machine.

### Download button

Downloads need no setup. The daemon streams the original file to the app in 384 KB chunks over the connection you already have, and the app saves it. The file never leaves your daemon and your device, and nothing is uploaded anywhere.

The thumbnail is a downscaled JPEG, but the download is the untouched original file.

This works in the Paseo web app, which includes the mobile app. On a build with no browser file APIs the button says so instead of failing silently. Files above 64 MB are refused.

## system-health

A sidebar row shows three pills for CPU, RAM and disk usage on the daemon machine: green below 80%, orange from 80% to 95%, red above 95%. They refresh every 15 seconds.

Tap the row for a popover with the details and a **Clean** button. Clean sends a prompt with the current readings to the session you pick in "Send cleanup prompt to" (searchable, grouped and ordered like the sidebar), so an agent you keep open can run another cleanup round. The plugin never deletes anything itself. The prompt is editable under Settings → Plugins → System health; `{stats}` is replaced with the readings.

On macOS, RAM uses `memory_pressure`, which ignores the file cache macOS counts as used.

## ai-accounts

Sign in several Claude and ChatGPT (Codex) subscriptions and spread conversations across them. Every conversation gets a composer pill with its account and usage; click it to move the conversation to another account. The AI accounts screen shows every account's 5-hour and weekly limits, and a **Balance** button proposes moves to even out the load before anything changes.

New conversations start on the account furthest behind its usage pace. Mark one as **Default** to pin new conversations to it instead.

### Requirements

- Paseo 0.12 or later.
- OpenCode for Claude and Codex accounts, Claude Code for Claude accounts.
- macOS for Claude Code: each account's credentials live in their own Keychain entry.
- `sqlite3` on `PATH` (shipped with macOS).

The Codex CLI keeps its own login, so its conversations get no pill.

### OpenCode setup

Nothing to configure. OpenCode reaches the accounts through two auth plugins in this directory, which wrap [`@ex-machina/opencode-anthropic-auth`](https://www.npmjs.com/package/@ex-machina/opencode-anthropic-auth) and [`opencode-openai-codex-auth`](https://www.npmjs.com/package/opencode-openai-codex-auth). As soon as you add a Claude or Codex account, the Paseo plugin drops a one-line file for that provider into `~/.config/opencode/plugins/` (`ai-accounts-anthropic.ts`, `ai-accounts-codex.ts`), which OpenCode loads on its own. Removing the provider's last account removes the file. Without any account, OpenCode is left untouched.

If you have another Anthropic or Codex auth plugin in `~/.config/opencode/opencode.json`, remove it.

Restart your OpenCode conversations after adding the first account. `npm install` also patches `opencode-openai-codex-auth` 4.4.0 so it passes current GPT model ids through instead of rewriting them to `gpt-5.1`, which the ChatGPT backend rejects.

### Balance options

Balance sorts conversations into careful work and housekeeping, by title by default. Two switches in the plan, both off at first and remembered:

- **Send housekeeping to Codex** moves housekeeping conversations from Claude to Codex.
- **Sort conversations with a Codex model** asks the smallest Codex model in your catalog to sort them instead of guessing from titles. It sends each conversation's title, project name, tool counts and first and latest request (truncated) to OpenAI through your own Codex account, once per Balance.

### Good to know

- Logins use the same public OAuth clients as Claude Code and the Codex CLI. Using a subscription outside the vendor's own tools may be against its terms; you decide.
- Tokens are stored in `~/.local/share/ai-accounts/accounts.json` (mode 600) and, for Claude Code, in the macOS Keychain. Removing an account deletes both.
- Claude Code reads credentials from a per-account Keychain entry through an undocumented setting, so a Claude Code update could break switching there. `/status` inside Claude Code shows your own email for every account; the account in use is the one the pill shows.

## License

MIT
