# 自定义说明（Shine）

上游仓库：`281677160/build-actions`，本地 remote 名 `upstream`。
本文件只记录**本仓库相对上游改了什么**、**为什么这么改**、**同步上游后怎么补回来**。
上游没有同名文件，`git merge upstream/main` 时本文件不会冲突。

最后更新：2026-09-07

---

## 一、编译入口一览

| 入口 workflow | 编译文件夹 | 机型 / 配置 | 实际用的 diy 脚本 | 后台 IP | 定时 |
|---|---|---|---|---|---|
| `Immortalwrt.yml`（Immortalwrt-天灵） | `build/Immortalwrt` | 手动单选，默认 `x86_64`；定时默认 `x86_64`、`x86_64_250` | 分别为 `diy-part.sh`、`diy-part-250.sh` | 分别为 192.168.6.2、192.168.250.2 | 北京时间每周六 06:05（UTC 周五 22:05） |
| `compile.yml`（编译主程序） | `build/Immortalwrt` | 跟随阶段一 | 跟随机型 | — | 由 push 触发 |

Immortalwrt 只保留一个阶段一入口，cron 仍为 `05 22 * * 5`。同一分支用 workflow 级 `concurrency` 防止入口并发回写，`cancel-in-progress: false` 不取消正在运行的入口；一次运行内，`build` 的 `max-parallel: 1` 让配置逐个完成阶段一、分别触发阶段二，不代表两个阶段二也串行编译。

## 二、双网段与定时列表怎么工作

规则一句话：**机型名以 `_250` 结尾就用 `diy-part-250.sh`，否则用 `diy-part.sh`**。
`diy-part.sh` 在仓库中保留为 6 网段版本；选择 250 配置时若缺少 `diy-part-250.sh`，直接报错，不回落到 6 网段。

- 手动触发：只编译下拉框选中的一个配置，**不修改长期定时列表**。
- 定时触发：`plan` job 读取 `build/Immortalwrt/settings.ini` 的 `CONFIG_FILE`，生成 `build` 使用的 matrix。
- 阶段二 `compile.yml`：显式 checkout 触发该次运行的 `github.sha`，读取该提交中的 `build/Immortalwrt/relevance/settings.ini`，再由 `select` 选择 DIY，避免读到下一配置的新提交。

长期定时列表用空格分隔，默认配置示例：

```ini
CONFIG_FILE="x86_64 x86_64_250"
```

只长期编译一个时，改成 `CONFIG_FILE="x86_64"` 或 `CONFIG_FILE="x86_64_250"` 即可，不需要另建 workflow。源码分支由 `REPO_BRANCH` 单独选择，手动下拉保留新增的 `openwrt-25.12` 及既有选项；它是源码分支名，不是 `CONFIG_FILE` 配置名。

选择与还原逻辑统一在 `tools/immortalwrt-config.sh`，四个命令的职责如下：

| 命令 | 用途 |
|---|---|
| `matrix` | 为 `plan` 生成矩阵：手动取单个输入，定时取长期列表 |
| `prepare` | 在 `@mishi` 前备份原始配置，临时把 `settings.ini` 写成本轮单配置，并选用对应 DIY |
| `restore` | 在 `@mishi` 后把长期 `settings.ini` 与原版 `diy-part.sh` 还原到 `${COMPILE_PATH}` |
| `select` | 阶段二按 `relevance/settings.ini` 中的单配置选择 DIY，缺少所需脚本即失败 |

为什么阶段一要 checkout 最新分支，并在 `@mishi` **之前**切、**之后**还原：

- 每个配置开始准备时 checkout 当前分支最新提交，才能保留前一个配置已经回写的 seed；只限制 `max-parallel: 1`、却始终 checkout 最初的提交，仍会覆盖前一轮成果。

- `@mishi` 第一步就 `cp -Rf build operates`，随后 `source custom/first.sh` → `Diy_four` 把 `operates/Immortalwrt` 整个复制到 `/tmp/common/Immortalwrt`，把 `DIY_PT1_SH` 钉在那个副本上，同时把 `export` 行静态 grep 成 `diy2-part.sh`。**所以切换必须早于 mishi，运行时 source 别的脚本没用。**
- 真正被执行的是 `/tmp/common` 那份副本（`common.sh` 的 `Diy_partsh` 直接跑 `${DIY_PT1_SH}`），所以 mishi 之后把长期 `settings.ini` 和 6 网段原版 DIY 写回 `${COMPILE_PATH}` 不影响本次编译。
- `@trigger` 把 `${COMPILE_PATH}` 回写到 `build/Immortalwrt`：根目录保留长期列表与原版 DIY，`relevance/settings.ini` 则保留本轮单配置，供阶段二使用。手动选择或矩阵中的单个配置都不能把长期列表固化成单配置。

