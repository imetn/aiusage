# CLAUDE.md

## 项目概述

AIUsage — 跨设备 AI 工具用量统计平台。Monorepo 结构，pnpm workspace + Turborepo 管理。

| 包 | 职责 | 技术栈 |
|---|---|---|
| `@aiusage/cli` | 本地扫描 AI 工具用量并上报 | Node 18+, esbuild, ESM |
| `@aiusage/dashboard` | 数据可视化前端 | React 18, Vite, Tailwind CSS |
| `@aiusage/worker` | API 后端 + 静态资源宿主 | Cloudflare Workers, D1 (SQLite) |
| `@aiusage/shared` | 共享类型与常量 | TypeScript 5 |

依赖关系：`cli → shared`，`dashboard → shared`，`worker → dashboard + shared`。

## 目录约定

- `docs/` — 面向用户的文档（部署指南、更新指南等）
- `packages/cli/` — CLI 扫描器
  - `src/scanners/` — 各 AI 工具的扫描器实现（每个工具一个文件）
  - `src/scanners/__tests__/` — 扫描器单元测试
  - `src/__tests__/` — CLI 集成测试（report、project、doctor）
- `packages/dashboard/` — 前端仪表盘
  - `src/components/` — React 组件
  - `src/hooks/` — 自定义 Hook
  - `src/utils/` — 工具函数
  - `src/embed/` — 嵌入式页面入口
- `packages/worker/` — Cloudflare Worker 后端
  - `src/routes/` — API 路由（ingest、overview、breakdowns 等）
  - `src/utils/` — 定价计算、隐私、鉴权等工具
  - `migrations/` — D1 数据库迁移文件
- `packages/shared/` — 跨包共享
  - `src/types.ts` — 核心数据模型与 API 类型定义
  - `src/constants.ts` — 共享常量

## 常用命令

```bash
pnpm install                          # 安装依赖
pnpm --filter @aiusage/cli build      # 构建 CLI
pnpm --filter @aiusage/cli test       # 测试 CLI（vitest）
pnpm --filter @aiusage/dashboard dev  # Dashboard 开发服务器
pnpm --filter @aiusage/dashboard build # 构建 Dashboard
pnpm --filter @aiusage/worker deploy  # 部署 Worker（含预编译）
```

## 代码规范

### Commit 格式

`<emoji> <type>(scope): <中文简短描述>`

可用类型与 emoji：`✨ feat` / `🐛 fix` / `📝 docs` / `♻️ refactor` / `🎨 style` / `⚡ perf` / `🌐 i18n` / `🔧 chore` / `🔧 ci` / `✅ test` / `⬆️ deps` / `🔖 release` / `🚧 wip`

- 中文描述，陈述式，每个 commit 只描述一个主要变更
- 避免"修复了""实现了"等冗余表述

### TypeScript

- 全包启用 `strict` 模式，ESM 格式
- Target: ES2022, moduleResolution: bundler
- 项目无 ESLint/Prettier 配置，保持现有代码风格即可

## 测试

- 框架：vitest 4.x
- 测试文件位置：`src/__tests__/` 或 `src/scanners/__tests__/`
- 时间戳使用 UTC 中午时段（如 `T12:00:00Z`）避免时区跨天问题
- CI 环境为 UTC，本地开发可能是其他时区，测试必须时区无关

## 数据库迁移

- 路径：`packages/worker/migrations/`
- 命名：`NNNN_description.sql`（4 位递增数字前缀）
- 执行：`npx wrangler d1 execute aiusage-db --remote --file=migrations/NNNN_xxx.sql`
- 新增迁移前检查现有编号，避免编号冲突
- `wrangler.jsonc` 不包含 `database_id`，执行远程迁移时需临时写入再删除

## Scanner 开发

CLI 扫描器位于 `packages/cli/src/scanners/`，每个 AI 工具一个文件。

新增 scanner 需同步更新：
1. `scanners/` 下新增扫描器文件及测试
2. `scan.ts` — 导入并注册
3. `project.ts` — 项目发现逻辑
4. `doctor.ts` — 诊断检查
5. `report.ts` — 本地报告（如需）

共享类型定义在 `packages/shared/src/types.ts`，新增字段需同步更新 worker 的 ingest 路由。

部分 scanner 的数据源不提供 token 信息，仅输出 eventCount，token 和费用为 0，这是预期行为：
- **copilot-vscode** — VS Code 日志和 chatSessions JSON 中无 token 字段（`~/.copilot/session-state/` 的 token 数据属于 Copilot CLI，由 `copilot.ts` 扫描）
- **antigravity** — 本地 transcript 可提供逐次用户输入及时间戳，但不提供 token；scanner 优先按 `USER_INPUT` 计数，并以 artifact/browser metadata 作为会话级回退

Activity scanner 还会从 Antigravity transcript 聚合用户消息、工具调用和
subagent 调用；只上传按日计数、工具名和来源，不上传提示词正文或工具参数。

## 定价计算

费用估算**集中维护在 `packages/shared/src/pricing/`**，CLI 端与 Worker 端共用同一份目录，不再有独立副本。

- 类型 / 计算逻辑：`packages/shared/src/pricing/{types,calculate,catalog}.ts`
- 各 provider 数据：`packages/shared/src/pricing/data/<provider>.ts`
- 详见 [`docs/pricing.md`](docs/pricing.md)

特性：
- 支持多币种（USD / CNY，统一折算到 USD）
- 支持阶梯定价（按 input token 数命中档位，Qwen / Gemini 2.5 Pro / GLM 用到）
- 显式 alias 命中算 `exact`；前缀回退算 `estimated`
- Claude Code 数据若 JSONL 自带 `costUSD` 优先采用

新增 scanner 或模型时，只需在 `packages/shared/src/pricing/data/` 下新增 / 更新条目；CI 会自动校验所有 scanner (provider, product) 都能解析。定价版本号在 `catalog.ts` 的 `PRICING_VERSION`。

## 部署

### Dashboard + Worker

CI 自动部署（push to main）：Dashboard 构建 → 静态资源复制到 worker/public/ → wrangler deploy。

需要的 GitHub Secrets：`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`。

### CLI 发布

CI 自动发布（push to main 且版本号变更）：构建 → npm publish。

需要的 GitHub Secret：`NPM_TOKEN`。

发布前更新 `packages/cli/package.json` 中的版本号。
