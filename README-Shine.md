# 自定义说明（Shine）

上游仓库：`281677160/build-actions`，本地 remote 名 `upstream`。
本文件只记录**本仓库相对上游改了什么**、**为什么这么改**、**同步上游后怎么补回来**。
上游没有同名文件，`git merge upstream/main` 时本文件不会冲突。

最后更新：2026-09-05

---

## 一、编译入口一览

| 入口 workflow | 编译文件夹 | 默认机型 | 实际用的 diy 脚本 | 后台 IP | 定时 |
|---|---|---|---|---|---|
| `Immortalwrt.yml`（Immortalwrt-天灵） | `build/Immortalwrt` | `x86_64` | `diy-part.sh` | 192.168.6.2 | 每周五 22:05 |
| `Immortalwrt -250.yml`（Immortalwrt-天灵-250） | `build/Immortalwrt` | `x86_64_250` | `diy-part-250.sh` | 192.168.250.2 | 已注释，只手动 |
| `compile.yml`（编译主程序） | `build/Immortalwrt` | 跟随阶段一 | 跟随机型 | — | 由 push 触发 |

两个手动入口的 `target` 都是 `Immortalwrt`，**别同时触发**，会并发 force-push 同一个路径。

## 二、双网段切换怎么工作

规则一句话：**机型名以 `_250` 结尾就用 `diy-part-250.sh`，否则用 `diy-part.sh`**。
`diy-part.sh` 永久是 6 网段版本，任何情况下都不会被 250 配置固化回仓库。

- 手动触发：读下拉框选的机型
- 定时触发：下拉框为空，回落读 `build/Immortalwrt/settings.ini` 的 `CONFIG_FILE=`（现在是 `x86_64` → 6 网段）
- 阶段二 `compile.yml`：读阶段一固化的 `build/Immortalwrt/relevance/settings.ini`

为什么必须在 `@mishi` **之前**切、`@mishi` **之后**还原：

- `@mishi` 第一步就 `cp -Rf build operates`，随后 `source custom/first.sh` → `Diy_four` 把 `operates/Immortalwrt` 整个复制到 `/tmp/common/Immortalwrt`，把 `DIY_PT1_SH` 钉在那个副本上，同时把 `export` 行静态 grep 成 `diy2-part.sh`。**所以切换必须早于 mishi，运行时 source 别的脚本没用。**
- 真正被执行的是 `/tmp/common` 那份副本（`common.sh` 的 `Diy_partsh` 直接跑 `${DIY_PT1_SH}`），所以 mishi 之后把 6 网段原版写回 `operates/Immortalwrt/diy-part.sh` 不影响本次编译。
- `@trigger` 把 `operates/Immortalwrt` force-push 回 `build/Immortalwrt`，还原步骤就是靠这一点保证仓库里的 `diy-part.sh` 始终是 6 网段。

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

## 四、相对上游改了哪些文件

新增：

- `.github/workflows/Immortalwrt -250.yml` — 250 手动入口
- `build/Immortalwrt/diy-part-250.sh` — 250 网段 diy 配置
- `build/Immortalwrt/seed/x86_64_250` — 250 机型 seed
- `.github/workflows/clean-workflow.yml`、`keepalive.yml` — 自建
- `README-Shine.md` — 本文件

改动（同步上游后要逐项补回）：

| 文件 | 加了什么 |
|---|---|
| `Immortalwrt.yml` | CONFIG_FILE 下拉加 `x86_64_250`；`@mishi` 前加 `选择本次编译使用的diy脚本`；`@mishi` 后加 `还原diy-part.sh`；`@need` 后加 `补回kucat配置插件到即将写入seed的配置` |
| `Immortalwrt -250.yml` | 同上三步（整个文件是新增的） |
| `compile.yml` | `@mishi` 前加 `选择本次编译使用的diy脚本`；`@need` 后加 `补回kucat配置插件并核验kucat必须存在` |
| `build/Immortalwrt/diy-part.sh` | 两个 kucat 插件源、6 网段 IP、`Mandatory_theme`/`Default_theme=kucat`、个性签名 |
| `build/Immortalwrt/seed/x86_64` | kucat 三件套等选包 |
| `build/Immortalwrt/settings.ini` | 自己的编译参数 |
| `.github/workflows/Mt798x.yml` | 只是默认机型/通知/cron 的默认值，与上面无关 |

`build/Immortalwrt/relevance/` 下的 `settings.ini` 和 `start` 是 CI 自动生成的，不用管。

## 五、同步上游代码：会不会覆盖我的改动

