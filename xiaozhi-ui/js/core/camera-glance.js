// 嘉嘉的「定时瞥视」—— 开会「实时观看」之后，每 20 秒看一眼，画面有变化就主动开口。
//
// 【启动条件：必须用户明确说「开始实时观看」】。相机开着 ≠ 会自动瞥视：
// 相机只由指令打开（见下），瞥视还要再单独说一句才开（watching 开关）。
// 这样她既不会自己开相机，也不会自己没完没了地说话/烧 API。
// 关相机、或点按钮关掉相机，都会顺带把 watching 关掉。
//
// 为什么是「瞥视」而不是「实时视频」：视觉模型（现为 DeepSeek deepseek-flash）是单张图片模型，
// 不支持视频流输入，所以只能靠反复采样来近似"实时观看"。
//
// 「要不要开口」用画面像素变化来判断，而不是比对模型返回的文字：
// 实测同一个静止画面，模型两次会给出措辞差别很大的描述
// （"一個穿白色衣服的人站在房間裡…" vs "一個在房間子，光線明亮…"），
// 文本相似度只有 0.27，靠文字去重根本拦不住。像素对比既可靠又省 API 调用。
//
// 注入原理：服务端 core/handle/textHandler/listenMessageHandler.py 收到
// {type:'listen', state:'detect', text} 会直接 startToChat(conn, text)，
// 走完整的 LLM+TTS 链路 —— 所以往对话里塞一段文本，嘉嘉就会真的开口说话。
//
// 注意：import 的 query 必须和别处完全一致（?v=0222），否则 ES module 会
// 加载出第二份实例，导致 WebSocket 处理器重复。

import { log } from '../utils/logger.js?v=0222';
import { getWebSocketHandler } from './network/websocket.js?v=0222';

const GLANCE_INTERVAL_MS = 20000;  // 瞥视间隔
const GLANCE_QUESTION = '用不超过十五个字描述画面里最主要的人和物，不要描述光线、颜色或背景细节';
const PHOTO_TIMEOUT_MS = 20000;    // 兜底超时，见下方 withTimeout 注释

// 画面变化的判定参数（想让她更敏感/更安静就调这两个）
const GRID = 16;              // 把画面缩成 16x16 再比
const CELL_DELTA = 35;        // 单个格子灰度差超过它才算"变了"
const CHANGED_RATIO = 0.18;   // 变化格子占比超过它才认为画面真的变了

let lastFrame = null;         // 上一次的 16x16 灰度采样
let lastCameraActive = false;
let inFlight = false;
let watching = false;         // 「实时观看」开关：只有它为 true 才会自动瞥视（默认关）

function getContainer() {
    return document.getElementById('cameraContainer');
}

function updateButton(open) {
    const btn = document.getElementById('cameraBtn');
    if (!btn) return;
    const txt = btn.querySelector('.btn-text');
    if (open) {
        btn.classList.add('camera-active');
        if (txt) txt.textContent = '关闭';
    } else {
        btn.classList.remove('camera-active');
        if (txt) txt.textContent = '摄像头';
    }
}

/** 把当前视频帧缩成 GRID x GRID 灰度数组；取不到返回 null */
function sampleFrame() {
    const v = document.getElementById('cameraVideo');
    if (!v || !v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = GRID;
    c.height = GRID;
    const ctx = c.getContext('2d');
    try {
        ctx.drawImage(v, 0, 0, GRID, GRID);
        const d = ctx.getImageData(0, 0, GRID, GRID).data;
        const out = new Array(GRID * GRID);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
            out[p] = (d[i] + d[i + 1] + d[i + 2]) / 3;
        }
        return out;
    } catch (e) {
        return null; // 例如视频还没就绪
    }
}

/** 与上次采样比，返回"变化格子"的占比；没有基准帧时返回 1（当作变了） */
function changedRatio(cur) {
    if (!cur) return 0;
    if (!lastFrame) return 1;
    let changed = 0;
    for (let i = 0; i < cur.length; i++) {
        if (Math.abs(cur[i] - lastFrame[i]) > CELL_DELTA) changed++;
    }
    return changed / cur.length;
}

function extractDescription(result) {
    const va = result && result.vision_analysis;
    if (!va || va.success === false) return '';
    return String(va.response || va.message || '').trim();
}