## 三、kucat 为什么需要「补回」步骤

上游 `common.sh` 的 `Diy_scripts` 拿主题名当 sed 模式，对 seed 跑了两次 `sed -i "/kucat/d"`，把这两项一起删掉：

- `CONFIG_PACKAGE_luci-app-kucat-config=y`
- `CONFIG_PACKAGE_luci-i18n-kucat-config-zh-cn=y`

之后只 `echo` 补回 `CONFIG_PACKAGE_luci-theme-kucat=y`。结果是主题在、配置插件丢。

两个主题变量**不能**改成 `0` 来绕开，它们各有用处：

- `Default_theme=kucat` → `Diy_definition` 才会把 `uci set luci.main.mediaurlbase='/luci-static/kucat'` 写进 `package/auto-scripts/files/99-first-run`。`99-*` 比各主题自带的 `30_*` 晚执行，才压得住 `luci-theme-bootstrap` 的 `30_luci-theme-bootstrap`（它会把默认主题改回 bootstrap）。
- `Mandatory_theme=kucat` → 才会把 luci / luci-light collection 的 `+luci-theme-*` 依赖改指 kucat。它要求 `grep -c "kucat=y" .config` **恰好为 1**；补回的两行是 `kucat-config=y`，不匹配 `kucat=y`，所以不影响这个判定。

所以做法是保留两个变量为 `kucat`，在 `@need` 之后补回：

- 阶段一补进 `${CONFIG_TXT}`（`@trigger` 会把它拷成新 seed，保证仓库 seed 一直带着）
- 阶段二补进 `.config` 并 `make defconfig`，然后核验主题、配置插件、语言包三项都为 `=y`，缺任一 `exit 1` 让编译当场失败，不静默放过

### 手动和定时双配置实测（2026-09-09）

- **手动选择单配置**：下拉框选 `x86_64` 或 `x86_64_250`，`tools/immortalwrt-config.sh matrix` 输出 `configs=["x86_64"]` 或 `["x86_64_250"]`，只编译选中的那个。
- **定时双配置**：周五 22:05 UTC（周六北京时间 06:05），`INPUT_CONFIG` 为空，脚本读取 `CONFIG_FILE="x86_64 x86_64_250"`，输出 `configs=["x86_64","x86_64_250"]`，两个配置并行编译（`max-parallel: 1` 保证准备阶段串行，防止覆盖 seed）。
- run #34344193695（`ac37582` 提交）成功，kucat 三包核验通过，固件正常产出。


## 四、相对上游改了哪些文件（含双配置定时与单网段切换）

**核心需求**：能手动选择 `x86_64` 或 `x86_64_250` 任一配置，也能定时自动编译两个配置；编译带 kucat 主题+配置插件并设为默认主题。

新增：

- `build/Immortalwrt/diy-part-250.sh` — 250 网段 diy 配置（`192.168.250.2`）
- `build/Immortalwrt/seed/x86_64_250` — 250 机型 seed
- `tools/immortalwrt-config.sh` — 矩阵生成、单配置准备、长期配置还原和 DIY 选择的统一实现（4 个命令：`matrix`/`prepare`/`restore`/`select`）
- `tools/apply-custom-steps.sh` — 同步上游后维护两个 workflow 的自定义结构
- `.github/workflows/clean-workflow.yml`、`keepalive.yml` — 自建
- `README-Shine.md` — 本文件

改动（**同步上游后要逐项补回，缺一不可**）：

