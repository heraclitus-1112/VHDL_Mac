# VHDL Mac · NVC Runner

> Looking for the English version? Visit the [English edition](https://github.com/heraclitus-1112/VHDL_Mac/tree/english) for English documentation and the English VS Code extension.

在 VS Code 中点击播放按钮，按配置顺序执行 NVC 分析、展开、仿真，成功后默认在独立窗口打开官方 Surfer 波形查看器。

## 在 Mac 上安装

需要先安装 VS Code 和 Homebrew；在终端执行：

```sh
brew install nvc
git clone https://github.com/heraclitus-1112/VHDL_Mac.git
cd VHDL_Mac
code --install-extension surfer-project.surfer
code --install-extension packages/nvc-runner-0.5.0.vsix
code examples/counter
```

`code` 不在 PATH 中时，在 VS Code 命令面板执行 **Shell Command: Install 'code' command in PATH**，或在扩展视图中选择 **从 VSIX 安装**。

打开 `examples/counter/tb_counter.vhd`，点击右上角 ▶ 即可运行已配置示例。NVC 输出应出现 `TB_PASS`，Surfer 在独立窗口打开波形；选中层级后点击 Variables 中的信号名加入波形图。详细操作见 [中文使用说明](docs/使用说明.md)。

本仓库提供扩展源码和预构建 VSIX；NVC 与官方 Surfer 需单独安装。当前验证环境为 Apple Silicon Mac、NVC 1.23.0、VS Code 1.132.0。扩展需要 VS Code 1.85 或以上；独立窗口功能在窗口命令不可用时回退到并排。

## 使用

1. 安装 NVC，并安装官方扩展 `surfer-project.surfer`。扩展要求 VS Code 1.85 或以上及可信任的本地工作区。
2. 打开包含设计和测试平台的文件夹，执行 **NVC: 配置 VHDL 仿真**。
3. 多选源文件，再逐项指定编译顺序；确认顶层测试平台实体、VHDL 标准和运行模式；新配置默认运行到结束。
4. 打开 `.vhd` / `.vhdl`，点击编辑器右上角播放按钮，或点击状态栏 **NVC 仿真**。
5. 在 Surfer 中选择要观察的信号。该查看器维护自己的信号选择界面。

每个工作区根目录使用 `vhdl.sim.json`：

```json
{
  "sources": ["counter.vhd", "tb_counter.vhd"],
  "top": "tb_counter",
  "standard": "2008",
  "stopTime": "all",
  "libraryPaths": []
}
```

## 运行到结束（Run All，0.4.0）

普通 ▶ 和状态栏按钮按项目的 `stopTime` 运行：`"all"` 表示运行到结束，`"5us"` 等数字时间表示停止上限。配置向导可选择这两种模式；新配置默认 `all`，重新配置已有项目时优先保留当前模式和数字值。旧配置不自动改变，省略 `stopTime` 仍按 `1us` 运行。

需要临时越过已保存的时间上限时，执行 **NVC: 运行到结束（Run All）**。命令位于命令面板、VHDL 编辑器标题栏的“…”菜单及 VHDL 文件的资源管理器右键菜单。它仅覆盖本次运行的内存配置，不改写 `vhdl.sim.json`；下一次普通 ▶ 仍使用保存的模式。输出通道会先显示本次模式。

`all` 不向 NVC 传 `--stop-time`，仿真在 `std.env.finish`、终止性失败或没有未来事件时结束。`end process` 只是过程结束，`report` 只是输出消息；它们不会强制结束整场仿真。有持续周期时钟的 testbench 应在测试完成后调用 `std.env.finish`（VHDL-2008）。没有结束条件时，可以用进度通知的取消按钮或 **NVC: 取消 VHDL 仿真** 中止。错误或取消后保留上次成功波形。退出码 0 仅表示 NVC 本次正常退出；功能是否正确仍需结合断言和输出判断。

## 自动生成 Testbench（0.2.0）

打开被测**设计文件**，执行 **NVC: 生成 Testbench**（`⌘⇧P`），或在资源管理器里右键该文件。向导读取当前编辑器的实体接口，包括未保存修改；多个实体或 architecture 时选择被测对象，整数泛型可修改。

先设置结束时间，再逐个 `in` 端口选择：

| 模式 | 填写示例 | 含义 |
|---|---|---|
| 固定值 | `0`、`true`、`-4`、`x"A5"` | 全程保持指定值 |
| 定时变化 | `0ns=0;20ns=1;100ns=0` | 从零时刻开始，按严格递增的时间变化 |
| 周期时钟 | 初值 `0`，开始 `0ns`，周期 `10ns` | 开始前保持初值，之后每半周期翻转 |

向量可用十进制、`"0101"` / `0b0101`、`x"A5"` / `0xA5`；二进制和十六进制必须匹配完整位宽，十进制按 signed/unsigned 范围检查。周期模式仅用于 `std_logic`。所有时间为非负整数加 fs/ps/ns/us/ms/sec，输入变化必须早于结束时间。

确认新实体名称并预览后，创建根目录下的同名 `.vhd`；已有文件不会覆盖。选择 **设为仿真顶层** 并确认编译顺序、标准和时限，即可点击 ▶ 运行。原有库路径保留；未配置项目先选择依赖源文件并确认顺序。创建新配置使用 `stopTime: "all"`；更新已有配置时保留 `all`，已有数字上限若短于测试结束时间则提高到该时间。生成器的结束时间仍是数字时长，控制激励边界和 TB 内的 `finish`，与运行模式分开。生成使用 VHDL-2008。

支持 std_logic、std_logic_vector、signed、unsigned、boolean 和基本整数/整数范围，支持简单整数泛型及位宽中的 `+ - * /` 运算。自定义类型、复杂泛型、inout/buffer 和扩展标识符等会提示不支持。输出仅连接观察，不生成输出驱动。生成器提供**输入激励**，预期输出仍需按设计要求填写 `assert`；完成提示为 `STIMULUS_DONE: no output assertions configured`，不冒充测试通过。

测试时可以为计数器选择：clk 周期 10ns，rst 定时 `0ns=1;20ns=0`，en 定时 `0ns=0;20ns=1;100ns=0;130ns=1`，结束 300ns，文件名 `tb_counter_inputs`。

`sources` 必须是工作区内存在的 `.vhd` / `.vhdl` 文件，顺序就是编译顺序，不能使用 `..` 或符号链接逃出工作区。`top` 是顶层基本实体名称，不带库名前缀。`standard` 可选 `1993` / `2002` / `2008`，默认 `2008`。`stopTime` 为字面量 `all`，或正整数加 `fs` / `ps` / `ns` / `us` / `ms` / `sec`；省略字段默认 `1us`。`libraryPaths` 是已经存在的库目录，可使用相对或绝对路径；本扩展不会自动编译外部库。

配置向导忽略 `.nvc-build`、`.git`、`node_modules`、`build`、`dist`、`out`、`.vscode-test`，不会扫描符号链接。向导取消时不会写入配置。已有配置需要点击“替换”才会覆盖。

多根工作区优先使用当前编辑器所属项目；没有所属项目时显示选择列表。只保存选中项目中的脏文件，保存失败便停止。每个项目同时只允许一次仿真或配置操作。可以通过进度通知的取消按钮，或 **NVC: 取消 VHDL 仿真**，终止当前项目的进程。

0.2.1 修复了重新生成时的旧路径问题：设置新顶层前会识别配置中已删除的源文件，在确认窗口列出将移除的条目；确认后清理失效路径，取消则保留原配置。若缺少的是设计依赖，请取消并重新选择依赖文件。

## 运行与波形

0.2.2 起默认使用独立的 VS Code 编辑器窗口显示波形，代码留在原窗口。VS Code 设置中的 **NVC Runner: Waveform Window** 可选择 `newWindow`（独立窗口，默认）或 `beside`（并排）。0.3.1 修复了恢复布局后残留 `Not available` 的问题：自动清理失效信号引用，保留有效信号和视图设置。

0.3.0 起，同一项目复用一个固定波形窗口；重跑保留已选信号、顺序、格式、游标和视图，关闭后重新打开也会恢复。可用 `nvcRunner.preserveWaveformLayout` 关闭恢复；Surfer 版本变化时自动重置布局。旧版 VS Code 若缺少窗口命令则回退到并排并在输出中说明。

各阶段以参数数组直接启动可执行文件，不调用 shell：

```text
nvc --std=2008 --work=work:<project>/.nvc-build/work -a <sources...>
nvc --std=2008 --work=work:<project>/.nvc-build/work -e tb_counter
nvc --std=2008 --work=work:<project>/.nvc-build/work -r tb_counter --wave=<unique.fst>
```

上例为 `all` 模式；数字模式的运行参数还包含 `--stop-time=1us` 等上限。库目录通过各阶段共有的 `-L <directory>` 传入。任一阶段失败后停止；所有阶段成功且本次新 FST 存在、非空时，才更新 `nvcRunner.waveformViewer`，使用已安装的官方 Surfer 渲染资源。每次使用独立 FST 文件名，保证旧编辑器不会冒充本次结果。

构建文件只放在 `.nvc-build`；该目录及其 `work` 子目录不能是符号链接。扩展只删除 `.nvc-runner.json` 中记录的上一次自有波形，保留其他文件。失败时保留上次已显示的波形；该波形代表上次成功结果，请查看“NVC 仿真”输出中的本次状态。

所有 NVC 输出进入 **NVC 仿真** 输出通道；可解析的源文件行列错误和警告进入 **问题** 面板。找不到配置时运行配置命令；找不到 NVC 时设置 `nvcRunner.nvcPath` 为完整可执行文件路径。留空会查找 `PATH`、`/opt/homebrew/bin/nvc` 和 `/usr/local/bin/nvc`。需要先信任工作区。

本扩展可生成受支持接口的输入激励测试平台，并运行已有测试平台，不综合、不烧录 FPGA。基础 `vhdl` 语言识别用于按钮入口；语法高亮和语言服务可以另装扩展。

## 交互仿真（0.3.0）

普通 ▶ 按保存的运行模式执行 testbench；Run All 用于运行到结束。需要分段推进、暂停和临时改输入时，运行 **NVC: 启动交互仿真**。首次编译后自动运行初始 100ns（若提前 finish，则停在实际结束时间），在同一个波形窗口上方显示交互按钮：

| 按钮 | 操作 |
|---|---|
| 运行一段 | 输入 `100ns` 等时长，保留仿真内部状态并继续推进 |
| 继续 / 暂停 | 按指定时长连续分段运行，暂停在当前段结束后生效 |
| 强制输入 | 选择层级信号并填入 NVC 值，例如 `'0'`、`'1'` 或 `"0101"` |
| 解除强制 | 解除所选信号的覆盖，让原来的驱动重新控制它 |
| 读信号 | 读取暂停时的实际值 |
| 结束会话 | 结束持续进程；修改代码后重新编译需要先结束会话 |

强制/解除后再运行一段以观察响应。工具栏显示实际仿真时间，而不是简单累计输入时长；时长小于下一事件时实际时间可能不变，连续模式会自动暂停并提示加长运行段。testbench 调用 `finish` / `stop` 后不能继续，需结束并重启会话。每段波形是同一持续进程的原生累计数据。只在段末刷新，不提供语句断点或单步源代码调试。

交互模式需要带 Tcl 的 NVC 和本仓库的**实验原生波形补丁**；普通 Homebrew NVC 保持用于批仿真。Apple Silicon Mac 可执行：

```sh
bash tools/build-nvc-interactive.sh --install-deps
```

脚本使用固定校验和的官方 NVC 1.23.0 源码，安装到 `~/.local/share/vhdl-mac/nvc-interactive-livewave`，保留对应 GPL 源码与构建记录，不替换 Homebrew NVC。补丁与构建脚本为 GPL-3.0-or-later；它不是 NVC 官方发行版。其他安装位置可在 `nvcRunner.interactiveNvcPath` 设置。

在 `vhdl.sim.json` 加入 `"dumpArrays": 1024`，普通批仿真就会把最多含 1024 个元素的嵌套数组加入波形。0 表示关闭；当前交互快照不支持该数组选项。

布局按项目保存于本地 VS Code 工作区状态，不上传。Surfer 内部状态接口可能随版本变化；当前已验证官方 Surfer 0.7.1001488。安装包不捆绑 Surfer 资源。

## 开发与验证

无第三方运行时依赖；使用 CommonJS 和 Node 内建模块。运行 `npm test` 或 `node --test test/*.test.js`。`test/TEST-EVIDENCE.md` 记录测试先失败再通过的过程。测试使用真实短 Node 子进程验证阶段短路、取消和新波形；VS Code 适配测试只为不能在 Node 直接访问的宿主 API 提供轻量替身。

API：`validateConfig(data)`、`resolveProject(projectDir, data)`、`discoverSources(projectDir)`、`buildStageArgs(resolvedConfig, buildDir, wavePath)`、`runSimulation(options)`、`parseDiagnostics(output, projectDir)`、`resolveNvc(override)`，由 `src/core.js` 导出。`runSimulation` 返回 `{ wavePath, output, projectDir }`，失败抛错；支持 `AbortSignal`、`onOutput`、`onStage` 和异步 `onResult(result)`。`onResult` 在新 FST 校验后、结果提交与旧 FST 清理前接收结果；回调可返回异步回滚函数，供提交前取消或提交失败时恢复消费者状态。提交开始后到来的取消请求不会撤销已经接受的新结果。提交后的旧 FST 或临时记录清理失败会输出警告，保留已接受的新结果；提交前的原始错误与取消仍按原状态报告。

真实 NVC、VS Code Extension Host 与官方 Surfer 的验收由独立测试负责，Node 单元测试本身不证明 UI 展示正确。

## 选择 Testbench architecture（0.5.0）

同一测试平台实体可以有多套 architecture。打开 VHDL 文件，使用编辑器右上角 `…` 或命令面板中的 **NVC: 选择 Testbench architecture**，选择要运行的一套。选择保存后，普通播放、Run All 和交互仿真都使用它；每次只运行一套，不会依次执行全部 architecture。配置向导也会提供选择；仅识别到一套时自动选中。

配置分别保存实体和架构，例如：

```json
"top": "tb_mux",
"architecture": "test1"
```

不填 `architecture` 的旧配置保持 NVC 默认选择；选择“NVC 默认选择”可移除固定选择。列表读取已配置源文件中的声明，也支持手动输入基本名称。取消不改变配置。若架构被删除或无法展开，运行会报错并保留上一份成功波形，不会自动切换到其他架构。输出中显示实际顶层，例如 `tb_mux(test1)`。交互会话启动后，先结束会话再切换。生成新 TB 并设为顶层时，选择更新为生成器的 `sim`。

这个选择只影响测试平台顶层；TB 中 DUT 实例所用的架构仍按 VHDL 实例化或 configuration 规则绑定。自动扫描支持基本名称，忽略行注释、块注释和字符串；扫描上限为单文件 4 MiB、总计 16 MiB。
