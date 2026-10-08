# ◈ CunDrop

基于 **Cloudflare Workers + R2 + D1** 的个人网盘 / 图床。无服务器，推送到 GitHub 即自动部署。

## 功能

- 📁 文件库：上传、搜索、删除、存储统计
- ⬆ 上传：浏览器经**预签名 URL 直传 R2**，不经过 Worker 中转，单文件最大 5GB，带实时进度
- 🔗 分享链接 `/f/xxxx`：可设有效期、访问密码、最大查看次数
- 🎬 视频在线播放（支持拖进度，Range 分片）、图片 / 音频预览、一键下载
- 🔒 单密码登录（无注册），HMAC 会话 Cookie
- 🌙 深色高级感 UI

## 架构

```
浏览器 ──静态页面──▶ Worker (src/worker.js)
   │                      ├─ D1 (REST API, 凭证全在 Secrets)
   │                      └─ R2 绑定 (删除/读取/Range 流)
   └─PUT 文件(预签名URL)─▶ R2 (直传, 不经过 Worker)
```

> D1 故意不使用原生绑定，而是经 REST API 访问——这样 `database_id` 等凭证可以全部放在 Secrets 里，公开仓库不暴露任何 ID。

## 部署准备（一次性）

### 1. 创建 R2 存储桶

Cloudflare 后台 → **R2 对象存储** → 创建存储桶，取名 `cundrop`。

**配置 CORS**（部署拿到 Worker 域名后再配，见下方“自动部署”）：在存储桶 → 设置 → CORS 策略，填入：

```json
[
  {
    "AllowedOrigins": ["https://你的Worker域名"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

> Worker 域名形如 `https://cundrop.你的子域名.workers.dev`，部署后可见；也可以绑定自己的域名。
> CORS 配好之前，上传功能会报跨域错误，其他功能不受影响。

### 2. 创建 R2 API Token

R2 页面 → **管理 R2 API 令牌** → 创建令牌：权限选 **对象读写**，指定存储桶 `cundrop`。
记下 **Access Key ID** 和 **Secret Access Key**（只显示一次）。

### 3. 创建 D1 数据库

Cloudflare 后台 → **Workers 和 Pages** → **D1 SQL 数据库** → 创建数据库，取名 `cundrop`。
记下它的 **数据库 ID**（后面填到 Secrets 里）。

表结构会在 Worker 收到首次请求时自动创建，无需手动执行 SQL。

### 4. 创建 D1 API Token

右上角头像 → **API 令牌** → 创建令牌 → **创建自定义令牌**：

- 权限：**帐户** → **D1** → **编辑**
- 帐户资源：包括 → 你的帐户

记下生成的 Token（只显示一次）。

### 5. 设置 Secrets

在 Worker 的 **设置 → 变量和机密** 里添加（或用 `npx wrangler secret put <名字>`）：

| Secret | 说明 |
|---|---|
| `ADMIN_PASSWORD` | 登录密码 |
| `SESSION_SECRET` | 任意随机长字符串（会话签名用） |
| `CF_ACCOUNT_ID` | Cloudflare Account ID（R2 页面右侧） |
| `D1_DATABASE_ID` | 第 3 步 D1 数据库的 ID |
| `D1_API_TOKEN` | 第 4 步的 API Token |
| `R2_ACCESS_KEY_ID` | 第 2 步的 Key ID |
| `R2_SECRET_ACCESS_KEY` | 第 2 步的 Secret |

> 所有需要填的值都在 Secrets 里，`wrangler.toml` 无需修改。

## 自动部署（推荐）

Cloudflare 后台 → **Workers 和 Pages** → **创建** → **连接到 Git**：

1. 选择本仓库 `cundrop`
2. 生产分支：`main`
3. 构建命令：`npm install`
4. 部署命令：`npx wrangler deploy`

之后每次 `git push` 到 main，Cloudflare 自动构建部署，无需任何手动操作。

> 注意：D1 的 `database_id` 和 Secrets 只需配置一次，自动部署不会覆盖它们。

### 手动部署

```bash
npm install
npx wrangler deploy
```

### 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入真实值
npm install
npx wrangler dev                 # 需先 wrangler login
```

## 分享链接说明

- 链接形如 `https://你的域名/f/aB3xYz9QwK2p`
- 可选：有效期（1/7/30 天或永久）、访问密码、最大查看次数
- 有密码的分享：访客输入密码后获得访问凭证才能读取文件流
- 删除文件会连带删除其所有分享链接

## 费用

Cloudflare 免费额度内完全够用：Workers 每天 10 万次请求、R2 10GB 存储、D1 5GB 存储。

## License

MIT