| 文件 | 加了什么（按重要性排序） |
|---|---|
| `Immortalwrt.yml` | ① 新增 `plan` job（读取 `CONFIG_FILE` 生成 matrix）和动态 matrix 结构；② `concurrency` 同分支并发控制与 `max-parallel: 1`；③ 每个配置准备时 checkout 最新分支（`ref: ${{ github.ref }}`）；④ `@mishi` 前调用 `tools/immortalwrt-config.sh prepare`（临时单配置+选 DIY）；⑤ `@mishi` 后调用 `restore`（还原长期配置与原版 DIY）；⑥ `@need` 后的 kucat 补回步骤；⑦ 下拉保留 `x86_64_250` 和 `openwrt-25.12` 选项；⑧ 个人 `cron: 05 22 * * 5`、`INFORMATION_NOTICE: Telegram`、`KEEP_*: 30` |
| `compile.yml` | ① 显式 checkout `github.sha`（防阶段二读到新提交）；② `@mishi` 前调用 `select`（按 `relevance/settings.ini` 单配置选 DIY，缺脚本即失败）；③ `@need` 后的 `补回kucat配置插件并核验kucat必须存在`（三项齐全否则 `exit 1`） |
| `build/Immortalwrt/diy-part.sh` | 两个 kucat 插件源（`git clone`）、6 网段 IP（`192.168.6.2`）、`Mandatory_theme=kucat`、`Default_theme=kucat`、个性签名（`Op_name="Op-Shine"`） |
| `build/Immortalwrt/seed/x86_64` | kucat 三件套（`luci-theme-kucat`、`luci-app-kucat-config`、`luci-i18n-kucat-config-zh-cn`）等选包 |
| `build/Immortalwrt/settings.ini` | `CONFIG_FILE="x86_64 x86_64_250"` 作为默认长期定时列表（空格分隔，支持只填一个）；其他编译参数（`SOURCE_CODE`、`REPO_BRANCH`、通知开关等） |
| `.github/workflows/Mt798x.yml` | 只是默认机型/通知/cron 的默认值，与双配置逻辑无关 |

**关键依赖**：`Immortalwrt.yml` 的 7 处改动缺一项编译都会挂（尤其是 ①②③④⑤，它们构成双配置调度的完整链路）；`compile.yml` 的 ①② 缺了会读错提交或找不到 DIY 脚本。

`build/Immortalwrt/relevance/` 下的 `settings.ini` 和 `start` 是 CI 自动生成的，不手工修改；这里的 `CONFIG_FILE` 只记录该次单配置，不是长期定时列表。


## 五、同步上游代码：会不会覆盖我的改动

**不会。** git 要么自动合并（两边改动都保留），要么冲突停下来等你，**不存在静默用上游版本盖掉你的文件**。以 `Immortalwrt.yml` 为例：

| 情况 | 结果 |
|---|---|
| 上游没动这个文件 | 你的版本原样保留 |
| 上游动的地方离你改的地方远（隔 3 行以上） | **自动合并**，两边改动都在 |
| 上游动的地方和你改的地方重叠或紧邻 | **冲突**，git 停下来等你处理 |

旧结构的历史验证（`git merge-tree` 在内存里试合并，不碰工作区；不代表本次双配置调度已通过 CI）：

- 上游只改文件尾部、或在中段插新行 → **自动合并成功**，当时的自定义步骤和 `cron: 05 22 * * 5` 全在，上游改动也进来了
- 上游改 `runs-on` 或 `actions/checkout@v4` → **冲突**（前者紧邻自定义的 `if:` 行，后者正是插入锚点）

现在 `Immortalwrt.yml` 的定制还包括 `plan`、matrix、并发控制和 checkout，不能只检查旧的三个步骤。中途想放弃：`git merge --abort` 回到合并前。

### ⚠️ 别碰 GitHub 网页上的「同步复刻 / Sync fork」按钮

本仓库目前**领先上游 336 个提交、落后 0 个**。那个按钮在这种状态下有三种走向：

- 上游有新提交且能干净合并 → 点 `Update branch` 是安全的，等价于 `git merge upstream/main` 成功，你的提交都还在
- 有冲突 → 按钮做不了，GitHub 只会提示你去开 PR 解决，不会偷偷覆盖
- 旁边那个**放弃提交的选项**（措辞见过 `Discard commits` / `Discard changes`）→ 把你的仓库硬重置到上游，**336 个提交连同所有 seed、diy 脚本、workflow 定制一起销毁，网页端没有撤销**

