# Run VHDL simulations in VS Code

Follow the [README installation instructions](../README.md). Install NVC, the English NVC Runner extension, and the official Surfer extension, then open `examples/counter`.

Since 0.2.2, successful simulations open Surfer waveforms in a separate VS Code window by default. For a view beside the code, search VS Code settings for `nvcRunner.waveformWindow` and select `beside`.

## Generate a testbench (0.2.0)

Open the design under test (`counter.vhd` in the example), press `⌘⇧P`, and run **NVC: Generate Testbench**. The wizard lets you configure each input port as a constant, timed changes, or a periodic clock. A timed sequence might be `0ns=0;20ns=1;100ns=0`; a vector value might be `x"A5"`. For a clock, set the initial value, start time, and full period.

Review the preview and name the new testbench file. Existing files are never overwritten. Choose **Set as Simulation Top**, confirm compilation order and the run mode, then click ▶. New generated targets default to Run All, while the generator keeps a numeric stimulus end time and calls `std.env.finish` at that time. Updating an existing target preserves Run All or a longer numeric limit and raises shorter limits to cover the stimulus. The generator provides input stimulus. Add `assert` statements for functional checks; without checks, it reports only `STIMULUS_DONE`.

For the counter, use an end time of 300ns; clk with initial value 0, start 0ns, and period 10ns; rst changes `0ns=1;20ns=0`; en changes `0ns=0;20ns=1;100ns=0;130ns=1`; and the new file name `tb_counter_inputs`.

## Set up your own project

1. Use **File → Open Folder** in VS Code to open the project folder containing your VHDL files, and trust the local project.
2. Write a design file such as `counter.vhd` and a testbench such as `tb_counter.vhd`. Put clocks, resets, input changes, and checks in the testbench. NVC/Surfer does not provide a ModelSim-style window for drawing input stimulus directly.
3. Open the Command Palette (`⌘⇧P`) and run **NVC: Configure VHDL Simulation**. Select the source files, order them by dependency, and enter the top-level testbench entity, VHDL standard, and run mode. New configurations default to **Run All**; reconfiguration retains the existing mode and numeric value. The extension saves `vhdl.sim.json`; you can also edit the JSON directly.

## Run the simulation

Open any `.vhd` or `.vhdl` file and click **▶ NVC: Run VHDL Simulation** in the top-right corner, or click **NVC Simulation** in the status bar. The extension saves unsaved files in the selected project, then analyzes, elaborates, and runs the testbench. It creates a fresh FST and opens Surfer in a separate VS Code waveform window after a successful run.

For a one-time run without the saved time limit, use **NVC: Run All** from the Command Palette, the VHDL editor overflow menu, or the Explorer context menu. It changes the in-memory configuration for this run only. Subsequent runs from the play button or status bar use the saved configuration. The output channel explicitly reports Run All or the numeric stop time.

Run All ends on `finish` / `stop`, a terminating failure, or no future events. A `report` statement or the end of one process does not force the entire simulation to end. Exit code 0 alone does not prove that all intended checks completed or that the design passed its functional requirements. It cannot run beyond the testbench's own finish condition. A clock that schedules events forever needs a finish condition or cancellation using the progress notification or **NVC: Cancel VHDL Simulation**.

In Surfer, expand a scope such as `tb_counter` on the left and select an instance. Click signal names under Variables to add them to the waveform on the right. Enlarge the editor group if needed. The example signals include `clk`, `rst`, `en`, and `count[3:0]`.

Simulation output appears under **Output → NVC Simulation**. NVC errors with identifiable source locations appear in the **Problems** panel. A failed or cancelled run keeps the previous successful waveform and result record. If viewer delivery or result publication fails before commit, the stable viewer record and prior layout are restored. Cancellation after the atomic commit leaves the accepted result in place. Cleanup failures are reported as warnings. Stop a run with **Cancel** in its progress notification or **NVC: Cancel VHDL Simulation**.

In `vhdl.sim.json`, `sources` defines compilation order, `top` names the testbench entity, and `stopTime` accepts the exact literal `"all"` or a positive integer duration such as `"1us"`. Omitting it retains the old `1us` default. The configuration wizard defaults a new project to Run All and preserves the mode and value of an existing configuration. If a third party or instructor supplies precompiled libraries in a dedicated directory, add that directory to `libraryPaths`. The extension does not compile those libraries automatically. Vendor-specific libraries unsupported by NVC may still require the course's prescribed ModelSim/Questa environment.

