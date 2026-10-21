# 挂载点台账（Seams Ledger）

> 更新：2026-10-21（S0 第一批）　|　依据：[构建方案](chessin-on-en-croissant-plan.md) §2.2「挂载点台账」、§2.3「文件三分法」、附录 A。

这份台账记录 Chessin 对 **En Croissant 上游文件** 的每一处改动。原则（方案 §2）：软分叉加覆盖层，上游文件只做"挂载点"级改动，每处改动写明原因；目标是 S2 结束时覆盖层（`src/chessin/`、`crates/`、配置覆盖文件、`chessin` 翻译命名空间）之外的改动少于 600 行。

状态取值：

| 状态                   | 含义                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| **S0 已改**            | 本批（S0 第一批）已经改完，代码在仓库里                               |
| **待做（需运行验证）** | S0 范围内但刻意没在本批做，因为要在真机或 CI 上跑过才能确认不破坏功能 |
| **计划中**             | 方案里列出的后续挂载点（S1 及以后），尚未动手                         |

## 1. 本批已改（S0 已改）

### 1.1 上游文件

| 文件                                                   | 改动                                                                                                                                                                                                                                            | 原因                                                                                                                     | 状态    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------- |
| `src/App.tsx`                                          | 删除 PostHog 初始化和上游的项目 key；不再引入 `posthog-js`                                                                                                                                                                                      | 分叉阻断项：遥测默认开启并发往 EC 的 PostHog 项目；拍板：不做遥测                                                        | S0 已改 |
| `src/components/settings/SettingsPage.tsx`             | 删除遥测开关                                                                                                                                                                                                                                    | 同上，开关已无后端                                                                                                       | S0 已改 |
| `src/state/atoms.ts`                                   | 删除遥测 atom；自动保存默认改为关闭                                                                                                                                                                                                             | 合规；数据安全：上游每走一步就写回源文件，包括用户的大师库                                                               | S0 已改 |
| `src/index.tsx`                                        | 语言检测顺序调整：中文优先，跟随系统语言                                                                                                                                                                                                        | 中文优先                                                                                                                 | S0 已改 |
| `src/utils/engines.ts`                                 | 引擎目录 URL 改为读取 `src/chessin/config.ts`                                                                                                                                                                                                   | 分叉阻断项：不再从 encroissant.org 下载                                                                                  | S0 已改 |
| `src/utils/db.ts`                                      | 棋谱库、谜题目录 URL 改为读取 `src/chessin/config.ts`                                                                                                                                                                                           | 同上                                                                                                                     | S0 已改 |
| `src/routes/__root.tsx`                                | 文档链接改为 Chessin 的                                                                                                                                                                                                                         | 分叉阻断项                                                                                                               | S0 已改 |
| `src/components/ErrorComponent.tsx`                    | 崩溃页的 issues 链接改为 Chessin 仓库                                                                                                                                                                                                           | 不把 Chessin 的 bug 报到上游 issue 区                                                                                    | S0 已改 |
| `src/utils/launch.ts`                                  | 深链 scheme 改为 `chessin://`                                                                                                                                                                                                                   | 分叉阻断项；与 EC 并存安装时不抢注册                                                                                     | S0 已改 |
| `src/utils/directories.ts`                             | 默认文档目录改为 Chessin 自己的文件夹                                                                                                                                                                                                           | 与 EC 并存安装，不互相覆盖数据                                                                                           | S0 已改 |
| `src-tauri/src/oauth.rs`                               | Lichess OAuth `client_id` 改为 Chessin 的标识                                                                                                                                                                                                   | 分叉阻断项                                                                                                               | S0 已改 |
| `src/components/common/Comment.tsx`                    | 移除 `rehype-raw`：PGN/CBH 注释里的原始 HTML 不再当 HTML 渲染，只渲染 Markdown；`++下划线++` 暂时只去掉标记（原来转成 `<u>`，现在会显示成字面量，所以改为纯文本）。保留 `remarkGfm`                                                             | 安全：不受信任的注释内容可注入 HTML。正式解法是 `rehype-sanitize` 并放行 `u`，待加依赖后替换（附录 B 第 3 项，回馈上游） | S0 已改 |
| `package.json`                                         | 新增 `dev:chessin`、`build:chessin` 脚本（`tauri dev/build --config src-tauri/tauri.chessin.conf.json`）                                                                                                                                        | 构建入口；`tauri.conf.json` 保持与上游一致                                                                               | S0 已改 |
| `.github/workflows/test.yml`                           | 新增 `rust` 任务：ubuntu-24.04，复用 release.yml 的系统依赖，cargo 缓存，占位 `dist/`，`cargo test --locked`，`cargo clippy --all-targets -D warnings`（`continue-on-error`，暂不阻断）。原 TS 任务不动                                         | 回归网：上游从未在 CI 跑过 Rust                                                                                          | S0 已改 |
| `.github/workflows/upstream-merge-rehearsal.yml`（新） | 每周一和手动触发：添加 `upstream` 远端，取 `upstream/master`，在一次性分支上 `merge --no-commit --no-ff`，冲突则列出文件并失败；成功则 `pnpm install --frozen-lockfile` + `pnpm lint`。`persist-credentials: false`、`contents: read`，永不推送 | 方案 §2.1：每周演练合并上游，提前暴露冲突                                                                                | S0 已改 |
| `README.md`                                            | 重写为 Chessin 的中文 README（附英文说明），保留 EC 的致谢、Discord、捐赠链接                                                                                                                                                                   | 品牌；说明上游关系和许可证                                                                                               | S0 已改 |

