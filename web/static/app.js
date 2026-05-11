const state = {
  files: [],
  toastTimer: null,
  uploadProgressTimer: null,
};

const els = {
  statusPill: document.querySelector("#status-pill"),
  statusText: document.querySelector("#status-text"),
  uploadForm: document.querySelector("#upload-form"),
  dropZone: document.querySelector("#drop-zone"),
  fileInput: document.querySelector("#file-input"),
  fileLabel: document.querySelector("#file-label"),
  dropHint: document.querySelector("#drop-hint"),
  uploadName: document.querySelector("#upload-name"),
  uploadRemark: document.querySelector("#upload-remark"),
  autoRenew: document.querySelector("#auto-renew"),
  uploadProgress: document.querySelector("#upload-progress"),
  uploadProgressText: document.querySelector("#upload-progress-text"),
  uploadProgressValue: document.querySelector("#upload-progress-value"),
  uploadProgressBar: document.querySelector("#upload-progress-bar"),
  uploadProgressActions: document.querySelector("#upload-progress-actions"),
  uploadButton: document.querySelector("#upload-button"),
  refreshButton: document.querySelector("#refresh-button"),
  refreshNowButton: document.querySelector("#refresh-now-button"),
  mappingForm: document.querySelector("#mapping-form"),
  mappingIp: document.querySelector("#mapping-ip"),
  mappingUser: document.querySelector("#mapping-user"),
  mappingList: document.querySelector("#mapping-list"),
  userFilter: document.querySelector("#user-filter"),
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

function setUploadProgress(percent, text) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
  els.uploadProgress.hidden = false;
  els.uploadProgressBar.style.width = `${safePercent}%`;
  els.uploadProgressValue.textContent = `${safePercent}%`;
  els.uploadProgressText.textContent = text;
}

function stopUploadProgressTimer() {
  if (state.uploadProgressTimer) {
    window.clearInterval(state.uploadProgressTimer);
    state.uploadProgressTimer = null;
  }
}

function startRemoteUploadProgress() {
  stopUploadProgressTimer();
  let current = 80;
  setUploadProgress(current, "正在上传到文叔叔");
  state.uploadProgressTimer = window.setInterval(() => {
    if (current < 90) {
      current += 1;
    } else if (current < 96) {
      current += 0.25;
    }
    setUploadProgress(current, "正在上传到文叔叔");
  }, 900);
}

function resetUploadProgress() {
  stopUploadProgressTimer();
  els.uploadProgress.hidden = true;
  els.uploadProgressBar.style.width = "0%";
  els.uploadProgressValue.textContent = "0%";
  els.uploadProgressText.textContent = "准备上传";
  els.uploadProgressActions.hidden = true;
}

function getSelectedFile() {
  return els.fileInput.files[0] || null;
}

function syncSelectedFile(file) {
  els.fileLabel.textContent = file ? file.name : "选择文件";
  els.dropHint.textContent = file
    ? "拖拽或点击可重新选择文件。"
    : "支持单文件上传，也可以直接拖到这里。";
  if (file && !els.uploadName.value.trim()) {
    els.uploadName.value = file.name;
  }
}

function forceRefreshPage() {
  const url = new URL(window.location.href);
  url.searchParams.set("_r", String(Date.now()));
  window.location.replace(url.toString());
}

function uploadWithProgress(url, formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.min(78, 5 + (event.loaded / event.total) * 73);
      setUploadProgress(percent, "正在上传到本地服务");
      if (event.loaded >= event.total) {
        startRemoteUploadProgress();
      }
    });

    xhr.addEventListener("load", () => {
      stopUploadProgressTimer();
      let payload = {};
      try {
        payload = JSON.parse(xhr.responseText || "{}");
      } catch {
        payload = {};
      }
      if (xhr.status < 200 || xhr.status >= 300 || payload.ok === false) {
        reject(new Error(payload.detail || payload.message || `请求失败: ${xhr.status}`));
        return;
      }
      resolve(payload);
    });

    xhr.addEventListener("error", () => {
      stopUploadProgressTimer();
      reject(new Error("上传请求失败"));
    });
    xhr.addEventListener("abort", () => {
      stopUploadProgressTimer();
      reject(new Error("上传已取消"));
    });
    xhr.send(formData);
  });
}

