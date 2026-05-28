# AIStudioToAPI 启动与使用指南

## 1. 如何启动服务

### 方式一：双击启动（推荐日常使用）
直接双击目录下的 **`start.bat`**，服务就在后台运行了。

### 方式二：命令行启动
```cmd
cd AIStudioToAPI
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
npm start
```

服务运行在 **http://localhost:7860**

---

## 2. 如何保持运行（后台常驻）

**当前问题**：`npm start` 是前台进程，关闭 CMD 窗口服务就停了。

### 方案 A：使用 pm2（推荐，最稳定）
```cmd
# 全局安装 pm2
npm install -g pm2

# 启动服务
cd AIStudioToAPI
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
pm2 start main.js --name aistudio-to-api

# 查看状态
pm2 status

# 停止服务
pm2 stop aistudio-to-api

# 重启服务
pm2 restart aistudio-to-api

# 开机自启
pm2 startup
pm2 save
```

### 方案 B：使用 Windows 后台 CMD（不装 pm2）
创建 `start_background.vbs`：
```vbs
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d D:\Study\Vue-\找到gemini反代\AIStudioToAPI && set HTTP_PROXY=http://127.0.0.1:7897 && set HTTPS_PROXY=http://127.0.0.1:7897 && node main.js", 0, False
Set WshShell = Nothing
```
双击运行这个 `.vbs` 文件，CMD 窗口不会显示，服务在后台运行。

### 方案 C：Docker（最干净，但需要 Docker）
```cmd
docker run -d \
  --name aistudio-to-api \
  -p 7860:7860 \
  -v ./configs/auth:/app/configs/auth \
  -e API_KEYS=123456 \
  -e TZ=Asia/Shanghai \
  ibuhub/aistudio-to-api:latest
```

---

## 3. 如何切换模型

模型通过 API 请求的 `model` 参数指定。

### OpenAI 兼容格式
```bash
curl http://localhost:7860/v1/chat/completions \
  -H "Authorization: Bearer 123456" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-pro",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Gemini 原生格式
```bash
curl http://localhost:7860/v1beta/models/gemini-2.5-pro:generateContent \
  -H "Authorization: Bearer 123456" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"parts": [{"text": "Hello"}]}]
  }'
```

### 支持的模型列表

| 模型 ID | 用途 |
|---------|------|
| `gemini-2.5-pro` | 最强推理，1M 上下文 |
| `gemini-2.5-flash` | 快速响应，1M 上下文 |
| `gemini-2.5-flash-lite` | 更快更轻量 |
| `gemini-3-pro-preview` | 新一代预览版 |
| `gemini-3-flash-preview` | 新一代快速版 |
| `gemini-2.5-flash-image` | 支持图像生成 |
| `gemini-3-pro-image-preview` | 生图预览版 |
| `gemini-2.5-pro-preview-tts` | 语音合成 |
| `gemini-3.1-flash-tts-preview` | 语音合成新版 |
| `gemma-4-26b-a4b-it` | 轻量开源模型 |
| `gemma-4-31b-it` | 中等开源模型 |
| `imagen-4.0-generate-001` | Imagen 图像生成 |
| `imagen-4.0-ultra-generate-001` | Imagen Ultra |
| `gemini-embedding-001` | 文本嵌入 |

### 模型后缀控制参数

在模型名后加后缀可以控制行为：

```bash
# 思考深度控制
"model": "gemini-3-flash-preview-high"      # 高强度思考
"model": "gemini-3-flash-preview-minimal"   # 最少思考

# 真/假流式控制
"model": "gemini-3-flash-preview-real"      # 真流式
"model": "gemini-3-flash-preview-fake"      # 假流式（Buffer 后输出）

# 强制联网搜索
"model": "gemini-3-flash-preview-search"

# 组合使用（顺序：思考 -> 流式 -> 搜索）
"model": "gemini-3-flash-preview-minimal-real-search"
```

### 查看完整模型列表
```bash
curl http://localhost:7860/v1/models \
  -H "Authorization: Bearer 123456"
```

---

## 4. 添加更多 Google 账号

如果你有多个 Google 账号：
```cmd
cd AIStudioToAPI
npm run setup-auth
```
按提示登录第二个账号，会自动保存为 `auth-1.json`。

账号会自动轮询切换（默认每 40 次请求切换一次，可在 `.env` 中配置 `SWITCH_ON_USES`）。

---

## 5. Web 控制台

浏览器访问 **http://localhost:7860**，可以：
- 查看账号状态
- 查看 API 使用统计
- 上传/下载 auth 文件
- 管理多个账号

控制台默认无需密码，也可在 `.env` 中设置 `WEB_CONSOLE_PASSWORD`。
