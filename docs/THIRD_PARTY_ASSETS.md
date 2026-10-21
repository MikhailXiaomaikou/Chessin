# 第三方素材清单

本文件记录 Chessin 随应用分发的棋子、棋盘和音效素材的作者与许可证。
这些素材由 En Croissant 从 Lichess（lila）继承，EC 仓库本身没有来源说明；
下表的作者和许可证信息依据 lila 仓库的 `COPYING.md`（2026-10-21 自 `master`
及 2021-06 / 2022-06 / 2023-06 三个历史版本核对，lila 目录名 `public/piece/<set>`、
`public/images/board`、`public/sounds/<set>`）。

审计与剔除的背景见 `docs/chessin-on-en-croissant-plan.md` 第 1.1 节和附录 A。

## 2026-10-21 剔除的素材

Chessin 以 GPL 分发并计划付费分发，CC BY-NC-SA 的"非商业"条款与 GPL 的再分发
自由和付费分发都冲突；没有任何许可证声明的素材则根本没有再分发的授权。因此
2026-10-21 从 `public/pieces/` 和 `sound/` 删除了以下集合，并从
`src/state/atoms.ts`（`PIECE_SETS_2D`）、`src/components/settings/SoundSelect.tsx`
的列表中移除。默认棋子集由 `staunty` 改为 `cburnett`；旧配置中保存的已删除棋子集
会在读取时回退到 `cburnett`（`src/state/atoms.ts` 的 `pieceSetAtom`）。

| 目录                        | 作者                                                                   | 许可证                                                            | 剔除原因              |
| --------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------- |
| `public/pieces/anarcandy`   | caderek                                                                | CC BY-NC-SA 4.0                                                   | NC                    |
| `public/pieces/california`  | Jerry S.                                                               | CC BY-NC-SA 4.0                                                   | NC                    |
| `public/pieces/cardinal`    | sadsnake1                                                              | CC BY-NC-SA 4.0                                                   | NC                    |
| `public/pieces/disguised`   | danegraphics                                                           | CC BY-NC-SA 4.0                                                   | NC                    |
| `public/pieces/dubrovny`    | sadsnake1                                                              | CC BY-NC-SA 4.0                                                   | NC                    |
| `public/pieces/fresca`      | sadsnake1                                                              | CC BY-NC-SA 4.0                                                   | NC                    |
| `public/pieces/gioco`       | sadsnake1                                                              | CC BY-NC-SA 4.0                                                   | NC                    |
| `public/pieces/horsey`      | cham, michael1241                                                      | CC BY-NC-SA 4.0                                                   | NC                    |
| `public/pieces/icpieces`    | sadsnake1                                                              | CC BY-NC-SA 4.0                                                   | NC                    |
| `public/pieces/libra`       | sadsnake1                                                              | CC BY-NC-SA 4.0（lila 2021–2023 版 COPYING.md；现已从 lila 移除） | NC                    |
| `public/pieces/maestro`     | sadsnake1                                                              | CC BY-NC-SA 4.0                                                   | NC                    |
| `public/pieces/staunty`     | sadsnake1                                                              | CC BY-NC-SA 4.0                                                   | NC（EC 原默认棋子集） |
| `public/pieces/tatiana`     | sadsnake1                                                              | CC BY-NC-SA 4.0                                                   | NC                    |
| `public/pieces/alpha`       | Eric Bentzen                                                           | "free for personal non commercial use"                            | 仅限个人非商业使用    |
| `public/pieces/reillycraig` | Reilly Craig                                                           | 无许可证声明                                                      | 无授权                |
| `public/pieces/riohacha`    | 未知                                                                   | 无许可证声明                                                      | 无授权                |
| `public/pieces/governor`    | 未知（lila 中与 sadsnake1 的 dubrovny / libra 同期加入，疑为同一作者） | lila `COPYING.md` 从未列出                                        | 无授权 / 疑似 NC      |
| `public/pieces/kosal`       | 未知（lila 的 `totoy` 集作者 Kosal Sen 可能即本集作者）                | lila `COPYING.md` 从未列出                                        | 无授权                |
| `sound/lisp`                | EdinburghCollective                                                    | CC BY-NC-SA 4.0                                                   | NC                    |

