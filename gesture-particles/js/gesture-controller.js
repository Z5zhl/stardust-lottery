/**
 * 手势控制模块 V9.0 - 完整版
 * 可拖动按钮 + 骨骼矫正 + 双手缩放 + 抓取选中
 * 
 * 核心理念：
 *   - 位置绝对映射：手在哪，相机就看哪（无需特定手势）
 *   - 手掌面积比检测手势（单手旋转/双手动作/双手缩放）
 *   - 纯本地文件加载，无 CDN 依赖，无跨域问题
 *   - 骨骼矫正校准后，手部追踪更自然
 *   - 主手握拳抓住粒子球 + 副手张开 = 选中，主手张开 + 副手握拳 = 引爆
 * 
 * 手势映射：
 *   - 单手  → 绝对位置映射相机旋转
 *   - 双手张开 → 距离缩放
 *   - 主手张开/副手握拳 → 引爆（open_palm）
 *   - 主手握拳/副手张开 → 选中（peace，骨骼手抓住粒子球）
 *   - 双手握拳 → 取消（fist）
 *   - 选中后主手握拳+副手张开 → NOP（保持选中，不触发动作）
 */
(function (global) {
    'use strict';

    /* ====== 配置 ====== */
    var CONFIG = {
        cameraWidth: 200,
        cameraHeight: 150,
        handOpenRatio: 0.30,          // 手掌张开阈值（V23降低，更容易检测握拳）
        actionCooldown: 600,
        twoHandZoomCooldown: 60,
        smoothingFactor: 0.6,         // 基础平滑系数（自适应：0.3~0.7）
        smoothingFast: 0.20,          // V12: 手快速移动时平滑系数（更快响应）
        smoothingSlow: 0.50,          // V12: 手静止时平滑系数（更跟手）
        smoothingSpeedThreshold: 0.02, // V12: 速度阈值
        frameSkip: 3,                 // V14: 跳帧增加（从2→3，降低GPU负载约33%）
        previewWidth: 200,
        previewHeight: 150,
        skeletonColor: 'rgba(80,200,240,0.75)',
        skeletonColor2: 'rgba(240,80,200,0.75)',
        loadTimeout: 6000,
        handLostThreshold: 20,
        twoHandZoomSensitivity: 10.0,
        motionThreshold: 30,
        motionMinArea: 0.005,
        motionSmoothFactor: 0.4,
        calibrationSamples: 5,        // V14: 骨骼校准采样帧数减少（从10→5，校准更快）
        calibrationTimeout: 3000,      // V14: 校准超时缩短（从5000→3000ms）
        dragHandleSize: 42,            // 拖动按钮尺寸
        prayThreshold: 0.06,           // 双手合十距离阈值（归一化坐标）
        prayCooldown: 1500,            // 双手合十冷却时间（ms）
        /* === 手势状态机 === */
        gestureStableFrames: 3,        // 需要连续N帧一致才触发动作
        gestureResetFrames: 5          // 连续N帧不一致才重置状态
    };

    /* ====== 手部关键点常量 ====== */
    var LANDMARK = {
        WRIST: 0,
        THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
        INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
        MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
        RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
        PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20
    };

    /* ====== 手指名称 ====== */
    var FINGER_NAMES = ['thumb','index','middle','ring','pinky'];

    /* ====== 路径工具 ====== */
    function absUrl(relativePath) {
        if (typeof window !== 'undefined' && window.location) {
            var origin = window.location.origin;
            var path = window.location.pathname;
            // 从当前页面路径推导项目根目录（兼容 GitHub Pages 子路径 /stardust-lottery/）
            var projectRoot = path.replace(/\/gesture-particles\/.*$/, '');
            return origin + projectRoot + '/libs/mediapipe/' + relativePath;
        }
        return '../libs/mediapipe/' + relativePath;
    }

    /* ====== 构造函数 ====== */
    function GestureController(opts) {
        opts = opts || {};
        this.onGesture = opts.onGesture || null;
        this.onHandTrack = opts.onHandTrack || null;
        this.onTwoHandZoom = opts.onTwoHandZoom || null;
        this.onCalibrated = opts.onCalibrated || null;
        this.onGrabSelect = opts.onGrabSelect || null;  // 选中后抓住
        this.onHandLandmarks = opts.onHandLandmarks || null;  // V10: 传递原始landmarks给3D场景
        this.container = opts.container || document.body;

        // 状态
        this._stream = null;
        this._videoEl = null;
        this._canvasEl = null;
        this._ctx = null;
        this._handLandmarker = null;
        this._initState = 'idle';
        this._active = false;
        this._lastError = null;
        this._requestId = null;
        this._handLostFrames = 0;
        this._isProcessing = false;
        this._frameCount = 0;
        this._lastActionTime = 0;
        this._lastTwoHandZoomTime = 0;
        this._motionMode = false;    // 是否使用运动检测降级
        this._visionModule = null;   // vision_bundle.mjs 模块引用

        // 手部数据
        this._mainHand = { x: 0.5, y: 0.5, rawX: 0.5, rawY: 0.5, isOpen: true, landmarks: null, fingerState: { thumb:0, index:0, middle:0, ring:0, pinky:0 } };
        this._secondaryHand = { x: 0.5, y: 0.5, isOpen: true, gesture: 'none', landmarks: null, fingerState: { thumb:0, index:0, middle:0, ring:0, pinky:0 } };
        this._twoHandsActive = false;
        this._twoHandDistance = 0;
        this._prevTwoHandDistance = 0;
        this._trackData = { x: 0.5, y: 0.5, rawX: 0.5, rawY: 0.5, gesture: 'rotate', twoHands: false, isOpen: true, fingerMain: null, fingerSec: null };

        // V10: 双手合十检测状态
        this._lastPrayTime = 0;
        this._wasTwoHandOpen = false;

        // 运动检测缓存
        this._motionPrevFrame = null;

        // === 自适应平滑 ===
        this._prevHandX = 0.5;
        this._prevHandY = 0.5;
        this._handSpeed = 0;

        // === 手势状态机（防误触） ===
        this._gestureState = {           // 当前稳定手势状态
            name: 'none',
            stableCount: 0,
            pendingGesture: null,
            pendingCount: 0
        };
        this._prevGestureState = 'none'; // 上次触发的手势

        // === 帧率限制：标签更新最多每秒30次 ===
        this._lastLabelUpdate = 0;
        this._labelUpdateInterval = 33;  // ~30fps

        // === 骨骼矫正 ===
        this._calibrated = false;          // 是否已校准
        this._calibrationOffset = { x: 0, y: 0, scale: 1 };  // 校准偏移
        this._calibrating = false;         // 正在校准中
        this._calibrationSamples = [];     // 校准采样数据
        this._calibrateTimeout = null;     // 校准超时

        // === 选中后抓住 ===
        this._hasSelection = false;        // 外部是否有选中状态

        // V18: 自然抓取检测
        this._handWasOpen = true;          // 主手上一帧是否张开
        this._secHandWasOpen = true;       // 副手上一帧是否张开
        this._lastGrabTime = 0;            // 上次抓取时间
        this._grabCooldown = 1000;         // 抓取冷却（ms），防止误触

        // V19: 语音识别增强
        this._speechActive = false;        // 语音识别是否活跃
        this._speechRetryCount = 0;        // 重试次数
        this._speechLastText = '';         // 上次识别的文本
        this._speechStatusEl = null;       // 语音状态元素

        /* V23: 双手分工 — 左手状态/右手操作 */
        this._leftHandActive = false;      // 左手是否张开（激活系统）
        this._leftHandOpenStart = 0;       // 左手张开起始时间戳
        this._singleHandOpenStart = 0;     // V25: 单手五指张开计时（0.2s防抖）
        this._singleHandActive = false;    // V25: 单手是否已激活
        this._rightHandGesture = 'none';   // 右手当前识别的手势
        this._rightHandGestureStart = 0;   // 右手当前手势起始时间戳
        this._rightHandVisible = false;    // 右手是否在画面中
        this._continuousSwitching = false; // 是否在连续切换模式
        this._lastSwitchTime = 0;          // 上次切换时间（用于连续切换间隔）
        this._explodeHoldTimer = 300;      // 握拳爆炸按住时间(ms)
        this._continuousSwitchDelay = 800; // 连续切换延迟(ms)
        this._continuousSwitchInterval = 200; // 连续切换间隔(ms)
        this._leftHandFistCount = 0;       // 左手握拳连续帧计数
        this._leftHandLostTime = 0;        // V24: 左手手势丢失起始时间（1s容错）
        this._rightHandIndexCount = 0;     // 右手食指伸出连续帧计数
        this._rightHandVCount = 0;         // 右手V字连续帧计数
        this._rightHandFistCount = 0;      // 右手握拳连续帧计数
        /* V25: 挥手检测 */
        this._handXHistory = [];           // 手部X位置历史（最近15帧）
        this._waveCooldown = 0;            // 挥手冷却时间戳
        this._waveThreshold = 0.15;        // 挥手触发阈值（归一化坐标）
        this._waveHistoryFrames = 15;      // 挥手检测帧数窗口

        this._createUI();
    }

    /* ================================================================
     *  UI 层：可拖动按钮 + 校准按钮 + 分离面板
     * ================================================================ */
    GestureController.prototype._createUI = function () {
        var self = this;

        this._uiContainer = document.createElement('div');
        this._uiContainer.id = 'gesture-ui';

        // ====== 切换按钮（可拖动） ======
        this._toggleBtn = document.createElement('div');
        this._toggleBtn.id = 'gt-toggle';
        this._toggleBtn.textContent = '👋';
        this._toggleBtn.title = '开启手势控制（拖动可移动）';
        // 从 localStorage 恢复位置
        this._loadBtnPosition();
        this._toggleBtn.addEventListener('click', function (e) {
            if (self._dragMoved) { self._dragMoved = false; return; }
            self.toggle();
        });
        this._makeDraggable(this._toggleBtn);

        // ====== 校准按钮 ======
        this._calibBtn = document.createElement('div');
        this._calibBtn.id = 'gt-calib';
        this._calibBtn.textContent = '🔧';
        this._calibBtn.title = '骨骼校准（手放画面中央，保持V手势）';
        this._calibBtn.style.display = 'none';
        this._calibBtn.addEventListener('click', function () { self.startCalibration(); });

        // ====== 状态面板 ======
        this._panelEl = document.createElement('div');
        this._panelEl.id = 'gt-panel';
        this._panelEl.innerHTML =
            '<span id="gt-status">待机</span>' +
            '<span id="gt-latency"></span>' +
            '<span id="gt-action"></span>' +
            '<span id="gt-calib-status"></span>';

        // ====== 预览窗口 ======
        this._previewWrap = document.createElement('div');
        this._previewWrap.id = 'gt-preview';
        this._canvasEl = document.createElement('canvas');
        this._canvasEl.id = 'gt-canvas';
        this._canvasEl.width = CONFIG.previewWidth;
        this._canvasEl.height = CONFIG.previewHeight;
        this._previewWrap.appendChild(this._canvasEl);
        this._labelEl = document.createElement('div');
        this._labelEl.id = 'gt-label';
        this._labelEl.textContent = '手势: --';
        this._previewWrap.appendChild(this._labelEl);

        // 追加
        this._uiContainer.appendChild(this._previewWrap);
        this._uiContainer.appendChild(this._panelEl);
        this._uiContainer.appendChild(this._calibBtn);
        this._uiContainer.appendChild(this._toggleBtn);
        this.container.appendChild(this._uiContainer);

        this._ctx = this._canvasEl.getContext('2d');

        // ====== 注入样式 ======
        var pw = CONFIG.previewWidth, ph = CONFIG.previewHeight;
        var style = document.createElement('style');
        style.textContent = [
            '#gesture-ui{position:fixed;inset:0;z-index:250;pointer-events:none;font-family:"Segoe UI","Microsoft YaHei",sans-serif;}',
            '#gesture-ui>*{pointer-events:all;}',

            // 切换按钮（可拖动，无 transition 避免拖拽延迟）
            '#gt-toggle{position:fixed;width:42px;height:42px;border-radius:50%;',
            'background:rgba(5,12,24,0.95);border:2px solid rgba(60,160,220,0.5);',
            'color:rgba(100,180,220,0.9);font-size:18px;',
            'display:flex;align-items:center;justify-content:center;',
            'backdrop-filter:blur(6px);user-select:none;cursor:grab;touch-action:none;',
            'box-shadow:0 2px 12px rgba(0,0,0,0.3);z-index:253;}',
            '#gt-toggle:active{cursor:grabbing;}',
            '#gt-toggle:hover{background:rgba(60,140,200,0.25);border-color:rgba(60,180,220,0.6);color:rgba(140,210,240,0.9);}',
            '#gt-toggle.on{background:rgba(60,200,180,0.2);border-color:rgba(60,220,200,0.5);color:#60e0c0;box-shadow:0 0 20px rgba(60,200,180,0.25),0 2px 12px rgba(0,0,0,0.3);animation:gt-pulse 2s ease-in-out infinite;}',
            '@keyframes gt-pulse{0%,100%{box-shadow:0 0 16px rgba(60,200,180,0.2),0 2px 12px rgba(0,0,0,0.3);}50%{box-shadow:0 0 28px rgba(60,220,200,0.4),0 2px 12px rgba(0,0,0,0.3);}}',

            // 校准按钮
            '#gt-calib{position:fixed;bottom:12px;right:12px;width:36px;height:36px;border-radius:50%;',
            'background:rgba(10,20,36,0.9);border:1.5px solid rgba(240,200,80,0.3);',
            'color:rgba(240,200,80,0.6);font-size:14px;cursor:pointer;',
            'display:none;align-items:center;justify-content:center;',
            'backdrop-filter:blur(6px);user-select:none;z-index:254;',
            'transition:all .3s;box-shadow:0 2px 8px rgba(0,0,0,0.2);}',
            '#gt-calib:hover{background:rgba(240,200,80,0.15);border-color:rgba(240,200,80,0.5);color:rgba(240,210,120,0.9);transform:scale(1.1);}',
            '#gt-calib.calibrating{background:rgba(240,200,80,0.2);border-color:rgba(240,200,80,0.6);color:#f0d060;animation:calib-pulse 0.6s ease-in-out infinite;}',
            '@keyframes calib-pulse{0%,100%{box-shadow:0 0 8px rgba(240,200,80,0.2);}50%{box-shadow:0 0 20px rgba(240,200,80,0.5);}}',

            '#gt-panel{position:fixed;right:12px;bottom:' + (ph + 20) + 'px;',
            'display:none;gap:6px;padding:6px 10px;border-radius:8px;',
            'background:rgba(5,10,20,0.95);border:1px solid rgba(60,160,220,0.3);',
            'backdrop-filter:blur(6px);font-size:11px;color:rgba(140,200,230,0.6);',
            'flex-wrap:wrap;justify-content:center;z-index:252;min-width:100px;}',
            '#gt-panel.show{display:flex;}',
            '#gt-status{color:#60e0c0;font-weight:500;}',
            '#gt-latency{color:rgba(140,200,230,0.4);}',
            '#gt-action{color:rgba(200,180,100,0.6);}',
            '#gt-calib-status{color:rgba(240,200,80,0.5);font-size:10px;width:100%;text-align:center;}',

            '#gt-preview{position:fixed;bottom:12px;right:70px;width:' + pw + 'px;height:' + ph + 'px;',
            'border-radius:10px;overflow:hidden;border:1.5px solid rgba(60,160,220,0.2);',
            'background:#0a0f1a;display:none;',
            'box-shadow:0 0 14px rgba(40,120,180,0.1);z-index:251;}',
            '#gt-canvas{width:100%;height:100%;display:block;background:#0a0f1a;}',
            '#gt-label{position:absolute;bottom:3px;left:50%;transform:translateX(-50%);',
            'font-size:9px;color:#80d8ff;background:rgba(5,12,24,0.75);',
            'padding:1px 6px;border-radius:5px;white-space:nowrap;pointer-events:none;}'
        ].join('\n');
        document.head.appendChild(style);
    };

    /* ====== 按钮拖动 ====== */
    GestureController.prototype._makeDraggable = function (el) {
        var self = this;
        self._dragMoved = false;
        var startX, startY, startLeft, startTop, dragging = false;

        function onStart(e) {
            e.preventDefault();
            var touch = e.touches ? e.touches[0] : e;
            startX = touch.clientX;
            startY = touch.clientY;
            var rect = el.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            dragging = false;
            self._dragMoved = false;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        }

        function onMove(e) {
            e.preventDefault();
            var touch = e.touches ? e.touches[0] : e;
            var dx = touch.clientX - startX;
            var dy = touch.clientY - startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                dragging = true;
                self._dragMoved = true;
            }
            if (!dragging) return;
            el.style.left = (startLeft + dx) + 'px';
            el.style.top = (startTop + dy) + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        }

        function onEnd() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            if (dragging) {
                var rect = el.getBoundingClientRect();
                self._saveBtnPosition(rect.left, rect.top);
            }
            dragging = false;
        }

        el.addEventListener('mousedown', onStart);
        el.addEventListener('touchstart', onStart, { passive: false });
    };

    GestureController.prototype._loadBtnPosition = function () {
        try {
            var pos = JSON.parse(localStorage.getItem('gt-toggle-pos') || 'null');
            if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
                this._toggleBtn.style.left = pos.left + 'px';
                this._toggleBtn.style.top = pos.top + 'px';
                this._toggleBtn.style.right = 'auto';
                this._toggleBtn.style.bottom = 'auto';
                return;
            }
        } catch (e) {}
        // 默认位置：右下角
        this._toggleBtn.style.right = '12px';
        this._toggleBtn.style.bottom = '12px';
    };

    GestureController.prototype._saveBtnPosition = function (left, top) {
        try {
            localStorage.setItem('gt-toggle-pos', JSON.stringify({ left: left, top: top }));
        } catch (e) {}
    };

    /* ================================================================
     *  骨骼矫正
     * ================================================================ */
    GestureController.prototype.startCalibration = function () {
        if (this._calibrating || !this._active) return;
        this._calibrating = true;
        this._calibrationSamples = [];
        this._calibBtn.classList.add('calibrating');
        this._calibBtn.title = '校准中...保持手部在画面中央';
        this._labelEl.textContent = '手势: 校准中...';
        this._setStatus('骨骼校准', '保持手部在中央');
        var calibEl = document.getElementById('gt-calib-status');
        if (calibEl) calibEl.textContent = '校准中 0/' + CONFIG.calibrationSamples;

        var self = this;
        this._calibrateTimeout = setTimeout(function () {
            if (self._calibrating) {
                self._cancelCalibration('校准超时');
            }
        }, CONFIG.calibrationTimeout);
    };

    GestureController.prototype._collectCalibrationSample = function (landmarks) {
        if (!this._calibrating) return;
        var wrist = landmarks[LANDMARK.WRIST];
        var indexMcp = landmarks[LANDMARK.INDEX_MCP];
        var pinkyMcp = landmarks[LANDMARK.PINKY_MCP];
        var palmWidth = Math.sqrt(
            Math.pow(indexMcp.x - pinkyMcp.x, 2) + Math.pow(indexMcp.y - pinkyMcp.y, 2)
        );
        this._calibrationSamples.push({
            x: wrist.x,
            y: wrist.y,
            palmWidth: palmWidth
        });

        // V14: 实时计算当前偏移距离（校准进度提示）
        var avgX = 0, avgY = 0, avgPalm = 0;
        for(var k = 0; k < this._calibrationSamples.length; k++){
            avgX += this._calibrationSamples[k].x;
            avgY += this._calibrationSamples[k].y;
            avgPalm += this._calibrationSamples[k].palmWidth;
        }
        avgX /= this._calibrationSamples.length;
        avgY /= this._calibrationSamples.length;
        avgPalm /= this._calibrationSamples.length;
        var offsetDist = Math.sqrt(Math.pow(0.5 - avgX, 2) + Math.pow(0.5 - avgY, 2));

        var calibEl = document.getElementById('gt-calib-status');
        if (calibEl) {
            calibEl.textContent = this._calibrationSamples.length + '/' + CONFIG.calibrationSamples +
                ' 偏移' + Math.round(offsetDist * 100) + '%' +
                ' 手掌' + Math.round(avgPalm * 100) + '%';
        }

        if (this._calibrationSamples.length >= CONFIG.calibrationSamples) {
            this._finishCalibration();
        }
    };

    GestureController.prototype._finishCalibration = function () {
        if (this._calibrateTimeout) { clearTimeout(this._calibrateTimeout); this._calibrateTimeout = null; }
        this._calibrating = false;
        this._calibBtn.classList.remove('calibrating');

        // 计算平均偏移
        var samples = this._calibrationSamples;
        var avgX = samples.reduce(function (s, c) { return s + c.x; }, 0) / samples.length;
        var avgY = samples.reduce(function (s, c) { return s + c.y; }, 0) / samples.length;
        var avgPalm = samples.reduce(function (s, c) { return s + c.palmWidth; }, 0) / samples.length;

        // 校准偏移：手在画面中央时，偏移量使映射到 (0.5, 0.5)
        // 如果用户手自然偏左，则偏移补偿让其映射到中心
        this._calibrationOffset = {
            x: 0.5 - avgX,       // 手的自然位置偏移
            y: 0.5 - avgY,
            scale: 1.0,
            palmWidth: avgPalm    // 参考手掌宽度
        };
        this._calibrated = true;

        this._labelEl.textContent = '手势: ✅ 已校准';
        this._setStatus('骨骼已校准', '');
        this._calibBtn.title = '重新校准';
        var calibEl = document.getElementById('gt-calib-status');
        if (calibEl) calibEl.textContent = '✅ 校准完成';

        if (this.onCalibrated) {
            this.onCalibrated(this._calibrationOffset);
        }
        console.log('[Gesture] ✅ 骨骼校准完成:', JSON.stringify(this._calibrationOffset));
    };

    GestureController.prototype._cancelCalibration = function (reason) {
        this._calibrating = false;
        this._calibrationSamples = [];
        this._calibBtn.classList.remove('calibrating');
        this._calibBtn.title = '骨骼校准';
        this._labelEl.textContent = '手势: 校准失败';
        this._setStatus('校准失败', reason || '');
        var calibEl = document.getElementById('gt-calib-status');
        if (calibEl) calibEl.textContent = '❌ ' + (reason || '取消');
        if (this._calibrateTimeout) { clearTimeout(this._calibrateTimeout); this._calibrateTimeout = null; }
    };

    /* ====== 应用骨骼矫正 ====== */
    GestureController.prototype._applyCalibration = function (landmarks) {
        if (!this._calibrated || !landmarks) return landmarks;
        var offset = this._calibrationOffset;
        // 仅对关键点位置做偏移矫正
        for (var i = 0; i < landmarks.length; i++) {
            landmarks[i].x = Math.max(0, Math.min(1, landmarks[i].x + offset.x));
            landmarks[i].y = Math.max(0, Math.min(1, landmarks[i].y + offset.y));
        }
        return landmarks;
    };

    /* ================================================================
     *  启动 / 停止
     * ================================================================ */
    GestureController.prototype.start = function () {
        var self = this;
        if (this._active) return Promise.resolve();
        this._initState = 'idle';
        this._lastError = null;

        this._previewWrap.style.display = 'block';
        this._panelEl.classList.add('show');
        this._calibBtn.style.display = 'flex';
        this._toggleBtn.classList.add('on');
        this._labelEl.textContent = '手势: 启动中...';
        this._setStatus('启动摄像头...', '');

        return navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: CONFIG.cameraWidth }, height: { ideal: CONFIG.cameraHeight }, facingMode: 'user' },
            audio: false
        }).then(function (stream) {
            self._stream = stream;
            self._videoEl = document.createElement('video');
            self._videoEl.srcObject = stream;
            self._videoEl.setAttribute('playsinline', '');
            self._videoEl.setAttribute('autoplay', '');
            self._videoEl.setAttribute('muted', '');
            return self._videoEl.play();
        }).then(function () {
            self._active = true;
            self._initState = 'cam';
            self._labelEl.textContent = '手势: 摄像头OK';
            self._setStatus('加载AI引擎...', '');
            self._startRawPreview();
            return self._loadAIEngine();
        }).then(function () {
            self._labelEl.textContent = self._motionMode ? '手势: 运动检测模式' : '手势: ✅ 就绪';
            self._setStatus(self._motionMode ? '运动检测降级' : '就绪', '');
            // V17: 启动语音识别
            self._initSpeechRecognition();
        }).catch(function (err) {
            console.error('[Gesture] 启动失败:', err);
            self._lastError = err;
            var msg = '';
            if (err.name === 'NotAllowedError') {
                msg = '请允许摄像头权限';
                self._toggleBtn.title = '❌ 摄像头被拒绝，点击重试';
                self._toggleBtn.textContent = '❌';
            } else if (err.name === 'NotFoundError') {
                msg = '未找到摄像头';
                self._toggleBtn.title = '❌ 未找到摄像头，点击重试';
                self._toggleBtn.textContent = '📷';
            } else {
                msg = err.message || err.name || '未知错误';
                self._toggleBtn.title = '❌ 错误，点击重试';
                self._toggleBtn.textContent = '⚠️';
            }
            self._labelEl.textContent = '手势: ❌ ' + msg;
            self._setStatus('失败', '点击👋重试');
            self._safeStop();
        });
    };

    GestureController.prototype._safeStop = function () {
        this._active = false;
        this._stopSpeechRecognition(); // V17: 停止语音识别
        if (this._requestId) { cancelAnimationFrame(this._requestId); this._requestId = null; }
        if (this._stream) {
            this._stream.getTracks().forEach(function (t) { t.stop(); });
            this._stream = null;
        }
        if (this._handLandmarker) {
            try { this._handLandmarker.close(); } catch (e) {}
            this._handLandmarker = null;
        }
        this._videoEl = null;
        this._motionPrevFrame = null;
    };

    GestureController.prototype.stop = function () {
        this._safeStop();
        this._previewWrap.style.display = 'none';
        this._panelEl.classList.remove('show');
        this._calibBtn.style.display = 'none';
        this._toggleBtn.classList.remove('on');
        this._toggleBtn.textContent = '👋';
        this._toggleBtn.title = '开启手势控制';
        this._labelEl.textContent = '手势: --';
        this._twoHandsActive = false;
        this._initState = 'idle';
        this._motionMode = false;
        this._calibrated = false;
        if (this._ctx) this._ctx.clearRect(0, 0, CONFIG.previewWidth, CONFIG.previewHeight);
    };

    GestureController.prototype.toggle = function () {
        if (this._active) { this.stop(); }
        else { this.start().catch(function () {}); }
    };

    GestureController.prototype._setStatus = function (status, detail) {
        var el = document.getElementById('gt-status');
        if (el) el.textContent = status;
        var act = document.getElementById('gt-action');
        if (act) act.textContent = detail || '';
    };

    /* ====== 自适应平滑：根据手移动速度动态调整平滑系数 ====== */
    GestureController.prototype._getAdaptiveSmoothing = function (rawX, rawY) {
        var dx = rawX - this._prevHandX;
        var dy = rawY - this._prevHandY;
        this._handSpeed = Math.sqrt(dx * dx + dy * dy);
        this._prevHandX = rawX;
        this._prevHandY = rawY;
        if (this._handSpeed > CONFIG.smoothingSpeedThreshold) {
            // 快速移动 → 低平滑（响应快）
            var ratio = Math.min(1, (this._handSpeed - CONFIG.smoothingSpeedThreshold) / 0.05);
            return CONFIG.smoothingFast + (CONFIG.smoothingFactor - CONFIG.smoothingFast) * (1 - ratio);
        }
        // 慢速/静止 → 高平滑（稳定）
        return CONFIG.smoothingSlow;
    };

    /* ====== 手势状态机：N帧一致才触发动作 ====== */
    GestureController.prototype._updateGestureState = function (gestureName) {
        var state = this._gestureState;
        if (gestureName === state.name) {
            state.stableCount++;
            // 达到稳定阈值时，产生待定手势
            if (state.stableCount >= CONFIG.gestureStableFrames && !state.pendingGesture) {
                state.pendingGesture = gestureName;
                state.pendingCount = 1;
            } else if (state.pendingGesture === gestureName) {
                state.pendingCount++;
            }
        } else {
            // 手势变化：如果待定中且计数器不足，重置
            if (state.pendingGesture && state.pendingCount < CONFIG.gestureStableFrames) {
                state.name = gestureName;
                state.stableCount = 1;
                state.pendingGesture = null;
                state.pendingCount = 0;
            } else {
                state.name = gestureName;
                state.stableCount = 1;
                state.pendingGesture = null;
                state.pendingCount = 0;
            }
        }
    };

    /* 检查手势是否已稳定通过状态机 */
    GestureController.prototype._isGestureStable = function (gestureName) {
        var state = this._gestureState;
        return state.pendingGesture === gestureName && state.pendingCount >= CONFIG.gestureStableFrames;
    };

    /* 更新标签（帧率限制，避免DOM更新过多） */
    GestureController.prototype._updateLabel = function (text) {
        var now = performance.now();
        if (now - this._lastLabelUpdate < this._labelUpdateInterval) return;
        this._lastLabelUpdate = now;
        this._labelEl.textContent = text;
    };

    /* ================================================================
     *  AI 引擎加载（纯本地）
     * ================================================================ */
    GestureController.prototype._loadAIEngine = function () {
        var self = this;
        if (window.__gcVision && window.__gcVision.HandLandmarker) {
            self._visionModule = window.__gcVision;
            return self._initHandLandmarker();
        }

        self._labelEl.textContent = '手势: 加载AI引擎...';
        self._setStatus('加载AI引擎...', 'vision_bundle.mjs');
        var visionPath = absUrl('vision_bundle.mjs');

        return import(visionPath).then(function (vision) {
            window.__gcVision = vision;
            self._visionModule = vision;
            if (!vision.FilesetResolver || !vision.HandLandmarker) {
                var v = vision.default || vision;
                if (v && v.FilesetResolver && v.HandLandmarker) {
                    window.__gcVision = v; self._visionModule = v;
                } else {
                    throw new Error('vision_bundle 缺少 FilesetResolver 或 HandLandmarker');
                }
            }
            self._labelEl.textContent = '手势: 初始化AI...';
            self._setStatus('加载AI引擎...', '初始化HandLandmarker');
            return self._initHandLandmarker();
        }).catch(function (err) {
            console.error('[Gesture] vision_bundle.mjs 加载失败:', err.message);
            self._setStatus('AI引擎失败', '启动运动检测降级...');
            return self._startMotionFallback();
        });
    };

    GestureController.prototype._initHandLandmarker = function () {
        var self = this;
        var vision = self._visionModule || window.__gcVision;
        if (!vision) return Promise.reject(new Error('vision 未加载'));

        var wasmBase = absUrl('wasm/');
        var modelPath = absUrl('hand_landmarker.task');
        var delegates = ['GPU', 'CPU'];

        function tryDelegate(idx) {
            if (idx >= delegates.length) {
                self._labelEl.textContent = '手势: ❌ 初始化失败';
                self._setStatus('初始化失败', '启动运动检测降级');
                return self._startMotionFallback();
            }
            var delegate = delegates[idx];
            self._setStatus('初始化AI...', delegate + ' delegate');

            return vision.FilesetResolver.forVisionTasks(wasmBase).then(function (resolver) {
                return vision.HandLandmarker.createFromOptions(resolver, {
                    baseOptions: { modelAssetPath: modelPath, delegate: delegate },
                    numHands: 2,
                    minHandDetectionConfidence: 0.5,
                    minHandPresenceConfidence: 0.5,
                    minTrackingConfidence: 0.5,
                    runningMode: 'VIDEO'
                });
            }).then(function (hl) {
                self._handLandmarker = hl;
                self._motionMode = false;
                var label = delegate === 'GPU' ? 'GPU加速' : 'CPU模式';
                self._labelEl.textContent = '手势: ✅ ' + label;
                self._setStatus('就绪 (' + label + ')', '');
                self._initState = 'ready';
                console.log('[Gesture] ✅ HandLandmarker(' + label + ')');
                self._processFrame();
                return true;
            }).catch(function (e) {
                console.warn('[Gesture] ' + delegate + ' 失败:', e.message);
                return tryDelegate(idx + 1);
            });
        }
        return tryDelegate(0);
    };

    /* ================================================================
     *  运动检测降级
     * ================================================================ */
    GestureController.prototype._startMotionFallback = function () {
        var self = this;
        self._labelEl.textContent = '手势: 运动检测模式';
        self._setStatus('运动检测降级', '基础追踪');
        self._motionMode = true;
        self._initState = 'ready';
        self._motionCanvas = document.createElement('canvas');
        self._motionCanvas.width = 80;
        self._motionCanvas.height = 60;
        self._motionCtx = self._motionCanvas.getContext('2d');
        self._motionPrevFrame = null;
        console.log('[Gesture] ⚠️ 使用运动检测降级模式');
        self._processFrameMotion();
        return Promise.resolve();
    };

    GestureController.prototype._processFrameMotion = function () {
        if (!this._active || !this._motionMode) return;
        var self = this;
        if (this._isProcessing) {
            this._requestId = requestAnimationFrame(function () { self._processFrameMotion(); });
            return;
        }
        this._isProcessing = true;
        var t0 = performance.now();
        if (this._videoEl && this._videoEl.readyState >= 2) {
            var mc = this._motionCtx, cw = this._motionCanvas.width, ch = this._motionCanvas.height;
            mc.save(); mc.translate(cw, 0); mc.scale(-1, 1);
            mc.drawImage(this._videoEl, 0, 0, cw, ch); mc.restore();
            var imageData = mc.getImageData(0, 0, cw, ch);
            var pixels = imageData.data;
            if (this._motionPrevFrame) {
                var diffCount = 0, sumDiffX = 0, sumDiffY = 0;
                for (var y = 0; y < ch; y++) {
                    for (var x = 0; x < cw; x++) {
                        var idx = (y * cw + x) * 4;
                        var diff = (Math.abs(pixels[idx] - this._motionPrevFrame[idx]) +
                                    Math.abs(pixels[idx+1] - this._motionPrevFrame[idx+1]) +
                                    Math.abs(pixels[idx+2] - this._motionPrevFrame[idx+2])) / 3;
                        if (diff > CONFIG.motionThreshold) { diffCount++; sumDiffX += x; sumDiffY += y; }
                    }
                }
                var motionArea = diffCount / (cw * ch);
                this._drawMotionPreview(diffCount, cw, ch);
                if (motionArea > CONFIG.motionMinArea && diffCount > 0) {
                    var avgX = sumDiffX / diffCount / cw, avgY = sumDiffY / diffCount / ch;
                    this._mainHand.x += CONFIG.motionSmoothFactor * (avgX - this._mainHand.x);
                    this._mainHand.y += CONFIG.motionSmoothFactor * (avgY - this._mainHand.y);
                    this._mainHand.rawX = avgX; this._mainHand.rawY = avgY;
                    this._handLostFrames = 0;
                    if (this.onHandTrack) {
                        this._trackData.x = this._mainHand.x; this._trackData.y = this._mainHand.y;
                        this._trackData.rawX = this._mainHand.rawX; this._trackData.rawY = this._mainHand.rawY;
                        this._trackData.gesture = 'rotate'; this._trackData.twoHands = false;
                        this._trackData.isOpen = true; this._trackData.motionMode = true;
                        this.onHandTrack(this._trackData);
                    }
                    var latency = Math.round(performance.now() - t0);
                    this._labelEl.textContent = '手势: 运动追踪';
                    this._setStatus('运动追踪', latency + 'ms');
                    var latEl = document.getElementById('gt-latency');
                    if (latEl) latEl.textContent = latency + 'ms';
                } else {
                    this._handLostFrames++;
                    if (this._handLostFrames > CONFIG.handLostThreshold) {
                        this._labelEl.textContent = '手势: 等待运动...';
                        this._setStatus('等待运动', '');
                    }
                }
            }
            this._motionPrevFrame = new Uint8Array(pixels);
        }
        this._isProcessing = false;
        this._requestId = requestAnimationFrame(function () { self._processFrameMotion(); });
    };

    GestureController.prototype._drawMotionPreview = function (diffCount, cw, ch) {
        var ctx = this._ctx, pw = CONFIG.previewWidth, ph = CONFIG.previewHeight;
        ctx.clearRect(0, 0, pw, ph);
        if (this._videoEl && this._videoEl.readyState >= 2) {
            ctx.save(); ctx.translate(pw, 0); ctx.scale(-1, 1);
            ctx.drawImage(this._videoEl, 0, 0, pw, ph); ctx.restore();
        }
        if (diffCount > 0) {
            var cx = this._mainHand.x * pw, cy = this._mainHand.y * ph;
            ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,200,80,0.7)'; ctx.lineWidth = 2.5; ctx.stroke();
            ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,200,80,0.5)'; ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,200,80,0.4)'; ctx.font = '9px sans-serif';
        ctx.fillText('运动检测', 6, 14);
    };

    /* ================================================================
     *  帧循环（MediaPipe）
     * ================================================================ */
    GestureController.prototype._processFrame = function () {
        if (!this._active || this._motionMode) return;
        var self = this;
        this._frameCount++;
        if (this._frameCount % CONFIG.frameSkip !== 0) {
            if (this._handLostFrames <= CONFIG.handLostThreshold && this.onHandTrack) {
                this._trackData.x = this._mainHand.x; this._trackData.y = this._mainHand.y;
                this._trackData.gesture = 'rotate';
                this.onHandTrack(this._trackData);
            }
            this._requestId = requestAnimationFrame(function () { self._processFrame(); });
            return;
        }
        if (this._isProcessing) {
            this._requestId = requestAnimationFrame(function () { self._processFrame(); });
            return;
        }
        if (this._videoEl && this._videoEl.readyState >= 2 && this._handLandmarker) {
            this._isProcessing = true;
            try {
                var t0 = performance.now();
                var results = this._handLandmarker.detectForVideo(this._videoEl, performance.now());
                this._onResults(results, performance.now() - t0);
            } catch (e) {}
            this._isProcessing = false;
        }
        this._requestId = requestAnimationFrame(function () { self._processFrame(); });
    };

    /* ================================================================
     *  处理 MediaPipe 结果（V9: 骨骼矫正 + 选中后抓住）
     * ================================================================ */
    GestureController.prototype._onResults = function (results, latency) {
        if (!this._active) return;
        this._drawPreview(results);

        var handCount = results.landmarks ? results.landmarks.length : 0;
        var latEl = document.getElementById('gt-latency');

        if (handCount === 0) {
            this._handLostFrames++;
            this._twoHandsActive = false;
            if (this._handLostFrames > CONFIG.handLostThreshold) {
                this._labelEl.textContent = '手势: 未检测到手';
                this._setStatus('等待手部...', '');
                if (latEl) latEl.textContent = '';
            }
            return;
        }
        this._handLostFrames = 0;

        // 主手
        var landmarks = results.landmarks[0];
        // 应用骨骼矫正
        if (this._calibrated) {
            this._applyCalibration(landmarks);
        }
        // 校准采样
        if (this._calibrating) {
            this._collectCalibrationSample(landmarks);
        }

        var wrist = landmarks[LANDMARK.WRIST];
        this._mainHand.rawX = wrist.x;
        this._mainHand.rawY = wrist.y;
        // V11: 自适应平滑 — 手快移时低平滑响应快，慢移时高平滑稳
        var adaptiveSmoothing = this._getAdaptiveSmoothing(wrist.x, wrist.y);
        this._mainHand.x = this._mainHand.x + adaptiveSmoothing * (wrist.x - this._mainHand.x);
        this._mainHand.y = this._mainHand.y + adaptiveSmoothing * (wrist.y - this._mainHand.y);
        this._mainHand.landmarks = landmarks;
        this._mainHand.isOpen = this._isHandOpen(landmarks);
        this._mainHand.fingerState = this._detectFingerStates(landmarks); // V17: 十指独立检测
        // V18: 自然抓取检测 — 手从张开→闭合的瞬间
        this._mainHand.isGrab = !this._mainHand.isOpen && this._handWasOpen;
        this._handWasOpen = this._mainHand.isOpen;

        // 副手
        if (handCount >= 2) {
            var landmarks2 = results.landmarks[1];
            if (this._calibrated) { this._applyCalibration(landmarks2); }
            var wrist2 = landmarks2[LANDMARK.WRIST];
            this._secondaryHand.x = wrist2.x;
            this._secondaryHand.y = wrist2.y;
            this._secondaryHand.landmarks = landmarks2;
            this._secondaryHand.isOpen = this._isHandOpen(landmarks2);
            this._secondaryHand.fingerState = this._detectFingerStates(landmarks2); // V17: 十指独立检测
            // 副手抓取检测
            this._secondaryHand.isGrab = !this._secondaryHand.isOpen && this._secHandWasOpen;
            this._secHandWasOpen = this._secondaryHand.isOpen;

            // V23: 双手张开 → 由V23手势系统统一处理（左手激活/右手操作）
            this._twoHandsActive = true;
            this._processGestureActions(handCount, Date.now(), latency, latEl, landmarks, landmarks2);
            return;
        } else {
            this._secondaryHand.landmarks = null;
            this._twoHandsActive = false;
        }

        // V25: 单手场景 — 统一由_processGestureActions处理（五指张开/握拳/挥手）
        this._processGestureActions(handCount, Date.now(), latency, latEl, landmarks, null);
        return;
    };

    /* ================================================================
     *  手掌面积比检测
     * ================================================================ */
    GestureController.prototype._isHandOpen = function (landmarks) {
        var wrist = landmarks[LANDMARK.WRIST];
        var tips = [LANDMARK.THUMB_TIP, LANDMARK.INDEX_TIP, LANDMARK.MIDDLE_TIP, LANDMARK.RING_TIP, LANDMARK.PINKY_TIP];
        var totalDist = 0;
        for (var i = 0; i < tips.length; i++) {
            var t = landmarks[tips[i]];
            totalDist += Math.sqrt(Math.pow(t.x - wrist.x, 2) + Math.pow(t.y - wrist.y, 2));
        }
        var avgDist = totalDist / tips.length;
        var indexMcp = landmarks[LANDMARK.INDEX_MCP];
        var pinkyMcp = landmarks[LANDMARK.PINKY_MCP];
        var palmWidth = Math.sqrt(Math.pow(indexMcp.x - pinkyMcp.x, 2) + Math.pow(indexMcp.y - pinkyMcp.y, 2));
        return avgDist / Math.max(palmWidth, 0.01) > CONFIG.handOpenRatio;
    };

    /* ================================================================
     *  十指独立检测 V17
     *  返回每根手指的弯曲状态: 1=伸直, 0=弯曲
     *  用于十根手指映射不同的控制动作
     * ================================================================ */
    GestureController.prototype._detectFingerStates = function (landmarks) {
        if (!landmarks) return { thumb:0, index:0, middle:0, ring:0, pinky:0 };
        var wrist = landmarks[LANDMARK.WRIST];
        var idxMcp = landmarks[LANDMARK.INDEX_MCP];
        var pinkyMcp = landmarks[LANDMARK.PINKY_MCP];
        // 手掌宽度（用于归一化）
        var pw = Math.sqrt(Math.pow(idxMcp.x - pinkyMcp.x, 2) + Math.pow(idxMcp.y - pinkyMcp.y, 2));
        if (pw < 0.01) pw = 0.01;

        // 食指、中指、无名指、小指：指尖到腕部距离 > PIP到腕部距离 * 1.05 即为伸直
        var fingers = [
            { name:'thumb',  tip: LANDMARK.THUMB_TIP,   pip: LANDMARK.THUMB_IP,   mcp: LANDMARK.THUMB_MCP },
            { name:'index',  tip: LANDMARK.INDEX_TIP,   pip: LANDMARK.INDEX_PIP,  mcp: LANDMARK.INDEX_MCP },
            { name:'middle', tip: LANDMARK.MIDDLE_TIP,  pip: LANDMARK.MIDDLE_PIP, mcp: LANDMARK.MIDDLE_MCP },
            { name:'ring',   tip: LANDMARK.RING_TIP,    pip: LANDMARK.RING_PIP,   mcp: LANDMARK.RING_MCP },
            { name:'pinky',  tip: LANDMARK.PINKY_TIP,   pip: LANDMARK.PINKY_PIP,  mcp: LANDMARK.PINKY_MCP }
        ];
        var states = {};
        for (var i = 0; i < fingers.length; i++) {
            var f = fingers[i];
            var tip = landmarks[f.tip];
            var pip = landmarks[f.pip];
            if (f.name === 'thumb') {
                // 拇指：用拇指尖端到食指MCP的距离 > 拇指IP到食指MCP的距离
                var tipDist = Math.sqrt(Math.pow(tip.x - idxMcp.x, 2) + Math.pow(tip.y - idxMcp.y, 2));
                var ipDist  = Math.sqrt(Math.pow(pip.x - idxMcp.x, 2) + Math.pow(pip.y - idxMcp.y, 2));
                states[f.name] = (tipDist > ipDist * 1.0) ? 1 : 0;
            } else {
                // 四指：尖端到腕部 > PIP到腕部 * 阈值
                var tipDist = Math.sqrt(Math.pow(tip.x - wrist.x, 2) + Math.pow(tip.y - wrist.y, 2));
                var pipDist = Math.sqrt(Math.pow(pip.x - wrist.x, 2) + Math.pow(pip.y - wrist.y, 2));
                states[f.name] = (tipDist > pipDist * 1.05) ? 1 : 0;
            }
        }
        return states;
    };

    /* ====== V23: 双手分工 — 左手状态/右手操作 ======
     *  
     *  左手 = 状态主控手：
     *    完全张开（五指展开、掌心朝向摄像头）：激活系统，粒子呈环轨排列并自转
     *    握拳 / 移出画面：系统待机，粒子半透明停止
     *  
     *  右手 = 操作指令手（仅在左手张开时生效）：
     *    仅食指伸出（拇指内收、其余弯曲）：切换至下一个粒子球
     *    食指+中指伸出（V字手势）：切换至上一个粒子球
     *    保持切换手势 > 0.8s → 连续快速切换（每 0.2s 自动切 1 个），松开即停
     *    完全握拳（保持 0.3s 以上）：确认选中当前高亮粒子球，触发爆炸
     *  
     *  边界容错：
     *    右手移出画面：暂停选择，保留当前选中状态
     *    双手手势冲突：优先执行左手的状态指令
     *    爆炸后无剩余粒子：自动回到待机状态（由引擎处理）
     *  
     *  防抖机制：
     *    握拳爆炸需 0.3s 确认 → 规避手势切换误识别
     *    连续切换需 0.8s 预热 → 避免快速切换时误触
     *    所有手势经 3 帧状态机稳定后才触发首次动作
     */
    var _lastHandCount = 0;
    var _handCountStableCount = 0;
    
    GestureController.prototype._detectRightHandFingerPattern = function (fs, isOpen) {
        /* 检测右手特定手指模式
         *  fs: fingerState 手指状态 {thumb,index,middle,ring,pinky} 0/1
         *  isOpen: 手掌面积比检测结果（_isHandOpen），用于握拳判定
         */
        if (!fs) return 'none';
        var idx = fs.index, mid = fs.middle, tmb = fs.thumb, ring = fs.ring, pinky = fs.pinky;
        
        // 握拳检测优先：用面积比最可靠，手指状态作为辅助
        if (!isOpen) {
            var curledCount = (idx === 0 ? 1 : 0) + (mid === 0 ? 1 : 0) + (ring === 0 ? 1 : 0) + (pinky === 0 ? 1 : 0);
            // 面积比显示闭合 + 至少3根手指弯曲 = 握拳
            if (curledCount >= 3) return 'right_fist';
        }

        // 食指伸出（不限制拇指状态，拇指自然位置不影响识别）
        // 中指、无名指、小指需弯曲
        if (idx === 1 && mid === 0 && ring === 0 && pinky === 0) return 'right_index';
        // V字手势（不限制拇指状态）
        if (idx === 1 && mid === 1 && ring === 0 && pinky === 0) return 'right_v';
        // 完全张开（所有手指伸直）
        if (idx === 1 && mid === 1 && tmb === 1 && ring === 1 && pinky === 1) return 'right_open';
        // 其他未识别手势
        return 'right_other';
    };

    /* V25: 挥手方向检测 — 通过手部X位置历史判断 */
    GestureController.prototype._detectWave = function () {
        if (this._handXHistory.length < this._waveHistoryFrames) return 'none';
        var now = Date.now();
        if (now < this._waveCooldown) return 'none'; // 冷却中
        
        // 取最近帧和最早帧的差值
        var recent = this._handXHistory.slice(-5);
        var old = this._handXHistory.slice(0, 5);
        var recentAvg = 0, oldAvg = 0;
        for (var i = 0; i < 5; i++) {
            recentAvg += recent[i];
            oldAvg += old[i];
        }
        recentAvg /= 5;
        oldAvg /= 5;
        
        var delta = recentAvg - oldAvg;
        // 右移为正，左移为负
        if (Math.abs(delta) > this._waveThreshold) {
            this._waveCooldown = now + 500; // 500ms冷却
            return delta > 0 ? 'right' : 'left';
        }
        return 'none';
    };

    /* V25: 检测五指全部张开 */
    GestureController.prototype._detectAllFingersOpen = function (fs) {
        if (!fs) return false;
        return fs.thumb === 1 && fs.index === 1 && fs.middle === 1 && fs.ring === 1 && fs.pinky === 1;
    };
    
    GestureController.prototype._processGestureActions = function (handCount, now, latency, latEl, landmarks, landmarks2) {
        // V16: handCount稳定去抖（保留）
        if (handCount !== _lastHandCount) {
            _handCountStableCount = 0;
            _lastHandCount = handCount;
            if (this.onHandTrack && this._mainHand.landmarks) {
                this._trackData.gesture = 'tracking';
                this._trackData.twoHands = false;
                this._trackData.handCount = handCount;
                this.onHandTrack(this._trackData);
            }
            return;
        }
        _handCountStableCount++;
        if (_handCountStableCount < 3) {
            if (this.onHandTrack && this._mainHand.landmarks) {
                this._trackData.gesture = 'tracking';
                this._trackData.twoHands = false;
                this._trackData.handCount = handCount;
                this.onHandTrack(this._trackData);
            }
            return;
        }

        var fsMain = this._mainHand.fingerState || { thumb:0, index:0, middle:0, ring:0, pinky:0 };
        var nowMs = Date.now();

        // 记录手部X位置历史（用于挥手检测）
        this._handXHistory.push(this._mainHand.x);
        if (this._handXHistory.length > this._waveHistoryFrames) {
            this._handXHistory.shift();
        }

        // 记录追踪数据
        if (this.onHandTrack) {
            this._trackData.x = this._mainHand.x;
            this._trackData.y = this._mainHand.y;
            this._trackData.rawX = this._mainHand.rawX;
            this._trackData.rawY = this._mainHand.rawY;
            this._trackData.handCount = handCount;
            this._trackData.fingerMain = fsMain;
        }

        // =============================================
        // V30: 顾客抽奖手势 — 五指张开激活 / 挥手切换 / 握拳确认
        // =============================================
        var isOpen = this._mainHand.isOpen;
        var allFingersOpen = this._detectAllFingersOpen(fsMain);

        // 检测五指张开 → 激活系统（0.2s防抖）
        if (allFingersOpen) {
            if (!this._singleHandActive) {
                if (this._singleHandOpenStart === 0) {
                    this._singleHandOpenStart = nowMs;
                }
                if (nowMs - this._singleHandOpenStart >= 200) {
                    this._singleHandActive = true;
                    this._singleHandOpenStart = nowMs;
                    this._fireGesture('left_open');
                    this._updateLabel('🖐 已激活 - 挥手切换');
                    this._setStatus('抽奖进行中', '');
                    this._handXHistory = [];
                    if (this.onHandTrack) {
                        this._trackData.gesture = 'left_open'; this._trackData.twoHands = false;
                        this._trackData.isOpen = true;
                        this._trackData.landmarks = landmarks;
                        this._trackData.secondaryLandmarks = null;
                        this.onHandTrack(this._trackData);
                    }
                    if (this.onHandLandmarks) {
                        this.onHandLandmarks(landmarks, landmarks2, handCount);
                    }
                    return;
                }
            } else {
                // 已激活 → 只检测挥手切换
                this._singleHandOpenStart = nowMs;
                this._leftHandLostTime = 0;
                var waveDir = this._detectWave();
                if (waveDir === 'right') {
                    this._fireGesture('right_next');
                    this._updateLabel('👉 挥手向右 → 下一个');
                    this._setStatus('挥手 → 下一个', '');
                    if (this.onHandTrack) {
                        this._trackData.gesture = 'right_next'; this._trackData.twoHands = false;
                        this._trackData.landmarks = landmarks;
                        this.onHandTrack(this._trackData);
                    }
                } else if (waveDir === 'left') {
                    this._fireGesture('right_prev');
                    this._updateLabel('👈 挥手向左 → 上一个');
                    this._setStatus('挥手 → 上一个', '');
                    if (this.onHandTrack) {
                        this._trackData.gesture = 'right_prev'; this._trackData.twoHands = false;
                        this._trackData.landmarks = landmarks;
                        this.onHandTrack(this._trackData);
                    }
                }
            }
        } else if (!isOpen) {
            // 手掌闭合 → 握拳进度检测
            this._singleHandOpenStart = 0;
            if (this._singleHandActive) {
                if (this._rightHandGesture !== 'right_fist') {
                    this._rightHandGesture = 'right_fist';
                    this._rightHandGestureStart = nowMs;
                    this._updateLabel('✊ 握拳中...');
                } else {
                    var fistHold = nowMs - this._rightHandGestureStart;
                    var progress = Math.min(fistHold / this._explodeHoldTimer, 1);
                    // V30: 发送进度更新
                    this._fireGesture('left_fist_progress', { progress: progress, text: '握拳 ' + Math.round(progress * 100) + '%' });
                    this._updateLabel('✊ 握拳 ' + Math.round(progress * 100) + '%');
                    if (fistHold >= this._explodeHoldTimer) {
                        this._rightHandGesture = 'none';
                        this._rightHandFistCount = 0;
                        this._fireGesture('right_explode');
                        this._updateLabel('💥 确认!');
                        this._setStatus('握拳 → 确认抽奖', Math.round(latency) + 'ms');
                        if (this.onHandTrack) {
                            this._trackData.gesture = 'right_explode'; this._trackData.twoHands = false;
                            this._trackData.landmarks = landmarks;
                            this.onHandTrack(this._trackData);
                        }
                    }
                }
            }
        } else {
            // 手掌张开但非五指 → 手势丢失计时
            this._singleHandOpenStart = 0;
            this._rightHandGesture = 'none';
            if (this._singleHandActive) {
                if (this._leftHandLostTime === 0) {
                    this._leftHandLostTime = nowMs;
                } else if (nowMs - this._leftHandLostTime >= 1000) {
                    this._singleHandActive = false;
                    this._leftHandLostTime = 0;
                    this._handXHistory = [];
                    this._fireGesture('left_fist');
                    this._updateLabel('✊ 手势消失 → 复位');
                    this._setStatus('手势消失 → 复位', '');
                    if (this.onHandTrack) {
                        this._trackData.gesture = 'left_fist'; this._trackData.twoHands = false;
                        this._trackData.landmarks = landmarks;
                        this._trackData.secondaryLandmarks = null;
                        this.onHandTrack(this._trackData);
                    }
                    if (this.onHandLandmarks) {
                        this.onHandLandmarks(landmarks, landmarks2, handCount);
                    }
                    return;
                }
            }
        }

        // 始终传递landmarks给3D场景
        if (this.onHandLandmarks) {
            this.onHandLandmarks(landmarks, landmarks2, handCount);
        }
        if (latEl) latEl.textContent = Math.round(latency) + 'ms';
    };

    /* ================================================================
     *  语音识别 V19 — 增强版：状态反馈 + 自动重连 + 实时文本显示
     * ================================================================ */
    GestureController.prototype._initSpeechRecognition = function () {
        var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.log('[Gesture] 语音识别不可用（浏览器不支持）');
            this._setStatus('🎤 不支持', '');
            return;
        }
        var self = this;
        this._speechActive = false;
        this._speechRetryCount = 0;

        // 创建语音状态指示元素
        if (!this._speechStatusEl) {
            this._speechStatusEl = document.createElement('div');
            this._speechStatusEl.id = 'gt-speech-status';
            this._speechStatusEl.style.cssText = 'position:fixed;left:12px;bottom:80px;z-index:255;font-size:11px;color:rgba(120,200,220,0.6);background:rgba(5,12,24,0.85);border:1px solid rgba(60,160,220,0.2);border-radius:8px;padding:3px 10px;font-family:"Segoe UI","Microsoft YaHei",sans-serif;pointer-events:none;transition:opacity .3s;backdrop-filter:blur(4px);';
            document.body.appendChild(this._speechStatusEl);
        }
        this._updateSpeechStatus('initializing', '🎤 语音启动中...');

        this._createSpeechRecognition();
    };

    GestureController.prototype._createSpeechRecognition = function () {
        var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) { return; }
        var self = this;
        if (this._recognition) {
            try { this._recognition.abort(); } catch (e) {}
            this._recognition = null;
        }

        this._recognition = new SpeechRecognition();
        this._recognition.continuous = true;
        this._recognition.interimResults = true;
        this._recognition.lang = 'zh-CN';
        this._lastSpeechTime = 0;
        this._speechCooldown = 800; // V19: 冷却从1200→800ms，响应更快

        // V19: 显示实时识别文本（用于调试和反馈）
        this._recognition.onaudiostart = function () {
            self._speechActive = true;
            self._speechRetryCount = 0;
            self._updateSpeechStatus('listening', '🎤 聆听中...');
        };

        this._recognition.onspeechstart = function () {
            self._updateSpeechStatus('hearing', '🎤 听到声音...');
        };

        this._recognition.onspeechend = function () {
            self._updateSpeechStatus('listening', '🎤 等待指令...');
        };

        this._recognition.onresult = function (event) {
            var now = Date.now();
            // 显示最新的识别文本
            var latestTranscript = '';
            for (var ri = event.resultIndex; ri < event.results.length; ri++) {
                latestTranscript = event.results[ri][0].transcript.trim();
            }
            if (latestTranscript) {
                self._speechLastText = latestTranscript;
                self._updateSpeechStatus('heard', '🎤 "' + latestTranscript + '"');
            }

            if (now - self._lastSpeechTime < self._speechCooldown) return;
            for (var i = event.resultIndex; i < event.results.length; i++) {
                var transcript = event.results[i][0].transcript.trim();
                if (event.results[i].isFinal) {
                    self._processSpeechCommand(transcript, now);
                }
            }
        };

        this._recognition.onend = function () {
            self._speechActive = false;
            // 如果还在活动中，自动重启（带延时避免频繁重试）
            if (self._active) {
                var delay = Math.min(500 + self._speechRetryCount * 300, 3000);
                self._speechRetryCount++;
                self._updateSpeechStatus('reconnecting', '🎤 重连中(' + self._speechRetryCount + ')...');
                setTimeout(function () {
                    if (self._active && !self._speechActive) {
                        try {
                            self._recognition.start();
                            self._speechActive = true;
                            self._updateSpeechStatus('listening', '🎤 已重连');
                        } catch (e) {
                            self._updateSpeechStatus('error', '🎤 重连失败');
                        }
                    }
                }, delay);
            } else {
                self._updateSpeechStatus('idle', '🎤 已停止');
            }
        };

        this._recognition.onerror = function (e) {
            if (e.error === 'no-speech') {
                self._updateSpeechStatus('listening', '🎤 等待指令...');
                return;
            }
            if (e.error === 'aborted') {
                self._updateSpeechStatus('idle', '🎤 已停止');
                return;
            }
            if (e.error === 'not-allowed') {
                self._updateSpeechStatus('error', '🎤 请允许麦克风权限');
                return;
            }
            self._updateSpeechStatus('error', '🎤 错误:' + e.error);
            console.log('[Gesture] 语音错误:', e.error);
        };

        try {
            this._recognition.start();
            this._speechActive = true;
            this._updateSpeechStatus('listening', '🎤 语音就绪，说"爆"引爆');
            console.log('[Gesture] 语音识别已启动');
        } catch (e) {
            this._updateSpeechStatus('error', '🎤 启动失败:' + e.message);
            console.log('[Gesture] 语音启动失败:', e);
        }
    };

    GestureController.prototype._updateSpeechStatus = function (state, text) {
        this._speechState = state;
        if (this._speechStatusEl) {
            this._speechStatusEl.textContent = text;
            // 状态颜色
            var colors = {
                'initializing': 'rgba(120,200,220,0.6)',
                'listening': 'rgba(120,220,180,0.7)',
                'hearing': 'rgba(255,220,120,0.8)',
                'heard': 'rgba(255,200,100,0.9)',
                'reconnecting': 'rgba(220,180,120,0.6)',
                'error': 'rgba(255,120,120,0.7)',
                'idle': 'rgba(120,120,120,0.5)'
            };
            this._speechStatusEl.style.color = colors[state] || 'rgba(120,200,220,0.6)';
            // 高亮显示识别到的文本
            if (state === 'heard') {
                this._speechStatusEl.style.borderColor = 'rgba(255,200,80,0.5)';
            } else {
                this._speechStatusEl.style.borderColor = 'rgba(60,160,220,0.2)';
            }
        }
    };

    GestureController.prototype._processSpeechCommand = function (text, now) {
        if (!text) return;
        var lower = text.toLowerCase();
        // 关键词检测
        if (text.indexOf('爆') >= 0 || lower.indexOf('bao') >= 0) {
            this._lastSpeechTime = now;
            this._updateLabel('语音→引爆!');
            this._setStatus('🗣 "爆"!', '');
            this._updateSpeechStatus('heard', '🎤 "爆" → 💥引爆!');
            this._fireGesture('voice_explode');
            return;
        }
        if (text.indexOf('选中') >= 0 || text.indexOf('选择') >= 0) {
            this._lastSpeechTime = now;
            this._fireGesture('voice_select');
            this._updateSpeechStatus('heard', '🎤 "选中"');
            return;
        }
        if (text.indexOf('取消') >= 0) {
            this._lastSpeechTime = now;
            this._fireGesture('voice_cancel');
            this._updateSpeechStatus('heard', '🎤 "取消"');
            return;
        }
        if (text.indexOf('暂停') >= 0) {
            this._lastSpeechTime = now;
            this._fireGesture('voice_pause');
            this._updateSpeechStatus('heard', '🎤 "暂停"');
            return;
        }
        if (text.indexOf('重置') >= 0) {
            this._lastSpeechTime = now;
            this._fireGesture('voice_reset');
            this._updateSpeechStatus('heard', '🎤 "重置"');
        }
    };

    GestureController.prototype._stopSpeechRecognition = function () {
        if (this._recognition) {
            try { this._recognition.abort(); } catch (e) {}
            this._recognition = null;
        }
        this._speechActive = false;
        if (this._speechStatusEl) {
            this._speechStatusEl.textContent = '🎤 已关闭';
            this._speechStatusEl.style.color = 'rgba(120,120,120,0.5)';
        }
    };

    GestureController.prototype._fireGesture = function (gesture, info) {
        if (this.onGesture) {
            this.onGesture(gesture, info || { handX: this._mainHand.x, handY: this._mainHand.y });
        }
    };

    /* ================================================================
     *  绘制
     * ================================================================ */
    GestureController.prototype._drawRawPreview = function () {
        if (!this._active || !this._videoEl || this._videoEl.readyState < 2) return;
        var ctx = this._ctx, w = CONFIG.previewWidth, h = CONFIG.previewHeight;
        ctx.clearRect(0, 0, w, h);
        ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1);
        ctx.drawImage(this._videoEl, 0, 0, w, h); ctx.restore();
        ctx.fillStyle = 'rgba(80,200,240,0.3)'; ctx.font = '10px sans-serif';
        ctx.fillText('AI加载中...', 8, 16);
    };

    GestureController.prototype._startRawPreview = function () {
        var self = this;
        function loop() {
            if (!self._active) return;
            if (self._initState === 'ready') return;
            self._drawRawPreview();
            setTimeout(loop, 30);
        }
        setTimeout(loop, 50);
    };

    GestureController.prototype._drawPreview = function (results) {
        var ctx = this._ctx, w = CONFIG.previewWidth, h = CONFIG.previewHeight;
        ctx.clearRect(0, 0, w, h);
        if (this._videoEl && this._videoEl.readyState >= 2) {
            ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1);
            ctx.drawImage(this._videoEl, 0, 0, w, h); ctx.restore();
        }
        if (results.landmarks && results.landmarks.length > 0) {
            this._drawHand(ctx, results.landmarks[0], w, h, CONFIG.skeletonColor);
            if (results.landmarks.length >= 2) {
                this._drawHand(ctx, results.landmarks[1], w, h, CONFIG.skeletonColor2);
            }
        }
        // 校准状态指示
        if (this._calibrating) {
            // V14: 校准目标圆环 — 显示手应该放在哪个位置
            var cx = w * 0.5, cy = h * 0.5;
            ctx.beginPath();
            ctx.arc(cx, cy, 25, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(240,200,80,0.6)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
            // 内圈提示
            ctx.beginPath();
            ctx.arc(cx, cy, 10, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(240,200,80,0.15)';
            ctx.fill();
            ctx.fillStyle = 'rgba(240,200,80,0.6)'; ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('👐 手放这里', cx, cy - 35);
            ctx.fillStyle = 'rgba(240,200,80,0.4)'; ctx.font = '9px sans-serif';
            ctx.fillText('校准中...', cx, cy + 32);
            ctx.textAlign = 'left';
        } else if (this._calibrated) {
            ctx.fillStyle = 'rgba(80,240,200,0.3)'; ctx.font = '9px sans-serif';
            ctx.fillText('✓ 已校准', 8, 16);
        }
    };

    GestureController.prototype._drawHand = function (ctx, landmarks, w, h, color) {
        var conns = [
            [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
            [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16],
            [0, 17], [17, 18], [18, 19], [19, 20], [5, 9], [9, 13], [13, 17]
        ];
        ctx.strokeStyle = color; ctx.lineWidth = 1.2;
        for (var i = 0; i < conns.length; i++) {
            var c = conns[i], p1 = landmarks[c[0]], p2 = landmarks[c[1]];
            ctx.beginPath();
            ctx.moveTo((1 - p1.x) * w, p1.y * h);
            ctx.lineTo((1 - p2.x) * w, p2.y * h);
            ctx.stroke();
        }
    };

    /* ================================================================
     *  兼容 & 外部接口
     * ================================================================ */
    GestureController.prototype.updateTargetIndicator = function () {};
    GestureController.prototype.hideTargetIndicator = function () {};

    /** 外部设置是否有选中状态（由 universe-v4.html 调用） */
    GestureController.prototype.setHasSelection = function (has) {
        this._hasSelection = !!has;
    };

    global.GestureController = GestureController;

})(typeof window !== 'undefined' ? window : this);