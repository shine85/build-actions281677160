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

## 五、同步上游代码的步骤

本仓库当前是「上游 + 本地提交」，分叉点就是上游最新提交，直接 merge 即可。

```bash
git fetch upstream
git log --oneline HEAD..upstream/main                   # 先看上游更新了什么
cp -Rf .github/workflows "BK/workflows-$(date +%Y%m%d)" # 动手前留一份
git merge upstream/main
```

冲突大概率出现在 `Immortalwrt.yml`、`compile.yml`、`build/Immortalwrt/diy-part.sh` 这三个文件。
处理原则：**以上游新版为底，把第四节表格里「加了什么」逐项补回去**，不要拿旧版整文件覆盖上游。

补回后必须自查：

1. 每个入口里 `选择本次编译使用的diy脚本` 在 `@mishi` **之前**
2. `还原diy-part.sh` 在 `@mishi` **之后**（`compile.yml` 不需要这步，因为阶段二不回写 `build/`）
3. `补回kucat...` 在 `@need` **之后**、`下载软件包` 之前
4. `npx --yes js-yaml <文件>` 三个 workflow 都能解析通过

## 六、已知的坑

1. **seed 每次编译后会被 CI 覆盖。** `Diy_prevent` 用 `diffconfig.sh` 生成 `CONFIG_TXT`，`@trigger` 再把它拷成 `seed/<机型>`。手写进 seed 的选包会被重排，变成依赖项的会直接消失——`luci-theme-argon` 就是这样在提交 `7891e6e` 里没的。
2. **判断插件包名要看被 clone 的那个分支。** `git clone` 不带 `-b` 取默认分支。`luci-app-kucat-config` 的 `master` 里 `NAME:=kucat-config` → 包名 `luci-app-kucat-config`；它还有条 `main` 分支写的是 `NAME:=kucat` → 包名会变成 `luci-app-kucat`，符号名就不一样了。
3. **推 workflow 改动不会触发编译。** `compile.yml` 只在 `build/Immortalwrt/relevance/start` 变化时触发，改完 workflow 得手动跑一次入口。
4. **仓库没有 `.gitignore`**，`BK/`、`memory/`、`tmp/` 都没被拦住，别用 `git add .`。