### 1.2 新增文件（覆盖层，不属于上游）

| 文件                                | 改动                                                                                                                           | 原因                                          | 状态    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------- |
| `src-tauri/tauri.chessin.conf.json` | 配置覆盖：`identifier`（`cn.chessin.app`）、`productName`、deep-link `schemes`、更新器（暂禁用，等 minisign 密钥）、窗口标题等 | 方案 §2.2「配置覆盖」：不碰 `tauri.conf.json` | S0 已改 |
| `src/chessin/config.ts`             | 目录、文档、issues 等 URL 的集中配置                                                                                           | 上游文件只改一行指向这里                      | S0 已改 |
| `catalog/*`                         | 引擎、棋谱库、谜题目录（先托管在 GitHub 仓库目录和 Releases）                                                                  | 拍板第 4 项                                   | S0 已改 |
| `docs/seams.md`                     | 本台账                                                                                                                         | 方案 §2.2                                     | S0 已改 |

## 2. S0 范围内、本批刻意未做（待做，需运行验证）

| 文件                                                                | 改动                                                                                                                                                                       | 原因                                                                                                 | 状态               |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------ |
| `src-tauri/tauri.chessin.conf.json`（`app.security.csp`）           | 在覆盖层设置严格 CSP（上游为 `null`）                                                                                                                                      | 安全。要在真机验证 `asset:`、`ipc:`、引擎与目录下载、Lichess/Chess.com 请求都不被误伤                | 待做（需运行验证） |
| `src-tauri/capabilities/main.json`                                  | 收窄 `fs`、`assetProtocol`、`opener` 的范围                                                                                                                                | 安全。要跑完打开 PGN、导入、引擎安装、外链打开等路径                                                 | 待做（需运行验证） |
| `src-tauri/src/db/mod.rs`                                           | 默认 `journal_mode=WAL`；批量导入用独立、不进连接池的连接（上游导入时关闭日志，崩溃会损坏库）                                                                              | 数据安全。要用大库实测导入性能和中断恢复；回馈上游（附录 B 第 2 项）                                 | 待做（需运行验证） |
| `src-tauri/src/fs.rs`                                               | 下载流式写盘、HTTP Range 续传、sha256 校验                                                                                                                                 | 安全；国内网络。要配合 `catalog/*` 里的校验和字段联调                                                | 待做（需运行验证） |
| `src-tauri/Cargo.toml`                                              | vendor `vampirc-uci`（现为 git 依赖，rev `0d2b70d`）；锁定 shakmaty 0.27.1（已是 `"0.27.1"`，待改为精确版本）                                                              | 构建可复现。要确认 vendor 后 `cargo test --locked` 仍过                                              | 待做（需运行验证） |
| `public/pieces`（及 `public/board`、`sound/`）                      | 素材许可证审计，剔除 NC 素材，补第三方素材清单                                                                                                                             | 许可证。需逐套核对来源                                                                               | 待做（需运行验证） |
| `src-tauri/tauri.chessin.conf.json`（`plugins.updater`）            | 生成 minisign 密钥对，填入 Chessin 公钥和端点，重新启用更新器                                                                                                              | 分叉阻断项：不换密钥会被"更新"成 En Croissant；私钥要进 CI secrets，先验证签名链                     | 待做（需运行验证） |
| `package.json`、`pnpm-lock.yaml`                                    | 移除已无引用的 `posthog-js` 依赖                                                                                                                                           | 合规；瘦身。要跑 `pnpm install` 更新锁文件并过 CI                                                    | 待做（需运行验证） |
| `src-tauri/Cargo.toml`、`src-tauri/src/main.rs`、`crates/chessin-*` | `src-tauri` 改为 Cargo workspace；`tauri-plugin-chessin` 空壳（tauri-specta 导出到 `src/chessin/bindings.ts`）；`main.rs` 只加一行 `.plugin(tauri_plugin_chessin::init())` | 挂载点骨架（方案 §2.2「Rust 新增」）。要确认 workspace 改造后 `tauri build` 和 rust-cache 路径仍正确 | 待做（需运行验证） |
| `.github/workflows/test.yml`                                        | 10 条 Playwright 冒烟测试（打开 PGN、走子、开引擎、导入、谜题、浏览库）                                                                                                    | 回归网。需要可在 CI 跑的 Tauri 驱动方案                                                              | 待做（需运行验证） |

