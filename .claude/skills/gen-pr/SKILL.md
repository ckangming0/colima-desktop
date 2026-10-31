---
name: gen-pr
description: Open a pull request into main from the current branch or worktree. Use when the user runs /gen-pr or asks to open, create or raise a PR for this repo. main is protected (no direct pushes), so all changes land through a PR.
argument-hint: "[optional PR title or branch name]"
---

# /gen-pr — open a PR into `main`

`main` on GitHub is protected: direct pushes are rejected and every change goes
through a pull request. This skill takes whatever state the contributor is in —
a feature branch, a git worktree, or commits accidentally made on `main` — and
turns it into a PR against `main`.

Work through the steps in order. Stop and ask the user whenever a step says to.

## 1. Inspect the current state

Run these together:

```sh
git rev-parse --show-toplevel          # repo or worktree root
git rev-parse --git-common-dir         # differs from --git-dir inside a linked worktree
git rev-parse --git-dir
git branch --show-current              # empty = detached HEAD
git status --porcelain
git fetch origin main
git log --oneline origin/main..HEAD    # commits that would go in the PR
```

Determine:
- **Worktree?** `--git-dir` ≠ `--git-common-dir` means a linked worktree. Run all
  remaining commands from that worktree root; never `cd` to the main checkout.
- **Branch:** the current branch name, `main`, or detached.
- **Uncommitted changes:** any output from `git status --porcelain`.
- **Commits ahead of `origin/main`:** the `git log` output.

## 2. Get onto a feature branch

- **On a feature branch:** keep it.
- **On `main` with commits ahead of `origin/main`:** these can't be pushed to
  `main`. Create a branch from the current HEAD (`git switch -c <name>`), then
  reset local `main` back to `origin/main` so it doesn't diverge:
  `git branch -f main origin/main`. (This is safe because the commits now live
  on the new branch. Do not do it if the new branch wasn't created.)
- **On `main` with only uncommitted changes:** `git switch -c <name>` — the
  changes come along.
- **Detached HEAD (common in worktrees):** `git switch -c <name>`.
- **Nothing to PR** (no commits ahead and a clean tree): tell the user and stop.

Branch names: use `$ARGUMENTS` if it looks like a branch name, otherwise derive
a short kebab-case name from the changes with a type prefix — `feat/`, `fix/`,
`chore/`, `docs/`, `test/`, `refactor/`. Never name it `main`.

## 3. Commit outstanding changes

If the tree is dirty, show the user `git status --short` and ask whether to
include everything. Stage files explicitly by path — never stage `.env`, keys,
credentials, `node_modules/`, `dist/` or `gen/`. Write a commit message in the
repo's existing style (imperative, sentence case, no type prefix — check
`git log --oneline -10`).

## 4. Sync with `main`

```sh
git rebase origin/main
```

If it conflicts, resolve the conflicts (use the `resolve-merge-conflicts` skill
if available), `git add` the files, and `git rebase --continue`. If a conflict's
intent is unclear, stop and ask the user. If the branch was already pushed and
shared with others, prefer `git merge origin/main` over rebasing and ask first.

## 5. Verify

```sh
npm install        # only if node_modules/ is missing or package-lock.json changed
npm test
```

If tests fail, show the failures and stop — don't open a PR on a red build
unless the user explicitly says to (then mark it as a draft and note the failure
in the description).

## 6. Push the branch

```sh
git push -u origin <branch>
```

Use `--force-with-lease` only if step 4 rewrote an already-pushed branch. Never
push to `main`, and never use plain `--force`.

## 7. Open the PR

Write the description from `git log origin/main..HEAD` and
`git diff --stat origin/main...HEAD`:

```markdown
## Summary
<1–3 bullets: what changed and why>

## Changes
<notable files/areas touched>

## Testing
<what was run — e.g. `npm test` passed; manual checks performed>
```

Title: `$ARGUMENTS` if it was given as a title, otherwise a concise
sentence-case summary under 70 characters.

**If `gh` is installed and authenticated** (`gh auth status` succeeds):

```sh
gh pr create --base main --head <branch> --title "<title>" --body-file <tmpfile>
```

If a PR already exists for this branch (`gh pr view <branch>` succeeds), the
push in step 6 already updated it — report its URL instead of creating another.

**Without `gh`:** print the compare link built from the `origin` URL, e.g.
`https://github.com/<owner>/<repo>/compare/main...<branch>?expand=1`, and give
the user the title and description in a code block to paste in.

## 8. Report

Tell the user the branch name, the PR URL (or compare link), and the test
result. If they were in a worktree, remind them it can be removed after merge
with `git worktree remove <path>` from the main checkout.
