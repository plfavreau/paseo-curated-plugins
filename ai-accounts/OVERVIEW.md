AI accounts lets you sign in several Claude and ChatGPT (Codex) subscriptions and spread your conversations across them.

Each conversation gets a composer pill showing which account it runs on and how much of that account's 5-hour and weekly limits is used. Click it to move the conversation to another account; the agent restarts on the new account and picks up where it left off. New conversations start on the account that is furthest behind its usage pace, unless you set a default.

The AI accounts screen (sidebar, or ⌘K "AI accounts (all sessions)") lists every account with its limits and conversations, and a Balance button that proposes moves to even out the load. You review the moves before anything changes.

## Setup

Add accounts from the screen with "Add account". Provider shims are installed automatically in OpenCode's global plugins directory; see the README for the required Codex build.

Codex requires an OpenCode build advertising `capabilities.authLoaderMiddleware`, provisioned with `make opencode-native` from the Minitap umbrella before installation. The Codex entry point wraps the built-in OpenAI OAuth loader only: native login methods, models, instructions, tools, and request bodies stay native. On older builds it loads OpenAI-only hooks that reject inference, because OpenCode swallows initialization errors and could otherwise bypass routing. Anthropic is unaffected. There is no third-party Codex fallback or opt-out flag. After upgrading, restart ONLY affected idle OpenCode processes, never the Paseo daemon. Do not enable another OpenAI auth replacement alongside it.

Each request snapshots its broker account, refreshes that exact account before native fetch, and pins a single 401 refresh/retry to it even if the conversation assignment changes. Missing assigned accounts and accounts requiring sign-in fail closed. Native loaders (including WebSocket pools) are isolated by account and credential fingerprint, without changing session IDs, so native session deletion and disposal still clean up their pools. Old credential loaders remain registered until native disposal; idle sockets retain native expiry behavior.

Adding or migrating broker accounts initializes OpenCode's OpenAI `auth.json` entry only when absent, using an empty OAuth sentinel with the reserved `accountId` `ai-accounts-broker-bootstrap`. Native activation and model filtering require only the OAuth type, not a plan JWT. No live broker credentials are duplicated. Migration ignores the sentinel and removing the last broker account removes only that exact sentinel, never an independent native login. An existing native API-key login blocks OpenAI inference before network activity and directs you to migrate to native ChatGPT OAuth. Requests never swap global OpenCode credentials. Rejected refreshes can recover a native-rotated login only after matching the email and pinned account ID before and after refresh. The shared Claude wrapper is unchanged.

Removing the final OpenAI broker account also records a user-choice dismissal in the existing account store. Subsequent account-state refreshes will not reimport a preserved independent native login. Explicitly signing in again clears that dismissal. This metadata contains only the provider enum, not tokens, emails or hashes; it is not a rollout flag. Dismissal, import and removal are serialized under the account-store lock. Anthropic's migration behavior is unchanged.

Offline verification: with Bun 1.3.14, run `npm ci --include=dev`, `npm run typecheck`, and `npm test`. Tests use synthetic credentials, a temporary data/config directory, mocked native loaders with credential-sticky session pools, and mocked token endpoints. They assert unsupported builds initialize successfully but reject OpenAI inference hooks while leaving Anthropic unchanged, remove/migrate cannot resurrect the activation sentinel or a dismissed independent native account, independent logins survive, API mode rejects before inference, and rotation recovery cannot cross identities. The real remove and account-state handlers run with shim synchronization disabled in the test process, including concurrent account-state refreshes and explicit sign-in after dismissal. Tests never contact providers, access Paseo, or read your real accounts.

The actual native HTTP/WebSocket adapter also has a loopback fixture: `OPENCODE_SOURCE=/path/to/opencode npm run test:native`. Use upstream commit `774cc7c1914e4329eefde5a669f938b0cf566661` with dependencies installed via Bun 1.3.14 (`bun install --frozen-lockfile`). The fixture composes the broker directly with the native adapter, so it needs no core middleware patch. CI runs both fixtures. It checks API-mode native loader initialization followed by Anthropic initialization, preserving native options, login methods and API-mode models, with only OpenAI inference rejecting. This mirrors the shared initialization loop, not the full core provider service. It also checks unchanged payloads, concurrent credential-isolated sockets, account switches, and native HTTP fallback using synthetic identities, not live customer accounts.

## Where it works

- OpenCode: Claude and Codex accounts.
- Claude Code: Claude accounts, macOS only.
- Codex CLI: not supported, it keeps its own login.
