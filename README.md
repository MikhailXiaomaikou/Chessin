<div align="center">

<h1>Chessin</h1>

<p>
  本地优先、跨平台、中英双语的认真棋手工作台<br />
  基于 <a href="https://github.com/franciscoBSalgueiro/en-croissant">En Croissant</a> 二次开发
</p>

</div>

> **English note.** Chessin is a local-first, cross-platform, bilingual (Chinese / English) workbench for serious chess players. It is a fork of [En Croissant](https://github.com/franciscoBSalgueiro/en-croissant) by Francisco Salgueiro, based on upstream commit [`d64ce9e`](https://github.com/franciscoBSalgueiro/en-croissant/commit/d64ce9e), and keeps its licence: GPL-3.0-only (see [LICENSE](./LICENSE)). It is free software with no telemetry and no paid tier. **Status: S0 "fork hygiene" in progress; not yet releasable.** Build with `pnpm install`, then `pnpm dev:chessin` (dev) or `pnpm build:chessin` (release); both apply `src-tauri/tauri.chessin.conf.json` on top of upstream's `tauri.conf.json`. Design documents live in [`docs/`](./docs).

## Chessin 是什么

Chessin 是给认真下棋的人用的桌面工作台：导入棋谱、复盘、建错题本、维护开局体系、管理本地棋谱库和引擎。它的立场是：

- **本地优先。** 棋谱、分析、训练记录都在你自己的电脑上；没有账号墙，没有云端依赖。
- **不丢数据。** 用户的外部文件默认只读，自动保存默认关闭，删除可撤销（S1 起逐步落地）。
- **中文优先、中英双语。** 界面、术语、文档以中文为先，英文同步维护。
- **完全免费、开源。** GPL-3.0-only，不做遥测，不收费，没有任何付费层。

Chessin 不是从零写的。它基于 En Croissant 二次开发：棋盘、着法树、多引擎分析、PGN 导入、开局体系训练、谜题、Lichess 与 Chess.com 同步都来自上游，Chessin 在此之上补数据安全、中文体验和 ChessBase 级别的库能力。方案见下方文档。

## 上游：En Croissant

- 上游项目：[En Croissant](https://github.com/franciscoBSalgueiro/en-croissant)（[encroissant.org](https://www.encroissant.org)），作者 Francisco Salgueiro 及贡献者。
- 分叉基线：上游 `master` 提交 [`d64ce9e`](https://github.com/franciscoBSalgueiro/en-croissant/commit/d64ce9e)（2026-10-18），完整历史已导入本仓库，远端命名 `upstream`。
- 策略：软分叉加覆盖层。上游文件只做"挂载点"级改动，Chessin 自己的代码放在独立位置（`src/chessin/`、`crates/`、配置覆盖文件），每月合并一次上游，通用修复回馈上游。每一处对上游文件的改动都登记在 [docs/seams.md](./docs/seams.md)。

## 现状

**S0「分叉卫生」进行中，尚不可发布。** 目前正在做的：换掉上游的更新器密钥和端点、删除 PostHog 遥测、目录和文档地址改为可配置、换应用标识和深链、注释渲染去掉原始 HTML、补 Rust CI 和每周上游合并演练。完成标准见方案第 6 节 S0 出口条件。

在 S0 完成之前，请不要把构建产物发给用户：更新器和目录尚未完全切换，安全收紧（CSP、文件权限范围、WAL）也还没有做完。

## 从源码构建

环境要求同 Tauri：参考 [Tauri 文档](https://tauri.app/start/prerequisites/) 安装你所在平台的依赖（Rust 工具链、系统库）。包管理器用 pnpm，安装方法见 [pnpm 文档](https://pnpm.io/installation)。

```bash
git clone <本仓库地址>
cd Chessin
pnpm install
pnpm dev:chessin     # 开发模式
pnpm build:chessin   # 构建发布版
```

`dev:chessin` 和 `build:chessin` 会把 `src-tauri/tauri.chessin.conf.json` 叠加在上游的 `src-tauri/tauri.conf.json` 之上（应用标识、产品名、深链 scheme、更新器、CSP 等都在覆盖文件里，`tauri.conf.json` 本身保持与上游一致）。上游原有的 `pnpm dev` / `pnpm build` 仍然可用，但构建出来的是 En Croissant 的身份，不要用它发 Chessin。

构建产物在 `src-tauri/target/release`。

## 文档

- [ChessBase 逆向拆解与体验优化方案](./docs/chessbase-teardown.md)：对标调研，Chessin 要解决的问题从哪里来。
- [Chessin 基于 En Croissant 的构建方案](./docs/chessin-on-en-croissant-plan.md)：分叉策略、目标架构、路线图、风险。
- [挂载点台账](./docs/seams.md)：Chessin 改动了哪些上游文件、为什么、现状。

## 参与贡献

贡献流程暂时沿用上游的 [Contributing guide](./CONTRIBUTING.md)。改上游文件前，先看 [docs/seams.md](./docs/seams.md) 的规则：新代码只放 `src/chessin/`、`crates/` 和 `chessin` 翻译命名空间；碰到的上游文件必须登记。

## 许可证

本软件以 **GPL-3.0-only** 许可发布，与上游 En Croissant 一致；全文见 [LICENSE](./LICENSE)。Chessin 的改动同样以 GPL-3.0-only 提供。

## 致谢

Chessin 站在 [En Croissant](https://github.com/franciscoBSalgueiro/en-croissant) 的肩膀上。感谢 Francisco Salgueiro 和所有 En Croissant 贡献者，把一个现代、开源、跨平台的国际象棋 GUI 做了出来并持续维护。如果你想支持上游的开发，可以在 [encroissant.org/support](https://encroissant.org/support) 捐赠；上游社区在 [Discord](https://discord.gg/tdYzfDbSSW)，文档在 [encroissant.org/docs](https://www.encroissant.org/docs)。

Chessin 也依赖上游所用的开源组件（Tauri、React、Mantine、shakmaty、chessops、Stockfish 等 UCI 引擎及棋子、棋盘、音效素材）；第三方素材清单将在许可证审计完成后补充到本仓库。
