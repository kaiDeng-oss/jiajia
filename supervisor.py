# -*- coding: utf-8 -*-
"""嘉嘉AI语音助手守护脚本(跨平台:Windows / Linux)

start.bat(Windows) 或 start.sh(Linux) 会调用本脚本:
- 启动 xiaozhi-server (8000/8003) 和 嘉嘉UI+唤醒词 (8006)
- 子进程崩溃自动重启(带冷却防抖,避免崩溃循环)
- 日志自动轮转保存在 <项目>/logs/ (UTF-8 编码,可直接查看)
- 启动时会先清理占用 8000/8003/8006 的旧服务进程
- 关闭控制台窗口 = 优雅停止全部服务并清理锁文件(CTRL_CLOSE 处理器, 不留孤儿进程)

用法:
  python supervisor.py              启动守护
  python supervisor.py --stop       停止全部服务并退出(含正在运行的守护)
  python supervisor.py --status     查看守护/服务/端口状态
  python supervisor.py --no-browser 启动但不自动打开网页

跨平台说明:
- Windows: 虚拟环境 venv-xiaozhi/Scripts/python.exe
- Linux  : 虚拟环境 ~/.venvs/jiajia/bin/python(可用环境变量 JIAJIA_VENV_PY 覆盖)
- 进程/端口检查用 psutil,不依赖 tasklist/taskkill/netstat
- .supervisor.pid 带平台标签,两系统共用同一文件互不误判
"""
import os
import socket
import subprocess
import sys
import time
import webbrowser
from collections import deque

try:
    import psutil
except ImportError:
    psutil = None

ROOT = os.path.dirname(os.path.abspath(__file__))
IS_WINDOWS = os.name == "nt"

if os.environ.get("JIAJIA_VENV_PY"):
    VENV_PY = os.environ["JIAJIA_VENV_PY"]
elif IS_WINDOWS:
    VENV_PY = os.path.join(ROOT, "venv-xiaozhi", "Scripts", "python.exe")
else:
    VENV_PY = os.path.join(os.path.expanduser("~"), ".venvs", "jiajia", "bin", "python")

SERVER_DIR = os.path.join(ROOT, "xiaozhi-esp32-server-main", "main", "xiaozhi-server")
SERVER_PY = os.path.join(SERVER_DIR, "app.py")
UI_DIR = os.path.join(ROOT, "xiaozhi-ui")
UI_PY = os.path.join(UI_DIR, "start.py")
LOG_DIR = os.path.join(ROOT, "logs")
LOCK_FILE = os.path.join(ROOT, ".supervisor.pid")
PAGE_URL = "http://127.0.0.1:8006/index.html"
PORTS = (8000, 8003, 8006)
LOG_KEEP = 3        # 日志保留代数(server.log / .1 / .2)
CRASH_WINDOW = 60.0 # 秒: 窗口时间内崩溃次数达到上限则进入冷却
CRASH_LIMIT = 3
COOLDOWN = 15.0     # 冷却秒数
POLL_INTERVAL = 2.0
BROWSER_DEADLINE = 120.0

SERVICES = [
    {"name": "server", "cmd": [VENV_PY, SERVER_PY], "cwd": SERVER_DIR,
     "log": os.path.join(LOG_DIR, "server.log"), "ports": [8000, 8003]},
    {"name": "ui", "cmd": [VENV_PY, UI_PY], "cwd": UI_DIR,
     "log": os.path.join(LOG_DIR, "ui.log"), "ports": [8006]},
]


def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def pid_alive(pid):
    if psutil is None:
        return False
    try:
        p = psutil.Process(pid)
        return p.is_running() and p.status() != psutil.STATUS_ZOMBIE
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


def is_our_process(pid):
    """仅识别本项目相关进程,避免跨平台 PID 碰撞误伤无关进程"""
    if psutil is None:
        return False
    try:
        cmdline = " ".join(psutil.Process(pid).cmdline() or [])
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False
    return ("xiaozhi-esp32-server-main" in cmdline
            or "xiaozhi-ui" in cmdline
            or "supervisor.py" in cmdline)


def kill_pids(pids):
    """整树杀掉本项目进程(原 taskkill /T /F 的等价实现)"""
    if psutil is None:
        return
    for pid in pids:
        if pid == os.getpid() or not is_our_process(pid):
            continue
        try:
            p = psutil.Process(pid)
            for child in p.children(recursive=True):
                try:
                    child.kill()
                except psutil.NoSuchProcess:
                    pass
            p.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass


def find_port_pids():
    """找到占用 8000/8003/8006 的进程(原 netstat -ano 的等价实现)"""
    if psutil is None:
        return set()
    pids = set()
    for conn in psutil.net_connections(kind="tcp"):
        if (conn.status == psutil.CONN_LISTEN and conn.laddr
                and conn.laddr.port in PORTS and conn.pid):
            pids.add(conn.pid)
    return pids