**不会。** git 要么自动合并（两边改动都保留），要么冲突停下来等你，**不存在静默用上游版本盖掉你的文件**。以 `Immortalwrt.yml` 为例：

| 情况 | 结果 |
|---|---|
| 上游没动这个文件 | 你的版本原样保留 |
| 上游动的地方离你改的地方远（隔 3 行以上） | **自动合并**，两边改动都在 |
| 上游动的地方和你改的地方重叠或紧邻 | **冲突**，git 停下来等你处理 |

已实测（`git merge-tree` 在内存里试合并，不碰工作区）：

- 上游只改文件尾部、或在中段插新行 → **自动合并成功**，3 个自定义步骤和 `cron: 05 22 * * 5` 全在，上游改动也进来了
- 上游改 `runs-on` 或 `actions/checkout@v4` → **冲突**（前者紧邻自定义的 `if:` 行，后者正是插入锚点）

本仓库对 `Immortalwrt.yml` 的改动散在 6 个区段（161 行的文件），所以冲突概率不低，但每次都只需处理冲突的那两三个文件。中途想放弃：`git merge --abort` 回到合并前。

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

`Immortalwrt -250.yml` 是本仓库独有的文件，上游没有，**永远不会冲突**。

### 用 `git checkout --theirs` 之后，这几项个人设置要手工改回来

脚本只补步骤，不管下面这些偏好值。`Immortalwrt.yml` 里被上游版本盖掉的是：

| 位置 | 上游值 | 要改成 |
|---|---|---|
| `INFORMATION_NOTICE` 的 `default` | `'关闭'` | `'Telegram'` |
| 清理 workflows 保留数的 `default` | `'50'` | `'30'` |
| 文件中部的 `schedule` | 两行都被注释 | 取消注释并设 `cron: 05 22 * * 5` |
| `jobs.build.if` | `${{ a }} == ${{ b }}`（写法有误） | `${{ a == b }}` |

**漏了 `schedule` 最要命**，会导致定时编译静默失效，合并后务必确认那两行没有 `#`。

`compile.yml` 的 `branches`、`paths`、`matrix.target` **不用管**：上游 `@trigger` 每次跑阶段一都会用 `sed` 把这三处改成正确值再推回来，会自愈。

### tools/apply-custom-steps.sh

幂等，跑几次都不会重复插入。只做 workflow 的结构性插入，不碰任何配置文件。

```bash
bash tools/apply-custom-steps.sh           # 补回缺失的步骤
bash tools/apply-custom-steps.sh --check   # 只检查,缺东西时退出码1
```

跑完自带 YAML 校验。若打印 `锚点没了!`，说明上游动了 workflow 结构（比如换掉 `@mishi`），这时别硬插，回头看第二、三节的原理再决定位置。

### 完整流程

```bash
git fetch upstream
git log --oneline HEAD..upstream/main          # 先看上游改了什么
git merge upstream/main                       # 有冲突按上面两类处理
bash tools/apply-custom-steps.sh --check      # 确认 9 项全在
# 再按上表把 Immortalwrt.yml 的个人设置改回来
git commit
```

合并后自查（前三条脚本已覆盖，列在这里是为了脚本报警时有依据）：

1. `选择本次编译使用的diy脚本` 在 `@mishi` **之前**
2. `还原diy-part.sh` 在 `@mishi` **之后**（`compile.yml` 不需要这步，阶段二不回写 `build/`）
3. `补回kucat...` 在 `@need` **之后**、`下载软件包` 之前
4. 三个 workflow 都能被 `npx --yes js-yaml` 解析


## 六、已知的坑

1. **seed 每次编译后会被 CI 覆盖。** `Diy_prevent` 用 `diffconfig.sh` 生成 `CONFIG_TXT`，`@trigger` 再把它拷成 `seed/<机型>`。手写进 seed 的选包会被重排，变成依赖项的会直接消失——`luci-theme-argon` 就是这样在提交 `7891e6e` 里没的。
2. **判断插件包名要看被 clone 的那个分支。** `git clone` 不带 `-b` 取默认分支。`luci-app-kucat-config` 的 `master` 里 `NAME:=kucat-config` → 包名 `luci-app-kucat-config`；它还有条 `main` 分支写的是 `NAME:=kucat` → 包名会变成 `luci-app-kucat`，符号名就不一样了。
3. **推 workflow 改动不会触发编译。** `compile.yml` 只在 `build/Immortalwrt/relevance/start` 变化时触发，改完 workflow 得手动跑一次入口。
4. **仓库没有 `.gitignore`**，`BK/`、`memory/`、`tmp/` 都没被拦住，别用 `git add .`。
