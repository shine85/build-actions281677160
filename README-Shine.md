# 自定义说明（Shine）

上游仓库：`281677160/build-actions`，本地 remote 名 `upstream`。
本文件只记录**本仓库相对上游改了什么**、**为什么这么改**、**同步上游后怎么补回来**。
上游没有同名文件，`git merge upstream/main` 时本文件不会冲突。

最后更新：2026-09-13

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
- 阶段一通过本库 `immortalwrt-mishi` 适配器将 `matrix.config_file` 显式传给准备动作，防止原始输入覆盖矩阵选出的配置；阶段二仍从触发提交的 relevance 读取单配置。

临时双配置验收入口及其快捷分支已在实跑通过后移除。正式手动入口保持单配置选择，定时入口按长期列表运行。

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

所以保留两个变量为 `kucat`，在两阶段的 `@need` 之后统一调用 `tools/immortalwrt-plugins.cjs`：

- 先补回 `.config` 中的 kucat 三包，再执行 `make defconfig`，检查仓库原始 seed 明确选择的全部 LuCI 应用和主题。缺包立即失败，不能以两个阶段都丢包为由判定一致。
- 阶段一生成 `${CONFIG_TXT}` 时保留这些显式请求，再由 `@trigger` 写回 seed；阶段二复用校验，不回写 seed。
- 对 DIY 克隆的 kucat 源码，修复已核实的 ACL JSON 末尾多余括号。只接受已知原件的 SHA-256；上游修正后的合法 JSON 保持原样，其他 JSON 错误明确报错。

### 备用主题 Argon

`x86_64` 与 `x86_64_250` 两套 seed 均启用 `CONFIG_PACKAGE_luci-theme-argon=y`，沿用上游已有的 Argon 源码。`Mandatory_theme` 和 `Default_theme` 继续设为 `kucat`，首次启动时由 `99-first-run` 最后设置默认主题；Argon 作为备用主题保留在选择列表中。

刷入包含本次配置的新固件后，在「系统 → 系统 → 语言和界面」中选择 **Argon**，保存并应用即可切换；选择 **kucat** 可切回原主题。两阶段插件校验会检查 Argon 是否进入最终配置，并在生成 seed 时保留这项显式选择。

### 手动与矩阵验证（2026-09-09）

- **手动选择单配置**：下拉框选 `x86_64` 或 `x86_64_250`，`tools/immortalwrt-config.sh matrix` 输出 `configs=["x86_64"]` 或 `["x86_64_250"]`，只编译选中的那个。
- **定时双配置**：周五 22:05 UTC（周六北京时间 06:05），`INPUT_CONFIG` 为空，脚本读取 `CONFIG_FILE="x86_64 x86_64_250"`，输出 `configs=["x86_64","x86_64_250"]`，两个配置并行编译（`max-parallel: 1` 保证准备阶段串行，防止覆盖 seed）。
- run #34344193695（`ac37582` 提交）成功，kucat 三包核验通过，固件正常产出。

### 在线更新、依赖与清理修复（2026-09-12）

两个 workflow 在 `@mishi` 后执行 `tools/prepare-immortalwrt.sh`；阶段一先完成 `restore`。该工具检查 `KEEP_RELEASES`、`KEEP_WORKFLOWS` 为非负整数，再对已下载的上游副本应用 `tools/patches/immortalwrt-common.patch`。整份补丁先检查再应用，上游上下文变化时明确失败。

这里的 mishi 使用 `.github/actions/immortalwrt-mishi`，基于上游 `7f54c8c5de614a14fbd518879171f36e3989d047` 固定版本。仅增加显式 `config_file` 输入并替换手动分支的配置取值，其余上游准备步骤保留；更新此副本时需对照 `tests/fixtures/common/mishi.yml` 和输入链路测试。

所有工作流的 `actions/checkout` 统一固定到 `3d3c42e5aac5ba805825da76410c181273ba90b1`（v7.0.1，Node.js 24），消除 v4 的 Node.js 20 弃用提示。官方要求 Runner 至少 2.327.1，Docker action 内使用认证 Git 命令需至少 2.329.0；本次实际使用的 2.337.0 满足要求。补回工具会先升级各工作流中的旧 v4 引用，再用同一固定版本生成规划任务并定位 checkout 的 `ref` 插入位置。

