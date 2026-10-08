/**
 * CunDrop — 基于 Cloudflare Workers + R2 + D1 的个人网盘/图床
 *
 * 架构:
 * - 前端: public/ 静态资源 (Workers Static Assets, run_worker_first)
 * - 文件存储: R2 — 浏览器经预签名 PUT URL 直传, 不经过 Worker 中转
 * - 元数据: D1 — 经 REST API 访问, 不使用原生绑定
 * - 鉴权: 单密码登录, HMAC 会话 Cookie
 * - 部署: 推送到 GitHub 即由 Cloudflare 自动部署 (Workers Git 集成)
 *
 * 需要的绑定与变量 (见 wrangler.toml):
 *   R2  -> R2 bucket 绑定
 *   ASSETS -> 静态资源绑定
 * Secrets (全部在 Cloudflare 后台设置, 不进公开仓库):
 *   ADMIN_PASSWORD / SESSION_SECRET /
 *   CF_ACCOUNT_ID / D1_DATABASE_ID / D1_API_TOKEN /
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
 * Vars: R2_BUCKET
 */
import { AwsClient } from 'aws4fetch';

const COOKIE_NAME = 'cundrop_session';
const SESSION_TTL = 30 * 24 * 3600; // 会话有效期 30 天
const UPLOAD_URL_TTL = 3600; // 预签名上传 URL 有效期 1 小时
const MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024; // R2 单次 PUT 上限 5GB

/* ---------------- D1 (经 REST API 访问) ---------------- */
// 不使用 D1 原生绑定: database_id / account_id / API Token 全部放在 Secrets 里,
// 公开仓库不暴露任何 ID, 部署时 wrangler.toml 里也没有数据库信息
async function d1(env, sql, params = []) {
  if (!env.CF_ACCOUNT_ID || !env.D1_DATABASE_ID || !env.D1_API_TOKEN) {
    throw new Error('D1 的 Secrets 缺失 (CF_ACCOUNT_ID / D1_DATABASE_ID / D1_API_TOKEN)');
  }
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.D1_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    }
  );
  const j = await r.json().catch(() => null);
  if (!j || !j.success) {
    throw new Error('D1 查询失败: ' + JSON.stringify((j && j.errors) || r.status));
  }
  return j.result[0];
}
const d1All = async (env, sql, params = []) => (await d1(env, sql, params)).results || [];
const d1First = async (env, sql, params = []) =>
  ((await d1(env, sql, params)).results || [])[0] || null;
const d1Run = async (env, sql, params = []) => {
  await d1(env, sql, params);
};
// 返回写操作影响的行数 (D1 REST API 的 meta.changes), 用于原子条件更新
const d1Changes = async (env, sql, params = []) => {
  const r = await d1(env, sql, params);
  return (r.meta && r.meta.changes) || 0;
};

