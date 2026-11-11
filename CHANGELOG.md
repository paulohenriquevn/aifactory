# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A run may last 90 minutes instead of 50, so a run in a repository with slow checks has room for a rework and the checks again; the GitHub token is renewed every 15 minutes while a run works, in the sandbox's firewall and in the factory's own calls, instead of being taken once and kept until it expired (#4)

### Fixed

- A task whose issue says it is blocked by issues still open no longer runs and lands in Needs a person: it waits in Will retry itself, before any sandbox, and checks again every half hour until each of them is closed (#21)
- A deploy now starts every enabled worker, a stopped one included, so the factory runs as many tasks at once as it has workers; before, a worker that stopped once stayed stopped through every later deploy (#20)

## [0.2.0] - 2026-11-10

### Added

- A failed or handed-over task that a person resolved another way can be marked resolved from its page, with a note saying where; it moves to Delivered (#10)

### Changed

- A done task whose pull request GitHub refused for a conflict with its base now runs again on its own from the new base, up to three times, instead of waiting for a person to press Retry; a merge refused for any other reason still waits for a person (#16)
- A done task whose pull request was never merged, as when GitHub refuses it for a conflict with the base, can be started again from the panel (#14)

### Fixed

- A merge GitHub refuses for a moment no longer leaves a task done with its pull request open: a 5xx or a 405 that says the base branch was modified is asked again, up to four times (#14)
- A run starting while another run makes its docker sandbox no longer removes that run's new network and fails it at the sandbox stage: a network counts as an orphan only once it is as old as a stale container (#15)
- The factory's squash merges no longer gain a `Co-authored-by` trailer for its own bot: each squash commit is named after its pull request, with no body, instead of the message GitHub composes, which lists every commit author; commits are also signed with the bot user's own email, which needs the new `GITHUB_APP_BOT_USER_ID` (#13)
- A repository's test that starts a server on localhost and fetches it no longer fails in the docker sandbox: localhost is named on 127.0.0.1 alone, as on a hosted runner (#12)
- A repository's test that a subprocess is gone no longer fails in the docker sandbox: the sandbox now runs an init that reaps exited orphans (#11)
- A Claude Code run that printed its result before a background command kept it alive past the timeout no longer fails the task (#8)
- The factory can push a change to `.github/workflows`: its installation token now asks for the `workflows` permission (#9)

## [0.1.0] - 2026-11-08

### Added

- An issue labelled `factory` in an enabled repository becomes exactly one task, and a repeated webhook delivery does not create a second (#6)
- Each task runs a coding agent (Claude Code or Codex) in an isolated sandbox with an explicit domain allowlist, with credentials attached outside the sandbox (#6)
- A pull request opens only after the configured checks pass on the pushed commit, and an independent reviewer approves it (#6)
- Failed checks or a review that asks for changes send the work back to the same agent session, and a person takes over after three attempts (#6)
- An agent that needs a decision asks on the issue, and the answer resumes the same session (#6)
- The factory merges its own pull request into `workspace`, tags a pre-release on `develop`, and leaves the release to `main` to a person or, when enabled, an agent's verdict (#6)
- A red `main` after a release opens a revert pull request, which the factory never merges (#6)
- The panel shows the board, the inbox, each task's timeline, evidence, reviews and cost, live, and lets the owner approve, ask for changes and retry (#6)
- The panel lists the repositories the GitHub App reaches, enables them, and sets checks, domains, branches, agents and release mode for each (#6)
- New jobs and plans of several issues can be started from the panel, and the task still comes from the issue's webhook (#6)
- A chat assistant and a guide on each page read the factory's state and ask before changing anything (#6)
- Every agent reads the owner's knowledge base, written as an Open Knowledge Format 0.2 bundle, and notes what it learned (#6)
- The panel shows what the agents do while they work, step by step, and keeps it for 30 days, with known token formats redacted (#6)
- A project can declare its install command, checks and domains in `.factory/setup.json` on its default branch, and its domains open only after the owner approves them (#6)
- The agent is told the exact commands the factory runs on its commit, in the first pass and in every rework (#6)
- An issue the code already resolves is closed with the evidence instead of failing (#6)
- The factory runs as `systemd --user` services, catches up on missed webhooks, and keeps a restorable database backup (#6)

### Fixed

- Claude Code runs on the Docker sandbox no longer fail with `claude: not found` (#1)
- A run started again after its process died can push its branch again (#2)
- A clone that stalls is cut after three minutes and tried again, instead of failing the task after ten (#6)
- A run may last 50 minutes instead of 30, and one that runs out says so instead of failing with `No such container` (#6)
- A check that fails runs once more at the same commit, so a flaky test no longer costs the agent an attempt; both runs stay in the evidence (#6)
- The checks run on a clean tree of the pushed commit, so what the agent left in ignored files no longer decides the result (#6)
- The backup check reads the whole dump and no longer fails with EPIPE on dumps over about a megabyte (#3)

[Unreleased]: https://github.com/paulohenriquevn/aifactory/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/paulohenriquevn/aifactory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/paulohenriquevn/aifactory/releases/tag/v0.1.0