/**
 * takePhoto 有个坑：app.js:336-340 在 localStorage 没有 'xz_tester_vision'
 * （即尚未成功建立过 ws 连接）时，只打一句 warning 就再也不 resolve，
 * promise 会永久挂起。没有这层超时的话 inFlight 会一直是 true，
 * 之后整个会话都不再瞥视。
 */
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label}超时(${ms}ms)`)), ms)),
    ]);
}

/** 供语音工具调用：开相机 */
export async function openCamera() {
    const container = getContainer();
    if (container && container.classList.contains('active')) {
        return { success: true, message: '相机本来就是开着的' };
    }
    if (typeof window.startCamera !== 'function') {
        return { success: false, error: '摄像头功能未就绪' };
    }
    const ok = await window.startCamera();
    if (!ok) {
        // 把 app.js 记录的真实失败原因翻成用户看得懂、知道怎么办的话
        const reason = (window.chatApp && window.chatApp.lastCameraError) || '';
        const hint = {
            NotAllowedError: '浏览器拒绝了摄像头权限，请点地址栏左边的相机图标选「允许」',
            NotFoundError: '没找到摄像头设备',
            NotReadableError: '摄像头被其他程序占用了（视频会议、相机 App、另一个浏览器标签页等），关掉它们再试',
            OverconstrainedError: '摄像头不支持请求的分辨率',
            AbortError: '摄像头被系统中断了，稍后再试',
        }[reason];
        return {
            success: false,
            error: `相机开启失败：${hint || reason || '未知原因'}`,
        };
    }
    updateButton(true);
    lastFrame = null; // 重置基准帧，让下一轮瞥视一定会开口
    // 注意：开相机 ≠ 开始自动瞥视，得再说一句「开始实时观看」。
    // 这句话会原样进到她的上下文，所以要写成她能照着转述的说明。
    return {
        success: true,
        message: '相机已开启，你现在能看到阿凯了；但你不会自动看，要阿凯另外说「开始实时观看」你才会持续帮他看着',
    };
}

/** 供语音工具调用：开始「实时观看」（开了它才会有 20 秒一次的自动瞥视） */
export async function startWatching() {
    if (watching) {
        return { success: true, message: '已经在实时观看啦' };
    }
    // 观看的前提是相机开着；没开就顺手打开。
    // 这仍然是「用户说了指令」才发生的，不会自己启动。
    const container = getContainer();
    if (!container || !container.classList.contains('active')) {
        const r = await openCamera();
        if (!r.success) return r;
    }
    watching = true;
    lastFrame = null;         // 重置基准帧，让她看的第一眼一定会开口
    lastCameraActive = false;
    return { success: true, message: '好，我开始帮你看着啦，有新东西就跟你说' };
}

/** 供语音工具调用：停止「实时观看」（相机保持开着，只是不再自动瞥视） */
export function stopWatching() {
    if (!watching) {
        return { success: true, message: '本来就没有在实时观看呀' };
    }
    watching = false;
    lastFrame = null;
    lastCameraActive = false;
    return { success: true, message: '好，我不自动看啦' };
}

/** 供语音工具调用：关相机（顺带停掉实时观看） */
export function closeCamera() {
    const container = getContainer();
    if (typeof window.stopCamera === 'function') {
        window.stopCamera();
    }
    if (container) container.classList.remove('active');
    const sw = document.getElementById('cameraSwitch');
    if (sw) sw.classList.remove('active');
    updateButton(false);
    lastFrame = null;
    lastCameraActive = false;
    watching = false;         // 关相机就等于结束观看
    return { success: true, message: '相机已关闭' };
}

/** 供语音工具/调试查询当前状态 */
export function getCameraState() {
    const container = getContainer();
    return {
        open: !!(container && container.classList.contains('active')),
        watching,
    };
}

async function glanceOnce() {
    // 没开「实时观看」就绝不自动瞥视 —— 这是"她不会自己看"的总闸
    if (!watching) return;
    if (inFlight) return;
    if (document.hidden) return; // 页面不在前台就别烧 API 了

    const container = getContainer();
    if (!container || !container.classList.contains('active')) {
        // 相机关了（可能是点按钮关的），观看也一并结束
        watching = false;
        lastCameraActive = false;
        lastFrame = null;
        return;
    }

    const firstGlance = !lastCameraActive;
    lastCameraActive = true;

    // 只在通话中瞥视（未接通时相机本来也开不起来）
    const dialBtn = document.getElementById('dialBtn');
    if (!dialBtn || !dialBtn.classList.contains('dial-active')) return;
    if (typeof window.takePhoto !== 'function') return;

    const ws = getWebSocketHandler();
    if (!ws || !ws.isConnected()) return;
    // 她正在说话就别打断，否则 sendTextMessage 会发 abort 把她的句子掐掉
    if (ws.isRemoteSpeaking) return;

    // 先比像素：画面没怎么变就不开口，也不花 API
    const frame = sampleFrame();
    const ratio = changedRatio(frame);
    if (frame) lastFrame = frame;
    if (!firstGlance && ratio < CHANGED_RATIO) {
        log(`瞥视：画面基本没变（变化 ${(ratio * 100).toFixed(0)}%），保持安静`, 'info');
        return;
    }

    inFlight = true;
    try {
        // 瞥视只用来判断"画面变没变"，传低分辨率就够了，省流量也省分析时间
        const result = await withTimeout(
            window.takePhoto(GLANCE_QUESTION, { maxWidth: 640 }),
            PHOTO_TIMEOUT_MS, '拍照');
        const desc = extractDescription(result);
        if (!desc) {
            log('瞥视：没拿到画面描述', 'warning');
            return;
        }
        if (ws.sendTextMessage(`（鏡頭畫面更新：${desc}）`)) {
            log(`瞥视已注入对话: ${desc}`, 'success');
        }
    } catch (e) {
        log(`瞥视异常: ${e.message}`, 'error');
    } finally {
        inFlight = false;
    }
}

setInterval(glanceOnce, GLANCE_INTERVAL_MS);

// 暴露给 tools.js / wakeword-bridge.js 的语音工具调用
window.jiajiaCamera = {
    open: openCamera,
    close: closeCamera,
    startWatching,
    stopWatching,
    state: getCameraState,
};