def read_lock():
    """读取锁文件, 返回 (平台, pid, 启动时间); 兼容旧格式(无启动时间)"""
    if not os.path.exists(LOCK_FILE):
        return None, None, None
    try:
        raw = open(LOCK_FILE).read().strip()
        parts = raw.split(":")
        if len(parts) == 1:
            return "", int(raw), None  # 旧格式: 裸 PID
        plat, pid = parts[0], int(parts[1])
        create = float(parts[2]) if len(parts) >= 3 else None
        return plat, pid, create
    except (ValueError, OSError):
        return None, None, None


def lock_is_stale(plat, pid, create=None):
    """锁是否过期: PID 已死 / 被回收给别的进程 / 启动时间对不上, 任一成立即过期"""
    if plat == sys.platform:
        # PID 存活但已不是本项目进程 = 陈旧锁(Windows 会回收 PID 给别的进程)
        if not is_our_process(pid):
            return True
        # 同一 PID 但启动时间不同 = 旧锁(PID 复用兜底校验)
        if create is not None:
            try:
                return abs(psutil.Process(pid).create_time() - create) > 2
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                return True
        return False
    if not plat:
        # 旧格式锁来自旧版 Windows 守护:Linux 上一律视为过期(避免误查同号 Linux PID)
        return not IS_WINDOWS or not pid_alive(pid)
    return True  # 另一平台的锁,对当前平台无效


def rotate_log(path):
    for i in range(LOG_KEEP - 1, 0, -1):
        src = path if i == 1 else "%s.%d" % (path, i - 1)
        dst = "%s.%d" % (path, i)
        if os.path.exists(dst):
            os.remove(dst)
        if os.path.exists(src):
            os.rename(src, dst)


def ports_ready(ports):
    for port in ports:
        s = socket.socket()
        s.settimeout(0.5)
        try:
            s.connect(("127.0.0.1", port))
        except OSError:
            return False
        finally:
            s.close()
    return True


def open_browser(url):
    if IS_WINDOWS:
        os.startfile(url)
        return
    # Linux/WSL: 优先系统默认方式;失败则经 WSL interop 调 Windows 默认浏览器
    try:
        ok = webbrowser.open(url)
    except Exception:
        ok = False
    if not ok:
        try:
            subprocess.Popen(["cmd.exe", "/c", "start", "", url],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            log("已通过 Windows 浏览器打开: %s" % url)
        except Exception:
            log("无法自动打开浏览器,请手动访问 %s" % url)


def start_service(svc):
    os.makedirs(LOG_DIR, exist_ok=True)
    f = open(svc["log"], "ab", buffering=0)
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    # 剥离代理环境变量：本机 HTTP_PROXY/HTTPS_PROXY 指向一个未运行的本地代理
    # (127.0.0.1:7890)，而 openai SDK 底层的 httpx 默认 trust_env=True 会读它，
    # 导致视觉分析等出网调用报 APIConnectionError（aiohttp 不读，所以 TTS 不受影响）。
    # 这里直接清掉，让子进程一律直连。
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
              "http_proxy", "https_proxy", "all_proxy"):
        env.pop(k, None)
    kwargs = {}
    if IS_WINDOWS:
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    proc = subprocess.Popen(svc["cmd"], cwd=svc["cwd"], env=env,
                            stdout=f, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, **kwargs)
    svc["proc"] = proc
    svc["logf"] = f
    svc.setdefault("crashes", deque()).clear()
    log("%s 已启动 (pid %d), 日志: %s" % (svc["name"], proc.pid, svc["log"]))


def check_service(svc):
    proc = svc.get("proc")
    if proc is None:
        start_service(svc)
        return
    code = proc.poll()
    if code is None:
        return
    # 子进程退出了
    if svc.get("logf"):
        try:
            svc["logf"].close()
        except Exception:
            pass
        svc["logf"] = None
    svc["proc"] = None
    now = time.time()
    crashes = svc.setdefault("crashes", deque())
    crashes.append(now)
    while crashes and crashes[0] < now - CRASH_WINDOW:
        crashes.popleft()
    log("%s 已退出 (code=%s), 自动重启..." % (svc["name"], code))
    if len(crashes) >= CRASH_LIMIT:
        log("%s 窗口期内崩溃 %d 次, 冷却 %.0f 秒" % (svc["name"], len(crashes), COOLDOWN))
        time.sleep(COOLDOWN)
    start_service(svc)


def stop_all():
    # 若有守护实例在运行,连服务一起整树杀掉(跳过自己: 关窗时 stop_all 由守护自己调用)
    plat, pid, create = read_lock()
    if pid and pid != os.getpid() and not lock_is_stale(plat, pid, create):
        log("停止守护进程树 (pid %d)..." % pid)
        kill_pids([pid])
        time.sleep(2)
    # 清理自己管理的子进程
    for svc in SERVICES:
        proc = svc.get("proc")
        if proc and proc.poll() is None:
            kill_pids([proc.pid])
        if svc.get("logf"):
            try:
                svc["logf"].close()
            except Exception:
                pass
        svc["proc"] = None
        svc["logf"] = None
    # 兜底: 清理仍占用端口的进程
    leftover = find_port_pids()
    if leftover:
        log("清理残留端口进程: %s" % ", ".join(map(str, sorted(leftover))))
        kill_pids(leftover)
    if os.path.exists(LOCK_FILE):
        try:
            os.remove(LOCK_FILE)
        except OSError:
            pass
    time.sleep(1)


