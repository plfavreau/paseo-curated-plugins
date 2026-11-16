# Notion card

Shows the Notion page an agent is working on as a live card in the conversation, instead of a raw `ntn` command and its YAML or JSON output.

It reacts to the [Notion CLI](https://ntn.dev) commands agents run: `ntn pages get`, `edit`, `create` and `trash`, and `ntn api` calls on `/v1/pages/<id>` or `/v1/blocks/<id>/children`. The card shows the page title and icon, the database it belongs to, its status, and how many of its to-dos are done. Expand it to see the main properties (assignee, priority, sprint, story points, dates, linked pages) and tick-by-tick checklist items, then open the page in Notion or copy its link.

The card fetches the page again when the agent finishes changing it, so earlier cards of the same page also show the new status. An expanded card refreshes every minute. The command and its output stay one tap away above the card.

## Setup

The `ntn` CLI must be installed and logged in on the machine running the Paseo daemon (`ntn doctor` checks it). The daemon looks for `ntn` on its PATH, then in `~/.local/bin`.

## Limits

Only top-level to-dos are counted; to-dos nested inside toggles are not. Formula, rollup and button properties are not shown. Each card makes a few Notion API calls through your own `ntn` login; nothing is sent anywhere else.
