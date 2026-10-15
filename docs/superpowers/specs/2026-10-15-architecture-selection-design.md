# Testbench architecture selection

Date: 2026-10-15

## Intended behavior

Let the user choose one architecture of the configured testbench entity and use it consistently in ordinary batch simulation, Run All, and interactive simulation. Selecting one architecture does not run the others.

## Alternatives

1. Recommended: save an optional `architecture` field, expose a dedicated selection command, and include the choice in the configuration wizard. This makes selection convenient while keeping subsequent runs one click.
2. Prompt on every run. This avoids a saved preference but adds a repeated step to every simulation.
3. Accept `entity(architecture)` in the existing top text box. This is compact but requires the user to know and type the exact name and is less discoverable.

## User flow and configuration

- Add `NVC: Select Testbench Architecture` (localized in the Chinese edition) to the command palette and VHDL editor overflow menu.
- For an existing project, show architectures belonging to the configured `top` in the configured source files, with the current choice first. Include an explicit NVC-default option which removes the optional field.
- The configuration wizard offers the same choice after confirming the top entity. Recognized single architectures may be selected directly; multiple architectures require a selection. Where discovery cannot identify a valid architecture, allow a validated basic identifier or the explicit NVC-default option.
- Persist an explicit selection as separate fields, e.g. `"top": "tb_mux", "architecture": "test1"`.
- Existing configurations with no `architecture` retain the current NVC-default behavior.
- Cancelled selection changes nothing. Use existing trust, path, dirty-editor, project-lock, and atomic configuration-write protections. Selection must not replace an active interactive session silently.

## Runtime and discovery

- Validate `architecture` as an optional VHDL basic identifier; reject empty or malformed values.
- Discover architecture declarations across configured project sources, matching the top entity case-insensitively and ignoring comments and string literals. Keep the reader bounded; NVC remains the authority on language validity.
- Build the explicit NVC elaboration target from entity and architecture. Verify the appropriate batch and interactive loading syntax against the installed NVC versions with real simulations.
- Log the chosen entity and architecture so the executed target is visible.
- If an explicit architecture no longer exists or cannot elaborate, report the error and preserve the last successful waveform. Never silently fall back to another architecture.
- When testbench generation changes the top to a newly generated testbench, replace any stale architecture selection with that generated testbench's `sim` architecture.
- Selection concerns only the top testbench architecture. Binding architectures of DUT instances continues to follow VHDL entity instantiation/configuration rules.

## Validation and delivery

- Cover configuration compatibility and validation, declaration discovery, source ordering, wizard selection/cancellation, saved selection switching, generation target updates, and command construction.
- Use a real two-architecture testbench with distinct reports to prove both choices work, including selection of the first-declared architecture and switching back.
- Exercise batch timed mode, Run All, and the installed interactive NVC path; retain cancellation/error and waveform-preservation coverage.
- Synchronize the separate English edition and run its language checks.
- Build both VSIX packages, install the Chinese edition, and verify the selection workflow in an isolated VS Code project. Do not modify the user's course sources or simulation configuration for acceptance testing.
- Commit locally. Remote push and merging remain separate from this implementation request.