## 3. 方案列出的后续挂载点（计划中）

| 文件                                               | 改动                                                                                          | 原因                             | 状态   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------- | ------ |
| `src/utils/tabs.ts`                                | 标签类型枚举扩展                                                                              | 挂载点：Chessin 新标签页         | 计划中 |
| `src/components/tabs/BoardsPage.tsx`               | `TabSwitch` 委托给注册表                                                                      | 挂载点                           | 计划中 |
| `src/components/Sidebar.tsx`                       | 导航注册表                                                                                    | 挂载点                           | 计划中 |
| `src/components/boards/BoardAnalysis.tsx`          | 停靠栏插槽                                                                                    | 挂载点                           | 计划中 |
| `src/routes/__root.tsx`                            | 挂载面板、状态栏、首启页；更新器改为后台下载加"重启以更新"芯片，并与 `App.tsx` 的重复实现合并 | 挂载点；体验                     | 计划中 |
| `src/App.tsx`                                      | 更新器（见上一行）                                                                            | 体验                             | 计划中 |
| `src/state/atoms.ts`                               | 其它默认值（标签页、会话、参考库）                                                            | 挂载点                           | 计划中 |
| `src/components/panels/database/DatabasePanel.tsx` | 来源芯片                                                                                      | 挂载点                           | 计划中 |
| `src/utils/launch.ts`                              | 深链导入前先确认                                                                              | 安全                             | 计划中 |
| `src/utils/chess.ts`                               | 符号导出修复加往返测试                                                                        | 保真；回馈上游（附录 B 第 1 项） | 计划中 |
| `src/translation/*.json`                           | 产品名改用 `{{appName}}` 插值                                                                 | 品牌；回馈上游（附录 B 第 9 项） | 计划中 |
| `.github/workflows/release.yml`                    | Windows 签名、macOS 公证；bindings 漂移检查；`cargo fmt --check`                              | 回归网                           | 计划中 |

## Rules

来自方案 §2.1–2.3，改上游文件前先读：

1. **新代码只放覆盖层。** 前端放 `src/chessin/**`（新路由靠 TanStack 文件路由自动生成，不手工合并 `routeTree.gen.ts`）；Rust 放 `crates/chessin-*`，以 `tauri-plugin-chessin` 注册，`main.rs` 只加一行 `.plugin(...)`，不碰 `collect_commands!`；翻译放独立命名空间 `chessin`（`src/chessin/i18n/{zh-CN,en-US}.json`，独立的 i18next-cli 配置），EC 已有 key 的中文修正直接给上游提 PR。
2. **配置走覆盖文件。** 身份、深链、更新器、CSP 都写在 `src-tauri/tauri.chessin.conf.json`，构建时 `--config` 合并；`tauri.conf.json` 与上游逐字节一致。
3. **上游文件只做挂载点级改动。** 允许改的上游文件以本台账为准（方案 §2.2 列出的：`main.rs`、`Cargo.toml`、`tabs.ts`、`BoardsPage.tsx`、`Sidebar.tsx`、`BoardAnalysis.tsx`、`__root.tsx`、`atoms.ts`、`index.tsx`、`App.tsx`、`DatabasePanel.tsx`，加上附录 A 的分叉阻断项和安全项）。**每一个被改动的上游文件都必须在这里登记**，写明改动、原因、状态；没登记的改动在 code review 里打回。
4. **按月合并上游。** 远端 `upstream` 指向 En Croissant，`main` 用 merge（不用 rebase）每月合入一次 `upstream/master`；每周 CI 自动演练合并（`upstream-merge-rehearsal.yml`），冲突即失败。发版列车自己掌握，不等上游。
5. **通用修复先进 Chessin，再回馈上游。** 队列见方案附录 B；上游接受后对应挂载点应能删掉。
6. **文件三分法。** 自有（S3 起不再自动合并，上游改动人工移植）：`src/routes/*`、`Sidebar.tsx`、`TopBar.tsx`、`tabs/{BoardsPage,BoardTab,NewTabHome,ConfirmChangesModal}.tsx`、`DatabasesPage.tsx`、`FilesPage.tsx`、`keybinds.ts`，以及 `atoms.ts` 中标签页、会话、参考库、自动保存的几段。跟随（最小差异，修复做成可上游的 PR）：`src-tauri/src/{db,engine}/*`、`chess.rs`、`game.rs`、`pgn.rs`、`puzzle.rs`、`opening.rs`、`src/utils/*`、`components/{boards,common,panels,puzzles}/*`、数据库表格组件。新增：`src/chessin/**`、`src-tauri/crates/chessin-*`、`services/*`。
7. **预算。** S2 结束时覆盖层之外的改动少于 600 行；每季度评估，若每月合并成本超过 2 个工程师日，改为只 cherry-pick。
