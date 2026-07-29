> [!NOTE]
> :us: [English](./SECURITY_CHECKLIST.md) | :jp: [日本語版](./SECURITY_CHECKLIST.ja.md)

# CLI 安全检查清单

这是 vibe CLI 工具的一份全面安全检查清单。每个类别都记录了本项目所采用的缓解措施。

## 1. 命令注入

- **风险**：通过未经净化的用户输入执行任意命令
- **缓解措施**：使用带数组参数的 `spawn()`（绝不拼接 shell 字符串）
- **强制手段**：ESLint `security/detect-child-process` + 自定义安全检查脚本

## 2. 路径穿越

- **风险**：通过 `../` 序列访问预期目录之外的文件
- **缓解措施**：`validate_path`（`rust/crates/vibe-core/src/copy/types.rs`）以及 `repo_info.rs` 中的 canonicalize + 包含性检查，将路径限制在预期边界内
- **强制手段**：代码审查 + 运行时校验

## 3. 符号链接攻击

- **风险**：跟随符号链接访问/修改非预期的文件
- **缓解措施**：`std::fs::canonicalize` 解析 + 包含性检查（两侧均做 canonicalize）；glob 展开会拒绝符号链接条目
- **强制手段**：在文件操作前进行运行时校验

## 4. TOCTOU（检查时到使用时）竞态

- **风险**：文件状态在安全检查与实际使用之间发生变化
- **缓解措施**：`verify_trust_and_read`（`rust/crates/vibe-core/src/settings_io.rs`）只读取文件一次，并对这份完全相同的内容计算哈希（不会重新读取）
- **强制手段**：信任校验中的架构性模式

## 5. 环境变量注入

- **风险**：环境变量中的恶意取值影响程序行为
- **缓解措施**：受控的环境变量合并，配合显式的允许列表
- **强制手段**：代码审查

## 6. 终端转义序列注入

- **风险**：输出中的恶意转义序列操纵终端显示
- **缓解措施**：对面向用户的输出过滤控制字符
- **强制手段**：输出净化工具函数

## 7. 参数注入（`--` 选项注入）

- **风险**：用户输入被当作命令行选项解释（例如 `--exec`）
- **缓解措施**：使用显式的参数数组（而非字符串拼接）
- **强制手段**：`spawn()` 数组模式 + 代码审查

## 8. 供应链攻击

- **风险**：上游包被投毒、恶意的生命周期脚本、从构建 runner 中窃取数据，或发布令牌被劫持 —— 参见例如 [TanStack npm compromise (2026-05-11)](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem)
- **缓解措施**（分层）：
  - **registry 加固**：Takumi Guard 代理（`.github/actions/setup-takumi-guard`）拦截已知的恶意包；`pnpm-workspace.yaml` 中的 `minimumReleaseAge: 4320`（72 小时）隔离期会阻止刚刚发布的版本
  - **不使用非常规来源**：`blockExoticSubdeps: true` 会在依赖图的任何位置拒绝 `github:user/repo`、`file:`、`http:` 等非 registry 依赖（可挫败可蠕虫化的 `optionalDependencies: github:<sha>` 手法）
  - **默认关闭生命周期脚本**：`strictDepBuilds: true` + 显式的 `only-built-dependencies` 允许列表（目前仅有 `node-pty`，参见 `.npmrc`）；CI 中每次调用 `pnpm install` 和 `pnpm publish` 都带 `--ignore-scripts`
  - **信任单调性**：`trustPolicy: no-downgrade` 会在某个包转变为信任度更低的状态时中止安装
  - **锁文件固定**：CI 中的每个安装步骤都使用 `--frozen-lockfile`
  - **工作流完整性**：所有第三方 GitHub Actions 均固定到完整的 commit SHA（`pinact-verify` job 会阻止未固定的引用）；工具链通过 `flake.lock` 可复现地固定（Rust 则通过 `rust-toolchain.toml`）
  - **Runner 出站流量可见性**：每个 job 上的 `step-security/harden-runner`（审计模式）会记录出站网络流量与 `/proc` 访问，从而暴露诸如 Shai-Hulud 所使用的 `*.getsession.org` C2 这类数据外泄通道
  - **发布来源证明**：每次发布都使用 `npm publish --provenance`，以获得 OIDC 签名的证明
  - **密钥扫描**：`gitleaks`（配置文件 `.gitleaks.toml`）阻止凭据进入仓库 —— 在 `pre-commit` 钩子（`lefthook.yml`）中扫描暂存的更改，并在 `gitleaks` CI job 中扫描完整历史
