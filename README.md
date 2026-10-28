# T3 Code fork layout

- `main` mirrors upstream `origin/main` (pingdotgg/t3code); no local commits.
- Each local feature is a branch `fork/<order>-<name>` based on `origin/main`.
  `fork/<order>.<n>-<name>` stacks on `fork/<order>-*` when it needs it.
- `fork/main` = `origin/main` + every `fork/*` branch merged in order. Build and run from it.
- Add a feature by creating a `fork/NN-name` branch off `origin/main`; drop one by deleting it
  (or when upstream ships the same change, the rebase empties it).
- `rerere` is on, so a conflict resolved once is replayed on the next sync.

Sync (from the `.claude/worktrees/fork-sync` worktree, never the main checkout):

```sh
git show fork-meta:fork-sync.sh > /tmp/fork-sync.sh && bash /tmp/fork-sync.sh
```

The pre-split history of `main` is tagged `pre-fork-split-main`.
