# PR card

When an agent runs a `gh pr` command (`create`, `view`, `checks`, `merge`, `edit` and similar), the plain shell row becomes a live card for that pull request. The command stays visible above the card and its output expands on tap.

The card shows the PR state (open, draft, merged, closed), title, repository and branches, the diff size, the review decision, unresolved review threads, and whether GitHub lets it merge. Below that is every CI check on the head commit: failing and running jobs first, with live timers, and passed ones folded away. Tapping a check opens its logs.

While the PR is open, the card refreshes every 10 seconds when checks are running and every minute otherwise. It stops refreshing once the PR is merged or closed. Cards for the same PR share one request. A card opens expanded after `gh pr create` and collapsed for other commands, so an agent polling `gh pr checks` produces one-line rows.

The footer opens the PR, copies its link, refreshes, and can re-run the failed workflow jobs.

## Setup

Requires the GitHub CLI (`gh`) on the daemon machine, logged in with access to the repositories. A PR given only by number or branch is looked up with `gh pr view` in the command's working directory.
