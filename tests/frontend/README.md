# 前端 Playwright 测试

本目录只放文叔叔单页 Web 管理页的前端测试，不修改业务代码。

## 覆盖范围

- `/api/status`: 页面状态展示
- `/api/storage`: 空间信息展示
- `/api/files`: 上传记录和分享链接展示
- `/api/upload`: 选择文件后上传并追加记录
- `/api/download`: 输入分享链接后触发下载
- `/api/search`: 按关键词搜索并复制分享链接

测试默认 mock 后端 API，所以只需要本地 Web 页面能打开即可。

## 推荐页面契约

后续实现页面时，优先给关键控件加稳定的 `data-testid`：

| 区域/控件 | data-testid |
| --- | --- |
| 状态标签 | `status-badge` |
| 空间信息区域 | `storage-panel` |
| 文件上传 input | `upload-input` |
| 上传按钮 | `upload-button` |
| 下载链接输入框 | `download-url-input` |
| 下载按钮 | `download-button` |
| 下载结果区域 | `download-result` |
| 上传记录/文件列表 | `file-list` 或 `upload-records` |
| 搜索输入框 | `search-input` |
| 搜索按钮 | `search-button` |
| 搜索结果区域 | `search-results` |
| 复制链接按钮 | `copy-link-button` |

测试也保留了中文按钮、label、placeholder 的兜底定位，但 `data-testid` 更稳定。

## 运行方法

```powershell
cd C:\Users\18501\Desktop\wenshushu
cd tests\frontend
npm install
npx playwright install chromium
$env:FRONTEND_BASE_URL = "http://127.0.0.1:8000"
npm test
```

如果前端服务不是 `8000` 端口，只改 `FRONTEND_BASE_URL`。
