# 上游回归夹具

- `common/upgrade.sh`、`common/ubuntu.sh`、`common/common.sh` 来自 `281677160/common` 提交 `4c706810ab610089568de291e299bde39595a2c0`（2026-09-10）。保留原始内容以复现修复前的元数据生成、依赖安装与源码补丁失败传播错误。
- `common/mishi.yml` 来自 `281677160/common@mishi` 的 `7f54c8c5de614a14fbd518879171f36e3989d047`；它用于复现手动“双配置测试”覆盖矩阵配置的问题，原始内容不改写。
- `immortalwrt/package-metadata.pl` 和 `metadata.pm` 来自 `immortalwrt/immortalwrt` 提交 `99ca94091f673607bdcb92ba1f93bda1e811fc93` 的 `scripts/`；保留上游授权说明。`mihomo.packageinfo` 为最小元数据夹具，保留实际 Mihomo/Nikki 的冲突、默认变体和虚包依赖关系，另有两个单向冲突用于回归。
- `kconfiglib.py` 为 `ulfalizer/Kconfiglib@061e71f7d78cb057762d88de088055361863deff` 原始源码，Git blob `c67895ced6b352190c62c2984ce61b65d39dda77`，SHA-256 `d81c16ca77a451e52e93c99d39ad9451d645506450766c9a6b7193d55c439103`；保留文件内许可证，仅作测试解析器。
- 测试只在项目 `tmp/` 下生成配置与固件占位数据，不执行系统安装、GitHub 写操作或设备升级。
- 执行：`node --test tests/immortalwrt-build.test.cjs tests/immortalwrt-kconfig.test.cjs tests/immortalwrt-workflow.test.cjs tests/immortalwrt-release.test.cjs`。需要 Node.js 18+、Bash、GNU patch、Perl、Python 3.7+；Windows 使用 Git Bash，Python 可由 `PYTHON` 指定，未指定时使用 `uv python find --offline --no-python-downloads` 查找已安装解释器，不自动安装。
- `IMMORTALWRT_TEST_BASELINE=1` 只用于构建回归测试的旧版对照，会跳过应用新补丁并复现错误；正常验收不能设置该变量。
