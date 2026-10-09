/* CunDrop 面板逻辑 (Cloudflare Workers 版) */
const $ = (s) => document.querySelector(s);
let FILES = [], SHARES = [];
// 卖家微信号：新建分享时自动填入密码框；修改后记得同步 public/share.html 里的展示
const SELLER_WECHAT = "dszl100";

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2200);
}
function fmtSize(n) {
  n = +n || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
function fmtDate(ms) {
  return new Date(+ms || 0).toLocaleString("zh-CN", { hour12: false }).slice(0, 16);
}
function kindOf(mime) {
  mime = mime || "";
  if (mime.startsWith("video")) return "video";
  if (mime.startsWith("image")) return "image";
  if (mime.startsWith("audio")) return "audio";
  return "file";
}
async function api(url, opt = {}) {
  const r = await fetch(url, opt);
  if (r.status === 401) { location.href = "/login.html"; throw new Error("未登录"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("请求失败 " + r.status));
  return j;
}
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, "&quot;"); }

/* ---------- 视图切换 ---------- */
document.querySelectorAll(".nav-item").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    $("#view-" + b.dataset.view).classList.remove("hidden");
    if (b.dataset.view === "shares") loadShares();
    if (b.dataset.view === "settings") loadSysinfo();
  })
);

/* ---------- 文件库 ---------- */
async function loadFiles() {
  const q = $("#search").value.trim();
  const j = await api("/api/files" + (q ? "?q=" + encodeURIComponent(q) : ""));
  FILES = j.files;
  renderFiles();
  const st = await api("/api/stats");
  $("#storageText").textContent = `${st.count} 个文件 · 共 ${fmtSize(st.bytes)} · ${st.shares} 个分享`;
  $("#storageBar").style.width = Math.min(100, st.count) + "%";
}
function renderFiles() {
  $("#emptyFiles").classList.toggle("hidden", FILES.length > 0);
  $("#fileList").innerHTML = FILES.map((f) => `
    <div class="file-row">
      <div class="file-icon ${kindOf(f.mime)}"></div>
      <div class="file-info">
        <div class="file-name">${esc(f.name)}</div>
        <div class="file-sub">${fmtSize(f.size)} · ${fmtDate(f.created_at)}</div>
      </div>
      <div class="file-actions">
        <button class="btn primary" onclick="openShare('${f.id}', '${escAttr(f.name)}')">分享</button>
        <button class="btn danger" onclick="delFile('${f.id}')">删除</button>
      </div>
    </div>`).join("");
}
$("#search").addEventListener("input", () => {
  clearTimeout($("#search")._t);
  $("#search")._t = setTimeout(loadFiles, 300);
});

async function delFile(id) {
  if (!confirm("确定删除这个文件吗？R2 上的源文件也会一起删除。")) return;
  await api("/api/files?id=" + encodeURIComponent(id), { method: "DELETE" });
  toast("已删除");
  loadFiles();
}

/* ---------- 上传（预签名 URL 直传 R2，带进度） ---------- */
const dz = $("#dropzone"), fi = $("#fileInput");
$("#uploadBtn").onclick = () => fi.click();
dz.onclick = () => fi.click();
["dragover", "dragenter"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (ev) => uploadMany(ev.dataTransfer.files));
fi.addEventListener("change", () => { uploadMany(fi.files); fi.value = ""; });

async function uploadMany(files) {
  for (const f of files) uploadOne(f);
}
function uploadOne(file) {
  const box = document.createElement("div");
  box.className = "up-item";
  box.innerHTML = `<div class="up-top"><span>${esc(file.name)}</span><span class="pct">准备…</span></div><div class="up-bar"><i></i></div>`;
  $("#uploadList").prepend(box);
  const bar = box.querySelector(".up-bar i"), pct = box.querySelector(".pct");

  (async () => {
    // 1. 拿预签名上传地址
    const init = await api("/api/upload-url", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size, mime: file.type || "application/octet-stream" }),
    });
    // 2. 浏览器直传 R2（不经过 Worker）
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", init.upload_url);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.round((e.loaded / e.total) * 100);
          bar.style.width = p + "%"; pct.textContent = p + "%";
        }
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("R2 返回 " + xhr.status)));
      xhr.onerror = () => reject(new Error("网络错误"));
      xhr.send(file);
    });
    // 3. 确认入库
    await api("/api/files/complete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: init.id, r2_key: init.r2_key, name: file.name, size: file.size, mime: file.type || "application/octet-stream" }),
    });
    box.classList.add("done"); pct.textContent = "完成 ✓";
    setTimeout(() => box.remove(), 2500);
    loadFiles();
  })().catch((e) => {
    box.classList.add("error"); pct.textContent = "失败";
    const x = document.createElement("button");
    x.className = "up-x"; x.textContent = "✕"; x.title = "关闭";
    x.onclick = () => box.remove();
    box.querySelector(".up-top").appendChild(x);
    toast("上传失败：" + e.message);
  });
}