/* ---------------- D1 表结构自动初始化 ---------------- */
// Worker 收到首次请求时自动建表, 无需手动执行 schema.sql
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS files (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     r2_key TEXT NOT NULL,
     size INTEGER NOT NULL DEFAULT 0,
     mime TEXT NOT NULL DEFAULT 'application/octet-stream',
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_files_created ON files (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS shares (
     token TEXT PRIMARY KEY,
     file_id TEXT NOT NULL,
     password_hash TEXT,
     expires_at INTEGER,
     max_views INTEGER,
     views INTEGER NOT NULL DEFAULT 0,
     revoked INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_shares_file ON shares (file_id)`,
];
let schemaPromise = null;
function ensureSchema(env) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const sql of SCHEMA_STATEMENTS) await d1Run(env, sql);
      // 兼容已存在的旧表: 补上 revoked 列 (列已存在时会报错, 忽略该特定错误)
      try {
        await d1Run(env, 'ALTER TABLE shares ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0');
      } catch (e) {
        if (!/duplicate column/i.test(String((e && e.message) || e))) throw e;
      }
    })().catch((e) => {
      schemaPromise = null; // 失败则下次重试
      throw e;
    });
  }
  return schemaPromise;
}

const te = new TextEncoder();
const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (s) => hex(await crypto.subtle.digest('SHA-256', te.encode(s)));
async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, te.encode(data)));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function randomToken(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}
// 分享密码哈希: SHA-256(SESSION_SECRET 作 pepper + ':' + 密码)
// pepper 存在 Secrets 里不进仓库, 比无盐哈希能防彩虹表
async function sharePasswordHash(env, password) {
  return sha256Hex(env.SESSION_SECRET + ':' + password);
}
// 分享访问凭证 k: HMAC(SECRET, "share:"+token+":"+exp), 自带过期时间 (M2)
// 格式: "<exp秒>.<sighex>", 前端当不透明字符串透传
const SHARE_K_TTL = 24 * 3600; // 凭证有效期 24 小时, 与分享默认有效期一致
async function shareCredential(env, token) {
  const exp = Math.floor(Date.now() / 1000) + SHARE_K_TTL;
  const sig = await hmacHex(env.SESSION_SECRET, `share:${token}:${exp}`);
  return `${exp}.${sig}`;
}
async function verifyShareCredential(env, token, k) {
  if (!k || typeof k !== 'string') return false;
  const i = k.indexOf('.');
  if (i < 0) return false;
  const exp = parseInt(k.slice(0, i), 10);
  const sig = k.slice(i + 1);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expect = await hmacHex(env.SESSION_SECRET, `share:${token}:${exp}`);
  return timingSafeEqual(expect, sig);
}
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
const err = (message, status = 400) => json({ error: message }, status);

/* ---------------- 会话 ---------------- */

async function createSessionCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const sig = await hmacHex(env.SESSION_SECRET, `v1:${exp}`);
  return (
    `${COOKIE_NAME}=v1:${exp}:${sig}; Path=/; HttpOnly; ` +
    `SameSite=Lax; Max-Age=${SESSION_TTL}; Secure`
  );
}
function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`;
}
async function isAuthed(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)'));
  if (!m) return false;
  const parts = m[1].split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = parseInt(parts[1], 10);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const sig = await hmacHex(env.SESSION_SECRET, `v1:${exp}`);
  return timingSafeEqual(sig, parts[2]);
}
function serveAsset(env, request, url, path) {
  const assetUrl = new URL(url);
  assetUrl.pathname = path;
  return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
}

/* ---------------- R2 预签名上传 URL ---------------- */

async function presignedUploadUrl(env, r2Key) {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto', // R2 固定用 auto
  });
  const url = new URL(
    `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${r2Key}`
  );
  url.searchParams.set('X-Amz-Expires', String(UPLOAD_URL_TTL));
  const signed = await client.sign(url.toString(), {
    method: 'PUT',
    aws: { signQuery: true },
  });
  return signed.url;
}

/* ---------------- API: 鉴权 ---------------- */

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err('请求格式错误', 400);
  }
  const pwd = typeof body.password === 'string' ? body.password : '';
  if (!pwd || !timingSafeEqual(pwd, env.ADMIN_PASSWORD || '')) {
    return err('密码错误', 401);
  }
  const cookie = await createSessionCookie(env);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

/* ---------------- API: 文件 ---------------- */

async function apiFiles(request, env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  let files;
  if (q) {
    files = await d1All(
      env,
      'SELECT id, name, size, mime, created_at FROM files WHERE name LIKE ? ORDER BY created_at DESC LIMIT 500',
      [`%${q}%`]
    );
  } else {
    files = await d1All(
      env,
      'SELECT id, name, size, mime, created_at FROM files ORDER BY created_at DESC LIMIT 500'
    );
  }
  return json({ files });
}

async function apiUploadUrl(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err('请求格式错误', 400);
  }
  const name = String(body.name || '').slice(0, 255).trim();
  const size = Number(body.size);
  const mime = String(body.mime || 'application/octet-stream').slice(0, 127);
  if (!name) return err('缺少文件名', 400);
  if (!Number.isFinite(size) || size <= 0) return err('文件大小无效', 400);
  if (size > MAX_UPLOAD_SIZE) return err('单文件最大 5GB', 400);

  const id = crypto.randomUUID();
  const r2Key = `f/${id}`;
  let uploadUrl;
  try {
    uploadUrl = await presignedUploadUrl(env, r2Key);
  } catch (e) {
    return err('生成上传地址失败: ' + (e.message || '请检查 R2 相关 Secrets'), 500);
  }
  return json({ id, r2_key: r2Key, upload_url: uploadUrl, expires_in: UPLOAD_URL_TTL });
}

async function apiComplete(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err('请求格式错误', 400);
  }
  const id = String(body.id || '');
  const r2Key = String(body.r2_key || '');
  const name = String(body.name || '').slice(0, 255).trim();
  const size = Number(body.size);
  const mime = String(body.mime || 'application/octet-stream').slice(0, 127);
  if (!id || r2Key !== `f/${id}` || !name) return err('参数无效', 400);

  // 确认 R2 上确实有这个对象，防止“假完成”
  let head;
  try {
    head = await env.R2.head(r2Key);
  } catch {
    return err('读取 R2 失败', 500);
  }
  if (!head) return err('R2 中找不到该文件，上传可能未成功', 400);

  const now = Date.now();
  // 大小以 R2 实际存储为准 (防客户端谎报), 拿不到才回退到客户端上报值
  const finalSize =
    head && Number.isFinite(head.size) ? head.size : Number.isFinite(size) ? size : 0;
  await d1Run(
    env,
    'INSERT OR REPLACE INTO files (id, name, r2_key, size, mime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, r2Key, finalSize, mime, now]
  );
  return json({ ok: true, id });
}

