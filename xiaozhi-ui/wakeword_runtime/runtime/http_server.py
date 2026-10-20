import base64
import hashlib
import json
import mimetypes
import queue
import re
import shutil
import socket
import subprocess
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import unquote

from ..bridge import WakewordEventBridge
from ..config.config_loader import load_config

# 页面里的「相册」显示和拍照保存都落在这个目录，它在网页根目录之外，
# 所以必须由这里显式地把 /media 暴露出去、并接收 /save-photo 的写入。
MEDIA_ROOT = Path(r"D:\Project\data")
# 语音拍照的保存目录（与相册目录分开：相册只放 data，照片是单独存档）
PHOTO_ROOT = Path(r"D:\Project\照片")
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v"}

# 浏览器 <video> 默认放不了 HEVC/H.265（微信传的视频基本都是），
# 所以遇到非 H.264 的视频就转码成 H.264 并缓存，原文件不动。
MEDIA_CACHE = Path(r"D:\Project\.media_cache")
_TRANSCODE_LOCK = threading.Lock()
_CODEC_CACHE: dict = {}  # (名字, 大小, mtime) -> codec_name


def _find_ffmpeg(name: str):
    """找 ffmpeg/ffprobe：先看 PATH，再找几个常见安装位置。"""
    found = shutil.which(name)
    if found:
        return found
    for base in (
        r"C:\Users\40865\AppData\Local\Microsoft\WinGet\Packages",
        r"D:\soft",
        r"C:\ffmpeg",
    ):
        for p in Path(base).glob(f"**/bin/{name}.exe"):
            return str(p)
    return None


# 别让 ffmpeg 弹出控制台窗口
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# 浏览器能直接播的编码，其余一律转码
_BROWSER_OK_CODECS = {"h264", "vp8", "vp9", "av1"}
_warm_thread_lock = threading.Lock()
_warming = False