在线更新在 `upgrade.sh` 生成元数据的位置统一加入 `CONFIG_FILE`，硬件目标 `TARGET_PROFILE` 保持原值：

| 配置 | 更新通道 | 固件内更新匹配标识 |
|---|---|---|
| `x86_64` | [Update-x86-x86_64](https://github.com/shine85/build-actions281677160/releases/tag/Update-x86-x86_64) | `x86-64-x86_64` |
| `x86_64_250` | [Update-x86-x86_64_250](https://github.com/shine85/build-actions281677160/releases/tag/Update-x86-x86_64_250) | `x86-64-x86_64_250` |

Legacy、UEFI 的发布文件名、固件版本、下载通道和旧资产清理前缀均由同一标识生成。旧固件可能仍指向原来的 `Update-x86` 共用通道，网页在线更新没有 6/250 配置选择框；需要按下面的步骤迁移。仓库中的修改不会自动改写已经安装的系统。

#### 已安装旧系统：SSH 修改更新目标

本节适用于本仓库的 **ImmortalWrt x86-64 固件**，机内须已有 `/usr/bin/AutoUpdate` 和 `/etc/openwrt_update`。第三方固件或没有这些文件的系统，使用后面的本地刷写方式，不要只创建一个同名文件冒充更新器。

先 SSH 登录当前路由器，查看系统、更新设置和实际引导方式：

```sh
cat /etc/openwrt_release
grep -E '^(GITHUB_LINK|FIRMWARE_VERSION|LUCI_EDITION|SOURCE|DEVICE_MODEL|RELEASE_DOWNLOAD)=' /etc/openwrt_update
if [ -d /sys/firmware/efi ]; then echo uefi; else echo legacy; fi
```

确认 `SOURCE="Immortalwrt"`，`GITHUB_LINK="https://github.com/shine85/build-actions281677160"`。网页的 GitHub 地址框应填仓库首页，不填 Release 页面；如果要修改仓库地址，先在 AutoUpdate 页面保存，避免其 UCI 设置随后覆盖文件中的地址。

更改更新目标前关闭定时更新，备份配置，并把备份下载到电脑；`/tmp` 中的备份重启后会消失：

```sh
uci set autoupdate.@login[0].enable='0'
uci commit autoupdate
/etc/init.d/autoupdate stop
sysupgrade -b /tmp/openwrt-before-upgrade.tar.gz
```

例如，在电脑终端执行 `scp root@192.168.250.2:/tmp/openwrt-before-upgrade.tar.gz .`，地址替换为当前实际管理地址。

**实际要修改的是 `/etc/openwrt_update` 中的三项：** `DEVICE_MODEL` 选择 6/250 配置，`RELEASE_DOWNLOAD` 选择对应下载通道，`LUCI_EDITION` 选择目标系统系列。`FIRMWARE_VERSION` 是本机真实版本与编译时间戳，必须保留，不要为强行升级改成 `0` 或其他版本。

下面以 **250 配置、目标 24.10** 为例。6 配置将变量改成 `UPGRADE_CONFIG="x86_64"`；升级 25.12 将变量改成 `UPGRADE_SERIES="25.12"`。这段只修改更新设置，不刷写固件：

```sh
(
  set -eu
  UPGRADE_CONFIG="x86_64_250"
  UPGRADE_SERIES="24.10"
  case "$UPGRADE_CONFIG" in x86_64|x86_64_250) ;; *) exit 1 ;; esac
  case "$UPGRADE_SERIES" in 23.05|24.10|25.12) ;; *) exit 1 ;; esac
  update_file=/etc/openwrt_update
  for key in DEVICE_MODEL RELEASE_DOWNLOAD LUCI_EDITION; do
    grep -q "^${key}=" "$update_file" || { echo "缺少字段：$key"; exit 1; }
  done
  backup_file="${update_file}.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$update_file" "$backup_file"
  sed -i \
    -e "s|^DEVICE_MODEL=.*|DEVICE_MODEL=\"x86-64-${UPGRADE_CONFIG}\"|" \
    -e "s|^RELEASE_DOWNLOAD=.*|RELEASE_DOWNLOAD=\"\$GITHUB_LINK/releases/download/Update-x86-${UPGRADE_CONFIG}\"|" \
    -e "s|^LUCI_EDITION=.*|LUCI_EDITION=\"${UPGRADE_SERIES}\"|" \
    "$update_file"
  printf '原设置已备份到 %s\n' "$backup_file"
  grep -E '^(GITHUB_LINK|FIRMWARE_VERSION|LUCI_EDITION|SOURCE|DEVICE_MODEL|RELEASE_DOWNLOAD)=' "$update_file"
)
```

只改 `LUCI_EDITION` 不会自动升级系统；只改下载地址而不改 `DEVICE_MODEL`，也无法正确匹配新文件名。修改后清除旧索引，再检测候选固件：

```sh
rm -f /tmp/api_version
AutoUpdate
```

这里不带参数的 `AutoUpdate` 会联网检查，不执行固件下载和刷写。确认输出的“固件全名称”同时符合目标系列、配置和实际引导方式，例如 `24.10-Immortalwrt-x86-64-x86_64_250-<时间戳>-uefi-<校验串>.img.gz`。目标通道必须已经发布对应镜像；没有候选、配置不符或引导方式不符时不要升级。

#### 23→24、24 同系列更新、24→25

| 当前系统 → 目标 | `LUCI_EDITION` 目标值 | 配置与通道 | 配置保留建议 |
| --- | --- | --- | --- |
| 23.05 → 24.10 | `24.10` | 保持原来的 6 或 250 配置 | 建议备份后不保留配置，按需恢复插件设置 |
| 24.10 → 最新 24.10 固件 | `24.10`，已正确则不用改 | 保持原配置、原独立通道 | 可保留配置；首次迁移旧网络缺陷时建议不保留 |
| 24.10 → 25.12 | `25.12` | 保持原来的 6 或 250 配置 | 建议不保留配置；25.12 从 opkg 改用 APK，额外安装的软件需重新确认 |

跨系列升级时，推荐从对应通道下载匹配的 `.img.gz`，在「系统 → 备份/升级 → 刷写固件」上传，关闭“保留配置”并核对镜像检查结果。网络修复只在首次生成配置时执行，保留旧 `/etc/config/network` 不会自动修正旧网关、DNS 或桥接设置；配置备份用于逐项恢复，不要跨系列直接还原整个旧配置包。

同系列日常更新可在 AutoUpdate 页面核对候选后点升级，也可在 SSH 中选择下面**其中一个**命令。它们会实际下载、刷写并重启，请在备份完成且可接受断网时执行：

```sh
AutoUpdate -u   # 保留配置更新
AutoUpdate -k   # 不保留配置更新
```

当前上游 AutoUpdate 最终使用 `sysupgrade -F`，因此跨系列优先使用上面的本地上传检查方式。它比较的是固件的**编译时间戳**：即使目标是 25.12，若目标镜像的编译时间戳早于本机固件，也会显示“云端低于本机”并退出；此时下载目标镜像本地刷写，不要伪造 `FIRMWARE_VERSION`。

需要全程 SSH 本地刷写时，在电脑上把已下载且匹配配置/引导的镜像上传为 `/tmp/firmware.img.gz`，再在路由器执行：

```sh
sha256sum /tmp/firmware.img.gz
sysupgrade -T /tmp/firmware.img.gz
```

核对 SHA-256 与对应 CI 验收报告一致，且 `-T` 检查成功后，再单独执行：

```sh
sysupgrade -n /tmp/firmware.img.gz
```

`-T` 只检查镜像；`-n` 才是不保留配置的刷写。检查失败就停止，不添加 `-F` 强行绕过。23.05→24.10、24.10→25.12 的上游迁移说明分别见 [OpenWrt 24.10](https://openwrt.org/releases/24.10/notes-24.10.0#upgrading_to_2410) 和 [OpenWrt 25.12](https://openwrt.org/releases/25.12/notes-25.12.0#upgrading_to_2512)；OpenWrt 官方不支持直接 23.05→25.12 的 sysupgrade，本仓库按逐级升级说明操作。

#### 升级后与后续日常更新

不保留配置时，6 配置从 `192.168.6.2` 登录，250 配置从 `192.168.250.2` 登录。重新检查 `/etc/openwrt_release`、上述三项更新字段，以及实际 LAN 网关/DNS；新固件应自带自己的系列和独立通道。后续 **24.10 更新 24.10** 或 **25.12 更新 25.12** 不用每次 SSH 改文件，直接检测并更新；切换系统系列才修改 `LUCI_EDITION`，切换 6/250 才同时修改设备标识和通道。

恢复需要的插件配置、确认系统正常后，再按个人需要启用定时更新。这里的“最新包”指本仓库新编译的整套固件；额外手工安装的软件不会仅凭配置备份保留，升级后使用当前系列的软件源重新安装。

#### 发布与校验实现

发布改用本仓库的 `.github/actions/immortalwrt-release`：上传固件和上传索引都显式要求上传错误使任务失败；`tools/immortalwrt-release.cjs` 逐一核对远端固件状态、大小和 SHA-256，全部符合本地文件后才生成 `zzz_api`。旧固件清理只操作相同配置、源码版本与引导格式，保留最近一份旧版；权限、删除、查询失败均会传播，只有新通道尚不存在的明确 404 允许首次创建。

发布标题直接显示网段与配置，例如 `AutoUpdate-x86 · 192.168.6.0/24 · x86_64` 和 `AutoUpdate-x86 · 192.168.250.0/24 · x86_64_250`。发布说明包含北京时间、网段、默认管理地址、网关，以及实际编入固件的 LuCI 插件和主题名称。

`compile.yml` 在编译成功后、整理删除清单前生成说明：插件来自本次输出目录的唯一 `.manifest`，x86 的网段、管理地址和网关来自实际启动验收，并再次核对镜像 SHA-256；DIY 用于核对预期值。日期记录实际 `make` 成功结束的时间。插件列表不使用 seed 推测，不混入语言包和底层依赖；清单异常、验收未完成或镜像发生变化时明确失败。非 x86 保留原有说明逻辑。两次发布共用同一标题和说明，更新通道及固件文件名沿用前述匹配规则。同步上游后的补回工具会恢复验收和说明步骤，并保证它们位于清单清理之前。

环境部署直接执行修复后的 `${LINSHI_COMMON}/custom/ubuntu.sh`，补齐依赖列表丢失的续行符，移除已经 404 的重复短链安装入口；依赖安装失败立即结束。`KEEP_RELEASES="30"` 与 `KEEP_WORKFLOWS="30"` 均须保留有效设置，入口清理、固件整理和云端发布失败也会使任务失败。

`build/Immortalwrt/patches/001-kconfig-reciprocal-conflicts.patch` 在首次 `make defconfig` 前修正 Kconfig 生成器：虚包 `select` 和相互冲突的去重共用同一 provider 顺序，避免默认变体的条件选择重新形成反向依赖。recipe 和原始包元数据中的双向冲突不变，保留 Nikki 与两个 Mihomo 变体。修复后的 23.05、24.10、25.12、master 生成器已通过真实 Kconfiglib 的 28 个场景、756 组状态验证。该补丁负责 Kconfig 依赖关系；23.05/24.10 的 opkg 与 25.12 的 APK 兼容由首次启动适配和运行验收覆盖，六组合实跑结果见下方。

可重复检查：

```bash
node --test tests/immortalwrt-build.test.cjs tests/immortalwrt-kconfig.test.cjs tests/immortalwrt-workflow.test.cjs tests/immortalwrt-release.test.cjs tests/immortalwrt-release-description.test.cjs tests/immortalwrt-mishi.test.cjs
bash tools/apply-custom-steps.sh --check
actionlint .github/workflows/Immortalwrt.yml .github/workflows/compile.yml
```

9 月 12 日旧版定时入口 `34659837575` 已真实完成两套编译。新修复的完整实跑结果见下方；实机启动未验证。cron 仍为北京时间每周六 06:05；[GitHub 官方说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)明确定时事件可能延迟或丢弃，仓库配置不能保证精确到点，9 月 12 日旧版实际在 07:55 触发。

### 24.10 编译与产物核对（2026-09-13）

修复提交 `a15074d` 已推送，当时通过临时双配置入口触发了一次关闭通知的验收（该临时入口现已撤下）。[准备入口 #150](https://github.com/shine85/build-actions281677160/actions/runs/34702805888) 与两套独立编译均为 `completed/success`：

| 配置 | 编译配置中的 IP / 网关 | 独立编译 | 完成时间（北京时间） |
|---|---|---|---|
| `x86_64` | `192.168.6.2` / `192.168.6.1` | [#149](https://github.com/shine85/build-actions281677160/actions/runs/34703045031) | 9 月 13 日 00:32 |
| `x86_64_250` | `192.168.250.2` / `192.168.250.1` | [#150](https://github.com/shine85/build-actions281677160/actions/runs/34703263236) | 9 月 13 日 00:37 |

两份完整 artifact 均已下载并核对 SHA-256；解包确认 kucat 主题、配置插件、中文包及其清单文件齐全，`99-first-run` 包含默认主题设置。四个 Legacy/UEFI 发布镜像与 artifact 内文件一致，各通道 `zzz_api` 的哈希和资产记录一致；使用固件自带的实际匹配语句验证后，两个配置都只选中自身镜像。

43 项本地回归通过。三份完整日志未再出现此前的清理空参数、依赖安装错误、下载 404、Mihomo 递归依赖或 make 失败记录。长期双配置列表和 6 网段原版 DIY 保持，通知仅在本次验收关闭。

发布说明实现 `7ca7f18` 随后通过了 [准备入口 #151](https://github.com/shine85/build-actions281677160/actions/runs/34740140679) 的编译验收：[6 网段编译](https://github.com/shine85/build-actions281677160/actions/runs/34740345460) 和 [250 网段编译](https://github.com/shine85/build-actions281677160/actions/runs/34740553558) 均成功。CI 自动生成发布说明，8 个 LuCI 插件及 kucat 主题与两份 rootfs 的软件包清单一致，四种 Legacy/UEFI 在线更新匹配均选中自身配置。当时说明中的网络字段来自 DIY，不能证明启动后已生效。正式入口移除测试选项后，仍以实际矩阵步骤验证手动单选、定时双配置及同步上游后的补回行为。

### 新旧版本兼容与启动验收（2026-09-14）

**23.05、24.10、25.12 × 6/250 六种组合已全部完成重新编译、双引导运行验收和发布，六份 CI 均为 `completed/success`，包括发布后的 Post 步骤。** 实际运行内核与完整 CI 记录如下：

| 系列 | 实际内核 | 包管理器 | 6 配置 `x86_64` | 250 配置 `x86_64_250` |
| --- | --- | --- | --- | --- |
| 23.05 | `5.15.198` | opkg | [通过](https://github.com/shine85/build-actions281677160/actions/runs/34838738970) | [通过](https://github.com/shine85/build-actions281677160/actions/runs/34839217681) |
| 24.10 | `6.6.151` | opkg | [通过](https://github.com/shine85/build-actions281677160/actions/runs/34855869752) | [通过](https://github.com/shine85/build-actions281677160/actions/runs/34856572816) |
| 25.12 | `6.12.103` | APK | [通过](https://github.com/shine85/build-actions281677160/actions/runs/34848287151) | [通过](https://github.com/shine85/build-actions281677160/actions/runs/34849896829) |

六份独立运行报告和 12 个发布镜像均已实际下载并核对 SHA-256。两个更新通道最终的 `zzz_api` 已核对资产 ID、大小、哈希和下载地址；原样执行固件更新器的选包语句，三版本、两配置、两引导共 12 次都选中各自镜像。六份准备日志和六份编译日志均已检查，所查既有错误为 0。长期默认仍为 `openwrt-24.10`，两个配置的 seed 已回到本轮实际构建使用的 24.10 版本。

此前 [25.12 实跑](https://github.com/shine85/build-actions281677160/actions/runs/34758596276) 虽然编译成功，实际镜像缺少预期网关、DNS、关闭 DHCP 和去桥接设置，功能验收未通过。根因是旧补丁依赖 `config_generate` 的特定行格式，未命中也继续编译；本轮已由下面的统一配置入口修复。

网络修改统一到 `tools/immortalwrt-network.cjs` 和 `tools/immortalwrt-lan-defaults.sh`：在首次生成 network 的分支末尾执行 UCI 收尾，兼容 23.05/24.10 的独立地址/掩码与 25.12 的 CIDR 地址；已有网络配置保持原样。去桥接依据实际 LAN 设备和端口，多端口、共享桥或桥接 VLAN 必须明确处理，不能擅自丢弃端口。未知上游结构、无效或重复配置会中止编译。首次启动补丁同时修正 APK/opkg 相关命令、旧 LuCI 页面修改，以及可选 IPv6 键的删除和关键写入失败传播。

x86 在发布前用 QEMU 分别启动本次 Legacy、UEFI 镜像，等待首次初始化和一次性重启结束，再验收实际 IPv4 地址、掩码、默认路由、DNS、DHCP 设置、LAN 下层桥接关系、首次启动脚本完成状态、所选 IPv6 模式、dnsmasq/uhttpd 服务、LuCI 登录页与 kucat 样式、实际安装的 LuCI 插件/主题。任一项失败会阻止后续发布；这些检查不改变已经安装在旧机器上的网络和升级地址。

插件验收调用原生配置生成器及真实核心：HomeProxy、Nikki 在回环网络转发固定响应，FRPC 验证配置解析和受控拒连，防火墙检查实际规则；同时检查定时重启配置生成、kucat 配色应用、包管理查询和各应用的认证页面/资源。23.05 允许原生 `luci-app-opkg` 名称和旧 FRPC 的启动解析方式。AutoUpdate 主表单有远端检查副作用，因此仅检查只读状态入口。测试不安装重启任务，不执行刷写；报告明确保留真实浏览器操作、外部订阅、透明代理和 FRPC 远端隧道未测状态。

验收报告通过 `IMMORTALWRT_RUNTIME_REPORT` 独立写到项目 `tmp/immortalwrt-runtime-verification.json`，以 `firmware-runtime-<配置>-<版本>-attempt-<运行尝试次数>` 单独上传到 Actions artifact，成功、失败和重跑都会保留独立证据。报告按编译时原始镜像名和 SHA-256 记录观测，避开上游的文件改名、全文替换及清理；发布镜像可以用 SHA-256 对应到报告。报告含失败记录、缺少完成时间或与镜像不匹配时，不允许用于生成发布说明。

失败报告在 `failure.serial` 中保留完整脱敏串口；编译成功且启用 `UPLOAD_FIRMWARE` 的 x86 失败任务还会把原始 SquashFS 镜像和 manifest 上传为 `firmware-debug-<配置>-<版本>-attempt-<运行尝试次数>`，保留 3 天，后续发布仍被阻止。

CI 旧版 QEMU 曾在暖重启后的 GRUB 内存搬移阶段极慢，`tools/immortalwrt-runtime.cjs` 已将 TCG 缓存固定为 `64 MiB`。同盘对照、原失败镜像的 Legacy/UEFI 复验和上述六组新 CI 均已验证该设置；启动超时和功能验收标准保持原值。

当前验收边界：上述六组均使用本轮重新编译的真实产物，每份镜像经历首次初始化及自动重启，并完成网络、基础服务、8 个应用及 kucat 的本机功能与页面检查。尚未进行实机刷写或跨系列升级实测；QEMU 结果不代替真实网卡、上游 IPv6 服务、真实浏览器交互或各插件外部业务连接的实测。


## 四、相对上游改了哪些文件（含双配置定时与单网段切换）

**核心需求**：能手动选择 `x86_64` 或 `x86_64_250` 任一配置，也能定时自动编译两个配置；编译带 kucat 主题+配置插件并设为默认主题。

新增：

- `build/Immortalwrt/diy-part-250.sh` — 250 网段 diy 配置（`192.168.250.2`）
- `build/Immortalwrt/seed/x86_64_250` — 250 机型 seed
- `tools/immortalwrt-config.sh` — 矩阵生成、单配置准备、长期配置还原和 DIY 选择的统一实现（4 个命令：`matrix`/`prepare`/`restore`/`select`）
- `tools/apply-custom-steps.sh` — 同步上游后维护两个 workflow 的自定义结构
- `tools/prepare-immortalwrt.sh`、`tools/patches/immortalwrt-common.patch` — 上游副本的更新标识、依赖与补丁失败传播修复
- `tools/immortalwrt-network.cjs`、`tools/immortalwrt-lan-defaults.sh` — 新旧网络生成器的统一 UCI 配置入口
- `tools/immortalwrt-runtime.cjs`、`tools/immortalwrt-runtime-probe.sh`、`tools/immortalwrt-verification.cjs` — 双引导启动、实际观测、镜像哈希与报告校验
- `.github/actions/immortalwrt-release/action.yml`、`tools/immortalwrt-release.cjs` — 上传失败传播、远端产物校验与索引生成
- `.github/actions/immortalwrt-mishi/action.yml` — 固定上游准备动作，并显式接收矩阵配置
- `build/Immortalwrt/patches/001-kconfig-reciprocal-conflicts.patch` — Kconfig 相互冲突消环
- `tests/` — 使用固定上游夹具的行为回归测试
- `.github/workflows/clean-workflow.yml`、`keepalive.yml` — 自建
- `README-Shine.md` — 本文件

改动（**同步上游后要逐项补回，缺一不可**）：

| 文件 | 加了什么（按重要性排序） |
|---|---|
| `Immortalwrt.yml` | ① 新增 `plan` job（读取 `CONFIG_FILE` 生成 matrix）和动态 matrix 结构；② `concurrency` 同分支并发控制与 `max-parallel: 1`；③ 每个配置准备时 checkout 最新分支（`ref: ${{ github.ref }}`）；④ `@mishi` 前调用 `tools/immortalwrt-config.sh prepare`（临时单配置+选 DIY）；⑤ `@mishi` 后调用 `restore`（还原长期配置与原版 DIY）；⑥ `@need` 后的 kucat 补回步骤；⑦ 下拉保留 `x86_64_250` 和 `openwrt-25.12` 选项；⑧ 个人 `cron: 05 22 * * 5`、`INFORMATION_NOTICE: Telegram`、`KEEP_*: 30` |
| `compile.yml` | ① 显式 checkout `github.sha`；② `@mishi` 前调用 `select`；③ `@need` 后核验 kucat 三包；④ `@mishi` 后应用上游修复，并执行修复后的部署脚本；⑤ 记录编译完成时间，发布前验收双引导并单独保存报告；⑥ 严格传播固件整理错误，使用本库可校验产物的发布动作 |
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
- 上游改 `runs-on` 或 checkout 步骤 → **冲突**（前者紧邻自定义的 `if:` 行，后者正是插入锚点）

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

幂等，跑几次都不会重复插入。结构补回只维护 `Immortalwrt.yml`、`compile.yml` 两个 workflow，另会统一升级仓库各工作流中的 checkout v4 引用；不依赖独立的 250 入口，也不修改 `settings.ini`、DIY 或 seed。维护范围包括 `plan`、并发控制、矩阵、checkout、调度兼容条件、`prepare` / `restore` / `select` 调用、原有 kucat 步骤，以及上游修复调用、部署脚本路径、编译时间、启动验收、独立报告上传和关键步骤失败传播。辅助脚本与两份补丁缺失时，检查必须失败；`--check` 发现旧 checkout 运行时也会失败，且不修改文件。

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
7. 两个入口均在 `@mishi` 后调用 `prepare-immortalwrt.sh`；部署执行修复后的本地上游副本，整理以 `bash -e` 执行，发布使用本库 action；清理和上传不忽略失败，两个补丁及发布校验脚本仍存在。
8. x86 的启动验收和报告上传位于固件整理之前；验收报告保存在独立路径，发布说明读取同一份报告；QEMU、OVMF 依赖和探针脚本齐全。

### 典型失误案例：批量删除诊断步骤时误删关键步骤（2026-09-09）

**背景**：添加了 15 个诊断步骤用于排查 runner 失联，后续删除时用 `sed '/^    - name: 诊断-/,/^$/d'` 批量匹配"从诊断步骤到下一个空行"。

**失误**：诊断步骤后紧跟 `下载源码`，中间无空行，导致连同 `下载源码` 和 `公告` 也被删掉。症状是 `@need` 启动时 `$HOME_PATH` 目录不存在，直接报 `No such file or directory` 失败（run #34336441555）。

**正确做法**：逐个精确删除，每个诊断步骤固定 4-5 行（`- name: 诊断-xxx` / `timeout-minutes` / `uses: ./.github/actions/runner-checkpoint` / `with:` / `stage:`），用完整块匹配而非贪婪范围匹配。或先用 `git diff --stat` 确认删除影响，再用 `git show HEAD:文件 | grep -n "下载\|公告"` 核对关键步骤是否还在。

**教训**：批量修改 workflow 后必须检查 `下载源码`、`@mishi`、`@need`、`@trigger` 这 4 个关键 action 是否都在；单靠 YAML 语法检查发现不了步骤被删。


## 六、已知的坑

1. **seed 每次编译后会被 CI 覆盖。** `Diy_prevent` 用 `diffconfig.sh` 生成 `CONFIG_TXT`，`@trigger` 再把它拷成 `seed/<机型>`。旧流程会省略已成为依赖项的显式选包，`luci-theme-argon` 曾因此在提交 `7891e6e` 中消失；当前 `tools/immortalwrt-plugins.cjs` 会保留原 seed 明确选择的 LuCI 应用和主题。多配置阶段一仍须 checkout 最新分支，防止后一个配置覆盖前一个刚回写的 seed。
2. **判断插件包名要看被 clone 的那个分支。** `git clone` 不带 `-b` 取默认分支。`luci-app-kucat-config` 的 `master` 里 `NAME:=kucat-config` → 包名 `luci-app-kucat-config`；它还有条 `main` 分支写的是 `NAME:=kucat` → 包名会变成 `luci-app-kucat`，符号名就不一样了。
3. **推 workflow 改动不会触发编译。** `compile.yml` 只在 `build/Immortalwrt/relevance/start` 变化时触发；验证两个配置需分别手动选择，或等待定时按长期列表触发，单次手动运行不会遍历长期列表。
4. **长期列表与本轮配置不是同一份状态。** 长期设置只改 `build/Immortalwrt/settings.ini`；`relevance/settings.ini` 必须是本轮单配置。手动选择不能改掉长期列表，`restore` 也不能把列表写进 `relevance/settings.ini`。
5. **两个阶段的 checkout 策略不能互换。** 阶段一取最新分支是为了累积 seed；阶段二固定 `github.sha` 是为了读取与触发事件匹配的配置，不能追随分支最新提交。
6. **缺少 250 DIY 不是可以回落的情况。** 选择 `_250` 配置而缺少 `diy-part-250.sh` 必须失败，否则会把 250 配置错误编译成 6 网段。
7. **本地备份与记录不应提交。** `.gitignore` 已忽略 `BK/`、`memory/`、`tmp/`；提交仍应按真实改动选择文件，别用 `git add .` 混入协作中的其他改动。

验证状态以“新旧版本兼容与启动验收”中的记录为准，历史 CI 成功不能代替启动验收。旧固件的在线更新通道不会被仓库代码自动迁移，首次须本地上传对应新版，或通过 SSH 同时迁移更新通道与设备匹配标识，再核对升级候选。
