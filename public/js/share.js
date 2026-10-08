/* CunDrop 分享页逻辑 */
(function () {
  const token = location.pathname.split("/").filter(Boolean)[1];
  const $ = (s) => document.querySelector(s);

  function fmtSize(n) {
    n = +n || 0;
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  function kindOf(mime) {
    mime = mime || "";
    if (mime.startsWith("video")) return "video";
    if (mime.startsWith("image")) return "image";
    if (mime.startsWith("audio")) return "audio";
    return "file";
  }
  function showErr(msg) {
    $("#errMsg").textContent = msg || "分享不存在或已过期";
    $("#errCard").classList.remove("hidden");
  }

  async function boot() {
    if (!token) return showErr();
    let r;
    try {
      r = await fetch(`/f/${token}/info`);
    } catch {
      return showErr("网络错误，请重试");
    }
    if (!r.ok) return showErr();
    const info = await r.json();
    if (info.needs_password) {
      $("#pwdCard").classList.remove("hidden");
      $("#pwdForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        $("#pwdErr").classList.add("hidden");
        const rr = await fetch(`/f/${token}/unlock`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: $("#pwdInput").value }),
        });
        const jj = await rr.json().catch(() => ({}));
        if (!rr.ok) {
          $("#pwdErr").textContent = jj.error || "解锁失败";
          $("#pwdErr").classList.remove("hidden");
          return;
        }
        renderFile(info, jj.k);
      });
    } else {
      // 无密码也走一次 unlock 拿访问凭证（接口内部直接放行）
      const rr = await fetch(`/f/${token}/unlock`, { method: "POST" });
      const jj = await rr.json().catch(() => ({}));
      renderFile(info, jj.k || "");
    }
  }

  function renderFile(info, k) {
    $("#pwdCard").classList.add("hidden");
    const kind = kindOf(info.mime);
    $("#fileIcon").classList.add(kind);
    $("#fileName").textContent = info.name;
    $("#fileMeta").textContent = `${fmtSize(info.size)} · ${info.views} 次查看`;
    const stream = `/f/${token}/file${k ? "?k=" + encodeURIComponent(k) : ""}`;
    const pv = $("#preview");
    if (kind === "video") {
      pv.innerHTML = `<video class="share-preview" src="${stream}" controls playsinline preload="metadata"></video>`;
    } else if (kind === "image") {
      pv.innerHTML = `<img class="share-preview" src="${stream}" alt="">`;
    } else if (kind === "audio") {
      pv.innerHTML = `<audio class="share-audio" src="${stream}" controls preload="metadata"></audio>`;
    }
    const sep = stream.includes("?") ? "&" : "?";
    $("#dlBtn").href = stream + sep + "download=1";
    $("#fileCard").classList.remove("hidden");
    document.title = info.name + " · CunDrop 分享";
  }

  boot();
})();