`governor` 和 `kosal` 不在本次审计的原始名单里，但 lila 任一版本的 `COPYING.md`
都没有它们的条目，按"无许可证声明即剔除"的同一规则处理；若日后拿到作者授权可以
恢复（文件在 git 历史里）。

## 保留的素材

### 2D 棋子（`public/pieces/`）

| 目录                                    | 作者                        | 许可证                                                                     | 来源                                                          |
| --------------------------------------- | --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `public/pieces/cburnett.css`（默认）    | Colin M.L. Burnett          | GPLv2+                                                                     | Lichess `public/piece/cburnett`                               |
| `public/pieces/chess7.css`              | Style-7（styleseven.com）   | "freeware"（lila 归入 non-free 表；非 NC，保留，建议进一步核实再分发条款） | Lichess `public/piece/chess7`                                 |
| `public/pieces/chessnut.css`            | Alexis Luengas              | Apache-2.0                                                                 | Lichess `public/piece/chessnut`（LexLuengas/chessnut-pieces） |
| `public/pieces/companion.css`           | David L. Brown              | "freeware"（enpassant.dk；同 chess7 的保留理由）                           | Lichess `public/piece/companion`                              |
| `public/pieces/fantasy.css`             | Maurizio Monge              | MIT                                                                        | Lichess `public/piece/fantasy`（maurimo/chess-art）           |
| `public/pieces/leipzig.css`             | Armando Hernandez Marroquin | "freeware"（enpassant.dk；同 chess7 的保留理由）                           | Lichess `public/piece/leipzig`                                |
| `public/pieces/letter.css`              | usolando                    | AGPLv3+                                                                    | Lichess `public/piece/letter`                                 |
| `public/pieces/merida.css`              | Armando Hernandez Marroquin | GPLv2+                                                                     | Lichess `public/piece/merida`                                 |
| `public/pieces/pirouetti.css`           | pirouetti                   | AGPLv3+                                                                    | Lichess `public/piece/pirouetti`                              |
| `public/pieces/pixel.css`               | therealqtpi                 | AGPLv3+                                                                    | Lichess `public/piece/pixel`                                  |
| `public/pieces/shapes.css`              | flugsio                     | CC BY-SA 4.0                                                               | Lichess `public/piece/shapes`（flugsio/chess_shapes）         |
| `public/pieces/spatial.css`             | Maurizio Monge              | MIT                                                                        | Lichess `public/piece/spatial`（maurimo/chess-art）           |
| `public/pieces/view-pawn-structure.css` | En Croissant 作者           | 同仓库 `LICENSE`                                                           | EC 自带的辅助样式（只隐藏非兵棋子），不是棋子集               |

每个 `.css` 文件把整套棋子的 SVG 以 base64 `data:` URI 内嵌，所以没有单独的图片目录。

### 2D 棋盘（`public/board/`）

| 目录                                                                                                                                                                                                                                                                             | 作者                          | 许可证  | 来源                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------- | ----------------------------- |
| `public/board/*.{png,jpg,svg}` 及 `*.thumbnail.*`（blue、blue2、blue3、blue4、blue-marble、brown、canvas2、gray、green、green-plastic、grey、horsey、ic、leather、maple、maple2、marble、metal、newspaper、olive、pink-pyramid、purple、purple-diag、wood、wood2、wood3、wood4） | the lila authors 与 pirouetti | AGPLv3+ | Lichess `public/images/board` |

备注：

- `gray.svg`（EC 默认棋盘）和 `blue4.svg` 的结构与 lila 的 SVG 棋盘一致，应视为
  其改色衍生作品，许可证同上（AGPLv3+）。
- `horsey.jpg` 是随 `horsey` 棋子集（cham, michael1241，CC BY-NC-SA 4.0）一同加入
  lila 的配套棋盘；lila `COPYING.md` 只把棋子和表情归为 NC，棋盘目录整体仍标注
  AGPLv3+，本次按 lila 的标注保留，建议向 Lichess 核实后再定。

