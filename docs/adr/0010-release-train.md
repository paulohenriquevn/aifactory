# ADR 0010: a release train takes integrated work to a release without a person

Status: accepted (2026-11-13). Written in English, as every versioned text from now on; ADRs 0001 to 0009
stay as they were written.

## Context

The factory integrates work on its own and stops there. Three steps after the integration still wait for a
person, and two days of running it on six repositories showed what that costs.

- **The promotion to `develop`.** When `develop` accepts changes only through a pull request, the factory
  opens `workspace` into `develop` (`integration.ts`) and nobody merges it. Its checks take more than
  30 minutes on the largest repository, and each new integration restarts them, so a person who waits for
  green never sees it.
- **The release.** `release()` in `deliver.ts` runs for one task, when a person asks in the panel or, in
  `auto` mode, when an agent approves that task. Work that was integrated while nobody was looking stays
  in `done` until someone asks. About 90 tasks sat there at one point.
- **A refused release.** A release that is refused because a check on `develop` was still running is
  never tried again, by rule. The check passes ten minutes later and the work stays where it was.

The owner decided on 2026-11-13 that full autonomy up to the release is the default, and that a repository
may opt out.

`AGENTS.md` forbids all three today: only a person or an agent's verdict may start a release, a refused
release is never retried on its own, and nothing but the factory's own integration merges into a branch it
does not own. This ADR changes those three rules, and only as far as written here.

## Decision

### 1. A release train starts releases in a repository in `auto` mode

- One train per repository, a cron (`release-train`) over a pure decision (`train.ts`). For each
  repository the decision is `promote`, `wait` or `hold`, with the reason a person reads.
- It promotes when the repository's mode is `auto`, there is integrated work that no release holds, no
  task of the repository is in a working stage, and `watch-main` reports the release branch green.
- It goes through `release()` and nothing else, so every refusal of `release()` applies to it. The actor
  recorded is `train`.
- A repository in `manual` or `trial` never gets a promotion from the train. `trial` records what the
  train would have done.
- `auto` becomes the default for a repository enabled from now on. A repository already saved keeps its
  mode; `FACTORY_RELEASE_MODE` still sets the default for one that has none.
- A red release branch pauses the train of that repository until it is green again.

### 2. A refused release is retried once, for a passing cause

- Only a refusal whose cause can end by itself is retried: checks still running or not yet reported on
  the commit, and a head that moved between the look and the merge.
- One retry per head of `develop`. A second refusal on the same head stays refused and is shown with its
  reason. A new head is a new attempt.
- A refusal about the work itself (red checks, no pre-release, a changed package with no changeset) is
  never retried.
- The retry is recorded with the refusal it follows (`release_wait.retry_of`).

### 3. The promotion into `develop` merges through pinned auto-merge

- When `develop` requires a pull request, the factory turns on auto-merge on its own promotion pull
  request, pinned to the head it saw, the same way it already does for `awaiting_ci_sha` and
  `release_wait`. GitHub merges it when the required checks pass.
- It applies only to the pull request from the integration branch into `develop` of the same repository,
  opened by the factory. Never a fork, never another head.
- While that pull request waits, the train holds new integrations out of it for a limited time
  (`hold_until`), so the checks can finish. The hold expires on its own; an integration is never lost,
  only promoted in the next pass.
- The factory still never merges into the release branch on its own account outside `release()`, and it
  still never merges a revert.

## What does not change

- A release is a promotion of `develop` and takes everything on it.
- A major version needs the `breaking` label on the issue. Without it the train bumps minor for a
  feature and patch for the rest; a changesets repository follows its changesets.
- An issue is closed only when the version answers in the registry it was published to. That check is
  its own decision, in the phase D issues.

## Consequences

- Work reaches a release without a person in a repository in `auto`. A bad release is now possible with
  nobody watching, so the train depends on `watch-main` and on the revert pull request it opens, which a
  person merges.
- A repository whose checks do not cover what its CI covers can release something its CI would refuse.
  The doctor's `checks_parity` item names that before the repository is turned on.
- `AGENTS.md` is edited in the same change that ships each rule, not before, so it never describes a
  behaviour the code does not have.

## Alternatives considered

- **Keep a person on the release.** It is what exists. It holds the work for hours for no reason a person
  adds: the decision the person makes is the one `release()` already checks.
- **Release each task as it integrates.** It restarts the promotion's checks for every task and, in a
  changesets repository, opens one version pull request per task. A train batches them.
- **Retry a refused release without a limit.** A refusal that never ends would loop. One retry per head
  covers the case seen in practice.
