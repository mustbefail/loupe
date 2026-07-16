# loupe

A headless iterative code-review loop for Claude Code. An ensemble of review lenses plus a judge, running in a loop to refine code quality.

## Name Origin

- **loop**: the iterative feedback cycle that drives continuous improvement.
- **lens**: each specialized review perspective that examines code from a unique angle.

Together they form `loupe` — an optical instrument for close examination and inspection.

## Installation

Symlink this repository to your Claude Code skills directory:

```bash
ln -s ~/projects/loupe ~/.claude/skills/loupe
```

## Known limitations

- Custom-instruction glob matching is O(n²) per `**` segment on non-matching paths; fine for real git paths (~3ms worst case) but pathological multi-`**` patterns on very deep trees could be slow.
- `parseDiff` does not decode git's quoted paths (`core.quotePath`), so changed files with spaces or non-ASCII names may be skipped from review.
- `check-attr` receives all changed paths as CLI args, which could hit `ARG_MAX` on an extremely large diff.

## Attribution

Inspired by, and ports the context-building essence of, GitLab Duo Code Review (GitLab CE, MIT).
