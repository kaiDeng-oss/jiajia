// 嘉嘉形象面板 —— 用真人照片替代原 Three.js 程序化钢铁侠
//
// 注意：这里故意保留 `window.ironman` 这个全局名和 setSpeaking/setState 两个方法，
// 因为 js/ui/controller.js 的 updateSessionStatus() 直接调用 window.ironman.setSpeaking()。
// 换名字就要改 controller.js，没必要。
//
// 原 3D 模块仍在 js/core/ironman.js，未删除。需要回滚时把 index.html 里的
// script 标签换回 ironman.js、并把面板结构还原即可。

class JiajiaAvatar {
    constructor(photoId, frameId, stateElId) {
        this.img = document.getElementById(photoId);
        this.frame = document.getElementById(frameId);
        this.stateEl = document.getElementById(stateElId);
        this.speaking = false;

        if (!this.img || !this.frame) return;

        // 基础缩放留出余量，视差平移时才不会露边
        this.baseScale = 1.06;
        this.img.style.transform = `translate(0px, 0px) scale(${this.baseScale})`;

        this.initParallax();
        this.setState('待机');
    }

    // 鼠标在面板上移动时照片做轻微视差 —— 替代原来的拖拽旋转（静态图转不了）
    initParallax() {
        const panel = this.frame.parentElement;
        if (!panel) return;

        const MAX = 6; // 最大平移像素，再大就看得出来是贴图在动

        panel.addEventListener('pointermove', (e) => {
            const r = this.frame.getBoundingClientRect();
            const dx = (e.clientX - r.left) / r.width - 0.5;
            const dy = (e.clientY - r.top) / r.height - 0.5;
            this.img.style.transform =
                `translate(${(-dx * MAX).toFixed(2)}px, ${(-dy * MAX).toFixed(2)}px) scale(${this.baseScale})`;
        });

        panel.addEventListener('pointerleave', () => {
            this.img.style.transform = `translate(0px, 0px) scale(${this.baseScale})`;
        });
    }

    // 接口与旧 ironman.js 一致
    setSpeaking(isSpeaking) {
        this.speaking = isSpeaking;
        if (this.frame) this.frame.classList.toggle('speaking', isSpeaking);
        this.setState(isSpeaking ? '讲话中…' : '聆听中');
    }

    setState(text) {
        if (this.stateEl) this.stateEl.textContent = text;
    }
}

// 全局单例（名字保持不变，见文件头说明）
// 面板内容现在由 media-carousel.js 轮播填充，所以视差作用在舞台上
// （它的子元素会跟着动），而不是某一张固定的 img。
window.ironman = new JiajiaAvatar('jiajiaMediaStage', 'jiajiaPhotoFrame', 'jiajiaState');