/* ---------- 分享 ---------- */
let shareFileId = null;
function openShare(id, name) {
  shareFileId = id;
  $("#shareFileName").textContent = name;
  $("#shareResult").classList.add("hidden");
  $("#sharePwd").value = SELLER_WECHAT;
  $("#shareViews").value = "1";
  $("#shareModal").classList.remove("hidden");
}
$("#shareCancel").onclick = () => $("#shareModal").classList.add("hidden");
$("#shareCreate").onclick = async () => {
  try {
    const pwd = $("#sharePwd").value;
    if (!pwd || pwd.length < 6) { toast("分享密码必填，至少 6 位"); return; }
    const hours = $("#shareExpire").value ? +$("#shareExpire").value : null;
    const maxViews = $("#shareViews").value ? +$("#shareViews").value : 1;
    const j = await api("/api/shares", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: shareFileId,
        expires_in_hours: hours,
        max_views: maxViews,
        password: pwd,
      }),
    });
    $("#shareUrl").value = location.origin + "/f/" + j.token;
    $("#shareResult").classList.remove("hidden");
    loadShares();
  } catch (e) { toast(e.message); }
};
$("#copyBtn").onclick = async () => {
  await navigator.clipboard.writeText($("#shareUrl").value);
  toast("链接已复制");
};

async function loadShares() {
  const j = await api("/api/shares");
  SHARES = j.shares;
  $("#emptyShares").classList.toggle("hidden", SHARES.length > 0);
  $("#shareList").innerHTML = SHARES.map((s) => {
    const exp = s.expires_at ? fmtDate(s.expires_at) + " 到期" : "永久有效";
    const gone = s.expires_at && s.expires_at < Date.now();
    const usedUp = s.max_views && s.views >= s.max_views;
    return `
    <div class="file-row">
      <div class="file-icon ${kindOf(s.mime)}"></div>
      <div class="file-info">
        <div class="file-name">${esc(s.name)}
          ${s.has_password ? '<span class="tag pwd">密码</span>' : ""}
          ${s.revoked ? '<span class="tag rev">已作废</span>' : ""}
          ${!s.revoked && gone ? '<span class="tag exp">已过期</span>' : ""}
          ${!s.revoked && !gone && usedUp ? '<span class="tag exp">次数用完</span>' : ""}
        </div>
        <div class="file-sub"><a href="/f/${s.token}" target="_blank">/f/${s.token}</a> · ${exp}${s.max_views ? " · 最多 " + s.max_views + " 次" : ""} · ${s.views} 次查看</div>
      </div>
      <div class="file-actions">
        <button class="btn" onclick="copyShare('${s.token}')">复制</button>
        ${s.revoked
          ? `<button class="btn primary" onclick="reactivateShare('${s.token}')">重启</button>`
          : `<button class="btn" onclick="revokeShare('${s.token}')">作废</button>`}
        <button class="btn danger" onclick="delShare('${s.token}')">删除</button>
      </div>
    </div>`;
  }).join("");
}
async function copyShare(token) {
  await navigator.clipboard.writeText(location.origin + "/f/" + token);
  toast("链接已复制");
}
async function delShare(token) {
  if (!confirm("删除这个分享链接？文件本身不受影响。")) return;
  await api("/api/shares?token=" + encodeURIComponent(token), { method: "DELETE" });
  toast("已删除"); loadShares();
}
async function revokeShare(token) {
  if (!confirm("作废这个分享链接？作废后买家立即无法访问, 可随时重启恢复。")) return;
  await api("/api/shares/revoke?token=" + encodeURIComponent(token), { method: "POST" });
  toast("已作废"); loadShares();
}
async function reactivateShare(token) {
  if (!confirm("重启这个分享链接？将取消作废、查看次数清零、有效期重置为 24 小时。")) return;
  await api("/api/shares/reactivate?token=" + encodeURIComponent(token), { method: "POST" });
  toast("已重启, 有效期 24 小时"); loadShares();
}

/* ---------- 设置 ---------- */
async function loadSysinfo() {
  const box = $("#sysinfo");
  const labels = {
    ADMIN_PASSWORD: "登录密码",
    SESSION_SECRET: "会话密钥",
    CF_ACCOUNT_ID: "Cloudflare 账户 ID",
    D1_DATABASE_ID: "D1 数据库 ID",
    D1_API_TOKEN: "D1 API Token",
    R2_ACCESS_KEY_ID: "R2 Key ID",
    R2_SECRET_ACCESS_KEY: "R2 Secret",
  };
  try {
    const h = await api("/api/health");
    let html = "";
    for (const [k, label] of Object.entries(labels)) {
      html += `<div class="health-row">${h.secrets[k] ? "✅" : "❌"} ${label} <code>${k}</code></div>`;
    }
    html += `<div class="health-row">${h.d1.ok ? "✅" : "❌"} D1 数据库连接${h.d1.ok ? "" : "——" + esc(h.d1.error)}</div>`;
    html += `<div class="health-row">${h.r2.ok ? "✅" : "❌"} R2 存储桶连接${h.r2.ok ? "" : "——" + esc(h.r2.error)}</div>`;
    box.innerHTML = html;
  } catch (e) {
    box.textContent = "❌ " + e.message;
  }
}

loadFiles();
