# tree-sitter-jbehave

A [tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar for
[JBehave](https://jbehave.org) `.story` files: `Narrative:`, `Meta:`,
`GivenStories:`, `Scenario:`, `Given`/`When`/`Then`/`And` steps with `$param`
placeholders, `Examples:` tables, per-step data tables, and `!--` comments —
including JBehave's **localized keyword sets** (a `.story` file can use
`Sammanhang`/`Givet`/`När`/`Så`/`Och` instead of
`Narrative`/`Given`/`When`/`Then`/`And`, etc.).

**Status:** grammar generates cleanly (tree-sitter ABI 15) and has a
passing test corpus (see [`test/corpus/`](test/corpus)). It ships a
[`make scan`](#batch-scan-status) harness that recursively parses every
`.story` file under a folder you point it at, plus `highlights.scm`,
`folds.scm`, and `runnables.scm` queries (see
["Relationship to zed-jbehave"](#relationship-to-zed-jbehave)). Not yet
published anywhere — this is consumed locally by the sibling
[`zed-jbehave`](https://github.com/HenrikNilsson/zed-jbehave) extension via a
`file://` reference in its `extension.toml` until this repo has a real
remote. There is one known performance limitation around certain
`!--` comment placements — see
["Known limitation"](#known-limitation-commentblank-line-handling-can-hang)
below before touching blank-line/comment handling.

## Why an external scanner

JBehave keywords (`Narrative`, `Meta`, `GivenStories`, `Scenario`,
`Given`/`When`/`Then`/`And`, `Examples`) are only keywords at the start of a
line in specific grammatical positions — narrative prose or step text is
free to contain the same words without them being parsed as syntax (e.g. a
narrative line reading "Given the above context..." must stay plain prose).
[`src/scanner.c`](src/scanner.c) is a hand-written external scanner that
resolves this: it only attempts to match a keyword when the parser's current
state says that keyword is actually reachable (`valid_symbols`), so
`free_text_line`/`step_text_fragment`/etc. always win when a keyword isn't
grammatically possible there. This is the same technique
[`tree-sitter-gherkin`](https://github.com/tree-sitter-grammars/tree-sitter-gherkin)
uses for the identical Given/When/Then-in-prose ambiguity in Gherkin.

The scanner also owns blank-line handling: its `EOL` token, once it matches
one line terminator, greedily absorbs any further fully-blank lines into the
same token. This keeps multi-blank-line runs a bounded lexical concern
instead of a grammar-level repetition — see "Gotcha" below for why that
distinction matters.

## Localized keywords

JBehave ships keyword translations for ~13 locales (`de`, `en`, `es`, `fi`,
`fr`, `hu`, `it`, `no`, `pl`, `pt`, `sv`, `tr`, `zh_TW` — see jbehave-core's
`i18n/keywords_*.properties`). A `.story` file's `!-- language: xx` comment
is a hint for JBehave's own Java story loader, not something this scanner
reads — instead, `src/scanner.c`'s `KEYWORDS` table recognizes every
locale's keyword text simultaneously (verified there are no cross-locale
collisions, e.g. no word means `GIVEN` in one language and `THEN` in
another). This means a mixed-locale file would technically parse too, which
real JBehave wouldn't allow — an accepted tradeoff since the scanner has no
way to know which single locale a given file is meant to use.

Matching localized keywords against tree-sitter's lexer required two
non-obvious fixes over the simple single-language version:

- The lexer operates on Unicode **codepoints**, not bytes, so keyword text
  containing non-ASCII characters (`Erzählung`, `Skenaario`, `場景`, ...)
  needs UTF-8-aware decoding to compare correctly — see `decode_utf8` in
  `src/scanner.c`.
- Trying each candidate keyword's *full text* one at a time in a loop is
  broken once candidates of the same type can share a prefix (e.g. Polish
  `Narracja` and English `Narrative` both start `Narra`): tree-sitter's
  lexer only moves forward, so a partially-matched failed candidate leaves
  the position stranded for the next candidate's attempt. `src/scanner.c`
  instead matches all currently-valid candidates *simultaneously*, one
  shared codepoint at a time (`try_match_keywords`), dropping candidates as
  they mismatch rather than retrying from scratch.

## Real-world coverage

The grammar was validated against a large corpus of real `.story` files,
which surfaced and fixed the following gaps that hypothetical test cases
had missed:

- `Narrative:`/`Sammanhang:` can have inline content with no following body.
- A step can be followed directly by a data table with no `Examples:`
  keyword (JBehave passes it as an `ExamplesTable` method argument).
- A step can be followed by unkeyworded continuation lines (JBehave's real
  `RegexStoryParser` treats a step as everything up to the *next* recognized
  keyword line, not just one line — confirmed by reading
  `RegexStoryParser.java` from `jbehave-core-3.10-sources.jar`).
- Table cells can be empty (blank padding between two `|`s). `table_cell`
  can't be nullable itself (tree-sitter forbids that), so the fix makes the
  *occurrence* of `table_cell` in `table_row` optional instead.
- Leading blank lines after one or more `!--` comments (e.g. `!-- language:
  sv` followed by a blank line) are tolerated via a `repeat($._eol)` gap at
  the very start of `source_file`, and similar gaps before
  `free_text`/`meta_line`/`step`/`examples_table` bodies.

### Batch-scan status

`make scan` recursively finds every `.story` under the folder you pass in
`STORY_DIR` and parses each with the same memory-capped (64M), per-file
timeouted (3s, `SCAN_TIMEOUT=...`) harness used everywhere else in this
repo's testing, classifying each file as CLEAN/ERROR/HANG:

```sh
make scan STORY_DIR=/path/to/some/folder   # recursive, any folder
make scan STORY_DIR=/path/to/folder SCAN_TIMEOUT=5
```

Each run uses a fresh `mktemp` directory (removed on exit); the paths to
the per-file `errors`/`hangs` lists are printed in the summary. Point it
at whatever real-world corpus you want to measure. (The grammar has been
validated against an external corpus of real `.story` files with a fully
clean run — the harness above is how that coverage gets re-checked.)

Or drive the same loop by hand:

```sh
find /path/to/stories -name "*.story" > /tmp/all_stories.txt
while IFS= read -r f; do
  timeout 3 systemd-run --user --scope --same-dir -p MemoryMax=64M -p MemorySwapMax=0 -- \
    npx tree-sitter parse --quiet "$f" > /tmp/out.txt 2>/tmp/err.txt
  rc=$?
  # rc 124/137/143 = timeout/killed (hang); grep ERROR in /tmp/out.txt = parse error; else clean
done < /tmp/all_stories.txt
```

Per-file timeouts, not one timeout around the whole batch — otherwise one
hanging file loses you all the stats for files after it.

## Known limitation: comment/blank-line handling can hang

**Symptom**: This grammar has historically been able to make `tree-sitter
parse`/`generate`/`test` hang or consume large amounts of memory on some
inputs instead of finishing or erroring cleanly. The original confirmed
repro — a real `.story` file whose block of consecutive
`!--`-commented-out example table rows hung the parser — has since been
fixed by the scanner's `EOL` handling and now parses clean. The underlying
pathology class isn't fully understood, so the safety protocol below still
applies.

**Root cause**: `comment` doesn't consume its own trailing newline, so a
standalone `!--` comment line appearing in certain grammar positions (e.g.
within a `step`'s trailing table/continuation `repeat`, between table rows
and the next step) has nowhere for its line terminator to go. That alone
just produces a single bounded `ERROR` node, which is fine. The *attempted
fix* — adding a bare `$._eol` as a third choice inside that same `repeat(...)`
— fixed the repro file but was found to introduce a **new, worse hang**
elsewhere (an unrelated, trivial corpus case). It was fully reverted. The
underlying mechanism isn't fully understood: it's not a `tree-sitter
generate` conflict (generate succeeds cleanly), so it's a runtime GLR
performance pathology, not a static ambiguity.

**What is and isn't safe**: only the *single-occurrence* `repeat($._eol)`
gaps placed once before a body starts (in `source_file`, `narrative`, `meta`,
`scenario`, `examples`) are proven safe. Making `$._eol` an alternative
*inside* an already-repeating body (`step`'s trailing
`repeat(choice($.table_row, $.step_continuation_line))`, `meta`'s body,
`free_text`'s body, `examples_table`'s body, `given_stories`'s trailing gap)
has been tried and reverted. Don't re-add `$._eol` as a `repeat`/`choice`
alternative and assume it's safe — something about that specific pattern is
dangerous in ways that aren't caught at generate time. If a new blank-line
or comment gap seems needed, prefer fixing it in `src/scanner.c`'s `EOL`
token logic instead.

**Safety protocol**: this grammar CAN make `tree-sitter` hang/OOM on some
inputs. Never run `npx tree-sitter generate`/`parse`/`test` bare on a
machine you care about staying up. Always wrap in a memory cap and timeout:

```sh
timeout 30 systemd-run --user --scope --same-dir -p MemoryMax=64M -p MemorySwapMax=0 -- npx tree-sitter test
```

(`make generate`/`test`/`parse` already wrap in a `systemd-run` 64M cgroup
cap — but no timeout; add your own when experimenting so a bad change fails
in seconds.) Earlier in this project, an
unguarded run of a different bad grammar change actually OOM-killed the
whole GNOME session, not just the `tree-sitter` process. If the environment
seems to restart/crash while running `tree-sitter` commands, suspect this
grammar's hang/OOM behavior before suspecting the tooling.

## Prerequisites

- Node.js and npm (any recent version) — used only to run `tree-sitter-cli`
  via `npx`; there's no runtime dependency on Node otherwise.

## Building and testing

```sh
make            # no target: lists every available target with its description
make install    # npm install (installs tree-sitter-cli)
make generate   # regenerate src/parser.c, node-types.json, grammar.json from grammar.js
make test       # regenerate, then run the test/corpus/*.txt corpus
make parse FILE=some.story   # regenerate, then print the syntax tree for a file
make scan       # regenerate, then recursively parse every .story under the
                # folder given in STORY_DIR, classifying each as CLEAN/ERROR/HANG
```

`make scan` is a convenience for measuring real-world coverage over any
folder of `.story` files; it per-file-timeouts (3s, `SCAN_TIMEOUT=...`) and
memory-caps each parse (64M). Each run uses a fresh `mktemp` directory for
its intermediate files (cleaned up on exit).

Or drive the CLI directly with `npx tree-sitter generate` / `test` / `parse`
(see "Safety protocol" above first).

## Gotcha: don't put `_eol` (or any explicitly-required token) in `extras`

`grammar.js`'s `extras` is `[$._ws, $.comment]` — deliberately **not**
including the external scanner's `_eol` token, even though it's tempting to
add it there to make blank-line handling "just work" everywhere. Doing that
once caused `tree-sitter generate`/`parse`/`test` to consume unbounded
memory and OOM-kill the whole machine: making a token both an explicit
required grammar symbol *and* a wildcard "may appear anywhere" extra means
the GLR parser has to consider, at every blank line in the input, whether
that newline is the required terminator or an inserted extra — and those
interpretations combine multiplicatively across every line in the file. If
you hit a grammar conflict involving blank-line handling, fix it in the
scanner's `EOL` token logic (as described above), not by touching `extras`.

`make generate`/`test`/`parse` wrap the CLI in a `systemd-run` cgroup memory
cap (64M, Linux only, no-op elsewhere) as a safety net against exactly this
class of bug reappearing.

## Relationship to zed-jbehave

This grammar is Phase 0/1 of a larger plan to build a
[Zed](https://zed.dev) extension with feature parity against the IntelliJ
JBehave plugin (highlighting now; step navigation/diagnostics/completion via
a separate Rust LSP server later, developed in `zed-jbehave`). Zed's
`extension.toml` fetches grammars via a `repository` + `rev` pointing at a
git repo, so this has to live in its own repo rather than a subdirectory of
`zed-jbehave`.

### Query file ownership

Zed only reads tree-sitter queries from the *extension*, i.e. the
`zed-jbehave/languages/jbehave/*.scm` files. The `queries/*.scm` files in
this repo are the **working copy** (the source of truth) for the three
query files the grammar owns:

- `queries/highlights.scm` — syntax highlighting
- `queries/folds.scm` — foldable blocks (`@fold`)
- `queries/runnables.scm` — runnable detection (`@run`/`@name`/`#set! tag`;
  the actual run command is configured per project, see the file header)

They are kept here so `tree-sitter highlight` and the tree-sitter
playground work standalone against this repo without needing the sibling
checkout, and are **mirrored** (copied) into `zed-jbehave/languages/jbehave/`
to ship. The working copy lives here rather than in zed-jbehave because
grammar rule renames originate in this repo — it's the natural place to
catch and propagate query updates.

`zed-jbehave`'s `outline.scm` and `indents.scm` are authored there
directly and are not mirrored here (both are trivial for a flat prose
format), and `brackets.scm` is intentionally empty (JBehave has no bracket
pairs). A grammar rename that touches `scenario`/`examples` therefore needs
those two files updated in zed-jbehave directly.

### Keeping queries in sync

Queries are hand-written, not generated — `make generate` only produces
`src/parser.c`, `src/node-types.json`, `src/grammar.json`, and
`src/tree_sitter/*`. A query only needs updating when a grammar rule *name*
changes (an edit to `grammar.js` or `src/scanner.c`). Workflow:

1. `make generate`, then diff `src/node-types.json` to see which node names
   changed.
2. Update `queries/*.scm` here, and re-check every referenced node against
   `src/node-types.json` (validate the queries with `npx tree-sitter query
   queries/<file>.scm <some.story>` — memory-capped).
3. Copy the changed files into zed-jbehave, e.g.:

   ```sh
   cp queries/highlights.scm queries/folds.scm queries/runnables.scm \
     /path/to/zed-jbehave/languages/jbehave/
   ```

## Contributing

Grammar rules live in [`grammar.js`](grammar.js), keyword/blank-line
disambiguation in [`src/scanner.c`](src/scanner.c). After any change to
either, run `make test` and add/update a case in `test/corpus/` if you've
changed what a construct parses to. See [`AGENTS.md`](AGENTS.md) for the
standing rules (hang-safety, no-touch boundaries).

## License

[MIT](LICENSE)