async function apiDeleteFile(request, env, url) {
  const id = url.searchParams.get('id');
  if (!id) return err('缺少 id', 400);
  const file = await d1First(env, 'SELECT r2_key FROM files WHERE id = ?', [id]);
  if (!file) return err('文件不存在', 404);
  try {
    await env.R2.delete(file.r2_key);
  } catch {
    return err('删除 R2 对象失败', 500);
  }
  await d1Run(env, 'DELETE FROM shares WHERE file_id = ?', [id]);
  await d1Run(env, 'DELETE FROM files WHERE id = ?', [id]);
  return json({ ok: true });
}

async function apiStats(env) {
  const row = await d1First(
    env,
    'SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM files'
  );
  const shares = await d1First(env, 'SELECT COUNT(*) AS n FROM shares');
  return json({ count: row.n || 0, bytes: row.s || 0, shares: shares.n || 0 });
}

/* 自检: 每个 Secret 是否存在 + D1/R2 连接是否正常 (只返回布尔值, 不泄露值) */
async function apiHealth(env) {
  const names = [
    'ADMIN_PASSWORD',
    'SESSION_SECRET',
    'CF_ACCOUNT_ID',
    'D1_DATABASE_ID',
    'D1_API_TOKEN',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ];
  const secrets = {};
  for (const k of names) secrets[k] = !!env[k];
  let d1ok = false,
    d1err = '';
  try {
    await d1First(env, 'SELECT 1 AS ok');
    d1ok = true;
  } catch (e) {
    d1err = String((e && e.message) || e).slice(0, 160);
  }
  let r2ok = false,
    r2err = '';
  try {
    await env.R2.list({ limit: 1 });
    r2ok = true;
  } catch (e) {
    r2err = String((e && e.message) || e).slice(0, 160);
  }
  return json({ secrets, d1: { ok: d1ok, error: d1err }, r2: { ok: r2ok, error: r2err } });
}

/* ---------------- API: 分享 ---------------- */

async function apiListShares(env) {
  const rows = await d1All(
    env,
    `SELECT s.token, s.file_id, s.password_hash, s.expires_at, s.max_views, s.views,
            s.revoked, s.created_at, f.name, f.size, f.mime
     FROM shares s JOIN files f ON f.id = s.file_id
     ORDER BY s.created_at DESC LIMIT 500`
  );
  const shares = rows.map((s) => ({
    token: s.token,
    file_id: s.file_id,
    name: s.name,
    size: s.size,
    mime: s.mime,
    has_password: !!s.password_hash,
    expires_at: s.expires_at,
    max_views: s.max_views,
    views: s.views,
    revoked: !!s.revoked,
    created_at: s.created_at,
  }));
  return json({ shares });
}

async function apiCreateShare(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err('请求格式错误', 400);
  }
  const fileId = String(body.file_id || '');
  if (!fileId) return err('缺少 file_id', 400);
  const file = await d1First(env, 'SELECT id FROM files WHERE id = ?', [fileId]);
  if (!file) return err('文件不存在', 404);

  // 有效期: 优先 expires_in_hours (小时), 兼容旧的 expires_in_days
  const hours = Number(body.expires_in_hours);
  const days = Number(body.expires_in_days);
  let expiresAt = null;
  if (Number.isFinite(hours) && hours > 0) {
    expiresAt = Date.now() + Math.floor(hours) * 3600000;
  } else if (Number.isFinite(days) && days > 0) {
    expiresAt = Date.now() + days * 86400000;
  }
  // 最大查看次数: 默认 1 次 (按单核销), 不填/非法值也按 1 处理
  const maxViews =
    Number.isFinite(Number(body.max_views)) && Number(body.max_views) > 0
      ? Math.floor(Number(body.max_views))
      : 1;
  const password = String(body.password || '');
  if (!password || password.length < 6) return err('分享密码必填，至少 6 位', 400);
  const passwordHash = password ? await sharePasswordHash(env, password) : null;

  const token = randomToken(12);
  await d1Run(
    env,
    'INSERT INTO shares (token, file_id, password_hash, expires_at, max_views, views, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [token, fileId, passwordHash, expiresAt, maxViews, Date.now()]
  );
  return json({ token });
}