function renderFiles(files) {
  state.files = files;
  if (!files.length) {
    els.filesBody.innerHTML = '<tr><td colspan="9" class="empty-cell">暂无记录</td></tr>';
    return;
  }

  els.filesBody.innerHTML = files
    .map((file) => {
      const fileId = file.id || file.fid || "";
      const shareUrl = file.share_url || "";
      const link = shareUrl
        ? `<a class="url-text" href="${escapeHtml(shareUrl)}" target="_blank" rel="noreferrer">${escapeHtml(shareUrl)}</a>`
        : '<span class="url-text">未返回链接</span>';
      const renewToggle = file.can_auto_renew
        ? `<label class="table-check-row"><input type="checkbox" data-renew-id="${escapeHtml(fileId)}" ${file.auto_renew ? "checked" : ""}><span>${file.auto_renew ? "已开启" : "未开启"}</span></label>`
        : '<span class="muted-text">需重新上传</span>';
      return `
        <tr>
          <td>${escapeHtml(file.name || "-")}</td>
          <td>${formatSize(file.size)}</td>
          <td>${escapeHtml(file.user || "-")}</td>
          <td>${escapeHtml(file.uploader_ip || "-")}</td>
          <td>${escapeHtml(file.upload_time || "-")}</td>
          <td>
            <input class="remark-input" type="text" data-remark-id="${escapeHtml(fileId)}" value="${escapeHtml(file.remark || "")}" placeholder="添加备注">
          </td>
          <td>${renewToggle}</td>
          <td>${link}</td>
          <td>
            <button class="link-button" type="button" data-testid="copy-command-button" data-command-id="${escapeHtml(fileId)}" ${shareUrl && fileId ? "" : "disabled"}>
              复制下载命令
            </button>
            <button class="link-button danger-button" type="button" data-delete-id="${escapeHtml(fileId)}" ${fileId ? "" : "disabled"}>
              删除记录
            </button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderUsers(users = []) {
  const selected = els.userFilter.value;
  const uniqueUsers = Array.from(new Set(users.filter(Boolean))).sort();
  els.userFilter.innerHTML =
    '<option value="">全部用户</option>' +
    uniqueUsers.map((user) => `<option value="${escapeHtml(user)}">${escapeHtml(user)}</option>`).join("");
  if (uniqueUsers.includes(selected)) {
    els.userFilter.value = selected;
  }
}

function renderMappings(mappings = []) {
  if (!mappings.length) {
    els.mappingList.innerHTML = '<span class="muted-text">未配置 IP 对应用户</span>';
    return;
  }

  els.mappingList.innerHTML = mappings
    .map((item) => `
      <span class="mapping-chip">
        <span>${escapeHtml(item.ip)} = ${escapeHtml(item.user)}</span>
        <button type="button" data-delete-mapping="${escapeHtml(item.ip)}" aria-label="删除 ${escapeHtml(item.ip)}">×</button>
      </span>
    `)
    .join("");
}

async function refreshMappings() {
  const payload = await requestJson("/api/ip-users");
  renderMappings(payload.mappings || []);
  renderUsers(payload.users || []);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function copyText(value) {
  if (!value) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fallback below for embedded browsers without clipboard permission.
    }
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.top = "-1000px";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  input.setSelectionRange(0, input.value.length);

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(input);
  }
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

async function refreshFiles(keyword = "") {
  const params = new URLSearchParams();
  if (keyword) params.set("keyword", keyword);
  if (els.userFilter.value) params.set("user", els.userFilter.value);
  const query = params.toString();
  const endpoint = keyword ? `/api/search${query ? `?${query}` : ""}` : `/api/files${query ? `?${query}` : ""}`;
  const payload = await requestJson(endpoint);
  renderFiles(payload.files || []);
  renderUsers(payload.users || []);
}

async function refreshAll() {
  await refreshStatus();
  await Promise.all([refreshMappings(), refreshFiles(els.searchInput.value.trim())]);
}

els.fileInput.addEventListener("change", () => {
  syncSelectedFile(getSelectedFile());
});

async function submitUpload() {
  const file = getSelectedFile();
  if (!file) {
    showToast("请选择要上传的文件");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("filename", els.uploadName.value.trim() || file.name);
  formData.append("remark", els.uploadRemark.value.trim());
  formData.append("auto_renew", els.autoRenew.checked ? "true" : "false");

  els.uploadButton.disabled = true;
  els.uploadButton.textContent = "上传中";
  setUploadProgress(0, "正在上传到本地服务");
  try {
    const payload = await uploadWithProgress("/api/upload", formData);
    setUploadProgress(100, "分享链接已生成");
    els.uploadProgressActions.hidden = false;
    showToast(`上传完成: ${payload.file.name}`);
    els.uploadForm.reset();
    syncSelectedFile(null);
    window.setTimeout(() => {
      forceRefreshPage();
    }, 1200);
  } catch (error) {
    showToast(error.message);
  } finally {
    els.uploadButton.disabled = false;
    els.uploadButton.textContent = "开始上传";
    window.setTimeout(resetUploadProgress, 1200);
  }
}

els.uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitUpload();
});

["dragenter", "dragover"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.add("drag-over");
  });
});

["dragleave", "dragend", "drop"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (eventName !== "drop") {
      const relatedTarget = event.relatedTarget;
      if (relatedTarget && els.dropZone.contains(relatedTarget)) return;
    }
    els.dropZone.classList.remove("drag-over");
  });
});

els.dropZone.addEventListener("drop", async (event) => {
  const files = event.dataTransfer?.files;
  if (!files || !files.length) return;
  const [file] = files;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  els.fileInput.files = transfer.files;
  syncSelectedFile(file);
  await submitUpload();
});

els.refreshButton.addEventListener("click", () => {
  refreshAll().catch((error) => showToast(error.message));
});

els.refreshNowButton.addEventListener("click", () => {
  forceRefreshPage();
});

els.mappingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await requestJson("/api/ip-users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ip: els.mappingIp.value.trim(),
        user: els.mappingUser.value.trim(),
      }),
    });
    els.mappingForm.reset();
    renderMappings(payload.mappings || []);
    renderUsers(payload.users || []);
    await refreshFiles(els.searchInput.value.trim());
    showToast("用户配置已保存");
  } catch (error) {
    showToast(error.message || "保存用户配置失败");
  }
});

els.mappingList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-mapping]");
  if (!button) return;
  const ip = button.getAttribute("data-delete-mapping");
  if (!ip) return;

  try {
    const payload = await requestJson(`/api/ip-users/${encodeURIComponent(ip)}`, {
      method: "DELETE",
    });
    renderMappings(payload.mappings || []);
    renderUsers(payload.users || []);
    await refreshFiles(els.searchInput.value.trim());
    showToast("用户配置已删除");
  } catch (error) {
    showToast(error.message || "删除用户配置失败");
  }
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

els.userFilter.addEventListener("change", () => {
  refreshFiles(els.searchInput.value.trim()).catch((error) => showToast(error.message));
});

els.filesBody.addEventListener("change", async (event) => {
  const input = event.target.closest("[data-remark-id]");
  if (!input) return;
  const uploadId = input.getAttribute("data-remark-id");
  if (!uploadId) return;

  try {
    await requestJson(`/api/files/${encodeURIComponent(uploadId)}/remark`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remark: input.value.trim() }),
    });
    showToast("备注已保存");
  } catch (error) {
    showToast(error.message || "保存备注失败");
  }
});

els.filesBody.addEventListener("click", async (event) => {
  const renewToggle = event.target.closest("[data-renew-id]");
  if (renewToggle) {
    const uploadId = renewToggle.getAttribute("data-renew-id");
    if (!uploadId) return;
    const enabled = Boolean(renewToggle.checked);
    renewToggle.disabled = true;
    try {
      await requestJson(`/api/auto-renew/${encodeURIComponent(uploadId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      showToast(enabled ? "自动续期已开启" : "自动续期已关闭");
      await refreshFiles(els.searchInput.value.trim());
    } catch (error) {
      renewToggle.checked = !enabled;
      showToast(error.message || "设置自动续期失败");
    } finally {
      renewToggle.disabled = false;
    }
    return;
  }

  const commandButton = event.target.closest("[data-command-id]");
  if (commandButton) {
    const uploadId = commandButton.getAttribute("data-command-id");
    if (!uploadId) return;

    const previousText = commandButton.textContent;
    commandButton.disabled = true;
    commandButton.textContent = "生成中";
    try {
      const payload = await requestJson(`/api/download-command/${encodeURIComponent(uploadId)}`);
      const copied = await copyText(payload.command || "");
      if (!copied) throw new Error("copy failed");
      showToast("下载命令已复制");
    } catch (error) {
      showToast(error.message || "复制命令失败");
    } finally {
      commandButton.disabled = false;
      commandButton.textContent = previousText;
    }
    return;
  }

  const deleteButton = event.target.closest("[data-delete-id]");
  if (!deleteButton) return;
  const uploadId = deleteButton.getAttribute("data-delete-id");
  if (!uploadId) return;

  const previousText = deleteButton.textContent;
  deleteButton.disabled = true;
  deleteButton.textContent = "删除中";
  try {
    await requestJson(`/api/files/${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
    });
    showToast("记录已删除");
    await refreshFiles(els.searchInput.value.trim());
  } catch (error) {
    showToast(error.message || "删除记录失败");
  } finally {
    deleteButton.disabled = false;
    deleteButton.textContent = previousText;
  }
});

refreshAll().catch((error) => showToast(error.message));
