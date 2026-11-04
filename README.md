# Paseo curated plugins

Custom plugins for [Paseo](https://paseo.sh). Each directory is a standalone plugin.

| Plugin | What it does |
| --- | --- |
| [`image-preview`](./image-preview) | Renders inline thumbnails for image files the agent reads, instead of a plain text row. |
| [`system-health`](./system-health) | Sidebar pills for CPU, RAM and disk usage, with a Clean button that prompts a session of your choice. |
| [`ai-accounts`](./ai-accounts) | Manage multiple Claude subscriptions; OpenAI uses one native OpenCode account. |
| [`pin-notes`](./pin-notes) | Pin notes and links to a conversation, shown as pills above the composer with the page title and favicon. |

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

## pin-notes

Pin a note or a link to a conversation. Open the Command Center (Ctrl+K, ⌘K on macOS) and run **Pin note** or **Manage pins**: one dialog to add a pin at the top and see, open or unpin your pins below.

Each pin is a pill above the composer. A link pill opens the page and shows its favicon; a note pill opens a popover with the text. When the description holds a URL, the daemon fetches the page once to fill in the title and favicon (a title you type wins).

Agents get three tools for their own conversation's pins: `pins_list`, `pin_set` (create, or update by id) and `pin_remove`. They pin the ticket, PRs and preview URLs they work with, keep them current and remove the ones they created once stale; they ask before removing yours. Pins an agent adds show up within a few seconds, while it is still working. New agents also get a short rule in their system prompt so they pin without being asked. OpenCode agents are skipped for now: a shared `opencode serve` process does not pick up per-agent tools.

Pins are stored on the daemon machine in `~/.paseo/plugin-data/pin-notes/pins.json`. Requires Paseo 0.15 or newer.

## ai-accounts

Sign in several Claude subscriptions and spread Claude conversations across them. Each Claude conversation gets a pill with its account and usage; click it to switch accounts. The accounts screen shows limits and a **Balance** button proposes Claude-only moves before anything changes.

New Claude conversations start on the account furthest behind its usage pace. Mark one as **Default** to pin new Claude conversations to it instead. Claude Code keychain namespaces, session preparation and the OpenCode Anthropic auth wrapper are unchanged.

### Requirements

- Paseo 0.12 or later.
- Stock upstream OpenCode for Claude and native OpenAI; Claude Code for Claude accounts.
- macOS for Claude Code: each account's credentials live in their own Keychain entry.
- `sqlite3` on `PATH` (shipped with macOS).

The Codex CLI keeps its own login, so its conversations get no pill.

### OpenCode setup

Claude accounts install `ai-accounts-anthropic.ts` in OpenCode's global plugins directory and wrap [`@ex-machina/opencode-anthropic-auth`](https://www.npmjs.com/package/@ex-machina/opencode-anthropic-auth). Existing Claude login import and renewal behavior is preserved.

OpenAI is **native managed, single account per teammate/host**. Use stock upstream OpenCode, with its native OpenAI login, model handling, prompts, tools, HTTP and WebSocket transport. No core patch or auth-loader middleware is required. Sign in using the native CLI on the daemon host:

```sh
opencode auth login
```

Choose OpenAI / ChatGPT, but first complete the legacy-process drain below. This plugin runtime does not offer OpenAI login, assignment, account deletion, default selection, usage polling, token refresh, auto-balance or LLM sorting. Old OpenAI records and metadata remain in `accounts.json`, inactive and never copied into native auth. An existing independent native OAuth or API-key login is left intact; the status check is structural and does not remotely validate credentials. Old OpenCode processes can still refresh broker tokens until fully retired, regardless of new files on disk.

### Native OpenAI handoff

Editing an installed directory is activation for **fresh OpenCode processes**, even without a Paseo plugin reload: a retained shim imports whatever source is now at its target. Pause launches **before** pulling, editing, installing or updating the plugin source. Already running processes keep their old broker code. Provisioning must coordinate these steps. Auth presence, plugin attestation and process retirement are separate conditions; none alone authorizes native inference:

1. Pause new OpenCode launches **before any pull/source edit/plugin install or update**. Inspect the affected process/server inventory and obtain user permission before retiring anything. Let running turns finish, then fully retire the old OAuth-using OpenCode processes, **including idle servers**, before native login or inference. Changing source, replacing a launcher or loading a new Paseo plugin does not unload their broker. Do not infer retirement from a process timestamp, plugin source text or an idle agent. Do not restart Paseo or kill/restart processes automatically.
2. After intentional deployment, query the **loaded** plugin from `ai-accounts` with `bun scripts/native-handoff.mjs --attest-only`. It calls the dedicated read-only RPC `invokePluginRpc("ai-accounts", "ai-accounts.native-ownership", {})` on the loopback daemon. An older plugin rejects the unknown method without invoking its old, potentially mutating state migration. Exit 0 means a valid versioned response with structurally present native auth only; this mode always prints `handoffReady: false`. Missing/unknown versions, missing/unreadable auth, unavailable RPC and non-local endpoints exit 2. Never substitute source-text inspection for this probe.
3. Require `ownership.ownershipVersion === 1` and `ownership.status === "native-auth-present"`. Version 1 attests only that the responding plugin runtime no longer imports, refreshes or routes OpenAI broker credentials. It does **not** attest old-process retirement, binary selection, config cleanup or remote token validity. The existing state RPC `ai-accounts.state` with `{ "provider": "openai", "refreshUsage": false }` exposes the same object as `nativeOpenAI`, but do not probe an unknown old runtime through that RPC because old state handlers can migrate credentials.
4. An absent/empty OAuth entry, invalid shape or reserved `ai-accounts-broker-bootstrap` sentinel is **not** usable auth. Require native login after the drain before declaring handoff ready. Do not restore stored broker tokens, even if one appears current. Unreadable auth requires operator inspection, not overwrite.
5. After native login has completed and its process has exited, **while launches remain paused**, explicitly run `paseo plugin reload ai-accounts` to run post-login synchronization. Merely logging in or reading the readiness RPC does not trigger shim cleanup. Only when native auth is structurally present does synchronization remove a marker-owned `ai-accounts-codex.ts` shim and recognized OpenAI entries from global config. Missing/sentinel/unreadable auth leaves those OpenAI shim/config entries intact and logs pending login; Claude synchronization continues independently. It never creates an OpenAI shim. Unowned files remain for operator inspection. Wait for synchronization and inspect the actual shim/config files before the migration-readiness gate; live ownership attestation alone does not prove asynchronous cleanup finished.
6. Recognized config entries are `opencode-openai-codex-auth` and manual `ai-accounts/opencode-codex-plugin.ts` paths in the top-level `plugin` array of `opencode.json` / `opencode.jsonc`. Removal creates a private `.bak-ai-accounts-*` backup and preserves unrelated settings/comments. Malformed or ambiguous configs and project-local overrides need manual review. Never restore a whole old config backup, which would reintroduce interception. Until references are removed, the compatibility entry initializes successfully but rejects **OpenAI inference only**, through `chat.params` and `chat.headers`, with a pending-handoff instruction. Anthropic is unchanged. It never loads broker auth, refreshes tokens or wraps native transport. Fresh processes loading a preserved shim therefore fail closed rather than silently activating native inference. A process that already loaded this guard keeps it: only launch a fresh native process after cleanup and readiness, without those references.
7. After the operator has verified retirement, run `bun scripts/native-handoff.mjs --confirm-legacy-retired` on the daemon host. It still blocks on **any** recognizable local OpenCode process (conservatively including stock servers), failed process inspection, unavailable/old live plugin or missing native auth. Exit 0 requires all gates; exit 2 reports pending. It returns PIDs, never argv or tokens, and never stops anything. This flag confirms operator review, not permission to kill. Renamed, wrapped or remote processes sharing the credentials require explicit operator inspection beyond `ps`; the scan is point-in-time, not a launch lock. Keep launches paused through the handoff.
8. Once all gates and config/launcher review pass, the umbrella's separate provisioning flow may launch stock OpenCode and verify a native request. Re-running the conservative drain gate after new servers start will block again by design. This repo neither provisions nor patches OpenCode. No safe overlap with old broker refresh ownership is claimed.

The exact dedicated RPC response is `{ "ownershipVersion": 1, "status": "native-auth-present" | "native-login-required" | "unreadable", "message": "..." }`. The CLI's `--attest-only` wraps it as `{ "handoffReady": false, "ownership": <response>, "message": "..." }`; the full gate returns `{ "ready": boolean, "reason": "...", ... }`. Unknown versions and missing fields fail closed. These read-only commands never renew credentials or write configs.

No migration code deletes or writes OpenAI auth, refreshes a broker credential, or imports native OpenAI credentials. The old sentinel is diagnosed, not silently repaired. Claude migration/renewal may still update Claude's auth as before.

### Verification

CI pins Node 22.22.2 and Bun 1.3.14: `npm ci --include=dev`, `npm run typecheck`, `npm test`. Regressions use temporary config/data and synthetic credentials, mock Claude keychain and Paseo access, and prove inactive OpenAI records survive, UI refresh makes no OpenAI requests, sentinel detection, scoped config cleanup and unchanged Claude routing/session preparation.

`OPENCODE_SOURCE=/path/to/stock/opencode npm run test:native` exercises the actual unmodified upstream v1.18.26 native adapter at commit `774cc7c1914e4329eefde5a669f938b0cf566661`, after `bun install --frozen-lockfile` there. It verifies native login/model hooks, HTTP/WebSocket requests with unchanged instructions/tools, pool reuse, HTTP fallback and native refresh/writeback against a synthetic loopback server. It neither patches source nor composes an auth-loader middleware. It is an adapter integration fixture, not a live account or full CLI end-to-end test.


### Good to know

- Logins use the same public OAuth clients as Claude Code and the Codex CLI. Using a subscription outside the vendor's own tools may be against its terms; you decide.
- Claude tokens are stored in `~/.local/share/ai-accounts/accounts.json` (mode 600) and, for Claude Code, in the macOS Keychain. Removing a Claude account deletes both. Legacy OpenAI records cannot be deleted through this UI.
- Claude Code reads credentials from a per-account Keychain entry through an undocumented setting, so a Claude Code update could break switching there. `/status` inside Claude Code shows your own email for every account; the account in use is the one the pill shows.

## License

MIT
