const state = {
  files: [],
  toastTimer: null,
};

const els = {
  statusPill: document.querySelector("#status-pill"),
  statusText: document.querySelector("#status-text"),
  usedSpace: document.querySelector("#used-space"),
  freeSpace: document.querySelector("#free-space"),
  totalSpace: document.querySelector("#total-space"),
  uploadForm: document.querySelector("#upload-form"),
  fileInput: document.querySelector("#file-input"),
  fileLabel: document.querySelector("#file-label"),
  uploadName: document.querySelector("#upload-name"),
  uploadButton: document.querySelector("#upload-button"),
  downloadForm: document.querySelector("#download-form"),
  shareUrl: document.querySelector("#share-url"),
  downloadName: document.querySelector("#download-name"),
  overwrite: document.querySelector("#overwrite"),
  downloadButton: document.querySelector("#download-button"),
  downloadResultText: document.querySelector("#download-result-text"),
  refreshButton: document.querySelector("#refresh-button"),
  searchInput: document.querySelector("#search-input"),
  searchButton: document.querySelector("#search-button"),
  filesBody: document.querySelector("#files-body"),
  toast: document.querySelector("#toast"),
};

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  state.toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("show");
  }, 3200);
}

function setStatus(ok, text) {
  els.statusPill.classList.toggle("ok", ok);
  els.statusPill.classList.toggle("bad", !ok);
  els.statusText.textContent = text;
}

function formatSize(bytes) {
  const value = Number(bytes || 0);
  if (value <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.detail || payload.message || `请求失败: ${response.status}`);
  }
  return payload;
}

function renderStorage(storage) {
  els.usedSpace.textContent = `${storage.used_space_gb ?? "--"} GB`;
  els.freeSpace.textContent = `${storage.free_space_gb ?? "--"} GB`;
  els.totalSpace.textContent = `${storage.total_space_gb ?? "--"} GB`;
}

function renderFiles(files) {
  state.files = files;
  if (!files.length) {
    els.filesBody.innerHTML = '<tr><td colspan="5" class="empty-cell">暂无记录</td></tr>';
    return;
  }

  els.filesBody.innerHTML = files
    .map((file) => {
      const shareUrl = file.share_url || "";
      const link = shareUrl
        ? `<a class="url-text" href="${shareUrl}" target="_blank" rel="noreferrer">${shareUrl}</a>`
        : '<span class="url-text">未返回链接</span>';
      return `
        <tr>
          <td>${escapeHtml(file.name || "-")}</td>
          <td>${formatSize(file.size)}</td>
          <td>${escapeHtml(file.upload_time || "-")}</td>
          <td>${link}</td>
          <td>
            <button class="link-button" type="button" data-testid="copy-link-button" data-copy="${escapeHtml(shareUrl)}" ${shareUrl ? "" : "disabled"}>
              复制链接
            </button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function refreshStatus() {
  try {
    const status = await requestJson("/api/status");
    setStatus(Boolean(status.logged_in), status.logged_in ? "已连接" : "未连接");
  } catch (error) {
    setStatus(false, "连接失败");
    showToast(error.message);
  }
}

async function refreshStorage() {
  const payload = await requestJson("/api/storage");
  renderStorage(payload.storage || payload || {});
}

async function refreshFiles(keyword = "") {
  const endpoint = keyword ? `/api/search?keyword=${encodeURIComponent(keyword)}` : "/api/files";
  const payload = await requestJson(endpoint);
  renderFiles(payload.files || []);
}

async function refreshAll() {
  await refreshStatus();
  await Promise.all([refreshStorage(), refreshFiles(els.searchInput.value.trim())]);
}

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files[0];
  els.fileLabel.textContent = file ? file.name : "选择文件";
  if (file && !els.uploadName.value.trim()) {
    els.uploadName.value = file.name;
  }
});

els.uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = els.fileInput.files[0];
  if (!file) {
    showToast("请选择要上传的文件");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("filename", els.uploadName.value.trim() || file.name);

  els.uploadButton.disabled = true;
  els.uploadButton.textContent = "上传中";
  try {
    const payload = await requestJson("/api/upload", {
      method: "POST",
      body: formData,
    });
    showToast(`上传完成: ${payload.file.name}`);
    els.uploadForm.reset();
    els.fileLabel.textContent = "选择文件";
    await Promise.all([refreshStorage(), refreshFiles()]);
  } catch (error) {
    showToast(error.message);
  } finally {
    els.uploadButton.disabled = false;
    els.uploadButton.textContent = "开始上传";
  }
});

els.downloadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.downloadButton.disabled = true;
  els.downloadButton.textContent = "下载中";
  try {
    const payload = await requestJson("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        share_url: els.shareUrl.value.trim(),
        filename: els.downloadName.value.trim() || null,
        overwrite: els.overwrite.checked,
      }),
    });
    const names = (payload.files || []).map((file) => file.name).join(", ");
    const message = `下载成功: ${names || payload.filename || payload.download_dir || "已完成"}`;
    els.downloadResultText.textContent = message;
    showToast(message);
  } catch (error) {
    els.downloadResultText.textContent = error.message;
    showToast(error.message);
  } finally {
    els.downloadButton.disabled = false;
    els.downloadButton.textContent = "开始下载";
  }
});

els.refreshButton.addEventListener("click", () => {
  refreshAll().catch((error) => showToast(error.message));
});

els.searchInput.addEventListener("input", () => {
  window.clearTimeout(els.searchInput._timer);
  els.searchInput._timer = window.setTimeout(() => {
    refreshFiles(els.searchInput.value.trim()).catch((error) => showToast(error.message));
  }, 220);
});

els.searchButton.addEventListener("click", () => {
  refreshFiles(els.searchInput.value.trim()).catch((error) => showToast(error.message));
});

els.filesBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const value = button.getAttribute("data-copy");
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast("分享链接已复制");
  } catch {
    showToast("复制失败，请手动选择链接");
  }
});

refreshAll().catch((error) => showToast(error.message));
