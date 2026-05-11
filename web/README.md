# 文叔叔 Web 管理页

这是基于 `fundrive.drives.wenshushu.WSSDrive` 的本地 Web 页面。

## 启动

```powershell
cd C:\Users\18501\Desktop\wenshushu
.\.venv\Scripts\python.exe -m pip install -e ".[wenshushu,web]"
.\.venv\Scripts\python.exe -m uvicorn web.app:app --host 127.0.0.1 --port 8765
```

打开：

```text
http://127.0.0.1:8765
```

## 功能

- 匿名登录文叔叔
- 上传单个文件并保存分享链接
- 记录上传 IP，并按 IP 映射显示用户
- 在上传记录中维护备注
- 按用户下拉筛选上传记录
- 使用 SQLite 保存本机上传记录
- 搜索和复制分享链接

## 测试

```powershell
cd C:\Users\18501\Desktop\wenshushu\tests\frontend
npm install
$env:FRONTEND_BASE_URL='http://127.0.0.1:8765'
npm test
```