这不是理论风险：GitHub 社区里多人这样丢过工作，有人丢了三个月的量，而官方文档里根本没写这个选项。见 [community/discussions/46271](https://github.com/orgs/community/discussions/46271)。

**结论：同步一律走命令行**，按本节下面的流程做。万一要用网页按钮，只许点 `Update branch`，看到 `Discard` 字样就直接关页面。

### 冲突文件分两类处理

**第一类：纯自己的配置** —— `build/Immortalwrt/` 下的 `diy-part.sh`、`diy-part-250.sh`、`seed/*`、`settings.ini`。
上游那边只是模板，这边是实际配置，直接保留自己的：

```bash
git checkout --ours build/Immortalwrt/diy-part.sh
git add build/Immortalwrt/diy-part.sh
```

保留后瞄一眼上游有没有加**新变量**，有就手工补进自己的脚本，别整段照抄：

```bash
MSYS_NO_PATHCONV=1 git show "upstream/main:build/Immortalwrt/diy-part.sh" | grep '^export'
```

**第二类：上游代码 + 我插入的步骤** —— `Immortalwrt.yml`、`compile.yml`。
这类**必须以上游新版为底**再把步骤插回去，不能拿旧版整文件覆盖，否则上游的修复就丢了：

```bash
git checkout --theirs .github/workflows/Immortalwrt.yml .github/workflows/compile.yml
bash tools/apply-custom-steps.sh
git add .github/workflows/
```

注意 `--theirs` 是**你主动选择**用上游版本，它会连带丢掉下面那张表里的个人设置，记得一并改回来。

保留 `tools/immortalwrt-config.sh` 和 `tools/apply-custom-steps.sh`；两个配置共用主入口，不再恢复独立的 250 workflow。

### 用 `git checkout --theirs` 之后，这几项个人设置要手工改回来

脚本维护 workflow 结构，不替你选择个人偏好；`Immortalwrt.yml` 里被上游版本盖掉后仍需核对的是：

| 位置 | 上游值 | 要改成 |
|---|---|---|
| `INFORMATION_NOTICE` 的 `default` | `'关闭'` | `'Telegram'` |
| 清理 workflows 保留数的 `default` | `'50'` | `'30'` |
| 文件中部的 `schedule` | 两行都被注释 | 取消注释并设 `cron: 05 22 * * 5` |
| `REPO_BRANCH` 的 `options` | 以上游当次内容为准 | 保留新增的 `openwrt-25.12` 及既有分支选项 |

**漏了 `schedule` 最要命**，会导致定时编译静默失效，合并后务必确认那两行没有 `#`。`build` 的条件也必须允许 `schedule`，不能仅依赖手动事件的 sender 判断；这属于补回脚本维护的结构，须用 `--check` 核对。cron 使用 UTC，上述时间对应北京时间每周六 06:05。

`compile.yml` 的 `branches`、`paths`、`matrix.target` **不用管**：上游 `@trigger` 每次跑阶段一都会用 `sed` 把这三处改成正确值再推回来，会自愈。

### tools/apply-custom-steps.sh

幂等，跑几次都不会重复插入。只维护 `Immortalwrt.yml`、`compile.yml` 两个 workflow，不依赖独立的 250 入口，也不修改 `settings.ini`、DIY 或 seed。维护范围包括 `plan`、并发控制、矩阵、checkout、调度兼容条件、`prepare` / `restore` / `select` 调用与原有 kucat 步骤。

```bash
bash tools/apply-custom-steps.sh           # 补回 workflow 结构
bash tools/apply-custom-steps.sh --check   # 只检查,缺东西时退出码1
```

脚本会尝试 YAML 校验；缺少 `npx` 时会提示跳过，不能视为解析已验证。若打印 `锚点没了!`，说明上游动了 workflow 结构（比如换掉 `@mishi`），这时别硬插，回头看第二、三节的原理再决定位置。

### 完整流程

```bash
git fetch upstream
git log --oneline HEAD..upstream/main          # 先看上游改了什么
git merge upstream/main                       # 有冲突按上面两类处理
bash tools/apply-custom-steps.sh --check
# 再按上表把 Immortalwrt.yml 的个人设置改回来
git commit
```

合并后自查（结构检查由脚本覆盖，配置偏好另行核对）：

1. `tools/immortalwrt-config.sh` 存在；`plan` 用 `matrix` 生成输出，`build` 消费该输出；两者均可随定时事件执行，手动仍只选一个配置。
2. 同分支 workflow `concurrency` 的 `cancel-in-progress: false`、`build` 的 `max-parallel: 1` 均保留，阶段一准备时 checkout 最新分支以保留前一配置的 seed。
3. `prepare` 在 `@mishi` **之前**，`restore` 在其**之后**，还原长期 `settings.ini` 和原版 DIY 到 `${COMPILE_PATH}`；阶段二不回写 `build/`，不需要还原。
4. `compile.yml` 显式 checkout `github.sha`，按该提交的 `relevance/settings.ini` 调用 `select`；250 脚本缺失时必须报错，不能静默回落。
5. 原有 `补回kucat...` 仍在 `@need` **之后**、`下载软件包` 之前；两个 workflow 都能被 `npx --yes js-yaml` 解析。
6. `CONFIG_FILE` 长期列表、`openwrt-25.12` 下拉选项、通知与保留数按需保留；cron 仍为 `05 22 * * 5`，即北京时间每周六 06:05。

### 典型失误案例：批量删除诊断步骤时误删关键步骤（2026-09-09）

**背景**：添加了 15 个诊断步骤用于排查 runner 失联，后续删除时用 `sed '/^    - name: 诊断-/,/^$/d'` 批量匹配"从诊断步骤到下一个空行"。

**失误**：诊断步骤后紧跟 `下载源码`，中间无空行，导致连同 `下载源码` 和 `公告` 也被删掉。症状是 `@need` 启动时 `$HOME_PATH` 目录不存在，直接报 `No such file or directory` 失败（run #34336441555）。

**正确做法**：逐个精确删除，每个诊断步骤固定 4-5 行（`- name: 诊断-xxx` / `timeout-minutes` / `uses: ./.github/actions/runner-checkpoint` / `with:` / `stage:`），用完整块匹配而非贪婪范围匹配。或先用 `git diff --stat` 确认删除影响，再用 `git show HEAD:文件 | grep -n "下载\|公告"` 核对关键步骤是否还在。

**教训**：批量修改 workflow 后必须检查 `下载源码`、`@mishi`、`@need`、`@trigger` 这 4 个关键 action 是否都在；单靠 YAML 语法检查发现不了步骤被删。


## 六、已知的坑

1. **seed 每次编译后会被 CI 覆盖。** `Diy_prevent` 用 `diffconfig.sh` 生成 `CONFIG_TXT`，`@trigger` 再把它拷成 `seed/<机型>`。手写进 seed 的选包会被重排，变成依赖项的会直接消失——`luci-theme-argon` 就是这样在提交 `7891e6e` 里没的。多配置阶段一还必须 checkout 最新分支，否则后一个配置可能覆盖前一个刚回写的 seed。
2. **判断插件包名要看被 clone 的那个分支。** `git clone` 不带 `-b` 取默认分支。`luci-app-kucat-config` 的 `master` 里 `NAME:=kucat-config` → 包名 `luci-app-kucat-config`；它还有条 `main` 分支写的是 `NAME:=kucat` → 包名会变成 `luci-app-kucat`，符号名就不一样了。
3. **推 workflow 改动不会触发编译。** `compile.yml` 只在 `build/Immortalwrt/relevance/start` 变化时触发；验证两个配置需分别手动选择，或等待定时按长期列表触发，单次手动运行不会遍历长期列表。
4. **长期列表与本轮配置不是同一份状态。** 长期设置只改 `build/Immortalwrt/settings.ini`；`relevance/settings.ini` 必须是本轮单配置。手动选择不能改掉长期列表，`restore` 也不能把列表写进 `relevance/settings.ini`。
5. **两个阶段的 checkout 策略不能互换。** 阶段一取最新分支是为了累积 seed；阶段二固定 `github.sha` 是为了读取与触发事件匹配的配置，不能追随分支最新提交。
6. **缺少 250 DIY 不是可以回落的情况。** 选择 `_250` 配置而缺少 `diy-part-250.sh` 必须失败，否则会把 250 配置错误编译成 6 网段。
7. **本地备份与记录不应提交。** `.gitignore` 已忽略 `BK/`、`memory/`、`tmp/`；提交仍应按真实改动选择文件，别用 `git add .` 混入协作中的其他改动。

验证边界：本次双配置调度重构尚未由 GitHub Actions 实跑验证；本地脚本检查和 YAML 解析不能代替两个配置的实际 CI 结果。
