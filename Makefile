.PHONY: help install generate test test-wasm parse scan scan-wasm clean

.DEFAULT_GOAL := help

# GLR grammar bugs (a rule that's ambiguous, or a token wrongly listed in
# `extras` alongside being required elsewhere) can make `tree-sitter
# generate`/`parse`/`test` explore an exponential number of parse states and
# exhaust all available memory rather than erroring out cleanly. On Linux,
# cap every tree-sitter invocation to a cgroup memory limit so a bad grammar
# change fails loudly (OOM-killed, non-zero exit) instead of taking down the
# whole session. No-op on systems without systemd-run.
#
# The caps are deliberately coarse, not MB-precise budgets: measured peak
# cgroup-charged memory is far below `time -v` RSS (max ~91MB, mostly node's
# shared-library footprint which doesn't count against MemoryMax). Real-world
# parses and `generate`/`test` fit comfortably in 64M (measured worst-case
# floors: parse ~44-52M, generate ~48-56M). The point is NOT to be tight — a
# few MB of drift doesn't matter. The point is that a GLR grammar regression
# blows up exponentially and would cross 64M in seconds, surfacing as a
# HANG/KILLED in `make scan` instead of going unnoticed (or worse, OOM-killing
# the session). If a future change pushes real files past 64M, step it up to
# 128M. If something ever measures in the gigabytes, the grammar is broken.
# No-op on systems without systemd-run.
SYSTEMD_RUN := $(shell command -v systemd-run 2>/dev/null)
ifneq ($(SYSTEMD_RUN),)
RUN := systemd-run --user --scope --same-dir -p MemoryMax=64M -p MemorySwapMax=0 --
SCAN_RUN := $(RUN)
else
RUN :=
SCAN_RUN :=
endif

# Folder scanned by `make scan` (required): every *.story under it is parsed
# recursively with the same memory-capped, per-file-timeouted harness used
# everywhere else in this repo's testing. No default — pass STORY_DIR=<folder>.
SCAN_TIMEOUT ?= 3

help: ## Show this help (default when run with no target)
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install tree-sitter-cli (needed by every other target)
	npm install

generate: ## Regenerate src/parser.c, node-types.json, grammar.json from grammar.js
	$(RUN) npx tree-sitter generate

test: generate ## Run the test/corpus/*.txt corpus
	$(RUN) npx tree-sitter test

test-wasm: generate ## Run the corpus under the WASM parser
	$(RUN) npx tree-sitter test --wasm

parse: generate ## Parse a file and print its syntax tree: make parse FILE=some.story
	$(RUN) npx tree-sitter parse $(FILE)

# Shared scan body. $(1) = extra parse flags (empty or --wasm),
# $(2) = target name for error messages. One shell invocation with a
# per-run mktemp dir, so parallel scans never share state.
define run_scan
	@[ -n "$(STORY_DIR)" ] || { echo "$(2) requires STORY_DIR=<folder> to scan recursively for .story files"; exit 1; }; \
	[ -d "$(STORY_DIR)" ] || { echo "STORY_DIR not found: $(STORY_DIR)"; exit 1; }; \
	if [ -n "$(SYSTEMD_RUN)" ]; then systemctl --user reset-failed 2>/dev/null || true; fi; \
	tmp=$$(mktemp -d); trap 'rm -rf "$$tmp"' EXIT INT TERM; \
	ok=0; err=0; hang=0; total=0; \
	find "$(STORY_DIR)" -name "*.story" -type f > $$tmp/files.txt; \
	while IFS= read -r f; do \
	  total=$$((total+1)); \
	  timeout $(SCAN_TIMEOUT) $(SCAN_RUN) npx tree-sitter parse $(1) --quiet "$$f" > $$tmp/out.txt 2>&1; \
	  rc=$$?; \
	  if [ "$$rc" = "124" ] || [ "$$rc" = "137" ] || [ "$$rc" = "143" ]; then \
	    hang=$$((hang+1)); echo "$$f" >> $$tmp/hangs.txt; \
	  elif grep -q "ERROR" $$tmp/out.txt; then \
	    err=$$((err+1)); echo "$$f" >> $$tmp/errors.txt; \
	  else \
	    ok=$$((ok+1)); \
	  fi; \
	done < $$tmp/files.txt; \
	echo "CLEAN $$ok  ERROR $$err  HANG/KILLED $$hang  (total $$total)"; \
	[ -s $$tmp/errors.txt ] && echo "errors: $$tmp/errors.txt"; \
	if [ -s $$tmp/hangs.txt ]; then echo "hangs: $$tmp/hangs.txt"; exit 1; else exit 0; fi
endef

scan: generate ## Recursively parse every .story under a folder: make scan STORY_DIR=some/folder
	$(call run_scan,,scan)

scan-wasm: generate ## Recursively parse .story files under the WASM parser: make scan-wasm STORY_DIR=some/folder
	$(call run_scan,--wasm,scan-wasm)

clean: ## Remove generated parser artifacts and node_modules
	rm -rf src/parser.c src/node-types.json src/grammar.json
	rm -rf node_modules
