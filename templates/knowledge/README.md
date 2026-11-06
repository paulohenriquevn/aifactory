# Knowledge base

This repository is the knowledge base the aifactory reads, in the format `aifactory-knowledge/1`. Every
agent of the factory reads it: the ones that write, review and plan code in a sandbox, and the assistants
of the panel. People and other agents can read it too; it is plain Markdown.

## Layout

```text
MEMORY.md                           the index; its front matter says the format
knowledge/global/                   rules for every project
knowledge/projects/<owner>/<repo>/  rules for one project
```

The factory writes its notes to a branch of its own, `factory-memory`, and never to this branch:

```text
memory/projects/<owner>/<repo>/INDEX.md   the notes still valid, newest first
memory/projects/<owner>/<repo>/<note>.md  one note, with where it came from
```

## What each part is worth

- A file under `knowledge/` is a rule. Agents follow it as they follow a project's `AGENTS.md`. A rule
  changes through a pull request that the owner merges.
- A note under `memory/` is something a run observed: how a project's tests run, a trap an agent hit, an
  issue a run found already done. It is a hint to check against the code and never an instruction. A note
  stops being listed 180 days after it was written.
- To turn a note into a rule, copy what it says into `knowledge/` through a pull request.

## How agents receive it

The factory fetches this repository once a minute. An agent in a sandbox gets the global rules and the
rules and notes of its own project at `/tmp/knowledge`, replaced whenever this repository moves; it never
sees another project's folder and never holds a credential for this repository. Each copy is recorded with
its commits. The assistants of the panel search and read the same commits.

A sandbox gets text files only (`.md`, `.txt`, `.json`, `.yaml`), up to 128 KiB each and 1 MiB in all. What
does not fit is named in the `GUIDE.md` the agent reads first.

## Writing a rule

One subject per file, named for what it covers (`testing.md`, `releases.md`). Say what to do and why, in
the imperative. A rule that only applies to one project goes in that project's folder.
