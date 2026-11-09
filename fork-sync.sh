#!/usr/bin/env bash
# Rebuilds fork/main = origin/main + every fork/<order>-<name> branch, merged in order.
#   fork/20-foo     is rebased onto origin/main
#   fork/20.1-bar   is stacked on fork/20-*, rebased onto it
# Run from a worktree that may switch branches freely (not the main checkout), with
# no fork/* branch checked out anywhere (detach the main checkout first).
# Stops on a conflict rerere can't resolve; fix it, finish the rebase/merge, rerun.
set -euo pipefail

git config rerere.enabled true
git config rerere.autoUpdate true
git fetch origin main

# lstrip=2, not short: with a remote named `fork`, short spells fork/main as heads/fork/main.
branches=$(git for-each-ref --format='%(refname:lstrip=2)' 'refs/heads/fork/' |
  grep -v '^fork/main$' | sort -t/ -k2 -V)

# Old tips, so stacked branches rebase only their own commits.
old_tips=$(for b in $branches; do echo "$b $(git rev-parse "$b")"; done)
old_tip() { echo "$old_tips" | awk -v b="$1" '$1 == b { print $2 }'; }

parent_of() { # fork/20.1-bar -> fork/20-*, fork/20-foo -> origin/main
  local order=${1#fork/}; order=${order%%-*}
  if [[ $order == *.* ]]; then
    git for-each-ref --format='%(refname:lstrip=2)' "refs/heads/fork/${order%.*}-*" | head -1
  else
    echo origin/main
  fi
}

for b in $branches; do
  p=$(parent_of "$b")
  [[ -n $p ]] || { echo "no parent branch for $b" >&2; exit 1; }
  if [[ $p == origin/main ]]; then
    git rebase origin/main "$b"
  else
    git rebase --onto "$p" "$(old_tip "$p")" "$b"
  fi
done

git switch -C fork/main origin/main
for b in $branches; do
  git merge --no-ff --no-edit -m "fork: merge $b" "$b"
done

# Keep main a plain mirror of upstream when it is not checked out here.
if git merge-base --is-ancestor main origin/main; then
  git branch -f main origin/main 2>/dev/null ||
    echo "main is checked out elsewhere; run there: git merge --ff-only origin/main"
fi
echo "fork/main rebuilt: $(git rev-parse --short HEAD)"
# Release fork/main so the main checkout can switch back to it.
git switch --detach

# Publishing stays a deliberate step: print the push, never run it.
# Rebased branches need the lease; --prune drops fork/* branches deleted here.
if git remote get-url fork >/dev/null 2>&1; then
  echo "publish: git push --force-with-lease --prune fork main fork-meta 'refs/heads/fork/*:refs/heads/fork/*'"
fi
