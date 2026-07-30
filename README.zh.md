# vibe

一款用于轻松管理 Git Worktree 的超快 CLI 工具。

> 🇺🇸 [English](./README.md) | 🇯🇵 [日本語版](./README.ja.md)

## 文档

📚 完整文档请访问 [vibe.kexi.dev](https://vibe.kexi.dev)

## 使用方法

| 命令                               | 说明                                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| `vibe start <branch> [options]`    | 使用新分支或已有分支创建 worktree（幂等）                    |
| `vibe scratch [options]`           | 创建自动命名为 `scratch/<timestamp>` 分支的 worktree         |
| `vibe jump <branch> [options]`     | 按分支名跳转到已有 worktree（支持部分匹配与模糊匹配）        |
| `vibe rename <new-name> [options]` | 重命名当前 worktree 的分支和目录                             |
| `vibe clean [options]`             | 删除当前 worktree 并返回主仓库（存在未提交更改时会提示确认） |
| `vibe home`                        | 不删除当前 worktree，直接返回主 worktree                     |
| `vibe trust`                       | 信任 `.vibe.toml` 和 `.vibe.local.toml` 文件                 |
| `vibe untrust`                     | 取消信任 `.vibe.toml` 和 `.vibe.local.toml` 文件             |
| `vibe verify`                      | 查看信任状态与哈希历史                                       |
| `vibe config`                      | 显示当前设置                                                 |
| `vibe upgrade [options]`           | 检查更新并显示升级方法                                       |
| `vibe doctor`                      | 检查环境中是否存在过时的 nushell / PowerShell 包装函数       |

### 示例

```bash
# 使用新分支创建 worktree
vibe start feat/new-feature

# 使用已有分支（或在 worktree 已存在时重复执行）
vibe start feat/existing-branch

# 从指定的基准分支创建 worktree
vibe start feat/new-feature --base main

# 跳转到已有 worktree（完全匹配、部分匹配或模糊匹配）
vibe jump feat/new-feature
vibe jump login
vibe jump feli  # 模糊匹配到 "feat/login"

# 无需起名即可创建临时 worktree（自动命名：scratch/<timestamp>）
vibe scratch

# 将当前的 scratch 提升为正式名称
vibe rename my-feature

# 工作完成后删除 worktree
vibe clean

# 不删除当前 worktree，直接返回主 worktree
vibe home
```

### 交互式提示

`vibe start` 会处理以下情况：

- **分支已被其他 worktree 占用时**：确认是否跳转到已有的 worktree
- **相同的 worktree 已存在时**：自动复用（幂等）
- **目录已存在但分支不同时**：可从以下选项中选择
  - 覆盖（删除后重新创建）
  - 复用（使用已有目录）
  - 取消

```bash
# 分支已被占用时的示例
$ vibe start feat/new-feature
Branch 'feat/new-feature' is already in use by worktree '/path/to/repo-feat-new-feature'.
Navigate to the existing worktree? (Y/n)
```

### 基准分支选项

`--base` 选项用于指定新分支的起点：

- **新分支**：从指定的基准（分支、标签或提交）创建分支
- **已有分支**：`--base` 选项将被忽略并给出警告
- **无效的基准**：如果指定的引用不存在，则以错误退出

默认情况下，`--base` **不会**设置上游跟踪。如需显式设置上游，请使用 `--track`：

```bash
# 不设置上游跟踪（默认）
vibe start feat/new-feature --base origin/develop

# 设置上游跟踪
vibe start feat/new-feature --base origin/develop --track
```

### 清理行为

`vibe clean` 采用快速删除策略：移动 worktree 目录，而不是同步删除它：

- **macOS**：通过 Finder 将条目移入系统废纸篓（需要时可恢复）
- **Linux**：将条目移入 XDG 回收站（可从文件管理器恢复）
- **Windows**：将条目移入回收站（需要时可恢复）

这种方式使 `vibe clean` 无论 worktree 有多大都能瞬间完成。

### 全局选项

| 选项              | 说明           |
| ----------------- | -------------- |
| `-h`, `--help`    | 显示帮助信息   |
| `-v`, `--version` | 显示版本信息   |
| `-V`, `--verbose` | 显示详细输出   |
| `-q`, `--quiet`   | 抑制非必要输出 |

### 命令选项

#### Start 选项

| 选项              | 说明                                                       |
| ----------------- | ---------------------------------------------------------- |
| `--base <ref>`    | 新分支的基准分支/提交                                      |
| `--track`         | 使用 `--base` 时设置上游跟踪                               |
| `--no-hooks`      | 跳过 pre-start 与 post-start 钩子                          |
| `--no-copy`       | 跳过文件和目录的复制                                       |
| `-n`, `--dry-run` | 只显示将要执行的操作，不做实际更改                         |
| `-f`, `--force`   | 跳过提示：跳转到已有分支的 worktree，或覆盖冲突的 worktree |

#### Clean 选项

| 选项              | 说明                         |
| ----------------- | ---------------------------- |
| `-f`, `--force`   | 跳过确认提示                 |
| `--delete-branch` | 删除 worktree 后同时删除分支 |
| `--keep-branch`   | 删除 worktree 后保留分支     |

#### Upgrade 选项

| 选项      | 说明                       |
| --------- | -------------------------- |
| `--check` | 仅检查更新，不显示升级方法 |

## 安装

### Homebrew (macOS)

```bash
brew install kexi/tap/vibe
```

### Homebrew Beta (macOS)

用于测试最新的开发版本：

```bash
brew install kexi/tap/vibe-beta
```

> ⚠️ **警告**：Beta 版本基于 `develop` 分支构建，可能包含不稳定的功能。请仅用于测试。

### npm (Node.js 18+)

```bash
# 全局安装
npm install -g @kexi/vibe

# 或使用 npx 直接运行
npx @kexi/vibe start feat/my-feature
```

> 注意：npm 包只是一个轻量启动器，用于运行适配你所在平台的原生 `vibe` 二进制文件（作为按平台划分的 `optionalDependency` 自动安装，例如 `@kexi/vibe-darwin-arm64`）。macOS (APFS) 与 Linux (Btrfs/XFS) 上经过优化的 Copy-on-Write 文件克隆功能已直接内置于该二进制文件中。

### Bun (1.2.0+)

```bash
# 全局安装
bun add -g @kexi/vibe

# 或使用 bunx 直接运行
bunx @kexi/vibe start feat/my-feature
```

> 注意：Bun 使用与 Node.js 相同的 npm 包 —— 它同样会启动适配你所在平台的原生 `vibe` 二进制文件。

### mise

添加到你的 `.mise.toml`：

```toml
[plugins]
vibe = "https://github.com/kexi/mise-vibe"

[tools]
vibe = "latest"
```

然后运行：

```bash
mise install
```

#### 使用 mise hooks 配置 shell

如果你使用 [`mise activate`](https://mise.jdx.dev/getting-started.html#activate-mise)，
可以添加 `[hooks]` 来跳过[手动 shell 配置](#shell-配置)：

```toml
[hooks]
enter = 'eval "$(vibe shell-setup)"'
```

### Nix

```bash
# 直接运行（临时）
nix run github:kexi/vibe -- start feat/my-feature

# 持久化安装
nix profile install github:kexi/vibe
```

> 注意：Nix 包会安装来自 GitHub Releases 的预构建二进制文件，并通过 SHA-256 哈希进行校验。

### Linux

> **注意**：WSL2 用户可以根据自己的发行版使用下面的 Linux 安装方式。

#### Ubuntu/Debian (.deb 包)

```bash
# x64
curl -LO https://github.com/kexi/vibe/releases/latest/download/vibe_amd64.deb
sudo apt install ./vibe_amd64.deb

# ARM64
curl -LO https://github.com/kexi/vibe/releases/latest/download/vibe_arm64.deb
sudo apt install ./vibe_arm64.deb

# 卸载
sudo apt remove vibe
```

#### 其他 Linux 发行版

```bash
# x64
curl -L https://github.com/kexi/vibe/releases/latest/download/vibe-linux-x64 -o vibe
chmod +x vibe
sudo mv vibe /usr/local/bin/

# ARM64
curl -L https://github.com/kexi/vibe/releases/latest/download/vibe-linux-arm64 -o vibe
chmod +x vibe
sudo mv vibe /usr/local/bin/
```

### Windows

vibe 支持 Windows (x64)。通过 npm 安装即可 —— `@kexi/vibe` 启动器会自动引入
适配你所在平台的二进制包 `@kexi/vibe-win32-x64`：

```bash
npm install -g @kexi/vibe
```

> [!NOTE]
> Windows 上无法使用 Copy-on-Write 克隆，创建 worktree 时 vibe 会回退到
> 标准文件复制。除此之外的功能与 Linux、macOS 上完全一致。你也可以在
> [WSL2](https://learn.microsoft.com/windows/wsl/) 中按照上面的 Linux 步骤
> 运行 vibe（如果想在 Btrfs 卷上使用 Copy-on-Write，这会很有用），或者使用
> Rust 工具链从源码构建（参见[手动构建](#手动构建)）。

### 手动构建

```bash
cargo build --manifest-path rust/Cargo.toml -p vibe --release
# 二进制文件位于：rust/target/release/vibe
```

## Shell 配置

请将以下内容添加到你的 shell 配置文件中：

<details>
<summary>Zsh (.zshrc)</summary>

```bash
vibe() { eval "$(command vibe "$@")" }
```

</details>

<details>
<summary>Bash (.bashrc)</summary>

```bash
vibe() { eval "$(command vibe "$@")"; }
```

</details>

<details>
<summary>Fish (~/.config/fish/config.fish)</summary>

```fish
function vibe
    eval (command vibe $argv)
end
```

</details>

<details>
<summary>Nushell (~/.config/nushell/config.nu)</summary>

```nu
def --env --wrapped vibe [...args] {
    let out = (^vibe --eval-dialect nu ...$args)
    for line in ($out | lines) {
        if ($line | str starts-with "__VIBE_CD__") {
            cd ($line | str replace "__VIBE_CD__" "")
        } else {
            print $line
        }
    }
}
```

需要 vibe 2.2.0 或更高版本，以及 nushell 0.83 或更高版本。请替换掉之前粘贴的旧版
`nu -c` 代码片段 —— 它实际上并不会切换目录，而且会拒绝任何带有 flag 的命令。请同时保留
`--wrapped`（以便 flag 能传递给 `...args`）和 `for`（因为 nushell 会丢弃在 `each`
闭包内所做的环境变更）。

</details>

<details>
<summary>PowerShell ($PROFILE)</summary>

```powershell
function vibe { $out = & vibe.exe --eval-dialect powershell @args; if ($out) { Invoke-Expression ($out -join "`n") } }
```

需要 vibe 2.2.0 或更高版本。请替换掉之前粘贴的旧版
`Invoke-Expression (& vibe.exe $args)` 代码片段 —— 它无法正确处理包含单引号的路径，
并且在 vibe 没有任何输出时会抛出错误。

</details>

## 配置

### .vibe.toml

在仓库根目录放置 `.vibe.toml` 文件，即可在执行 `vibe start` 时自动运行任务。
该文件通常会提交到 git 并与团队共享。

```toml
# 将文件和目录从原始仓库复制到 worktree
[copy]
files = [".env"]
dirs = ["node_modules", ".cache"]

# worktree 创建后要执行的命令
[hooks]
pre_start = ["echo 'Preparing worktree...'"]
post_start = [
  "pnpm install",
  "pnpm db:migrate"
]
pre_clean = ["git stash"]
post_clean = ["echo 'Cleanup complete'"]
```

首次使用时需要通过 `vibe trust` 进行信任登记。

#### Copy 配置中的 Glob 模式

`files` 数组支持 glob 模式，可灵活地选择文件：

```toml
[copy]
files = [
  "*.env",              # 根目录下的所有 .env 文件
  "**/*.json",          # 递归匹配所有 JSON 文件
  "config/*.txt",       # config/ 下的所有 .txt 文件
  ".env.production"     # 精确路径同样可用
]
```

**支持的模式：**

- `*` - 匹配除 `/` 以外的任意字符
- `**` - 匹配包括 `/` 在内的任意字符（递归）
- `?` - 匹配任意单个字符
- `[abc]` - 匹配方括号中的任意一个字符

**注意事项：**

- 复制匹配到的文件时会保留目录结构
- 递归模式（`**/*`）在大型仓库中可能较慢
  - 尽可能使用更具体的模式（例如用 `config/**/*.json` 代替 `**/*.json`）
  - 模式展开只在创建 worktree 时执行一次，而不是每次执行命令都展开

#### 目录复制配置

`dirs` 数组会递归复制整个目录：

```toml
[copy]
dirs = [
  "node_modules",      # 精确的目录路径
  ".cache",            # 隐藏目录
  "packages/*"         # 匹配多个目录的 Glob 模式
]
```

**注意事项：**

- 目录会被完整复制（而非增量同步）
- Glob 模式的行为与文件模式一致
- 像 `node_modules` 这样的大目录复制起来可能比较耗时

#### 复制性能优化

Vibe 会根据你的系统自动选择最佳的复制策略：

| 策略            | 使用条件                    | 平台        |
| --------------- | --------------------------- | ----------- |
| Clone (CoW)     | APFS 上的原生 clonefile()   | macOS       |
| Clone (reflink) | Btrfs/XFS 上的目录复制      | Linux       |
| rsync           | 无法使用 clone 时的目录复制 | macOS/Linux |
| Standard        | 文件复制，或作为兜底方案    | 全部        |

**工作原理：**

- **文件复制**：始终使用原生的 `copyFile()`，以获得最佳的单文件性能
- **目录复制**：自动使用当前可用的最快方式：
  - 在使用 APFS 的 macOS 上：使用原生 `clonefile()` 系统调用（已内置于二进制文件中）实现瞬时 CoW 克隆。如果不可用，则回退到 `cp -cR`
  - 在使用 Btrfs/XFS 的 Linux 上：使用 `cp --reflink=auto` 进行 CoW 克隆
  - 如果 CoW 不可用，则回退到 rsync 或标准复制

**优势：**

- Copy-on-Write 只复制元数据而非实际数据，因此速度极快
- 无需配置 —— 最佳策略会被自动检测
- 自动回退机制确保复制始终可用

关于复制策略与实现的详细说明，请参见 [Copy Strategies](docs/specifications/copy-strategies.zh.md)。

### Worktree 路径配置

可以使用外部脚本自定义 worktree 的目录路径：

```toml
[worktree]
path_script = "~/.config/vibe/worktree-path.sh"
```

该脚本会接收以下环境变量，并且需要输出一个绝对路径：

| 变量                    | 说明                        | 示例               |
| ----------------------- | --------------------------- | ------------------ |
| `VIBE_REPO_NAME`        | 仓库名                      | `my-project`       |
| `VIBE_BRANCH_NAME`      | 分支名                      | `feat/new-feature` |
| `VIBE_SANITIZED_BRANCH` | 净化后的分支名（`/` → `-`） | `feat-new-feature` |
| `VIBE_REPO_ROOT`        | 仓库根目录路径              | `/path/to/repo`    |

**脚本示例：**

```bash
#!/bin/bash
echo "${HOME}/worktrees/${VIBE_REPO_NAME}-${VIBE_SANITIZED_BRANCH}"
```

### 编辑器支持 (JSON Schema)

Vibe 为 `settings.json` 提供了 JSON Schema，可实现自动补全与校验。当 vibe 保存设置文件时会**自动添加** `$schema` 属性。大多数现代编辑器（VS Code、IntelliJ 等）都会自动提供补全功能。

关于 VS Code 的手动配置，请参见 [settings.json 文档](https://vibe.kexi.dev/configuration/settings/#json-schema)。

### 安全性：哈希校验

Vibe 会使用 SHA-256 哈希自动校验 `.vibe.toml` 与 `.vibe.local.toml` 文件的完整性，从而防止配置文件被未经授权地修改。

#### 工作原理

- 当你执行 `vibe trust` 时，Vibe 会计算并保存配置文件的 SHA-256 哈希
- 当你执行 `vibe start` 时，Vibe 会通过校验哈希来确认文件未被修改
- 如果哈希不匹配，Vibe 会以错误退出，并要求你重新执行 `vibe trust`

#### 跳过哈希校验（用于开发）

你可以在设置文件（`~/.config/vibe/settings.json`）中禁用哈希校验：

**全局设置：**

```json
{
  "version": 3,
  "skipHashCheck": true,
  "permissions": { "allow": [], "deny": [] }
}
```

**按文件设置：**

```json
{
  "version": 3,
  "permissions": {
    "allow": [
      {
        "repoId": {
          "remoteUrl": "github.com/user/repo",
          "repoRoot": "/path/to/repo"
        },
        "relativePath": ".vibe.toml",
        "hashes": ["abc123..."],
        "skipHashCheck": true
      }
    ],
    "deny": []
  }
}
```

> **注意**：版本 3 使用基于仓库的信任标识。设置会在首次加载时自动从 v2 迁移到 v3。信任信息在同一仓库的所有 worktree 之间共享。

#### 切换分支

Vibe 会为每个文件保存多个哈希（最多 100 个），因此只要你为每个分支的版本各信任过一次，就可以在分支之间自由切换而无需重新信任。

#### 安全性注意事项

信任机制会校验配置文件在你信任之后是否被修改过。但请注意以下几点：

- **信任是一种意愿声明**：执行 `vibe trust` 即表示你声明已经审阅并批准了这些配置文件，包括其中包含的所有钩子命令。
- **钩子会执行任意命令**：在 `hooks.pre_start`、`hooks.post_start` 等中定义的命令会在你的 shell 中执行。Vibe 不会对这些命令做沙箱隔离或功能限制。
- **信任前请先审阅**：在执行 `vibe trust` 之前，请务必审阅 `.vibe.toml` 与 `.vibe.local.toml` 文件，尤其是在你无法掌控的仓库中。
- **哈希校验不是恶意软件防护**：哈希校验只能检测你已信任的文件是否发生了变化，并不会评估命令本身是否安全。

### .vibe.local.toml

创建 `.vibe.local.toml` 文件可以进行仅在本地生效、不会提交到 git 的配置覆盖
（会被自动 gitignore）。这对于开发者个人的专属设置非常有用。

```toml
# 用本地命令覆盖或扩展共享钩子
[hooks]
post_start_prepend = ["echo 'Local setup starting'"]
post_start_append = ["npm run dev"]

# 覆盖要复制的文件
[copy]
files = [".env.local", ".secrets"]
```

### 配置合并

当 `.vibe.toml` 与 `.vibe.local.toml` 同时存在时：

- **完全覆盖**：直接使用字段名（例如 `post_start = [...]`）
- **在前面插入**：使用 `_prepend` 后缀（例如 `post_start_prepend = [...]`）
- **在后面追加**：使用 `_append` 后缀（例如 `post_start_append = [...]`）

**示例：**

```toml
# .vibe.toml（共享）
[hooks]
post_start = ["npm install", "npm run build"]

# .vibe.local.toml（本地）
[hooks]
post_start_prepend = ["echo 'local setup'"]
post_start_append = ["npm run dev"]

# 结果：["echo 'local setup'", "npm install", "npm run build", "npm run dev"]
```

### 可用的钩子

| 钩子         | 执行时机                              | 可用的环境变量                           |
| ------------ | ------------------------------------- | ---------------------------------------- |
| `pre_start`  | worktree 创建前                       | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH` |
| `post_start` | worktree 创建后                       | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH` |
| `pre_clean`  | worktree 删除前（在当前 worktree 中） | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH` |
| `post_clean` | worktree 删除后（在主仓库中）         | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH` |

**注意**：`post_clean` 钩子会通过 `&&` 连接到删除命令之后，在 `git worktree remove` 命令执行完毕后于主仓库目录中运行。

### 钩子输出行为

Vibe 会在钩子执行期间显示实时进度树来展示任务状态。钩子的输出会根据不同场景以不同方式处理：

- **进度显示处于激活状态时**：钩子的标准输出会被抑制，以保持进度树整洁、避免视觉干扰。此时只显示进度树。
- **进度显示未激活时**：钩子的标准输出会被写入标准错误输出（以免干扰 shell 包装函数的 `eval`）。
- **失败的钩子**：无论进度显示是否激活，标准错误输出都**始终**会被展示，以便于调试。

进度显示示例：

```
✶ Setting up worktree feature/new-ui…
┗ ☒ Pre-start hooks
   ┗ ☒ npm install
     ☒ cargo build --release
  ⠋ Copying files
   ┗ ⠋ .env.local
     ☐ node_modules/
```

**注意**：在非 TTY 环境（例如 CI/CD）中进度显示会自动关闭，钩子输出将正常展示。

### 环境变量

以下环境变量在所有钩子命令中均可使用：

| 变量                 | 说明                       |
| -------------------- | -------------------------- |
| `VIBE_WORKTREE_PATH` | 所创建 worktree 的绝对路径 |
| `VIBE_ORIGIN_PATH`   | 原始仓库的绝对路径         |

## 安全性

Vibe 遵循 CLI 工具的安全最佳实践：

- **防止 shell 注入**：为 shell 包装函数 `eval` 而输出的 `cd` 行会经过单引号转义（`rust/crates/vibe-core/src/shell.rs`），以防止通过精心构造的目录名进行命令注入。完整协议请参见 [The stdout Eval Contract](docs/specifications/eval-contract.zh.md)
- **不执行 shell 字符串**：子进程通过 `std::process::Command` 以参数数组的方式启动，绝不使用 shell 字符串，因此参数不会被 shell 解释
- **配置信任机制**：对 `.vibe.toml` 与 `.vibe.local.toml` 文件进行 SHA-256 哈希校验
- **路径校验**：所有用户提供的路径在使用前都会经过校验

完整的安全检查清单请参见 [docs/SECURITY_CHECKLIST.zh.md](docs/SECURITY_CHECKLIST.zh.md)。

## 参与贡献

关于开发环境搭建与贡献指南，请参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT —— 请参见 [LICENSE](./LICENSE)。

截至 v2.x（含）的发行版本以 Apache-2.0 许可发布。
MIT 许可证自 v3.0.0 起适用（参见 [#553](https://github.com/kexi/vibe/issues/553)）。
