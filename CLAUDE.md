# CLAUDE.md - Podcast Digest 项目经验总结

## 项目概述
自动化播客内容处理系统：RSS抓取 → 音频下载 → Whisper转录 → GPT-4o分析 → Markdown生成 → 邮件推送
技术栈：TypeScript + Node.js + Express + SQLite + OpenAI API

## 关键经验和教训

### 1. 云平台部署（Railway）
- **Railway 封锁 SMTP 出站端口**（465/587 都不行），这是防垃圾邮件的常见策略。解决方案：使用 HTTP API 邮件服务（如 Resend）代替直接 SMTP 连接
- **Railway 的 IPv6 问题**：Railway 容器默认优先 IPv6，但 IPv6 连接外部服务经常失败（ENETUNREACH）。必须在代码中设置 `dns.setDefaultResultOrder('ipv4first')` 全局强制 IPv4
- **Railway 的 PORT 环境变量**：Railway 动态分配端口，服务器必须读取 `process.env.PORT`，不能硬编码端口号
- **Railway Volume**：SQLite 数据库必须存储在 Volume 挂载路径中，否则每次重新部署数据会丢失。Volume 需要 Hobby 计划（$5/月）
- **GitHub 认证**：GitHub 不再支持密码认证 Git 操作，必须使用 Personal Access Token（Settings → Developer Settings → Tokens）
- **启动脚本需要先杀旧进程**：`start.sh` 必须先 `kill` 旧的 PID 并 `lsof -ti:PORT | xargs kill -9`，否则端口占用导致启动失败

### 2. TypeScript 类型问题
- **rss-parser 的 customFields 类型不兼容**：解决方案是用 `new (Parser as any)({...})` 绕过类型检查
- **Express 5 的 req.params 返回 `string | string[]`**：需要写 helper 函数 `param(req, name)` 统一处理
- **nodemailer 的 `family: 4` 选项不在类型定义中**：用 `as any` 类型断言绕过
- **第三方库类型不完整时**：优先用 `any` 断言快速解决，不要在类型体操上浪费时间

### 3. 异步处理架构
- **HTTP 端点不能同步等待长任务**：播客处理每集需要几分钟（下载+转录+分析），HTTP 端点必须立即返回 taskLogId，后台异步处理，前端轮询状态
- **轮询模式**：前端用 `setInterval` 每5秒查询任务状态，超时10分钟自动停止。比 WebSocket 简单得多
- **p-limit 控制并发**：多个播客同时处理时用 `p-limit(5)` 限制并发数，避免 API 限流

### 4. 音频处理
- **OpenAI Whisper API 限制 25MB**：必须用 ffmpeg 先压缩（16kHz mono 32kbps），超过25MB 的还要分割成多个 chunk
- **ffmpeg 命令**：`ffmpeg -i input -ar 16000 -ac 1 -b:a 32k output`，压缩率通常 70%+
- **Dockerfile 中必须安装 ffmpeg**：`apt-get install -y ffmpeg`

### 5. OpenAI API 使用
- **GPT-4o 分析用 JSON 模式**：`response_format: { type: 'json_object' }`，prompt 中明确要求输出 JSON 格式
- **max_tokens 要给足**：复杂的4部分内容分析（摘要+要点+关键词+长版纪要）需要 16000 tokens
- **超时设置**：OpenAI 客户端超时设为 300000ms（5分钟），长音频转录需要时间
- **重试机制**：所有 API 调用用指数退避 + 抖动重试（baseDelay 10s，maxAttempts 3）

### 6. 定时任务
- **node-cron 支持时区**：直接用 `timezone: 'Asia/Shanghai'`，cron 表达式就按该时区解释，不需要手动 UTC 转换
- **时间窗口设计**：凌晨2点处理新剧集（`0 2 * * *`），早上8点发邮件（`0 8 * * *`），确保处理完成后再发
- **手动触发 vs 定时触发**：手动触发处理所有 pending 剧集，定时触发只处理过去24小时发布的新剧集（`useTimeWindow` 参数区分）

### 7. 邮件功能
- **邮件服务需要双通道设计**：本地用 SMTP（Gmail 应用密码），云端用 HTTP API（Resend）。通过 `EMAIL_PROVIDER` 环境变量切换
- **Resend 免费账号限制**：每月100封，发件人只能用 `onboarding@resend.dev`（除非绑定自定义域名）
- **Gmail 应用密码**：需要在 Google 账号设置中开启2FA后，在 myaccount.google.com/apppasswords 生成16位专用密码
- **HTML 邮件中的可展开内容**：用 `<details><summary>` 标签实现，大多数邮件客户端支持

### 8. 数据库设计
- **SQLite WAL 模式**：`PRAGMA journal_mode = WAL` 提升并发读写性能
- **字段复用**：当需要存储新数据结构但不想改表结构时，可以复用现有列（如 `arguments` 列存 keywords JSON，`knowledge_points` 列存 fullRecap 文本）
- **状态流转**：episode 状态 pending → processing → completed/failed，查询时按状态过滤

### 9. 前端设计
- **纯 vanilla JS SPA**：不需要框架，用 hash 路由 + 模块化对象（App 对象）足够
- **marked.js 渲染 Markdown**：引入 CDN 版本即可，`marked.parse(content)` 直接转 HTML
- **Toast 通知**：用 CSS 动画 + setTimeout 自动移除，简洁高效

## 项目文件结构
```
src/
  config/index.ts          # 环境变量配置
  database/schema.ts       # SQLite 表结构
  database/index.ts        # 数据库 CRUD
  rss/discovery.ts         # iTunes 搜索 + OPML 解析
  rss/parser.ts            # RSS feed 解析
  audio/downloader.ts      # 音频下载
  audio/processor.ts       # ffmpeg 压缩/分割
  transcription/whisper.ts # Whisper API
  analysis/prompts.ts      # GPT-4o prompt
  analysis/index.ts        # 内容分析
  markdown/index.ts        # Markdown 生成
  email/index.ts           # 邮件发送（SMTP + Resend 双通道）
  pipeline/processor.ts    # 处理流水线
  scheduler/index.ts       # 定时任务
  web/routes.ts            # API 路由
  server.ts                # Express 服务器
public/                    # 前端静态文件
```
