// 左栏相框里的「相册轮播」—— 循环播放 D:\Project\data 里的照片和视频。
//
// 目录不在网页根目录下，靠唤醒词服务暴露的两个接口读写（见
// wakeword_runtime/runtime/http_server.py 的 /media 与 /save-photo）：
//   GET  /media        列出图片和视频
//   GET  /media/<名字>  读取单个文件
//   POST /save-photo   把拍到的照片存成 df_<序号>.jpg
//
// 视频必须 muted 才能自动播放（浏览器策略），用户要的就是静音显示。
// 轮播节奏：图片停 IMAGE_MS，视频播完自然切下一个。

import { log } from '../utils/logger.js?v=0222';

const IMAGE_MS = 8000;
const FALLBACK_SRC = 'images/jiajia.jpg'; // data 目录为空时的兜底，别让相框空着

let stage = null;
let playlist = [];
let cursor = 0;
let timer = null;
let currentEl = null;

function el() {
    return stage || (stage = document.getElementById('jiajiaMediaStage'));
}

function clearTimer() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}

function mediaUrl(name) {
    return '/media/' + encodeURIComponent(name);
}

/** 把某个元素放进舞台（替换掉上一个） */
function show(node) {
    const s = el();
    if (!s) return;
    if (currentEl && currentEl.parentNode === s) {
        s.removeChild(currentEl);
    }
    currentEl = node;
    s.appendChild(node);
}

function showFallback() {
    const img = document.createElement('img');
    img.src = FALLBACK_SRC;
    img.alt = '嘉嘉';
    show(img);
}

function nextIndex() {
    return playlist.length ? (cursor + 1) % playlist.length : 0;
}

function playAt(index) {
    clearTimer();
    const s = el();
    if (!s) return;

    if (!playlist.length) {
        showFallback();
        return;
    }

    cursor = ((index % playlist.length) + playlist.length) % playlist.length;
    const item = playlist[cursor];
    const url = mediaUrl(item.name);

    if (item.kind === 'video') {
        const v = document.createElement('video');
        v.muted = true;          // 必须，否则浏览器不给自动播放
        v.autoplay = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.src = url;
        v.addEventListener('ended', () => playAt(nextIndex()));
        v.addEventListener('error', () => {
            log(`视频播放失败，跳过: ${item.name}`, 'warning');
            playAt(nextIndex());
        });
        show(v);
        // 兜底：万一 ended 没触发（某些编码），按 60 秒强切
        timer = setTimeout(() => playAt(nextIndex()), 60000);
        v.play().catch(() => {
            log(`视频自动播放被拒，跳过: ${item.name}`, 'warning');
            playAt(nextIndex());
        });
    } else {
        const img = document.createElement('img');
        img.src = url;
        img.alt = item.name;
        img.addEventListener('error', () => {
            log(`图片加载失败，跳过: ${item.name}`, 'warning');
            playAt(nextIndex());
        });
        show(img);
        timer = setTimeout(() => playAt(nextIndex()), IMAGE_MS);
    }
}

/** 拉取媒体列表；列表没变就保持当前播放位置不打断 */
export async function refreshMedia(force = false) {
    try {
        const res = await fetch('/media', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];

        const before = playlist.map(x => x.name).join('|');
        const after = items.map(x => x.name).join('|');
        if (!force && before === after && currentEl) {
            return; // 列表没变，别打断正在播的东西
        }

        const curName = playlist[cursor] && playlist[cursor].name;
        playlist = items;

        // 正在播的那个如果还在，就接着播 —— 新丢进来的文件只是排进队列，
        // 不该把画面硬切回第一个
        const keep = items.findIndex(x => x.name === curName);
        if (!force && keep >= 0 && currentEl) {
            cursor = keep;
            log(`相册更新，现共 ${items.length} 个媒体`, 'info');
            return;
        }
        log(`相册已加载 ${items.length} 个媒体`, 'info');
        playAt(0);
    } catch (e) {
        log(`相册加载失败: ${e.message}`, 'warning');
        if (!currentEl) showFallback();
    }
}

// 拍照保存成功后由 tools.js 调用：把新照片纳入轮播
window.jiajiaMedia = {
    refresh: (force = false) => refreshMedia(force),
};

refreshMedia(true);

// 定时看目录里有没有新文件 —— 往 D:\Project\data 里丢图片/视频，
// 页面不用刷新就会自动加进轮播
setInterval(() => refreshMedia(false), 20000);
