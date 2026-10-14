# VHDL Mac · NVC Runner

**English edition on the `english` branch.** The [Chinese edition is maintained on `main`](https://github.com/heraclitus-1112/VHDL_Mac/tree/main).

Click the play button in VS Code to run NVC analysis, elaboration, and simulation in the configured order. After a successful run, the official Surfer waveform viewer opens in a separate window by default.

## Install on macOS

Install VS Code and Homebrew first, then run:

```sh
brew install nvc
git clone --branch english https://github.com/heraclitus-1112/VHDL_Mac.git
cd VHDL_Mac
code --install-extension surfer-project.surfer
code --install-extension packages/nvc-runner-0.3.2-en.vsix
code examples/counter
```

If `code` is not on your PATH, run **Shell Command: Install 'code' command in PATH** from the VS Code Command Palette, or select **Install from VSIX** in the Extensions view.

The English VSIX uses manifest version `0.3.2` and the same extension ID as the Chinese edition. These are alternative builds: install one language edition at a time. Installing one replaces the other. To return to Chinese, install the VSIX from `main` with `--force`:

```sh
git clone --branch main https://github.com/heraclitus-1112/VHDL_Mac.git VHDL_Mac-Chinese
code --install-extension VHDL_Mac-Chinese/packages/nvc-runner-0.3.1.vsix --force
```

Open `examples/counter/tb_counter.vhd` and click ▶ in the top-right corner to run the configured example. NVC should print `TB_PASS`, and Surfer should open the waveform in a separate window. Select a scope, then click signal names under Variables to add them to the waveform. See the [user guide](docs/USER-GUIDE.md) for detailed instructions.

This repository provides extension source and a prebuilt VSIX. Install NVC and the official Surfer extension separately. The verified environment is an Apple Silicon Mac, NVC 1.23.0, and VS Code 1.132.0. The extension requires VS Code 1.85 or later. If the separate-window command is unavailable, waveforms open beside the code instead.

## Use

1. Install NVC and the official `surfer-project.surfer` extension. Use VS Code 1.85 or later and a trusted local workspace.
2. Open a folder containing the design and testbench, then run **NVC: Configure VHDL Simulation**.
3. Select the source files, specify their compilation order, and confirm the top-level testbench entity, VHDL standard, and stop time.
4. Open a `.vhd` or `.vhdl` file and click the editor's play button or **NVC Simulation** in the status bar.
5. Select the signals to observe in Surfer, which provides its own signal-selection interface.

Each workspace root uses `vhdl.sim.json`:

```json
{
  "sources": ["counter.vhd", "tb_counter.vhd"],
  "top": "tb_counter",
  "standard": "2008",
  "stopTime": "1us",
  "libraryPaths": []
}
```

## Generate a testbench (0.2.0)

Open the **design under test** and run **NVC: Generate Testbench** (`⌘⇧P`), or right-click the file in the Explorer. The wizard reads the entity interface from the current editor, including unsaved changes. If the file contains multiple entities or architectures, select the one to test. You can also edit integer generic values.

Set the end time, then choose a stimulus mode for each `in` port:

| Mode | Example | Behavior |
|---|---|---|
| Constant | `0`, `true`, `-4`, `x"A5"` | Holds the specified value throughout the simulation |
| Timed changes | `0ns=0;20ns=1;100ns=0` | Starts at time zero and changes at strictly increasing times |
| Periodic clock | Initial value `0`, start `0ns`, period `10ns` | Holds the initial value until the start time, then toggles every half-period |

Vectors accept decimal values, `"0101"` / `0b0101`, and `x"A5"` / `0xA5`. Binary and hexadecimal values must match the full bit width; decimal values are checked against the signed or unsigned range. Periodic clocks support only `std_logic`. Times use a nonnegative integer followed by fs/ps/ns/us/ms/sec. Input changes must occur before the end time.

Confirm the new entity name and review the preview. The wizard creates a `.vhd` file with that name in the workspace root and never overwrites an existing file. Choose **Set as Simulation Top**, confirm compilation order, standard, and time limit, then click ▶. Existing library paths are preserved. For an unconfigured project, first select the dependency source files and confirm their order. Generated testbenches use VHDL-2008.

Supported interfaces include std_logic, std_logic_vector, signed, unsigned, boolean, basic integer types and integer ranges, simple integer generics, and `+ - * /` expressions in bit widths. Custom types, complex generics, inout/buffer ports, extended identifiers, and other unsupported constructs produce an explanation. Output ports are connected for observation and are never driven by the generator. The generator supplies **input stimulus**; add `assert` statements to check expected outputs against the design requirements. Without output assertions, completion reports `STIMULUS_DONE: no output assertions configured`, not a test pass.

For the counter example, use a 10ns periodic clk; rst changes `0ns=1;20ns=0`; en changes `0ns=0;20ns=1;100ns=0;130ns=1`; an end time of 300ns; and the file name `tb_counter_inputs`.

`sources` must list existing `.vhd` / `.vhdl` files inside the workspace in compilation order. Neither `..` nor symbolic links may escape the workspace. `top` is a basic top-level entity name without a library prefix. `standard` accepts `1993`, `2002`, or `2008`, with `2008` as the default. `stopTime` is a positive integer followed by `fs`, `ps`, `ns`, `us`, `ms`, or `sec`; the default is `1us`. `libraryPaths` lists existing library directories, using relative or absolute paths. The extension does not compile external libraries automatically.

The configuration wizard ignores `.nvc-build`, `.git`, `node_modules`, `build`, `dist`, `out`, and `.vscode-test`, and does not scan symbolic links. Canceling the wizard leaves the configuration untouched. An existing configuration is overwritten only after you choose **Replace**.

In a multi-root workspace, the extension prefers the project containing the current editor. Otherwise, it asks you to select a project. It saves dirty files only in that project and stops if saving fails. Each project allows only one simulation or configuration operation at a time. Cancel the current project's process using the progress notification or **NVC: Cancel VHDL Simulation**.

Version 0.2.1 fixed stale source paths when regenerating a testbench. Before setting the new top, the wizard detects deleted source files and lists the entries to remove. Confirmation removes stale paths; cancellation preserves the original configuration. If a missing file is a required design dependency, cancel and select the dependency files again.

## Simulation and waveforms

Since 0.2.2, waveforms open in a separate VS Code editor window by default, leaving the code in the original window. **NVC Runner: Waveform Window** accepts `newWindow` (the default) or `beside`. Version 0.3.1 fixed lingering `Not available` entries after layout restoration: invalid signal references are removed while valid signals and view settings are preserved.

Since 0.3.0, each project reuses a dedicated waveform window. Rerunning preserves selected signals, their order and formats, cursors, and the view. Closing and reopening also restores the layout. Disable this behavior with `nvcRunner.preserveWaveformLayout`. A Surfer version change resets the saved layout automatically. On older VS Code versions without the window command, the extension opens beside the code and explains the fallback in its output.

Each stage launches the executable directly with an argument array, without a shell:

```text
nvc --std=2008 --work=work:<project>/.nvc-build/work -a <sources...>
nvc --std=2008 --work=work:<project>/.nvc-build/work -e tb_counter
nvc --std=2008 --work=work:<project>/.nvc-build/work -r tb_counter --stop-time=1us --wave=<unique.fst>
```

Library directories are passed as `-L <directory>` to every stage. A failed stage stops the run. The `nvcRunner.waveformViewer` editor is updated only after all stages succeed and the current run's new FST exists and is nonempty. It uses rendering resources from the installed official Surfer extension. Each run uses a unique FST filename so an old editor cannot be mistaken for the current result.

Build artifacts stay in `.nvc-build`. Neither that directory nor its `work` subdirectory may be a symbolic link. The extension deletes only its previous waveform recorded in `.nvc-runner.json`, preserving other files. A failed run leaves the last displayed waveform intact; that waveform represents the previous successful run. Check **NVC Simulation** output for the current run's status.

All NVC output appears in the **NVC Simulation** output channel. Source errors and warnings with parseable file, line, and column locations appear in the **Problems** panel. If configuration is missing, run the configuration command. If NVC cannot be found, set `nvcRunner.nvcPath` to its full executable path. An empty setting searches `PATH`, `/opt/homebrew/bin/nvc`, and `/usr/local/bin/nvc`. Trust the workspace before running.

The extension generates input-stimulus testbenches for supported interfaces and runs existing testbenches. It does not synthesize designs or program FPGAs. Basic `vhdl` language registration enables the editor buttons; install a separate extension for syntax highlighting and language services.

## Interactive simulation (0.3.0)

The normal ▶ button runs the complete testbench. For incremental advancement, pauses, and temporary input overrides, run **NVC: Start Interactive Simulation**. After compilation, the session runs an initial 100ns, or stops at the actual finish time if the testbench finishes earlier. Controls appear above the waveform in the same window:

| Button | Action |
|---|---|
| Run segment | Enter a duration such as `100ns` to advance while preserving simulation state |
| Continue / Pause | Run consecutive segments of the specified duration; Pause takes effect at the end of the current segment |
| Force input | Select a hierarchical signal and enter an NVC value such as `'0'`, `'1'`, or `"0101"` |
| Release force | Remove the selected signal's override so its original drivers control it again |
| Read signal | Read the actual value while paused |
| End session | Stop the persistent process; end the session before recompiling changed code |

After forcing or releasing a signal, run another segment to observe the response. The toolbar shows actual simulation time, not the sum of requested durations. If a duration is shorter than the time to the next event, actual time may not advance. Continuous mode then pauses automatically and suggests a longer segment. After a testbench calls `finish` / `stop`, it cannot continue; end and restart the session. Each segment's waveform contains native cumulative data from the same persistent process. Waveforms refresh only at segment boundaries. Statement breakpoints and source-code single stepping are not supported.

Interactive mode requires an NVC build with Tcl and this repository's **experimental native waveform patch**. Keep ordinary Homebrew NVC for batch simulation. On an Apple Silicon Mac, run:

```sh
bash tools/build-nvc-interactive.sh --install-deps
```

The script uses official NVC 1.23.0 source with a pinned checksum and installs to `~/.local/share/vhdl-mac/nvc-interactive-livewave`. It retains the corresponding GPL source and build records, and does not replace Homebrew NVC. The patch and build script are licensed under GPL-3.0-or-later. This patched build is not an official NVC release. Set `nvcRunner.interactiveNvcPath` for another installation location.

Add `"dumpArrays": 1024` to `vhdl.sim.json` to include nested arrays with up to 1024 elements in batch waveforms. Set it to 0 to disable array dumping. Current interactive snapshots do not support this option.

Layouts are stored locally in VS Code workspace state for each project and are not uploaded. Surfer's internal state interface may change between versions. The currently verified official Surfer version is 0.7.1001488. The VSIX does not bundle Surfer resources.

## Development and verification

There are no third-party runtime dependencies. The extension uses CommonJS and Node built-in modules. Run `npm test` or `node --test test/*.test.js`. [Test evidence](test/TEST-EVIDENCE.md) records the sequence of failing and passing tests. Tests use real short-lived Node child processes to check stage short-circuiting, cancellation, and fresh waveforms. VS Code adapter tests use lightweight substitutes only for host APIs unavailable directly in Node.

`src/core.js` exports `validateConfig(data)`, `resolveProject(projectDir, data)`, `discoverSources(projectDir)`, `buildStageArgs(resolvedConfig, buildDir, wavePath)`, `runSimulation(options)`, `parseDiagnostics(output, projectDir)`, and `resolveNvc(override)`. `runSimulation` returns `{ wavePath, output, projectDir }` and throws on failure. It supports `AbortSignal`, `onOutput`, and `onStage`.

Separate acceptance tests cover real NVC, the VS Code Extension Host, and the official Surfer viewer. Passing Node unit tests alone does not establish that the waveform UI displays correctly.
