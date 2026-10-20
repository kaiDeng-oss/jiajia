# 嘉嘉 AI 语音助手（JiaJia AI Voice Assistant）

基于开源项目 [xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server) 搭建的本地化 AI 语音助手，包含：

- **服务端**：语音识别（Sherpa-ONNX）、大模型对话（DeepSeek）、语音合成（火山引擎）
- **Web UI**：数字人页面 + 浏览器端唤醒词检测
- **守护脚本**：一键启动、崩溃自动重启、日志轮转、端口清理
- **硬件端文档**：ESP32-S3 语音盒子部署指南

## 架构

```
【浏览器 / ESP32-S3 盒子】                 【本机服务器】
  麦克风 ──音频流──→  WebSocket(8000) ──→  xiaozhi-server
  喇叭   ←──音频流──                        ├─ ASR：Sherpa-ONNX
  页面   ←──状态/文字──  UI(8006)           ├─ LLM：DeepSeek
                                            └─ TTS：火山引擎
                        OTA/配置(8003)
```

## 目录结构

```
.
├── start.bat                    # Windows 一键启动（调用 supervisor.py）
├── supervisor.py                # 服务守护：启动/重启/日志轮转/端口清理
├── test_voice.py                # WebSocket 语音链路测试脚本
├── xiaozhi-ui/                  # 嘉嘉 Web UI + 本地唤醒词运行时（含唤醒词模型）
│   ├── index.html
│   ├── start.py                 # UI 启动入口（8006）
│   └── wakeword_runtime/        # 唤醒词检测（Sherpa-ONNX KWS）
├── xiaozhi-esp32-server-main/   # 上游服务端源码（MIT，见其 LICENSE）
├── ESP32语音盒子部署指南.md
├── 嘉嘉AI语音助手使用说明.doc
└── 嘉嘉盒子-产品化部署手册.doc
```

## 快速开始（Windows）

### 1. 环境要求

- Python 3.10 / 3.11
- Windows 10/11

### 2. 创建虚拟环境并安装依赖

```bat
python -m venv venv-xiaozhi
venv-xiaozhi\Scripts\activate
pip install -r xiaozhi-esp32-server-main\main\xiaozhi-server\requirements.txt
pip install -r xiaozhi-ui\wakeword_runtime\requirements.txt
```

### 3. 准备语音模型

仓库不包含体积较大的 ASR 模型（单文件数百 MB），请按上游文档下载后放到：

```
xiaozhi-esp32-server-main\main\xiaozhi-server\models\
```

唤醒词模型（约 5 MB）已包含在 `xiaozhi-ui\wakeword_runtime\models\` 中。

### 4. 配置

```bat
copy xiaozhi-esp32-server-main\main\xiaozhi-server\config.yaml ^
     xiaozhi-esp32-server-main\main\xiaozhi-server\data\.config.yaml
```

然后在 `data\.config.yaml` 中填写你自己的：

- LLM API Key（如 DeepSeek）
- 火山引擎语音合成 `appid` / `access_token`
- MCP 接入点（可选）

> `data\.config.yaml` 已被 `.gitignore` 排除，不会被提交。

### 5. 启动

```bat
start.bat
```

启动后自动打开 <http://127.0.0.1:8006/index.html>。

其他命令：

```bat
venv-xiaozhi\Scripts\python.exe supervisor.py --status   # 查看状态
venv-xiaozhi\Scripts\python.exe supervisor.py --stop     # 停止全部服务
```

## 端口说明

| 端口 | 用途 |
| --- | --- |
| 8000 | WebSocket 语音通道 |
| 8003 | OTA / 设备配置 |
| 8006 | Web UI + 唤醒词事件桥 |

## 上游项目与许可

- 服务端与数字人模块来自 [xinnan-tech/xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server)，遵循 **MIT License**（见 `xiaozhi-esp32-server-main/LICENSE`）。
- 硬件固件来自 [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32)。
- 本仓库中的部署脚本、UI 调整与文档由项目作者维护。

## 说明

- 仓库不包含 `venv-xiaozhi/`、ffmpeg 工具、ASR 模型、日志、`data/` 配置及上游历史备份。
- 公开的局域网 IP 仅用于示例，部署时请替换为你自己的地址。
