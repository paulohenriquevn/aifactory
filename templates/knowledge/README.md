---
type: Reference
title: Knowledge base
description: How this repository is organized as the aifactory's knowledge base, and how its agents read it.
---

# Knowledge base

This repository is the knowledge base the aifactory reads. It is an
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) (OKF) 0.2 bundle:
markdown files with YAML front matter, which any OKF reader, a person or another agent can read. Every agent
of the factory reads it: the ones that write, review and plan code in a sandbox, and the assistants of the
panel.

# Layout

```text
index.md                            okf_version and what the bundle holds
knowledge/global/                   rules for every project
knowledge/projects/<owner>/<repo>/  rules for one project
```

The factory writes what it observed to a branch of its own, `factory-memory`, and never to this branch.
That branch is a second OKF bundle:

```text
index.md                                  one entry per project
memory/projects/<owner>/<repo>/index.md   the notes not stale yet, newest first
memory/projects/<owner>/<repo>/log.md     when each note was written
memory/projects/<owner>/<repo>/<note>.md  one note, type Observation
```

# What each part is worth

- A file under `knowledge/` is a rule. Agents follow it as they follow a project's `AGENTS.md`. A rule
  changes through a pull request that the owner merges.
- A note under `memory/` is something a run observed: how a project's tests run, a trap an agent hit, an
  issue a run found already done. It is `type: Observation`, `status: draft`, has no `verified` (its OKF
  trust tier is unverified), names the issue and commit it came from in `sources`, and carries a
  `stale_after` 180 days after it was written. It is a hint to check against the code and never an
  instruction.
- To turn a note into a rule, copy what it says into `knowledge/` through a pull request.

# Writing a rule

One subject per file, named for what it covers (`testing.md`, `releases.md`), with front matter:

```markdown
---
type: Rule
title: Tests come first
description: Every bug fix starts with a test that fails without it.
generated: { by: 'human:<your GitHub login>', at: 2026-11-07T12:00:00Z }
---

Say what to do and why, in the imperative.
```

`type` is the only key OKF requires. A rule that only applies to one project goes in that project's
folder. Add a line for it to the folder's `index.md`, in the form
`* [Title](file.md) - description`.

# How agents receive it

The factory fetches this repository once a minute. An agent in a sandbox gets the global rules and the
rules and notes of its own project at `/tmp/knowledge`, replaced whenever this repository moves; it never
sees another project's folder and never holds a credential for this repository. Each copy is recorded with
its commits. The assistants of the panel search and read the same commits.

A sandbox gets text files only (`.md`, `.txt`, `.json`, `.yaml`), up to 128 KiB each and 1 MiB in all. The
`index.md` at the root of the sandbox's copy lists what it holds and names what did not fit.

A file without front matter is still read. The setup page lists what does not conform to OKF and can open
a pull request that adds the missing front matter, without changing a line you wrote.