def status():
    """快速查看守护/服务/端口状态"""
    plat, pid, create = read_lock()
    if pid and not lock_is_stale(plat, pid, create):
        log("守护运行中 (pid %d), 服务由守护托管" % pid)
    else:
        log("守护未运行")
    owners = sorted(find_port_pids())
    if owners:
        log("8000/8003/8006 占用进程: %s" % ", ".join(map(str, owners)))
    else:
        log("8000/8003/8006 无进程占用")
    log("UI 页面: %s (%s)" % (PAGE_URL, "可访问" if ports_ready([8006]) else "不可访问"))
    log("server: %s" % ("可访问" if ports_ready([8000]) else "不可访问"))


def register_console_close_handler():
    """Windows 关闭控制台窗口时优雅停止: 杀子进程 + 清理锁文件, 不留孤儿进程"""
    if not IS_WINDOWS:
        return
    try:
        import ctypes
        def handler(ctrl_type):
            if ctrl_type == 0x2:  # CTRL_CLOSE_EVENT: 用户点击窗口关闭按钮
                try:
                    log("控制台窗口关闭, 停止全部服务...")
                    stop_all()
                    log("已全部停止")
                finally:
                    os._exit(0)
            return False  # Ctrl+C / Ctrl+Break 等走默认处理(KeyboardInterrupt)
        cb = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_uint)(handler)
        if ctypes.windll.kernel32.SetConsoleCtrlHandler(cb, 1):
            globals()["_console_ctrl_handler"] = cb  # 保持引用, 防止被 GC 后处理器失效
    except Exception:
        pass  # 注册失败不影响正常运行


def main():
    stop_only = "--stop" in sys.argv
    no_browser = "--no-browser" in sys.argv

    if not os.path.exists(VENV_PY):
        log("找不到 python: %s" % VENV_PY)
        return 1

    if "--status" in sys.argv:
        status()
        return 0

    if stop_only:
        log("停止全部服务...")
        stop_all()
        log("已全部停止")
        return 0

    # 单实例保护(平台标签 + 启动时间, 跨系统不误判, 防 PID 复用)
    plat, pid, create = read_lock()
    if pid and not lock_is_stale(plat, pid, create):
        log("守护已在运行 (pid %d), 本实例退出" % pid)
        log("如需重启: 先执行 python supervisor.py --stop; 若服务实际未在运行, 删除 %s 后重试" % LOCK_FILE)
        return 1
    if pid:
        try:
            os.remove(LOCK_FILE)  # 残留的过期锁
        except OSError:
            pass

    register_console_close_handler()
    log("========== 嘉嘉AI语音助手守护启动 ==========")
    os.makedirs(LOG_DIR, exist_ok=True)
    for svc in SERVICES:
        rotate_log(svc["log"])

    old = find_port_pids()
    if old:
        log("清理旧服务进程: %s" % ", ".join(map(str, sorted(old))))
        kill_pids(old)
        time.sleep(1)
        # 仅清理本项目进程: 若端口仍被无关进程占用, 明确警告以便排查
        still = find_port_pids()
        if still:
            for pid in sorted(still):
                try:
                    pname = psutil.Process(pid).name()
                except Exception:
                    pname = "?"
                log("警告: 端口仍被非本项目进程占用 (pid %s, %s), 服务可能无法绑定" % (pid, pname))
            log("可运行 python supervisor.py --status 查看占用详情")

    for svc in SERVICES:
        svc["proc"] = None
        start_service(svc)

    try:
        create = psutil.Process().create_time() if psutil else time.time()
    except Exception:
        create = time.time()
    with open(LOCK_FILE, "w") as f:
        f.write("%s:%d:%.3f" % (sys.platform, os.getpid(), create))

    log("全部服务已启动; 关闭本窗口即停止全部服务")
    log("页面: %s" % PAGE_URL)

    opened = no_browser
    deadline = time.time() + BROWSER_DEADLINE
    try:
        while True:
            for svc in SERVICES:
                check_service(svc)
            if not opened:
                if ports_ready([8006]) and ports_ready([8000]):
                    open_browser(PAGE_URL)
                    opened = True
                    log("页面已打开: %s" % PAGE_URL)
                elif time.time() > deadline:
                    log("端口长时间未就绪, 未自动打开页面, 可手动访问 %s" % PAGE_URL)
                    opened = True
            time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        log("收到退出信号, 停止服务...")
        stop_all()
        log("已全部停止, 再见~")
    return 0


if __name__ == "__main__":
    sys.exit(main())
