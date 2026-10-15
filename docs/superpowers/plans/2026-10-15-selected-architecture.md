# Selected Architecture Compilation Implementation Plan

> Use subagent-driven-development for the bounded source filter and independent spec/quality review. Integrate runtime changes in this session with test-first checkpoints.

**Goal:** Run an explicitly selected testbench architecture while excluding unfinished alternatives from analysis.
**Architecture:** A pure byte-preserving VHDL design-unit reader selects a dependency closure. A shared preparation adapter creates owned source shadows and a fresh work library; batch and interactive runtimes remap source diagnostics before publishing them. Unselected/NVC-default projects retain the existing path.
**Tech Stack:** Node.js, VS Code extension API, NVC 1.23.0 batch and patched Tcl/live-wave runtime.

### Task 1: Bounded source filtering
- [ ] Create failing tests in test/selected-source.test.js for byte-preserving filtering, both declaration orders and split files, context clauses, comments/strings, nested process/subprogram/generate constructs, same-top explicit architecture dependencies, missing architecture and unsupported/ambiguous syntax.
- [ ] Implement src/selected-source.js exporting filterArchitectures(files, top, architecture). Each input/output file is {filename, buffer}; return {files, excluded}, where excluded records filename/entity/architecture. Never modify input buffers; blank excluded spans with ASCII space while retaining CR/LF and all bytes elsewhere. Bound source length and parsing work. NVC remains the semantic authority for retained units.
- [ ] Run focused tests and perform separate spec and quality reviews before accepting the module.

### Task 2: Preparation and batch integration
- [ ] Add failing real-NVC tests in test/selected-compilation.test.js for valid TB1 plus invalid TB2, first/second switching, full-source default failure, selected runtime diagnostics mapped to original source/line, stale library isolation and prior-wave preservation.
- [ ] Create src/compilation.js: prepareCompilation(resolved, runDir, signal, onOutput) reads sources with bounds, applies filter only for explicit architecture, creates unique source shadows within an owned run directory, returns a resolved-source override and path mapper. Print selected/excluded architecture names. Create streaming line mappers for stdout/stderr so paths split across chunks are translated correctly before reaching Output/Problems.
- [ ] Integrate preparation into src/core.js before building NVC commands. Explicit selections use a unique per-run work library under .nvc-build and keep FST publication at the stable project level. Clean owned compile scratch after the simulator exits; cleanup warnings never override the primary result/error. Keep the default no-architecture path compatible.

### Task 3: Interactive integration
- [ ] Add failing real-interactive tests proving TB1 can start without RTL2, source diagnostic mapping and lifetime of shadows through the live session.
- [ ] Integrate prepareCompilation into src/interactive.js using its existing unique session directory; map each output stream line before diagnostics and protocol parsing. Remove only owned source/work scratch after the process closes, leaving published wave files intact. Handle analysis/startup failure and cancellation cleanup.

### Task 4: Editions and acceptance
- [ ] Review full diff and resolve spec and quality findings. Update documentation and version Chinese 0.6.0 / English 0.6.1; remove contradictory previous full-compile descriptions.
- [ ] Port the reviewed runtime/filter/tests into the English worktree with localized messages; run both full suites and English language checks. Preserve independent language branches.
- [ ] Package and verify both VSIX archives; install Chinese; exercise picker and Run in an owned raw-byte copy of SerialOR course sources. Verify TB1 produces a fresh wave, TB2 reports missing RTL2 at its original workspace source location, and selecting TB1 again recovers.
- [ ] Record concrete acceptance limits and hashes, preserve all original course files/config, commit both editions locally, and leave remote push/merge to a separate request.
