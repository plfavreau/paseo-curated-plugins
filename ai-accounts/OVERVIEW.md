AI accounts manages multiple Claude subscriptions and shows the native OpenAI account beside them, with the same usage bars. OpenAI uses one account per teammate on the daemon host, managed entirely by stock OpenCode.

Claude conversations get a composer pill with their assigned account and usage. Switch an individual conversation or review a Claude-only Balance plan. New Claude conversations follow the usage recommendation unless you set a default. Claude Code keychain namespaces and OpenCode's Anthropic wrapper keep their existing behavior.

## Setup

Requires Paseo 0.12 or later, OpenCode, and sqlite3. Claude Code account switching requires macOS. Add Claude accounts from the screen. The plugin imports an existing native Claude login and installs its Claude wrapper automatically.

For OpenAI, first drain and retire affected old OpenCode processes, including idle servers, with user permission. They retain their broker code and may still refresh tokens. Then run `opencode auth login` on the daemon host and choose OpenAI / ChatGPT. No patched binary or middleware hook is required. Stock OpenCode owns login, credentials, refresh, models, prompts, tools and transport after handoff. The plugin reads OpenAI usage with the token native OpenCode currently holds, through a read-only request at most once a minute; it never refreshes, copies or stores that token, and a rejected or expired token is only reported. The native account is always the OpenAI default. Tapping it moves an OpenCode conversation to the chosen OpenAI model, and Force moves every OpenCode conversation running on Claude there; Claude Code conversations, pins and new conversations are unchanged. There are no OpenAI multiaccount controls. Native auth readiness is a local structural check, not remote credential validation or proof of process retirement.

## Migrating from the OpenAI broker

All existing OpenAI account records remain stored but inactive. Nothing restores or refreshes their tokens. An empty broker sentinel, missing login or unreadable auth requires operator action and native login before handoff; the plugin never silently substitutes a broker credential. Existing independent native logins are preserved.

An installed-directory source edit or pull activates the new entry point for fresh OpenCode processes even without a Paseo reload. Pause launches before any source edit, pull, install or update, and keep them paused through drain, native login, cleanup and readiness.

After native login completes and its process exits, explicitly reload the ai-accounts plugin while still paused to run post-login synchronization; login and read-only readiness probes do not trigger cleanup. Synchronization removes the marker-owned Codex shim and recognized legacy Codex config entries only when native auth is present, with a private config backup. Missing, sentinel or unreadable auth preserves OpenAI shim/config entries; Claude synchronization continues independently. Unowned shims and malformed or ambiguous configs remain for operator review.

The retained Codex compatibility entry blocks OpenAI inference through `chat.params` and `chat.headers` until references are removed, without touching Anthropic, auth or token refresh. Inspect cleanup before checking migration readiness and launching a fresh native process without the guard. Do not treat a preserved shim as inert or a source update as waiting for Paseo reload.

The read-only `ai-accounts.native-ownership` RPC attests the loaded plugin's `ownershipVersion: 1`; source text is not runtime attestation. The handoff CLI requires explicit operator retirement confirmation, a conservative process scan and this live RPC before reporting ready. No simultaneous ownership with old broker processes is safe. The plugin never stops processes or restarts Paseo. See the repository README for exact commands, pending states, limits of process detection and offline verification.
