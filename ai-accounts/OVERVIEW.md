AI accounts manages multiple Claude subscriptions and shows native OpenAI login readiness. OpenAI uses one account per teammate on the daemon host, managed entirely by stock OpenCode.

Claude conversations get a composer pill with their assigned account and usage. Switch an individual conversation or review a Claude-only Balance plan. New Claude conversations follow the usage recommendation unless you set a default. Claude Code keychain namespaces and OpenCode's Anthropic wrapper keep their existing behavior.

## Setup

Requires Paseo 0.12 or later, OpenCode, and sqlite3. Claude Code account switching requires macOS. Add Claude accounts from the screen. The plugin imports an existing native Claude login and installs its Claude wrapper automatically.

For OpenAI, first drain and retire affected old OpenCode processes, including idle servers, with user permission. They retain their broker code and may still refresh tokens. Then run `opencode auth login` on the daemon host and choose OpenAI / ChatGPT. No patched binary or middleware hook is required. Stock OpenCode owns login, credentials, refresh, models, prompts, tools and transport after handoff. This plugin runtime does not poll OpenAI usage or provide OpenAI multiaccount controls. Native auth readiness is a local structural check, not remote credential validation or proof of process retirement.

## Migrating from the OpenAI broker

All existing OpenAI account records remain stored but inactive. Nothing restores or refreshes their tokens. An empty broker sentinel, missing login or unreadable auth requires operator action and native login before handoff; the plugin never silently substitutes a broker credential. Existing independent native logins are preserved.

On intentional deployment, startup removes the marker-owned Codex shim and recognized legacy Codex config entries only when native auth is present, with a private config backup. Missing, sentinel or unreadable auth preserves OpenAI shim/config entries; Claude synchronization continues independently. Unowned shims and malformed or ambiguous configs remain for operator review. The old manual Codex entry point is a no-op.

The read-only `ai-accounts.native-ownership` RPC attests the loaded plugin's `ownershipVersion: 1`; source text is not runtime attestation. The handoff CLI requires explicit operator retirement confirmation, a conservative process scan and this live RPC before reporting ready. No simultaneous ownership with old broker processes is safe. The plugin never stops processes or restarts Paseo. See the repository README for exact commands, pending states, limits of process detection and offline verification.
