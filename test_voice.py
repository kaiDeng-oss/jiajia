# 测试湾湾小何音色：连接服务器，发消息，检查 TTS 是否成功
import asyncio
import json
import websockets

WS_URL = "ws://127.0.0.1:8000/xiaozhi/v1/?device-id=AA:BB:CC:DD:EE:FF&client-id=web_test_client"


async def main():
    async with websockets.connect(WS_URL, max_size=100 * 1024 * 1024) as ws:
        await ws.send(json.dumps({
            "type": "hello",
            "device_id": "AA:BB:CC:DD:EE:FF",
            "device_name": "测试设备",
            "device_mac": "AA:BB:CC:DD:EE:FF",
            "token": "",
            "features": {"mcp": True, "emoji": False},
        }))
        while True:
            msg = await asyncio.wait_for(ws.recv(), timeout=15)
            if isinstance(msg, bytes):
                continue
            data = json.loads(msg)
            if data.get("type") == "hello" and data.get("session_id"):
                break

        await asyncio.sleep(1)
        await ws.send(json.dumps({
            "type": "listen", "state": "detect", "text": "你好呀"
        }))
        print("[OK] 已发送，等待回复...")
        got_tts = False
        got_audio = False
        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=30)
                if isinstance(msg, bytes):
                    got_audio = True
                    continue
                data = json.loads(msg)
                t = data.get("type", "")
                if t == "tts" and data.get("state") == "sentence_start":
                    got_tts = True
                    print(f"[TTS文本] {data.get('text','')[:100]}")
                elif t == "tts" and data.get("state") == "stop":
                    break
        except asyncio.TimeoutError:
            print("[!] 超时")
        print(f"\nTTS 成功: {'✓' if got_tts else '✗'}   音频: {'✓' if got_audio else '✗'}")
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