### 3D 棋子（`public/pieces-3d/`）与 3D 棋盘（`public/board-3d/`）

| 目录                                                                                                | 作者       | 许可证     | 来源       |
| --------------------------------------------------------------------------------------------------- | ---------- | ---------- | ---------- |
| `public/pieces-3d/{Basic,Experimental,Glass,Metal,ModernJade,ModernWood,RedVBlue,Trimmed,Wood}.css` | 来源待确认 | 来源待确认 | 来源待确认 |
| `public/pieces-3d/CubesAndPi.css`                                                                   | 来源待确认 | 来源待确认 | 来源待确认 |
| `public/pieces-3d/Staunton.css`                                                                     | 来源待确认 | 来源待确认 | 来源待确认 |
| `public/board-3d/*.png` 及 `*.thumbnail.png`（20 张）                                               | 来源待确认 | 来源待确认 | 来源待确认 |

备注：文件名与 lila `public/images/staunton/{piece,board}` 一致。若确认来自 lila，
lila `COPYING.md` 的标注是：`public/images/staunton` 整体为 James Clarke，MIT
（clarkerubber/Staunton-Pieces）；`piece/CubesAndPi` 为 CubesAndPi，AGPLv3+；
`piece/Staunton` 为 Eden Murs（存疑），**无许可证声明**。核实后 `Staunton` 可能需要
与上面的无授权棋子集一样剔除。本次未删除任何 3D 素材。

### 音效（`sound/`）

| 目录                     | 作者       | 许可证       | 来源                                           |
| ------------------------ | ---------- | ------------ | ---------------------------------------------- |
| `sound/futuristic`       | Enigmahack | AGPLv3+      | Lichess `public/sounds/futuristic`             |
| `sound/nes`              | Enigmahack | AGPLv3+      | Lichess `public/sounds/nes`                    |
| `sound/piano`            | Enigmahack | AGPLv3+      | Lichess `public/sounds/piano`                  |
| `sound/sfx`              | Enigmahack | AGPLv3+      | Lichess `public/sounds/sfx`                    |
| `sound/standard`（默认） | 未知       | 许可证待确认 | 文件名与 Lichess `public/sounds/standard` 一致 |
| `sound/robot`            | 未知       | 许可证待确认 | 文件名与 Lichess `public/sounds/robot` 一致    |
| `sound/woodland`         | 未知       | 许可证待确认 | 文件名与 Lichess `public/sounds/woodland` 一致 |

备注：lila `COPYING.md` 没有 `standard`、`robot`、`woodland` 的单独条目，只在
non-free 例外表之后以一句 "The other sounds in public/sound" 兜底，即 Lichess 自己
也没有把它们当作自由素材。本次按原审计名单只剔除了 `lisp`；这三套（含默认音效
`standard`，`src/utils/sound.ts` 对它有特殊处理）是否替换为自制或 AGPL 音效，需要
另行决定。

### 其他

| 目录                                                        | 作者              | 许可证                                             | 来源         |
| ----------------------------------------------------------- | ----------------- | -------------------------------------------------- | ------------ |
| `public/chesscom.png`                                       | Chess.com         | 商标，仅用于指代 Chess.com                         | En Croissant |
| `public/logo.png`、`public/favicon.ico`、`src-tauri/icons/` | En Croissant 作者 | 同仓库 `LICENSE`；Chessin 发布前应替换为自己的图标 | En Croissant |

## 维护规则

- 新增任何棋子、棋盘、音效前先确认许可证允许随 GPL 软件再分发且不含 NC 条款，
  并把条目补进本文件。
- `src/state/atoms.ts` 的 `PIECE_SETS_2D` / `PIECE_SETS_3D` 和
  `src/components/settings/SoundSelect.tsx` 的列表必须与目录内容一致。
- 与上游 En Croissant 合并时，若上游重新加入已剔除的集合，合并后再次删除。
