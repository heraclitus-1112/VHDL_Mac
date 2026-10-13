# NVC Runner · VHDL 仿真

在 VS Code 中点击播放按钮，按配置顺序执行 NVC 分析、展开、仿真，成功后在旁边打开官方 Surfer 波形查看器。

## 使用

1. 安装 NVC，并安装官方扩展 `surfer-project.surfer`。扩展要求 VS Code 1.85 或以上及可信任的本地工作区。
2. 打开包含设计和测试平台的文件夹，执行 **NVC: 配置 VHDL 仿真**。
3. 多选源文件，再逐项指定编译顺序；确认顶层测试平台实体、VHDL 标准和停止时间。
4. 打开 `.vhd` / `.vhdl`，点击编辑器右上角播放按钮，或点击状态栏 **NVC 仿真**。
5. 在 Surfer 中选择要观察的信号。该查看器维护自己的信号选择界面。

每个工作区根目录使用 `vhdl.sim.json`：

```json
{
  "sources": ["counter.vhd", "tb_counter.vhd"],
  "top": "tb_counter",
  "standard": "2008",
  "stopTime": "1us",
  "libraryPaths": []
}
```

`sources` 必须是工作区内存在的 `.vhd` / `.vhdl` 文件，顺序就是编译顺序，不能使用 `..` 或符号链接逃出工作区。`top` 是顶层基本实体名称，不带库名前缀。`standard` 可选 `1993` / `2002` / `2008`，默认 `2008`。`stopTime` 为正整数加 `fs` / `ps` / `ns` / `us` / `ms` / `sec`，默认 `1us`。`libraryPaths` 是已经存在的库目录，可使用相对或绝对路径；本扩展不会自动编译外部库。

配置向导忽略 `.nvc-build`、`.git`、`node_modules`、`build`、`dist`、`out`、`.vscode-test`，不会扫描符号链接。向导取消时不会写入配置。已有配置需要点击“替换”才会覆盖。

多根工作区优先使用当前编辑器所属项目；没有所属项目时显示选择列表。只保存选中项目中的脏文件，保存失败便停止。每个项目同时只允许一次仿真或配置操作。可以通过进度通知的取消按钮，或 **NVC: 取消 VHDL 仿真**，终止当前项目的进程。

## 运行与波形

各阶段以参数数组直接启动可执行文件，不调用 shell：

```text
nvc --std=2008 --work=work:<project>/.nvc-build/work -a <sources...>
nvc --std=2008 --work=work:<project>/.nvc-build/work -e tb_counter
nvc --std=2008 --work=work:<project>/.nvc-build/work -r tb_counter --stop-time=1us --wave=<unique.fst>
```

库目录通过各阶段共有的 `-L <directory>` 传入。任一阶段失败后停止；所有阶段成功且本次新 FST 存在、非空时，才打开 `surfer.waveformViewer`。每次使用独立 FST 文件名，保证旧编辑器不会冒充本次结果。

构建文件只放在 `.nvc-build`；该目录及其 `work` 子目录不能是符号链接。扩展只删除 `.nvc-runner.json` 中记录的上一次自有波形，保留其他文件。先前波形标签页在文件删除后可能仍显示缓存内容，请以最后一次打开的独立文件名和“NVC 仿真”输出为准。

所有 NVC 输出进入 **NVC 仿真** 输出通道；可解析的源文件行列错误和警告进入 **问题** 面板。找不到配置时运行配置命令；找不到 NVC 时设置 `nvcRunner.nvcPath` 为完整可执行文件路径。留空会查找 `PATH`、`/opt/homebrew/bin/nvc` 和 `/usr/local/bin/nvc`。需要先信任工作区。

本扩展运行现有测试平台，不自动生成任意测试平台，不综合、不烧录 FPGA。基础 `vhdl` 语言识别用于按钮入口；语法高亮和语言服务可以另装扩展。

## 开发与验证

无第三方运行时依赖；使用 CommonJS 和 Node 内建模块。运行 `npm test` 或 `node --test test/*.test.js`。`test/TEST-EVIDENCE.md` 记录测试先失败再通过的过程。测试使用真实短 Node 子进程验证阶段短路、取消和新波形；VS Code 适配测试只为不能在 Node 直接访问的宿主 API 提供轻量替身。

API：`validateConfig(data)`、`resolveProject(projectDir, data)`、`discoverSources(projectDir)`、`buildStageArgs(resolvedConfig, buildDir, wavePath)`、`runSimulation(options)`、`parseDiagnostics(output, projectDir)`、`resolveNvc(override)`，由 `src/core.js` 导出。`runSimulation` 返回 `{ wavePath, output, projectDir }`，失败抛错；支持 `AbortSignal`、`onOutput`、`onStage`。

真实 NVC、VS Code Extension Host 与官方 Surfer 的验收由独立测试负责，Node 单元测试本身不证明 UI 展示正确。
