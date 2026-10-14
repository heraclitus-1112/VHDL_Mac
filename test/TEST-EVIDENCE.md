# Automated test evidence

This document translates the recorded development and acceptance evidence. Historical test counts describe those checkpoints, not the current suite size. Raw historical logs are available in the [Chinese edition's `main` branch and Git history](https://github.com/heraclitus-1112/VHDL_Mac/tree/main/test); obsolete logs are not duplicated in the English edition.

Runtime for the initial checkpoints: `node` v24.19.0.

1. Core tests were written before `src/core.js` existed. Running `node --test test/core.test.js` produced 11 failures, each asserting that a required API was missing.
2. The first core implementation passed 9 of 11 tests. The remaining failures arose from macOS resolving `/var` to `/private/var`. Returning the fixture's real path fixed the tests while preserving the real-path safety requirement.
3. Adapter tests were written before `src/extension.js` existed. Running `node --test test/extension.test.js` produced five failures because `createExtension` was missing.
4. After implementing the host adapter, `node --test test/core.test.js test/extension.test.js` passed all 16 tests.

Core tests launch real short-lived Node child processes and create real files. They cover stage order, spaces in arguments, failure short-circuiting, rejection of stale waveforms, unique waveform URIs, preservation of files not owned by the extension, cancellation, missing fresh waveforms, path constraints, and diagnostic parsing. The host adapter uses minimal API substitutes to check workspace trust, acquisition of the project lock before saving, saving only the selected project's files, stopping on save failure, wizard cancellation, explicit compilation order, and rejection of configuration symbolic links that could write into a source file.

Passing automated tests was not treated as acceptance of the real VS Code waveform UI.

5. Self-review added fixtures for actual NVC 1.23 diagnostics of the form `> file.vhd:line`, aliases to source files inside the build directory, and dirty-file symbolic links outside the workspace. Running `node --test test/*.test.js` reproduced three corresponding failures. The fixes removed the `>` diagnostic marker, rejected sources whose real paths point into the build directory, and checked real-path boundaries before saving.
6. The resulting `node --test test/*.test.js` run passed all 20 tests. An additional assertion for existing library paths in argument construction also passed; the implementation was already covered by earlier stage-order and argument tests.

Self-review confirmed the manifest version, official Surfer dependency, and exact viewType. Core execution uses no shell and returns only the current run's unique FST. Build and configuration paths reject unsafe symbolic links. The run lock is acquired synchronously before saving, and the final Promise waits for the editor-opening command. Separate acceptance work covered the real UI.

7. Specification review supplied actual NVC assertion output. Regression fixtures were added for `** Failure` and `Process/Procedure ... at file:line`. A real Node child process also verified that Warning output does not prevent a successful waveform result. Before the fix, three assertions failed: Failure was not recognized and the call-frame prefix polluted the path.
8. Failure is now classified as an error, and runtime call frames yield the actual source path. `node --test test/*.test.js` then passed all 23 tests. `node --check src/core.js` and `git diff --check` also passed.

## 0.2.0: Generate input stimulus

Failing tests for the testbench/generate modules and command were added before implementation. A test for externally modified configuration during confirmation failed first, then passed after a content recheck was added. Initial validation with real NVC found that a non-ASCII report string was incompatible; an ASCII `STIMULUS_DONE` report fixed the issue while retaining the original source comments at that checkpoint.

Real NVC validated generated counter clocks, resets, and enables, plus generic unsigned/signed/boolean/positive inputs. Test-specific assertions checked actual values. In the user's normal VS Code window, the wizard configured A/B/SEL timing for `Exo1/mux21.vhd`, generated `tb_mux21_inputs.vhd`, confirmed the top-level configuration, and ran immediately. The run produced a 373-byte FST. Official Surfer displayed all four signals. A generated file without output assertions reported `STIMULUS_DONE`, not `TB_PASS`.

## 0.2.2: Separate waveform window

Failing waveform-module tests preceded implementation. All 43 tests passed, covering movement of the exact waveform URI, the beside setting, fallback when older VS Code versions lack the window command, and fallback after a window-creation exception. Running Exo1 in the user's normal VS Code opened Surfer's custom editor in Window 2, with Webview parentId=4. The separate window displayed actual tb_a/tb_b/tb_sel/tb_y waveforms while code stayed in the original window. The default setting was `newWindow`.

## 0.3.0: Workflow acceptance (2026-10-13)

- `node --test test/*.test.js` passed all 60 tests, including six real persistent NVC session tests, combinational waveforms at time zero, finish/failure behavior, force/noforce, segment-boundary pauses, and existing generator and batch regressions.
- A real batch NVC run with `--dump-arrays=16` produced VCD signals `memory[0][3:0]` and `memory[1][3:0]`.
- VS Code and the user's Exo1 project: rerunning replaced the FST in the same auxiliary editor and preserved tb_a, tb_b, tb_sel, and tb_y. Closing and reopening restored those four signals. Selection was also preserved across FST/VCD files.
- Real GUI interaction: one session advanced to 100ns, forced tb_a=0, showed a waveform change at 200ns, released the force, continued in 10ns segments, and paused at a segment boundary at 1190ns. The buttons became available again. Ending the session removed the persistent process.
- Independent code review led to fixes for Surfer's saved-state `data` field and the `command_file` bridge. Protocol regression tests passed. Manually opened external waveforms used the official Surfer editor without replacing the project's run record.
- The experimental interactive patch uses NVC's native waveform dumper. One hundred 5ns segments produced the same event region as one 500ns run. Time-zero init/force/noforce operations did not create artificial time. A rebuild from fresh source using the build script passed.
- Rendering resources came from installed official Surfer 0.7.1001488. Its custom state interface may change on upgrade; version changes automatically discard old layouts. Interactive segments that are too short to advance time cause an automatic pause. This is not source-code single stepping.

## 0.3.1: Invalid waveform reference fix (2026-10-14)

- Root cause: LoadState restored invalid references as Placeholder entries, and cached Wellen numeric IDs in old RON state belonged to the previous file. An old active_scope containing a cached ID could be incorrectly accepted in a new file.
- Cached IDs are removed before restoration, allowing full paths to be resolved again. Rebinding active_scope uses an uncached path, and saving calls RemovePlaceholders. User names and comments inside strings are left untouched.
- Three bridge regressions failed before the fix and passed afterward: invalid references are removed while valid signals/cursors/zoom/formats survive; cached IDs can be transported safely without changing user text; and manual state restoration also removes invalid entries.
- All 63 tests passed.
- Acceptance used official Surfer 0.7.1001488's actual WASM and the user's Exo2 FST in a separate browser. Real RON state was injected with five valid signals, one invalid signal, an invalid scope, and old numeric IDs. Restoration, rerunning, and reopening each produced five valid signals and zero placeholders. The real page result was PASS.
- The user was editing Exo3, so final acceptance did not touch its unsaved files.

## English edition

The English edition keeps the recorded feature and acceptance boundaries. Translating this document does not rerun those historical acceptance checks. The edition's current automated checks are run separately during packaging and are reported by that task.

## 0.4.1 English edition: Run All synchronization (2026-10-14)

- English equivalents of the approved Run All feature and transaction regressions were added before production changes. The first targeted run covered 73 tests: 40 passed and 33 failed. Failures demonstrated missing literal `all` support, schema acceptance, the `nvcRunner.runAll` command, wizard defaults, result handoff rollback, and viewer cancellation/cleanup handling.
- The approved implementation was ported while retaining English runtime messages, stable mode identifiers, configuration keys, and the official Surfer protocol. A translation-only warning assertion was corrected to match the English cleanup message.
- The full `node --test --test-reporter=spec test/*.test.js` run passed all 97 tests, with zero failures and zero skips. Real batch NVC tests exercised natural completion beyond a numeric limit, finish with a periodic clock, cancellation of an endless clock, and generated numeric-duration finish in Run All mode. Persistent interactive and existing waveform regressions also passed.
- The English-language test now scans the test directory as well as runtime source, schemas, documentation, tools, and examples, and verifies the exact `NVC: Run All` command title.
- English VSIX packaging and real VS Code GUI acceptance are separate steps; this source verification did not install a VSIX or exercise the English UI in VS Code.

### Run All package and desktop acceptance (2026-10-14)

Chinese 0.4.0: 96/96 tests; English 0.4.1: 97/97; no skips. Both VSIX archives passed integrity and source-content checks. Chinese 0.4.0 remains installed locally.

Real VS Code acceptance used isolated fixtures. The copied Exo4 retained a 5us config; its editor Run All menu omitted --stop-time, printed End of test at 5120ns and opened a fresh FST. Config bytes and user Exo4 source/config hashes stayed unchanged. The new configuration wizard selected all by default; normal Run displayed clk/count/en/rst and finished the asserting counter at 280ns. Default detached window loading and beside rendering were observed. An endless clock was cancelled through the native progress button, then the same project produced a fresh waveform using a 50ns limit. No test NVC process remained.

The English package passed language, semantic comparison and real NVC command-adapter tests. This acceptance run did not separately install the new English GUI; these checks are not presented as independent English GUI proof.
