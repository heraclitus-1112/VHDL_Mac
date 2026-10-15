# Compile only the selected testbench architecture

Date: 2026-10-15

## Goal

When the user explicitly selects TB1, allow that testbench to compile and run even if an unselected TB2 refers to an unfinished DUT architecture. Keep all original course files untouched.

## Evidence

The installed NVC 1.23.0 rejects the current full serialor_tb.vhd at analysis time because TB2 directly instantiates SerialOR(RTL2), which does not exist. Both normal analysis and --relaxed analysis reject it. A temporary copy containing TB1 without TB2 analyses and elaborates successfully.

## Approaches

1. Recommended: prepare isolated source copies for an explicitly selected testbench architecture. This works with the installed batch and interactive NVC executables without a custom compiler fork.
2. Maintain a patched compiler that defers architecture lookup. This requires changes to compiler semantics and ongoing maintenance; it is outside this feature's scope.
3. Split TB architectures manually into separate source files. This works today, but requires changes to the course files and compilation lists.

## Selected behavior

- An explicit saved architecture activates selected-testbench compilation for batch Run, Run All and interactive sessions. NVC-default selection without an explicit architecture retains full-source compilation.
- Keep the top entity and selected architecture, together with unrelated design units and their context clauses. Exclude only other architectures of the same configured top testbench entity from compilation copies.
- An excluded architecture is not semantically checked in this run. Selecting that architecture later compiles it and exposes its own missing dependencies normally.
- Detect design-unit boundaries using a bounded lexical/structural reader that understands comments, strings and nested constructs; do not cut source with a simple text regex.
- If the selected testbench depends explicitly on another architecture of the same entity, retain its dependency closure when safely recognized. Refuse ambiguous or unsupported dependencies instead of silently producing an incomplete simulation.
- If filtering cannot safely determine unit boundaries, stop with an actionable error rather than deleting uncertain source ranges or pretending compilation succeeded.
- Create per-run copies under the dedicated build directory, preserving bytes outside excluded regions and retaining newline/column positions by blanking excluded spans. Preserve encoding and line endings.
- Translate diagnostics and runtime source locations from temporary paths back to original workspace paths. Preserve normal Problems-panel navigation.
- Log the selected target and the architectures excluded from this compilation so the behavior is visible.
- Use a fresh or isolated compiled work library for selected compilation so an old excluded architecture cannot leak into the result through cached units.
- Preserve the last successful waveform and result records on cancellation, compile failure, or viewer failure. Clean up only owned temporary files at safe lifecycle points; keep live interactive sources until the session ends.

## Verification and delivery

- First reproduce the current TB1/invalid-TB2 failure, then prove TB1 runs through both installed batch and interactive runtimes while selecting TB2 still reports its missing RTL2.
- Test both declaration orders, separate files, nested processes/subprograms/generates, context clauses, comments/strings, mixed case, line-ending and encoding preservation, and original-path diagnostic mapping.
- Test stale-library isolation, unsupported-source rejection, missing selections, dependency retention/refusal, cancellation and prior-wave preservation.
- Synchronize Chinese and English editions, run full suites and English language checks, package both editions, install Chinese, and verify the GUI in an owned copy of the course project.
- Do not rewrite the user's course sources or simulation configuration during acceptance. Commit locally; remote push/merge remains a separate action.