- **强制手段**：`pinact-verify` CI job + CI 中的 `pnpm install --frozen-lockfile --ignore-scripts` + `pnpm publish ... --ignore-scripts` + `gitleaks` CI job + 每次发布后审查 Harden-Runner Insights

### 应对 gitleaks 检出

gitleaks 命中意味着该密钥已经进入工作区或 git 历史，必须视为已经泄露：

1. **立即轮换**：在做任何其他事情之前，先在来源方（服务提供商）吊销/轮换泄露的凭据 —— 一旦提交就必须假定它已经公开。
2. **从历史中清除**：可以考虑重写历史（例如 `git filter-repo`）来移除该密钥，但要认识到无论如何旧值都已处于泄露状态。
3. **仅对误报使用允许列表**：只有当匹配项确实不是密钥时，才在 `.gitleaks.toml` 中添加取值/正则条目 —— 绝不能用它来掩盖真实的泄露。

## 9. 不安全的临时文件创建

- **风险**：可预测的临时文件名会使符号链接攻击成为可能
- **缓解措施**：基于 UUID 的命名 + 原子性的 rename 操作
- **强制手段**：代码审查 + fast-remove 的实现

## 10. Shell 输出注入

- **风险**：包含特殊字符（例如单引号）的路径在被 `eval` 时导致 shell 注入
- **缓解措施**：`shell_escape()`（`rust/crates/vibe-core/src/shell.rs`）会对所有 `cd` 输出中的单引号进行转义
- **强制手段**：自定义安全检查脚本会检测未转义的 `cd` 模式
- **参考**：完整协议规范：[specifications/eval-contract.zh.md](specifications/eval-contract.zh.md)

## 11. 配置文件投毒

- **风险**：恶意的 `.vibe.toml` 通过钩子执行任意命令
- **缓解措施**：SHA-256 信任机制 —— 配置必须先被显式信任，钩子才会执行
- **强制手段**：`trust`/`untrust`/`verify` 命令 + 哈希校验

## 12. 不安全的正则表达式（ReDoS）

- **风险**：存在灾难性回溯的正则表达式导致拒绝服务
- **缓解措施**：ESLint `security/detect-unsafe-regex` 规则
- **强制手段**：CI 中的 ESLint + pre-commit 检查

## 13. eval / 动态代码执行

- **风险**：执行动态构造的代码会导致任意代码执行
- **缓解措施**：生产代码中不使用 `eval()` 或 `new Function()`
- **强制手段**：ESLint `security/detect-eval-with-expression` + 自定义安全检查脚本
- **备注**：shell 包装函数本身会按设计 `eval` vibe 输出的 `cd` 内容；该输出经过单引号转义（参见上文的“Shell 输出注入”）。完整协议规范：[specifications/eval-contract.zh.md](specifications/eval-contract.zh.md)

---

## 自动化强制手段

| 工具                  | 范围       | 时机                                                    |
| --------------------- | ---------- | ------------------------------------------------------- |
| ESLint security 插件  | 静态分析   | `pnpm run lint`                                         |
| 自定义安全脚本        | 模式匹配   | `pnpm run security:check`                               |
| Claude Code 钩子      | 编辑时检查 | PostToolUse (Write/Edit)                                |
| CI security-check job | PR 门禁    | 每次 push/PR                                            |
| gitleaks              | 密钥扫描   | `pre-commit`（暂存内容）+ CI `gitleaks` job（完整历史） |