## Run segments and temporarily change inputs (0.3.0)

Press `⌘⇧P` and run **NVC: Start Interactive Simulation**. It compiles the current configuration and runs an initial 100ns, then shows controls above the waveform. Click **Run segment** and enter a duration such as `100ns`. Repeated segments preserve the circuit's internal state. Click **Continue** to keep running segments of that duration, and **Pause** to pause at the end of the current segment.

While paused, click **Force input**, select a signal such as `/tb_a`, and enter `'0'`, `'1'`, or a width-matched value such as `"0101"`. Run another segment to observe the circuit response. Click **Release force**, then run again to restore the original drivers. **Read signal** displays the current value.

After editing code, click **End session** before starting a new interactive session or using the normal ▶ button. Restart after the testbench reaches `finish` / `stop` as well; Continue does not bypass either operation. Pauses occur at segment boundaries, so longer segments can mean a longer wait for a pause. You can still force combinational inputs when actual simulation time has not advanced.

Batch and interactive simulations share the project's waveform window. Rerunning preserves signal selection and layout; closing and reopening restores them too. Disable `nvcRunner.preserveWaveformLayout` if you want to select the signals again.

Before using interactive mode on a new Mac, follow the README and run `bash tools/build-nvc-interactive.sh --install-deps`. Ordinary Homebrew NVC does not include this experimental snapshot patch. The current interactive controls support learning and basic functional simulation. They do not provide ModelSim's source-code breakpoints, single stepping, or vendor-library integration.

## Select a testbench architecture (0.5.1)

A testbench entity can have multiple architectures. Open a VHDL file and use **NVC: Select Testbench Architecture** in the editor overflow menu or Command Palette. The saved choice applies to normal Run, Run All, and interactive simulation. Each run uses one architecture; it does not run every architecture in sequence. The configuration wizard also offers this selection; a single discovered architecture is selected automatically.

The entity and architecture are stored separately:

```json
"top": "tb_mux",
"architecture": "test1"
```

Existing configurations without `architecture` retain NVC's default selection. Choose **NVC default selection** to remove a pinned choice. Candidates come from declarations in the configured source files; manual entry of a basic identifier is also available. Cancellation leaves configuration unchanged. A deleted or invalid selected architecture fails explicitly and preserves the previous successful waveform rather than falling back. Output shows the actual target, such as `tb_mux(test1)`. End an active interactive session before switching. Setting a newly generated testbench as top replaces any old architecture choice with its generated `sim` architecture.

This selects only the top-level testbench architecture. DUT architectures inside it still follow VHDL instantiation or configuration binding. Discovery supports basic identifiers and ignores line comments, block comments, and strings. It is limited to 4 MiB per file and 16 MiB total.

## Compile the selected testbench architecture (0.6.1)

With an explicit testbench architecture selected, normal Run, Run All, and interactive simulation prepare temporary sources in the build directory. They compile the selected TB architecture and its explicit architecture dependencies while retaining the DUT and unrelated design units. Original `.vhd` files stay unchanged. Selecting `TB1` can therefore run while an unselected `TB2` references an unfinished `RTL2`; selecting `TB2` still reports that missing dependency.

Output lists the excluded TB architectures. Compile and runtime source locations map back to the original workspace files and line numbers. Each selected compilation uses an isolated work library to prevent stale architectures from affecting results. Failure or cancellation preserves the last successful waveform. Without a pinned architecture, **NVC default selection** continues to compile all sources.

The filter recognizes design-unit boundaries, context clauses, and nested statements while preserving byte positions and line endings. It stops explicitly if boundaries or dependencies cannot be determined safely and does not hide errors in the selected architecture. Selected compilation currently supports basic identifiers. Extended identifiers, ambiguous same-entity component binding, and unresolved configuration dependencies require splitting files or explicit entity/architecture binding. Sources still need complete, recognizable structure; structural errors such as a missing `end` in an unselected architecture must also be corrected.