async function apiDeleteShare(env, url) {
  const token = url.searchParams.get('token');
  if (!token) return err('缺少 token', 400);
  await d1Run(env, 'DELETE FROM shares WHERE token = ?', [token]);
  return json({ ok: true });
}

// 作废分享: 买家立即无法访问 (k 凭证虽未过期, 但 revoked 会被 /file 拒绝)
async function apiRevokeShare(env, url) {
  const token = url.searchParams.get('token');
  if (!token) return err('缺少 token', 400);
  await d1Run(env, 'UPDATE shares SET revoked = 1 WHERE token = ?', [token]);
  return json({ ok: true });
}

// 重启分享: 取消作废、查看次数清零、有效期重置为 24 小时
async function apiReactivateShare(env, url) {
  const token = url.searchParams.get('token');
  if (!token) return err('缺少 token', 400);
  await d1Run(env, 'UPDATE shares SET revoked = 0, views = 0, expires_at = ? WHERE token = ?', [
    Date.now() + 24 * 3600000,
    token,
  ]);
  return json({ ok: true });
}

/* ---------------- 分享页 (公开) ---------------- */

// 原始分享记录 (含 revoked), 不做有效性判断
async function lookupShare(env, token) {
  return d1First(
    env,
    `SELECT s.token, s.file_id, s.password_hash, s.expires_at, s.max_views, s.views,
            s.revoked, s.created_at, f.name, f.r2_key, f.size, f.mime
     FROM shares s JOIN files f ON f.id = s.file_id WHERE s.token = ?`,
    [token]
  );
}
// 分享不可用的原因: null=可用
// allowExhausted=true 时, 次数用完不算不可用 (用于 /file: k 凭证已证明完成过一次核销)
function shareInvalidReason(share, opts = {}) {
  if (!share) return 'missing';
  if (share.revoked) return 'revoked';
  if (share.expires_at && share.expires_at < Date.now()) return 'expired';
  if (!opts.allowExhausted && share.max_views && share.views >= share.max_views)
    return 'exhausted';
  return null;
}
async function getValidShare(env, token, opts = {}) {
  const share = await lookupShare(env, token);
  return shareInvalidReason(share, opts) ? null : share;
}
const SHARE_ERR_MSG = {
  missing: '分享不存在',
  expired: '分享已过期',
  exhausted: '该分享的查看次数已用完',
  revoked: '该分享已被作废',
};
async function shareErrFor(env, token, opts = {}) {
  const share = await lookupShare(env, token);
  const reason = shareInvalidReason(share, opts);
  const status = reason === 'missing' || reason === 'expired' ? 404 : 403;
  return err(SHARE_ERR_MSG[reason] || '分享不可用', status);
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null) {
    start = size - end;
    end = size - 1;
  }
  if (!Number.isFinite(start) || start < 0) return null;
  if (end === null || end >= size) end = size - 1;
  if (start >= size || start > end) return null;
  return { start, end, length: end - start + 1 };
}

