# Agent guidelines

Standing rules for any agent (or tool-assisted session) working in this
repository.

## Git is handled by the user

Never run state-changing git commands (`init`, `add`, `commit`, `push`,
`reset`, `rm`, ...). Inspecting history/state (`status`, `log`, `diff`)
is fine. The user stages and commits manually.

## Grammar hang safety

This grammar CAN make `tree-sitter generate`/`parse`/`test` hang or OOM on
some inputs (see README's "Known limitation" section). Never run those
commands bare. Always wrap them in a memory cap and timeout:

```sh
timeout 30 systemd-run --user --scope --same-dir -p MemoryMax=64M -p MemorySwapMax=0 -- npx tree-sitter test
```

`make generate`/`test`/`parse` already wrap the CLI in a 64M cgroup cap
(no timeout) — add your own timeout when experimenting so a bad change
fails in seconds. An unguarded bad grammar change once OOM-killed the
whole GNOME session.

## DO NOT re-add `$._eol` inside repeating bodies

Never re-add a bare `$._eol` as a `repeat`/`choice` alternative inside an
already-repeating grammar body (e.g. `step`'s trailing table/continuation
`repeat`, `meta`'s body, `examples_table`'s body). That specific pattern
is proven to introduce a worse GLR hang than the one it fixes; it was
tried and fully reverted. Only the *single-occurrence* `repeat($._eol)`
gaps placed once before a body starts (in `source_file`, `narrative`,
`meta`, `scenario`, `examples`) are known-safe. If you think you need a
new blank-line/comment gap, fix it in `src/scanner.c`'s `EOL` token logic,
not in `grammar.js` — see README's "Gotcha" section.
