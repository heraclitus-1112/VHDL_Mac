# 自动测试证据

运行时：`/Users/macbookair/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`（v24.19.0）。

1. 在 `src/core.js` 尚不存在时编写核心测试，运行 `node --test test/core.test.js`：11 项失败，均为对应 API 缺失的断言；原始输出 `red-evidence.txt`。
2. 实现核心后初轮 9/11 通过。剩余两个断言因 macOS `/var` 与 `/private/var` 的真实路径不同；将 fixture 返回真实路径后保持实路径安全要求。
3. 在 `src/extension.js` 尚不存在时编写适配层测试，运行 `node --test test/extension.test.js`：5 项失败，均为 `createExtension` 缺失；原始输出 `red-extension-evidence.txt`。
4. 实现宿主适配后运行 `node --test test/core.test.js test/extension.test.js`：16/16 通过；输出 `green-evidence.txt`。

核心测试确实启动短 Node 子进程，并创建真实文件，覆盖顺序、参数中的空格、失败短路、旧波形不能返回、独立波形 URI、非自有文件保留、取消、缺少新波形、路径约束和诊断解析。宿主适配以最小 API 替身验证信任、同项目锁在保存前生效、只保存选中项目、保存失败停止、向导取消与显式顺序、配置符号链接不写入源文件。

未将自动测试通过等同于真实 VS Code 波形 UI 验收。

5. 自审新增真实 NVC 1.23 `> file.vhd:line` fixture、构建目录源文件别名、工作区外脏文件符号链接测试；运行 `node --test test/*.test.js` 出现 3 个对应断言失败（`red-boundaries-evidence.txt`）。先复现后修正：诊断去掉 `>` 标记，源文件禁止真实路径位于构建目录，保存前检查文件真实路径边界。
6. 最终 `node --test test/*.test.js`：20/20 通过（`green-evidence.txt`）。参数构造的既有库路径行为另加断言通过，其实现已由阶段顺序和参数测试先行覆盖。

自审：确认 manifest 版本、官方 Surfer 依赖与 exact viewType；core 没有 shell，输出只有本次独立 FST；构建与配置均拒绝符号链接危险路径；run 的项目锁在保存前同步占用，最终 Promise 等待打开命令。真实 UI 验收由父任务负责。

7. 规格审查提供实际 NVC assertion 输出，新增 `** Failure` 和 `Process/Procedure ... at file:line` 回归 fixture，另使用真实 Node 子进程验证 Warning 不阻止成功返回波形。修复前 3 项失败（`red-runtime-diagnostics-evidence.txt`）：Failure 未识别，调用帧前缀污染路径。
8. 将 Failure 归类为 error，提取运行时调用帧后的真实路径。最终 `node --test test/*.test.js`：23/23 通过（`green-evidence.txt`）；`node --check src/core.js` 与 `git diff --check` 通过。


## 0.2.0 自动生成输入激励

先添加 testbench/generate 模块与命令的失败测试，再实现；配置在确认期间外部修改的测试先失败，加入内容重检后通过。真实 NVC 初次验证发现中文 report 字符串不兼容，改为 ASCII STIMULUS_DONE 并保留中文注释后通过。

真实 NVC 验证生成的计数器时钟、复位、使能和泛型 unsigned/signed/boolean/positive 输入，测试专用断言检查了实际值。用户正常 VS Code 窗口中，对 `/Users/macbookair/exoC03/Exo1/mux21.vhd` 分别设置 A/B/SEL 时序，生成 `tb_mux21_inputs.vhd`、确认顶层配置后立即点击运行，生成 373 字节 FST。官方 Surfer 显示四个信号的波形；没有输出断言的生成文件显示 STIMULUS_DONE，而不是 TB_PASS。


## 0.2.2 独立波形窗口

先添加 waveform 模块的失败测试，再实现。43 项测试通过，覆盖精确波形 URI 的移动、并排设置、旧版本缺少命令的回退、窗口创建异常回退。使用用户正常 VS Code 运行 Exo1 后，Surfer 自定义编辑器出现在“窗口 2”中，Webview parentId=4，独立窗口显示 tb_a/tb_b/tb_sel/tb_y 实际波形，代码留在原窗口。默认配置为 newWindow。