async function handleShare(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['f', token] 或 ['f', token, 'info'...]
  const token = parts[1];
  const action = parts[2]; // undefined | 'info' | 'unlock' | 'file'
  if (!token) return new Response('Not Found', { status: 404 });

  // 分享页 HTML
  if (!action && request.method === 'GET') {
    const share = await lookupShare(env, token);
    const reason = shareInvalidReason(share);
    if (reason) {
      const status = reason === 'missing' || reason === 'expired' ? 404 : 403;
      return new Response(SHARE_ERR_MSG[reason], {
        status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    return serveAsset(env, request, url, '/share.html');
  }

  // 分享元信息
  if (action === 'info' && request.method === 'GET') {
    const share = await getValidShare(env, token);
    if (!share) return shareErrFor(env, token);
    return json({
      name: share.name,
      size: share.size,
      mime: share.mime,
      views: share.views,
      needs_password: !!share.password_hash,
    });
  }

  // 密码解锁 → 原子计数一次核销 → 返回访问凭证 k (H1)
  // 解锁即核销: /file 只做校验不再计数, 因此 <img>/video 预加载不会误消耗次数
  if (action === 'unlock' && request.method === 'POST') {
    const share = await getValidShare(env, token);
    if (!share) return shareErrFor(env, token);
    if (share.password_hash) {
      let body;
      try {
        body = await request.json();
      } catch {
        return err('请求格式错误', 400);
      }
      const ok = timingSafeEqual(
        await sharePasswordHash(env, String(body.password || '')),
        share.password_hash
      );
      if (!ok) return err('密码错误', 403);
    }
    // 原子核销: 仅当未作废、未过期、还有剩余次数时计数成功。
    // 并发下只有一个请求能拿到 changes=1, 防止超发 (D1 单写串行, 条件更新是原子的)。
    const changed = await d1Changes(
      env,
      `UPDATE shares SET views = views + 1 WHERE token = ?
       AND (revoked IS NULL OR revoked = 0)
       AND (expires_at IS NULL OR expires_at > ?)
       AND (max_views IS NULL OR views < max_views)`,
      [token, Date.now()]
    );
    if (changed < 1) return shareErrFor(env, token);
    const k = await shareCredential(env, token);
    return json({ ok: true, k });
  }

  // 文件流 (支持 Range 断点续传 / 视频拖进度)
  // 只校验不计数: k 凭证即"已完成一次核销"的证明; 次数用完的分享凭有效 k 仍可下载,
  // 但作废 / 过期的分享即使有 k 也拒绝
  if (action === 'file' && request.method === 'GET') {
    const share = await getValidShare(env, token, { allowExhausted: true });
    if (!share) return shareErrFor(env, token, { allowExhausted: true });
    const k = url.searchParams.get('k') || '';
    if (!(await verifyShareCredential(env, token, k))) return err('无权访问', 403);
    const range = parseRange(request.headers.get('Range'), share.size);
    let obj;
    try {
      obj = range
        ? await env.R2.get(share.r2_key, {
            range: { offset: range.start, length: range.length },
          })
        : await env.R2.get(share.r2_key);
    } catch {
      return err('读取文件失败', 500);
    }
    if (!obj) return err('文件不存在', 404);

    const download = url.searchParams.get('download') === '1';
    const filename = encodeURIComponent(share.name).replace(/['()]/g, escape);
    const headers = {
      'Content-Type': share.mime || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(range ? range.length : share.size),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${filename}`,
    };
    let status = 200;
    if (range) {
      status = 206;
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${share.size}`;
    }
    return new Response(obj.body, { status, headers });
  }

  return new Response('Not Found', { status: 404 });
}

/* ---------------- 主路由 ---------------- */

export default {
  async fetch(request, env, ctx) {
    // D1 自动建表 (每个实例只执行一次, 失败不阻断静态资源访问)
    try {
      await ensureSchema(env);
    } catch (e) {
      console.error('D1 schema init failed:', e);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 首页: 登录后进面板, 否则去登录页
    if (path === '/') {
      if (await isAuthed(request, env)) return serveAsset(env, request, url, '/app.html');
      return Response.redirect(new URL('/login.html', url).toString(), 302);
    }
    if (path === '/login.html' && (await isAuthed(request, env))) {
      return Response.redirect(new URL('/', url).toString(), 302);
    }

    // 登录 / 登出
    if (path === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }
    if (path === '/api/logout') {
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/login.html',
          'Set-Cookie': clearSessionCookie(),
        },
      });
    }

    // 分享 (公开)
    if (path === '/f' || path.startsWith('/f/')) {
      return handleShare(request, env, url);
    }

    // 需要登录的 API
    if (path.startsWith('/api/')) {
      if (!(await isAuthed(request, env))) return err('未登录', 401);
      if (path === '/api/files' && request.method === 'GET') return apiFiles(request, env, url);
      if (path === '/api/upload-url' && request.method === 'POST') return apiUploadUrl(request, env);
      if (path === '/api/files/complete' && request.method === 'POST') return apiComplete(request, env);
      if (path === '/api/files' && request.method === 'DELETE') return apiDeleteFile(request, env, url);
      if (path === '/api/stats' && request.method === 'GET') return apiStats(env);
      if (path === '/api/health' && request.method === 'GET') return apiHealth(env);
      if (path === '/api/shares' && request.method === 'GET') return apiListShares(env);
      if (path === '/api/shares' && request.method === 'POST') return apiCreateShare(request, env);
      if (path === '/api/shares' && request.method === 'DELETE') return apiDeleteShare(env, url);
      if (path === '/api/shares/revoke' && request.method === 'POST')
        return apiRevokeShare(env, url);
      if (path === '/api/shares/reactivate' && request.method === 'POST')
        return apiReactivateShare(env, url);
      return err('未知接口', 404);
    }

    // 管理面板页面与脚本需要登录 (登录页 / 分享页 / 公共样式保持公开, L1)
    if (
      (path === '/app.html' || path === '/js/app.js') &&
      !(await isAuthed(request, env))
    ) {
      return Response.redirect(new URL('/login.html', url).toString(), 302);
    }

    // 其余走静态资源
    return env.ASSETS.fetch(request);
  },
};
