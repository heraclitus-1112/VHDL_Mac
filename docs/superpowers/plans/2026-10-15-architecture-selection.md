# Architecture Selection Implementation Plan

> Execute inline using executing-plans, with test-first checkpoints.

**Goal:** Persist a top-level architecture choice across batch, Run All and interactive simulation.
**Architecture:** A bounded declaration reader and selection helper, optional validated config field, and shared explicit elaboration target. Existing files without the field retain NVC defaults.
**Tech Stack:** Node.js, VS Code extension API, real NVC batch and Tcl runtimes.

- [ ] Add tests in test/architecture.test.js for config validation, lexical discovery and real first/second architecture batch execution; observe failures.
- [ ] Implement src/architecture.js discovery and picker; src/core.js validates optional architecture and uses entity(architecture) for elaboration with the correct run target; schemas/config.schema.json exposes the field.
- [ ] Add adapter tests for saved selection, cancellation, config races and trust. Wire src/extension.js wizard and selectArchitecture command, using existing lock and atomic write patterns.
- [ ] Add real interactive tests proving both explicit architecture choices; update src/interactive.js target construction. Update src/generate.js to set sim on generated targets and test stale selection removal.
- [ ] Run all tests; review changes for unsafe source paths, lost config edits, implicit fallback and stale interactive sessions. Document usage and bump package versions.
- [ ] Port changes and tests to the isolated English edition with localized strings. Run both full suites and language scan.
- [ ] Package both VSIX files, validate runtime contents, install Chinese edition, and verify a two-architecture picker and both reports in an owned VS Code fixture. Preserve user source/config files.
- [ ] Record actual acceptance evidence, commit both editions locally, report usage and verification boundaries. No remote push in this task.