def _probe_codec(path: Path) -> str:
    """探测视频编码名；结果按 (名字, 大小, mtime) 缓存，探测失败返回空串。"""
    try:
        st = path.stat()
    except OSError:
        return ""
    key = (path.name, st.st_size, st.st_mtime)
    cached = _CODEC_CACHE.get(key)
    if cached is not None:
        return cached
    codec = ""
    ffprobe = _find_ffmpeg("ffprobe")
    if ffprobe:
        try:
            out = subprocess.run(
                [ffprobe, "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=codec_name",
                 "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                capture_output=True, text=True, timeout=30,
                creationflags=_NO_WINDOW)
            codec = (out.stdout or "").strip().splitlines()[0].strip() if out.stdout.strip() else ""
        except Exception:
            codec = ""
    _CODEC_CACHE[key] = codec
    return codec


def _ensure_playable(path: Path) -> Path:
    """浏览器放不了的编码（HEVC 等）转成 H.264 缓存后返回缓存路径。

    原始文件不动，转换结果放在 MEDIA_CACHE，文件名带原编码后缀以便区分。
    """
    if path.suffix.lower() not in VIDEO_EXTS:
        return path
    codec = _probe_codec(path)
    if not codec or codec in _BROWSER_OK_CODECS:
        return path  # 空串=探测不出，交给浏览器自己试
    cache = MEDIA_CACHE / f"{path.stem}.{codec}.mp4"
    try:
        if cache.is_file() and cache.stat().st_size > 0:
            return cache
    except OSError:
        pass
    ffmpeg = _find_ffmpeg("ffmpeg")
    if not ffmpeg:
        return path
    with _TRANSCODE_LOCK:
        try:
            if cache.is_file() and cache.stat().st_size > 0:
                return cache  # 等锁期间别的请求已经转好了
        except OSError:
            pass
        MEDIA_CACHE.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_name(cache.stem + ".tmp.mp4")
        try:
            subprocess.run(
                [ffmpeg, "-y", "-i", str(path),
                 "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                 "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-b:a", "128k",
                 "-movflags", "+faststart", str(tmp)],
                capture_output=True, timeout=900,
                creationflags=_NO_WINDOW)
            if tmp.is_file() and tmp.stat().st_size > 0:
                tmp.replace(cache)
                return cache
        except Exception:
            pass
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
    return path


def _warm_transcodes(paths) -> None:
    """后台把要转码的视频先转好，免得轮播到它时才卡一下。"""
    global _warming
    with _warm_thread_lock:
        if _warming:
            return
        _warming = True

    def run():
        global _warming
        try:
            for p in paths:
                try:
                    _ensure_playable(p)
                except Exception:
                    pass
        finally:
            with _warm_thread_lock:
                _warming = False

    threading.Thread(target=run, daemon=True).start()


class TestRuntimeHttpServer:
    def __init__(self, test_root: Path, host: str = "0.0.0.0", port: int = 8006) -> None:
        self.test_root = test_root
        self.host = host
        self.port = port
        self.event_bridge = WakewordEventBridge()
        self._restart_handler: Callable[[], None] | None = None
        self._restart_lock = threading.Lock()
        self._server = self._build_server()

    @property
    def page_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/index.html"

    @property
    def bridge_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/wakeword-ws"

    def serve_forever(self) -> None:
        self._server.serve_forever()

    def shutdown(self) -> None:
        self._server.shutdown()
        self.event_bridge.close()
        self._server.server_close()

    def set_restart_handler(self, handler: Callable[[], None]) -> None:
        self._restart_handler = handler

    def request_runtime_restart(self) -> None:
        with self._restart_lock:
            handler = self._restart_handler

        if handler is None:
            raise RuntimeError("restart handler is not configured")

        threading.Thread(
            target=self._run_restart_handler,
            name="test-runtime-restart",
            daemon=True,
        ).start()

    def _run_restart_handler(self) -> None:
        handler = self._restart_handler
        if handler is None:
            return
        handler()

    def _build_server(self) -> ThreadingHTTPServer:
        test_root = self.test_root
        event_bridge = self.event_bridge
        schedule_restart = self.request_runtime_restart

        class TestRuntimeHandler(SimpleHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            # 静态文件默认只带 Last-Modified、不带 Cache-Control，浏览器会按
            # 启发式规则自行缓存，导致改了 js/css 也可能继续用旧的（踩过两次：
            # 新加的 MCP 工具迟迟不生效，误以为是代码问题）。统一禁掉缓存。
            _cc_sent = False

            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(test_root), **kwargs)

            def send_header(self, keyword, value) -> None:
                if keyword.lower() == "cache-control":
                    self._cc_sent = True
                super().send_header(keyword, value)

            def end_headers(self) -> None:
                if not self._cc_sent:
                    super().send_header("Cache-Control", "no-store, must-revalidate")
                super().end_headers()

            def handle(self) -> None:
                try:
                    super().handle()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

            def do_GET(self) -> None:
                if self.path == "/wakeword-ws":
                    self._handle_websocket(event_bridge)
                    return

                if self.path == "/health":
                    body = json.dumps({"status": "ok"}).encode("utf-8")
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return

                if self.path.startswith("/camera/"):
                    self._handle_camera_command()
                    return

                if self.path == "/media":
                    self._handle_media_list()
                    return

                if self.path.startswith("/media/"):
                    self._handle_media_file()
                    return

                super().do_GET()

            def do_POST(self) -> None:
                if self.path == "/save-photo":
                    self._handle_save_photo()
                    return
                if self.path.startswith("/camera/"):
                    self._handle_camera_command()
                    return
                self.send_error(HTTPStatus.NOT_FOUND, "unknown endpoint")

            def _handle_camera_command(self) -> None:
                """不经语音/LLM，直接把相机开关命令推给页面。

                用来把"语音链路"和"摄像头代码"分开验证：
                    GET/POST /camera/open    开相机
                    GET/POST /camera/close   关相机

                注意语义和语音指令一致：开相机需要正在通话中
                （app.js 的 startCamera() 里有"没接通就立刻关掉"的逻辑）。
                """
                action = self.path.rstrip("/").rsplit("/", 1)[-1].lower()
                if action not in ("open", "close"):
                    self._send_json(
                        {"success": False, "error": "未知动作，只支持 open 或 close"},
                        HTTPStatus.BAD_REQUEST)
                    return
                count = event_bridge.client_count
                event_bridge.publish("camera_command", {"action": action})
                self._send_json({
                    "success": True,
                    "action": action,
                    "pages": count,
                    "note": ("命令已广播" if count else
                             "没有页面连着事件桥，命令没人接收（页面是不是没开？）"),
                })

            def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _handle_media_list(self) -> None:
                """列出 data 目录里的图片和视频，按修改时间升序（先来的先播）。"""
                items = []
                if MEDIA_ROOT.is_dir():
                    for fp in MEDIA_ROOT.iterdir():
                        if not fp.is_file():
                            continue
                        ext = fp.suffix.lower()
                        if ext in IMAGE_EXTS:
                            kind = "image"
                        elif ext in VIDEO_EXTS:
                            kind = "video"
                        else:
                            continue
                        try:
                            items.append({
                                "name": fp.name,
                                "kind": kind,
                                "mtime": fp.stat().st_mtime,
                            })
                        except OSError:
                            continue
                items.sort(key=lambda x: x["mtime"])
                # 顺手在后台把需要转码的视频准备好，等轮播到它时就不用等
                need = [MEDIA_ROOT / it["name"] for it in items
                        if it["kind"] == "video"
                        and _probe_codec(MEDIA_ROOT / it["name"]) not in _BROWSER_OK_CODECS
                        and _probe_codec(MEDIA_ROOT / it["name"])]
                if need:
                    _warm_transcodes(need)
                self._send_json({"items": items})

            def _handle_media_file(self) -> None:
                # 只取路径最后一段，杜绝 ../ 穿越到 data 目录之外
                name = Path(unquote(self.path[len("/media/"):])).name
                fp = MEDIA_ROOT / name
                if not name or not fp.is_file():
                    self.send_error(HTTPStatus.NOT_FOUND, "media not found")
                    return
                fp = _ensure_playable(fp)  # 放不了的编码先转成 H.264 再发
                ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
                try:
                    size = fp.stat().st_size
                except OSError:
                    self.send_error(HTTPStatus.NOT_FOUND, "media not found")
                    return
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(size))
                self.end_headers()
                try:
                    with fp.open("rb") as src:
                        while True:
                            chunk = src.read(64 * 1024)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass  # 浏览器 seek/关掉视频时会主动断开，属正常

            def _handle_save_photo(self) -> None:
                """接收浏览器发来的 JPEG 原始字节，按 df_<序号>.jpg 存进照片目录。"""
                try:
                    length = int(self.headers.get("Content-Length", 0))
                except ValueError:
                    self._send_json({"success": False, "error": "bad length"},
                                    HTTPStatus.BAD_REQUEST)
                    return
                if length <= 0 or length > 20 * 1024 * 1024:
                    self._send_json({"success": False, "error": "图片大小不合法"},
                                    HTTPStatus.BAD_REQUEST)
                    return
                data = self.rfile.read(length)
                PHOTO_ROOT.mkdir(parents=True, exist_ok=True)
                # 接着现有最大编号往下排，不覆盖旧照片
                next_n = 1
                for fp in PHOTO_ROOT.glob("df_*.jpg"):
                    m = re.match(r"df_(\d+)\.jpg$", fp.name)
                    if m:
                        next_n = max(next_n, int(m.group(1)) + 1)
                out = PHOTO_ROOT / f"df_{next_n}.jpg"
                out.write_bytes(data)
                self._send_json({"success": True, "name": out.name, "bytes": len(data)})

            def log_message(self, format: str, *args) -> None:
                return

            def _handle_websocket(self, bridge: WakewordEventBridge) -> None:
                if self.headers.get("Upgrade", "").lower() != "websocket":
                    self.send_error(HTTPStatus.BAD_REQUEST, "expected websocket upgrade")
                    return

                websocket_key = self.headers.get("Sec-WebSocket-Key")
                if not websocket_key:
                    self.send_error(HTTPStatus.BAD_REQUEST, "missing Sec-WebSocket-Key")
                    return

                accept_source = websocket_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
                accept_value = base64.b64encode(
                    hashlib.sha1(accept_source.encode("utf-8")).digest()
                ).decode("ascii")

                client_queue = bridge.add_client()
                self.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
                self.send_header("Upgrade", "websocket")
                self.send_header("Connection", "Upgrade")
                self.send_header("Sec-WebSocket-Accept", accept_value)
                self.end_headers()

                try:
                    self.connection.settimeout(0.2)
                    self._send_websocket_text(bridge.build_ready_message())
                    self._send_websocket_text(self._build_wakeword_config_message(bridge))

                    while bridge.is_running:
                        inbound_message = self._receive_websocket_message()
                        if inbound_message is not None:
                            response_message = self._handle_bridge_request(bridge, inbound_message)
                            if response_message:
                                self._send_websocket_text(response_message)

                        try:
                            message = client_queue.get(timeout=0.2)
                            if message == "__bridge_closed__":
                                break
                            self._send_websocket_text(message)
                        except queue.Empty:
                            if not bridge.is_running:
                                break
                            continue
                except socket.timeout:
                    pass
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass
                finally:
                    bridge.remove_client(client_queue)

            def _build_wakeword_config_message(self, bridge: WakewordEventBridge) -> str:
                try:
                    runtime_root = test_root / "wakeword_runtime"
                    config = load_config(runtime_root)
                    payload = {
                        "enabled": config.wakeword_enabled,
                        "wakeWords": config.wake_words,
                    }
                    return bridge.build_message("wakeword_config", payload)
                except Exception as exc:
                    return bridge.build_message(
                        "wakeword_config",
                        {},
                        success=False,
                        error=f"读取唤醒词配置失败: {exc}",
                    )

            def _handle_bridge_request(self, bridge: WakewordEventBridge, raw_message: str) -> str | None:
                try:
                    message = json.loads(raw_message)
                except json.JSONDecodeError:
                    return None

                message_type = str(message.get("type", "")).strip()
                request_id = message.get("requestId")
                payload = message.get("payload") or {}
                result_type = f"{message_type}_result" if message_type else "bridge_request_result"

                if message_type == "set_wakeword_config":
                    try:
                        result_payload = self._save_wakeword_config(payload)
                        bridge.publish("wakeword_config", result_payload)
                        return bridge.build_message(
                            "set_wakeword_config_result",
                            result_payload,
                            request_id=request_id,
                        )
                    except Exception as exc:
                        return bridge.build_message(
                            "set_wakeword_config_result",
                            {},
                            request_id=request_id,
                            success=False,
                            error=f"保存唤醒词配置失败: {exc}",
                        )

                if message_type == "restart_wakeword_service":
                    schedule_restart()
                    return bridge.build_message(
                        "restart_wakeword_service_result",
                        {"restarting": True},
                        request_id=request_id,
                    )

                return bridge.build_message(
                    result_type,
                    {},
                    request_id=request_id,
                    success=False,
                    error=f"unsupported message type: {message_type}",
                )

            def _save_wakeword_config(self, payload: dict) -> dict:
                runtime_root = test_root / "wakeword_runtime"
                config_path = runtime_root / "config.json"
                model_root = runtime_root / "models"
                keywords_path = model_root / "keywords.txt"

                enabled = bool(payload.get("enabled", True))
                wake_words = payload.get("wakeWords") or []
                normalized_wake_words = []
                for item in wake_words:
                    if not isinstance(item, str):
                        continue
                    text = item.strip()
                    if text and text not in normalized_wake_words:
                        normalized_wake_words.append(text)

                if enabled and not normalized_wake_words:
                    raise ValueError("wakeWords cannot be empty when wakeword is enabled")

                raw_config = json.loads(config_path.read_text(encoding="utf-8"))
                raw_config.setdefault("wakeword", {})["enabled"] = enabled
                config_path.write_text(
                    json.dumps(raw_config, indent=2, ensure_ascii=False),
                    encoding="utf-8",
                )

                keywords_lines = [self._build_keyword_line(item) for item in normalized_wake_words]
                keywords_path.write_text(
                    ("\n".join(keywords_lines) + "\n") if keywords_lines else "",
                    encoding="utf-8",
                )

                return {
                    "enabled": enabled,
                    "wakeWords": normalized_wake_words,
                }

            def _build_keyword_line(self, keyword_text: str) -> str:
                from pypinyin import Style, pinyin

                initials = pinyin(keyword_text, style=Style.INITIALS, strict=False)
                finals = pinyin(
                    keyword_text,
                    style=Style.FINALS_TONE,
                    strict=False,
                    neutral_tone_with_five=True,
                )

                tokens: list[str] = []
                for initial_parts, final_parts in zip(initials, finals):
                    initial = initial_parts[0].strip()
                    final = final_parts[0].strip()
                    if initial:
                        tokens.append(initial)
                    if final:
                        tokens.append(final)

                if not tokens:
                    raise ValueError(f"failed to generate pinyin tokens for wake word: {keyword_text}")

                return f"{' '.join(tokens)} @{keyword_text}"

            def _receive_websocket_message(self) -> str | None:
                try:
                    header = self._read_exact(2)
                except socket.timeout:
                    return None

                if not header:
                    return None

                first_byte, second_byte = header[0], header[1]
                opcode = first_byte & 0x0F
                masked = (second_byte & 0x80) != 0
                payload_length = second_byte & 0x7F

                if payload_length == 126:
                    payload_length = int.from_bytes(self._read_exact(2), "big")
                elif payload_length == 127:
                    payload_length = int.from_bytes(self._read_exact(8), "big")

                masking_key = self._read_exact(4) if masked else b""
                payload = self._read_exact(payload_length) if payload_length else b""

                if masked and payload:
                    payload = bytes(
                        byte ^ masking_key[index % 4]
                        for index, byte in enumerate(payload)
                    )

                if opcode == 0x8:
                    raise ConnectionAbortedError("websocket closed by client")

                if opcode == 0x9:
                    self._send_websocket_frame(0xA, payload)
                    return None

                if opcode == 0xA:
                    return None

                if opcode != 0x1:
                    return None

                return payload.decode("utf-8")

            def _read_exact(self, size: int) -> bytes:
                if size <= 0:
                    return b""

                chunks = bytearray()
                while len(chunks) < size:
                    chunk = self.connection.recv(size - len(chunks))
                    if not chunk:
                        raise ConnectionResetError("websocket connection closed")
                    chunks.extend(chunk)
                return bytes(chunks)

            def _send_websocket_text(self, message: str) -> None:
                self._send_websocket_frame(0x1, message.encode("utf-8"))

            def _send_websocket_frame(self, opcode: int, payload: bytes) -> None:
                header = bytearray()
                header.append(0x80 | opcode)

                payload_length = len(payload)
                if payload_length < 126:
                    header.append(payload_length)
                elif payload_length < 65536:
                    header.append(126)
                    header.extend(payload_length.to_bytes(2, "big"))
                else:
                    header.append(127)
                    header.extend(payload_length.to_bytes(8, "big"))

                self.wfile.write(bytes(header) + payload)
                self.wfile.flush()

        server = ThreadingHTTPServer((self.host, self.port), TestRuntimeHandler)
        server.daemon_threads = True
        return server
