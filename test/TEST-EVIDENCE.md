# 自动测试证据

运行时：`node`（v24.19.0）。

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

真实 NVC 验证生成的计数器时钟、复位、使能和泛型 unsigned/signed/boolean/positive 输入，测试专用断言检查了实际值。用户正常 VS Code 窗口中，对 `Exo1/mux21.vhd` 分别设置 A/B/SEL 时序，生成 `tb_mux21_inputs.vhd`、确认顶层配置后立即点击运行，生成 373 字节 FST。官方 Surfer 显示四个信号的波形；没有输出断言的生成文件显示 STIMULUS_DONE，而不是 TB_PASS。


## 0.2.2 独立波形窗口

先添加 waveform 模块的失败测试，再实现。43 项测试通过，覆盖精确波形 URI 的移动、并排设置、旧版本缺少命令的回退、窗口创建异常回退。使用用户正常 VS Code 运行 Exo1 后，Surfer 自定义编辑器出现在“窗口 2”中，Webview parentId=4，独立窗口显示 tb_a/tb_b/tb_sel/tb_y 实际波形，代码留在原窗口。默认配置为 newWindow。

## 0.3.0 工作流验收（2026-10-13）

- `node --test test/*.test.js`：60/60，通过；包含6项真实持续 NVC 会话验证、纯组合0时刻波形、finish/failure、force/noforce、段边界暂停，以及原有生成器和批处理回归。
- 真实批 NVC `--dump-arrays=16`：VCD出现 `memory[0][3:0]`、`memory[1][3:0]`。
- VS Code / 用户 Exo1：同一辅助编辑器中重跑换FST，tb_a、tb_b、tb_sel、tb_y保持；关闭重新打开恢复四信号；跨FST/VCD也保留选择。
- 真实GUI交互：同一会话100ns→强制tb_a=0→200ns波形变化→解除强制→按10ns连续运行→1190ns段边界暂停，按钮恢复可用；结束会话删除持续进程。
- 独立代码审查修复Surfer状态保存字段data及command_file桥接；协议回归测试通过。手动外部波形通过官方Surfer编辑器打开，不替换项目的运行记录。
- 交互实验补丁使用官方原生wave dumper，100段5ns与一次500ns事件区相同；纯0时刻init/force/noforce不制造假时间；构建脚本全新源码重建通过。
- Surfer资源由已安装官方0.7.1001488提供；自定义状态接口升级可能变化，版本变化自动丢弃旧布局。交互运行段太短且无时间推进时自动暂停，非源代码单步。

## 0.3.1 失效波形引用修复（2026-10-14）

- 根因：LoadState 恢复失效引用为 Placeholder，且旧 RON 中的 Wellen 数字编号属于旧文件；带缓存编号的旧 active_scope 可能被新文件错误识别为有效。
- 恢复前清除缓存编号，由完整路径重新解析；重绑 active_scope 时使用无缓存路径；保存前调用 RemovePlaceholders。字符串中的用户名称与注释不做替换。
- 三项桥接回归先失败后通过：清理失效引用并保留有效信号/游标/缩放/格式；缓存编号可移植且用户文本保持；手动恢复状态同样清理。
- 全部63项测试通过。
- 使用官方 Surfer 0.7.1001488 实际 WASM 和用户 Exo2 FST，独立浏览器中注入真实 RON（5个有效信号、1个失效信号、失效scope及旧数字编号）。恢复、重跑、再次打开三阶段均为5个有效信号、0个占位。真实页面结果 PASS。
- 用户正在编辑 Exo3，因此最后验收不操作其未保存文件。


## 0.4.0 Run All（2026-10-14）

- 在修改生产代码前新增配置/schema、命令适配、向导及生成器回归与真实批 NVC 验收。运行 `node --test test/core.test.js test/extension.test.js test/generate.test.js test/run-all-real.test.js`：48 项中 35 通过、13 失败。红灯对应 `all` 被旧校验和 schema 拒绝、Run All 注册/菜单缺失、新配置仍使用数字时长、向导尚无模式选择和数字默认值保留。原始本次开发日志 `/tmp/nvc-run-all-red.log`。
- 最小实现后，首轮 47/48 通过；剩余断言预期了错误的 NVC 完成提示。真实 NVC 输出为 `12ns+0: FINISH called`，据此修正测试的输出匹配，没有修改运行实现。
- 随后补充生成的周期时钟 TB 在 all 模式下仍于数字 duration 调用 finish 的验收。完整 `node --test test/*.test.js`：79/79 通过，0 失败、0 跳过。环境：Node v24.19.0，Homebrew NVC 1.23.0（LLVM 23.1.1）；既有6项真实交互 NVC 测试同样通过。
- 新真实批 NVC 测试证明：5ns 数字上限不会输出 12ns 的末尾 report，all 自然结束会输出；周期时钟由 12ns 的 finish 结束；无 finish 的周期时钟可取消且保留上次成功波形；生成器的时钟激励在 30ns 输出 STIMULUS_DONE 并 finish。
- 通过真正注册的 VS Code 命令适配器和真实 NVC 进程验证 Run All 后保存的数字配置字节不变，随后的普通 Run 再次按 5ns 截断；取消命令释放项目锁且保留显示波形记录，之后可重新运行；Run All 运行时断言失败报告诊断并保留原波形窗口记录。宿主 API 使用轻量替身，未把该测试当作实际 GUI 波形加载证明。
- 向导覆盖 all/数字稳定 id（改变 label 仍按 id 运行）、新配置默认 all、现有模式首项和数字输入默认值（含缺省字段仍为 1us）、模式/数字输入取消不写入；生成器覆盖新配置 all、已有 all 保持及数字上限按原规则提高/保留。
- 本次未改动交互分段运行实现；安装包和真实 VS Code / Surfer UI 验收由主任务负责。
