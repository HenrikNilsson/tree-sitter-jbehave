const PREC = {
  OTHER: -1,
};

module.exports = grammar({
  name: "jbehave",

  extras: ($) => [$._ws, $.comment],

  externals: ($) => [
    $.narrative_kw,
    $.meta_kw,
    $.given_stories_kw,
    $.scenario_kw,
    $.lifecycle_kw,
    $.before_kw,
    $.after_kw,
    $.scope_kw,
    $.given_kw,
    $.when_kw,
    $.then_kw,
    $.and_kw,
    $.examples_kw,
    $._eol,
  ],

  rules: {
    source_file: ($) =>
      seq(
        // Absorbs leading blank lines (e.g. after one or more leading `!--`
        // comments, such as `!-- language: sv`) before any real content —
        // every other blank-line gap in the grammar is owned by the
        // *preceding* construct's own required $._eol, but there's nothing
        // preceding here. repeat (not optional) so each of several leading
        // comments can have its own following blank-line run absorbed
        // separately (a single $._eol call only absorbs one contiguous run).
        repeat($._eol),
        // Meta can appear before the narrative (observed in real files) as
        // well as after it, so it's allowed on both sides of the narrative.
        // repeat($.narrative) (not optional) lets several keyworded
        // narrative-like blocks (Narrative:, Sammanhang:, Story:, Context:)
        // appear one after another instead of the first one's free_text
        // swallowing the rest as prose.
        optional($.meta),
        // A keywordless narrative (JBehave's legacy "In order to/As a/I
        // want" prose, no `Narrative:` header) can only appear at the top of
        // the file. It's a distinct once-only rule — not part of
        // repeat($.narrative) — so the grammar never has to decide whether a
        // bare prose line extends a previous narrative's free_text or starts
        // a new keywordless one (that ambiguity makes the parser explode).
        optional(alias($._keywordless_narrative, $.narrative)),
        repeat($.narrative),
        optional($.meta),
        optional($.given_stories),
        optional($.lifecycle),
        repeat($.scenario),
      ),

    // The colon can be followed by inline content on the same line (e.g.
    // "Narrative: FC-1326" used as a short story id/summary, common when
    // the multi-line free-text body is skipped entirely) in addition to, or
    // instead of, a following free-text body — mirrors how `scenario`
    // allows an inline title.
    //
    // The keyword itself is optional too: JBehave's legacy keywordless
    // narrative (three free-text lines in "In order to/As a/I want" order,
    // e.g. Swedish "För att ... / I egenskap av ... / så vill ...") appears
    // in real files with no `Narrative:` header at all. A bare leading
    // prose line then opens the narrative and `free_text` absorbs the rest;
    // every section/step keyword still wins over `title` (external scanner
    // priority), so a following Scenario:/Meta:/Lifecycle: always ends it.
    narrative: ($) =>
      seq(
        $.narrative_kw,
        ":",
        optional($.title),
        $._eol,
        repeat($._eol),
        optional($.free_text),
      ),
    // Legacy JBehave narrative written without a `Narrative:` header: a run
    // of bare prose lines at the top of the file. The first line is the
    // title; `free_text` greedily absorbs the rest (a following section
    // keyword still ends it, since external keywords outrank free_text_line).
    // Aliased to `narrative` at the reference site so consumers see one
    // uniform shape.
    _keywordless_narrative: ($) =>
      seq($.title, $._eol, repeat($._eol), optional($.free_text)),
    free_text: ($) => repeat1(seq($.free_text_line, $._eol)),
    free_text_line: ($) => token(prec(PREC.OTHER, /[^\r\n]+/)),

    meta: ($) =>
      seq(
        $.meta_kw,
        ":",
        // The colon can be followed by inline content on the same line
        // (e.g. "Meta: @Issue FC-3729" or "Meta: SER-14084"), mirroring how
        // `narrative` allows an inline title. The block form (tags on the
        // following lines) is unaffected since `title` can't span a newline.
        optional($.title),
        $._eol,
        repeat($._eol),
        // repeat (not repeat1): a `Meta:` line with no tags at all is valid
        // (observed in real files), e.g. a bare `Meta:` whose following line
        // is a step.
        repeat($.meta_line),
      ),
    meta_line: ($) => seq(repeat1($.tag), $._eol),
    tag: ($) => seq($.tag_name, optional($.tag_value)),
    // The leading "@" is optional because some real files write bare
    // issue references on their own line inside a Meta: block (e.g. "Issue
    // FC-519" or just "FC-1955"), and JBehave's loader ignores non-@ lines
    // there anyway. Keywords are matched by the scanner before this regex,
    // so a step line like "Givet foo" still wins over being read as a tag;
    // "|" is excluded so a table can never be swallowed as a tag.
    tag_name: ($) => /@?[^\s@|]+/,
    // Higher precedence than tag_name so the word after a tag is its value
    // (e.g. "@Issue FC-613" -> name @Issue, value FC-613), not a second
    // bare tag; "Issue FC-519" behaves the same.
    tag_value: ($) => token(prec(1, /[^\s@:|\r\n][^@\r\n]*/)),

    given_stories: ($) =>
      seq($.given_stories_kw, ":", $.story_ref_list, $._eol),
    story_ref_list: ($) => seq($.story_ref, repeat(seq(",", $.story_ref))),
    story_ref: ($) => token(prec(PREC.OTHER, /[^\s,\r\n][^,\r\n]*/)),

    // A lifecycle (Lifecycle:/Livscykel:) applies setup/teardown steps to
    // every scenario in the story. Each Before:/Innan:/After:/Efter: section
    // can carry an optional Scope: (SCENARIO or STORY) line immediately
    // after the section keyword — the scope value sits on the same line as
    // the colon, so it reuses the inline-title pattern.
    lifecycle: ($) =>
      seq(
        $.lifecycle_kw,
        ":",
        $._eol,
        repeat($._eol),
        repeat1($.lifecycle_section),
      ),
    lifecycle_section: ($) =>
      seq(
        choice($.before_kw, $.after_kw),
        ":",
        $._eol,
        repeat($._eol),
        optional($.lifecycle_scope),
        repeat1($.step),
      ),
    lifecycle_scope: ($) =>
      seq($.scope_kw, ":", optional($.title), $._eol, repeat($._eol)),

    scenario: ($) =>
      seq(
        $.scenario_kw,
        ":",
        optional(field("title", $.title)),
        $._eol,
        repeat($._eol),
        optional($.meta),
        repeat1($.step),
        optional($.examples),
      ),
    title: ($) => token(prec(PREC.OTHER, /[^\r\n]+/)),

    // JBehave's real parser (RegexStoryParser) treats a step as everything
    // from its keyword up to the *next* recognized keyword line (any
    // language) or `Examples:`/end of file — not just one line. A data
    // table (no `Examples:` keyword needed — JBehave passes it as an
    // ExamplesTable argument to that step's method) and arbitrary
    // continuation lines can both extend a step this way. Since our
    // external scanner already only recognizes a keyword where the parser
    // could legally start a new step/section there, any line that isn't one
    // of those and isn't a table row just extends the current step —
    // mirroring JBehave's actual leniency rather than enforcing single-line
    // steps.
    step: ($) =>
      seq(
        $.step_keyword,
        $.step_text,
        $._eol,
        // table_row (not the examples_table wrapper) directly here: wrapping
        // consecutive rows under a repeatable examples_table node would be
        // ambiguous (can't tell "keep growing this table" from "start a new
        // adjacent one" from grammar shape alone). The scenario-level
        // `Examples:` table below isn't repeated this way, so it keeps its
        // examples_table wrapper.
        repeat(choice($.table_row, $.step_continuation_line)),
      ),
    step_keyword: ($) =>
      choice($.given_kw, $.when_kw, $.then_kw, $.and_kw),
    step_text: ($) => repeat1(choice($.parameter, $.step_text_fragment)),
    parameter: ($) => /\$[A-Za-z_][A-Za-z0-9_]*/,
    step_text_fragment: ($) => token(prec(PREC.OTHER, /[^$\r\n]+/)),

    step_continuation_line: ($) => seq($.continuation_text, $._eol),
    // Excludes a leading "|" so a table row is never mistaken for a plain
    // continuation line — table_row's own literal "|" always wins that case
    // structurally, no precedence trick needed.
    continuation_text: ($) => token(prec(PREC.OTHER, /[^\r\n|][^\r\n]*/)),

    examples: ($) => seq($.examples_kw, ":", $._eol, repeat($._eol), $.examples_table),
    examples_table: ($) => repeat1($.table_row),
    // table_cell itself can't be nullable (tree-sitter rejects any rule that
    // can match the empty string), so a blank cell — just padding spaces
    // between two "|"s, which _ws as an extra already consumes, leaving
    // nothing for table_cell_fragment to match — is modeled as the cell
    // being *absent* at that position rather than an empty node. A trailing
    // optional(table_cell) (no closing "|") is allowed because real files
    // contain rows like "| !-- förnamn: James" whose last cell is
    // unterminated; for well-formed rows it matches nothing, so their trees
    // are unchanged.
    table_row: ($) =>
      seq("|", repeat(seq(optional($.table_cell), "|")), optional($.table_cell), $._eol),
    table_cell: ($) => repeat1(choice($.parameter, $.table_cell_fragment)),
    // `$` is allowed inside a cell fragment: real tables hold regex strings
    // like "MATCH_WITH_REGEX(^(.*)$)" whose `$` isn't a parameter marker.
    // A cell-starting `$word` still lexes as parameter, since `parameter` has
    // no precedence (0) and outranks this fragment's prec(PREC.OTHER) (-1).
    table_cell_fragment: ($) => token(prec(PREC.OTHER, /[^|\r\n]+/)),

    comment: ($) => token(/!--[^\r\n]*/),
    _ws: ($) => /[ \t]+/,
  },
});
