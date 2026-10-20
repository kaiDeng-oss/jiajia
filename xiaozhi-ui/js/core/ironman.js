// 钢铁侠虚拟体 - Three.js 程序化机甲
// 说话时胸口反应堆脉冲发光；支持拖拽旋转
import * as THREE from 'three';

// 机甲配色
const RED = 0xc41e2a;      // 战甲红
const GOLD = 0xd8a33a;     // 战甲金
const DARK = 0x2a2a30;     // 结构深灰
const CORE_BLUE = 0x66d9ff; // 反应堆蓝

class IronMan {
    constructor(canvasId, stateElId) {
        this.canvas = document.getElementById(canvasId);
        this.stateEl = document.getElementById(stateElId);
        this.speaking = false;
        this.coreGlow = 1.0; // 当前反应堆亮度（动画插值）
        this.targetGlow = 1.0;
        this.suit = null;
        this.coreLight = null;
        this.coreMesh = null;
        this.autoRotate = true;
        this.rotating = false;
        this.rotY = 0;
        this.rotX = 0;
        this.lastX = 0;
        this.lastY = 0;

        if (!this.canvas) return;
        this.init();
    }

    init() {
        const width = this.canvas.clientWidth || 320;
        const height = this.canvas.clientHeight || 380;

        // 场景
        this.scene = new THREE.Scene();

        // 相机
        this.camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
        this.camera.position.set(0, 0.9, 3.4);
        this.camera.lookAt(0, 0.7, 0);

        // 渲染器
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: true
        });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0x000000, 0);

        // 灯光
        const ambient = new THREE.AmbientLight(0xffffff, 0.55);
        this.scene.add(ambient);

        const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
        keyLight.position.set(2.5, 3, 3);
        this.scene.add(keyLight);

        const rimLight = new THREE.DirectionalLight(0xffd0e0, 0.5);
        rimLight.position.set(-2, 1, -2);
        this.scene.add(rimLight);

        // 反应堆点光源（说话时变亮）
        this.coreLight = new THREE.PointLight(CORE_BLUE, 0.8, 2.5);
        this.coreLight.position.set(0, 0.42, 0.35);
        this.scene.add(this.coreLight);

        // 构建机甲
        this.suit = this.buildIronMan();
        this.scene.add(this.suit);

        // 拖拽旋转
        this.canvas.addEventListener('pointerdown', (e) => {
            this.rotating = true;
            this.autoRotate = false;
            this.lastX = e.clientX;
            this.lastY = e.clientY;
            this.canvas.style.cursor = 'grabbing';
        });
        window.addEventListener('pointermove', (e) => {
            if (!this.rotating) return;
            this.rotY += (e.clientX - this.lastX) * 0.01;
            this.rotX += (e.clientY - this.lastY) * 0.005;
            this.rotX = Math.max(-0.5, Math.min(0.5, this.rotX));
            this.lastX = e.clientX;
            this.lastY = e.clientY;
        });
        window.addEventListener('pointerup', () => {
            this.rotating = false;
            this.canvas.style.cursor = 'grab';
        });

        // 窗口自适应
        window.addEventListener('resize', () => this.resize());

        this.animate();
        this.setState('待机');
    }

    // 构建钢铁侠机甲（几何体组合）
    buildIronMan() {
        const group = new THREE.Group();

        // 材质
        const red = new THREE.MeshStandardMaterial({ color: RED, roughness: 0.42, metalness: 0.75 });
        const gold = new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.35, metalness: 0.85 });
        const dark = new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.6, metalness: 0.5 });
        const coreMat = new THREE.MeshBasicMaterial({ color: CORE_BLUE });

        // 头盔（金色）
        const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 20), gold);
        helmet.position.set(0, 1.52, 0);
        helmet.scale.set(1, 1.08, 1.05);
        group.add(helmet);

        // 面部（深色面罩）
        const face = new THREE.Mesh(new THREE.SphereGeometry(0.225, 18, 14), dark);
        face.position.set(0, 1.5, 0.16);
        face.scale.set(0.85, 0.78, 0.4);
        group.add(face);

        // 眼睛（发光）
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x9ff0ff });
        const eyeGeo = new THREE.BoxGeometry(0.07, 0.028, 0.02);
        const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
        eyeL.position.set(-0.095, 1.53, 0.27);
        const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
        eyeR.position.set(0.095, 1.53, 0.27);
        group.add(eyeL, eyeR);

        // 躯干（红色，圆角感用盒+缩放）
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.78, 0.4), red);
        torso.position.set(0, 0.82, 0);
        group.add(torso);

        // 胸口弧反应堆
        const coreRing = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.016, 12, 28), gold);
        coreRing.position.set(0, 0.42, 0.21);
        coreRing.rotation.x = 0;
        group.add(coreRing);
        this.coreMesh = new THREE.Mesh(new THREE.CircleGeometry(0.062, 20), coreMat);
        this.coreMesh.position.set(0, 0.42, 0.218);
        group.add(this.coreMesh);

        // 腰腹（金）
        const waist = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.24, 0.14, 16), gold);
        waist.position.set(0, 0.3, 0);
        group.add(waist);

        // 肩甲（金，左右）
        for (const side of [-1, 1]) {
            const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), gold);
            shoulder.position.set(side * 0.42, 1.22, 0);
            shoulder.scale.set(0.95, 0.7, 1.15);
            group.add(shoulder);

            // 上臂（红）
            const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.065, 0.34, 12), red);
            arm.position.set(side * 0.38, 1.0, 0);
            group.add(arm);

            // 前臂（金）
            const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.05, 0.3, 12), gold);
            forearm.position.set(side * 0.37, 0.68, 0);
            group.add(forearm);

            // 手掌
            const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), gold);
            hand.position.set(side * 0.365, 0.5, 0);
            group.add(hand);

            // 大腿（红）
            const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.075, 0.36, 12), red);
            thigh.position.set(side * 0.14, -0.06, 0);
            group.add(thigh);

            // 小腿（金）
            const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.3, 12), gold);
            shin.position.set(side * 0.14, -0.36, 0);
            group.add(shin);

            // 脚（金）
            const foot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.28), gold);
            foot.position.set(side * 0.14, -0.55, 0.05);
            group.add(foot);
        }

        // 颈部
        const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.1, 12), gold);
        neck.position.set(0, 1.24, 0);
        group.add(neck);

        return group;
    }

    setSpeaking(isSpeaking) {
        this.speaking = isSpeaking;
        this.targetGlow = isSpeaking ? 3.6 : 1.0;
        this.setState(isSpeaking ? '讲话中…' : '聆听中');
    }

    setState(text) {
        if (this.stateEl) this.stateEl.textContent = text;
    }

    resize() {
        if (!this.canvas) return;
        const width = this.canvas.clientWidth || 320;
        const height = this.canvas.clientHeight || 380;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        if (!this.suit) return;

        // 反应堆亮度插值
        this.coreGlow += (this.targetGlow - this.coreGlow) * 0.08;
        if (this.coreLight) {
            this.coreLight.intensity = this.coreGlow;
        }
        if (this.coreMesh) {
            const scale = 1 + (this.targetGlow - 1.0) * 0.18 * Math.sin(Date.now() * 0.02);
            this.coreMesh.scale.set(scale, scale, 1);
        }

        // 旋转
        if (this.autoRotate) {
            this.rotY += 0.006;
        }
        this.suit.rotation.y = this.rotY;
        this.suit.rotation.x = this.rotX + Math.sin(Date.now() * 0.001) * 0.02;

        // 悬浮呼吸
        this.suit.position.y = Math.sin(Date.now() * 0.0018) * 0.03;

        this.renderer.render(this.scene, this.camera);
    }
}

// 全局单例
window.ironman = new IronMan('ironman-canvas', 'ironmanState');
