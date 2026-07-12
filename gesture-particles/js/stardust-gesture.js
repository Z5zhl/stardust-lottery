/**
 * 星尘抽奖 · 手势控制系统 V1.0
 * 
 * 单手控制，MediaPipe 手部关键点识别
 * 
 * 手势映射：
 *   手部位置 → 粒子球360°旋转（抓取旋转）
 *   五指张开 → 粒子发散（程度可控）
 *   握拳     → 爆炸（抽取奖品）
 *   食指单出 → 下一个粒子球
 *   食指+中指 → 上一个粒子球
 *   比心手势 → 爱心飞舞特效
 * 
 * 悬浮面板：可拖动、含摄像头预览、骨骼绘制、手势状态
 */
(function(global) {
  'use strict';

  /* ====== 配置 ====== */
  var CONFIG = {
    previewWidth: 200,
    previewHeight: 150,
    frameSkip: 2,              // 跳帧（降低GPU负载）
    smoothing: 0.65,           // 手部位置平滑系数
    rotSmoothing: 0.3,         // 旋转平滑系数
    gestureStableFrames: 4,    // 连续N帧一致才触发手势
    gestureCooldown: 800,      // 手势触发冷却(ms)
    switchCooldown: 600,       // 切换粒子球冷却(ms)
    fistHoldTime: 400,         // 握拳保持时间(ms)触发爆炸
    openPalmDebounce: 200,     // 五指张开防抖(ms)
    heartCooldown: 2000,       // 比心冷却(ms)
    dispersionSmooth: 0.15,    // 发散程度平滑
    rotationSpeed: 4.0,        // 旋转灵敏度
    invertX: true,             // X轴反转
    invertY: false,            // Y轴反转
    handLostTimeout: 3000,     // 手部丢失超时(ms)
    skeletonColor: 'rgba(64,196,255,0.7)',
    skeletonJointColor: 'rgba(255,215,64,0.8)',
    dragHandleSize: 36
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

  /* ====== 骨骼连线 ====== */
  var SKELETON_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],        // 拇指
    [0,5],[5,6],[6,7],[7,8],        // 食指
    [0,9],[9,10],[10,11],[11,12],   // 中指
    [0,13],[13,14],[14,15],[15,16], // 无名指
    [0,17],[17,18],[18,19],[19,20], // 小指
    [5,9],[9,13],[13,17]            // 手掌横线
  ];

  /* ====== 手势枚举 ====== */
  var GESTURE = {
    NONE: 'none',
    FIST: 'fist',              // 握拳
    OPEN_PALM: 'open_palm',    // 五指张开
    INDEX_ONLY: 'index_only',  // 仅食指
    INDEX_MIDDLE: 'index_middle', // 食指+中指
    HEART: 'heart'             // 比心
  };

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

  /* ================================================================
   *  StardustGesture 主类
   * ================================================================ */
  function StardustGesture(opts) {
    opts = opts || {};
    this._onRotate = opts.onRotate || null;       // (deltaX, deltaY) 连续旋转
    this._onGesture = opts.onGesture || null;     // (type, data) 离散手势
    this._onDisperse = opts.onDisperse || null;   // (amount) 发散程度 0~1
    this._onHeart = opts.onHeart || null;         // 比心触发
    this._container = opts.container || document.body;

    // 状态
    this._active = false;
    this._stream = null;
    this._videoEl = null;
    this._handLandmarker = null;
    this._visionModule = null;
    this._initState = 'idle';
    this._lastError = null;
    this._requestId = null;
    this._frameCount = 0;
    this._isProcessing = false;

    // 手部数据
    this._handPos = { x: 0.5, y: 0.5 };       // 当前平滑位置
    this._rawHandPos = { x: 0.5, y: 0.5 };    // 原始位置
    this._prevHandPos = { x: 0.5, y: 0.5 };   // 上一帧位置
    this._handLost = false;
    this._handLostTime = 0;
    this._handVisible = false;
    this._landmarks = null;

    // 目标旋转（由手势驱动）
    this._targetRotX = 0;
    this._targetRotY = 0;
    this._currentRotX = 0;
    this._currentRotY = 0;

    // 发散
    this._dispersionAmount = 0;
    this._targetDispersion = 0;

    // 手势状态机
    this._currentGesture = GESTURE.NONE;
    this._stableGesture = GESTURE.NONE;
    this._gestureStableCount = 0;
    this._lastGestureTime = 0;
    this._lastSwitchTime = 0;
    this._fistStartTime = 0;
    this._openPalmStartTime = 0;
    this._lastHeartTime = 0;

    // UI
    this._createUI();
  }

  /* ================================================================
   *  UI 层：悬浮面板（可拖动）
   * ================================================================ */
  StardustGesture.prototype._createUI = function() {
    var self = this;

    // 防止重复创建：移除已存在的旧面板
    var existing = document.getElementById('sg-root');
    if (existing) existing.remove();

    // 主容器
    this._uiRoot = document.createElement('div');
    this._uiRoot.id = 'sg-root';
    this._uiRoot.style.cssText =
      'position:fixed;z-index:600;top:120px;right:20px;display:none;' +
      'background:rgba(4,14,30,0.92);backdrop-filter:blur(12px);' +
      '-webkit-backdrop-filter:blur(12px);border-radius:10px;' +
      'border:1px solid rgba(64,196,255,0.25);overflow:hidden;' +
      'box-shadow:0 0 30px rgba(0,150,255,0.15);' +
      'width:210px;user-select:none;';

    // 标题栏（可拖动）
    this._titleBar = document.createElement('div');
    this._titleBar.id = 'sg-titlebar';
    this._titleBar.style.cssText =
      'padding:7px 10px;cursor:move;display:flex;align-items:center;justify-content:space-between;' +
      'border-bottom:1px solid rgba(64,196,255,0.12);font-size:11px;color:rgba(64,196,255,0.7);' +
      'letter-spacing:0.1em;background:rgba(64,196,255,0.04);';
    this._titleBar.innerHTML = '<span>✋ 手势控制</span><span id="sg-close" style="cursor:pointer;color:rgba(255,100,100,0.6);font-size:14px;">✕</span>';
    this._uiRoot.appendChild(this._titleBar);

    // 摄像头预览
    this._previewWrap = document.createElement('div');
    this._previewWrap.id = 'sg-preview-wrap';
    this._previewWrap.style.cssText = 'position:relative;width:100%;height:150px;background:#000;overflow:hidden;';
    this._canvasEl = document.createElement('canvas');
    this._canvasEl.id = 'sg-canvas';
    this._canvasEl.width = CONFIG.previewWidth;
    this._canvasEl.height = CONFIG.previewHeight;
    this._canvasEl.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    this._previewWrap.appendChild(this._canvasEl);

    // 手势状态标签
    this._gestureLabel = document.createElement('div');
    this._gestureLabel.id = 'sg-label';
    this._gestureLabel.style.cssText =
      'position:absolute;bottom:6px;left:0;right:0;text-align:center;font-size:11px;' +
      'color:rgba(64,196,255,0.8);text-shadow:0 0 8px rgba(64,196,255,0.5);' +
      'letter-spacing:0.1em;pointer-events:none;';
    this._gestureLabel.textContent = '等待手势...';
    this._previewWrap.appendChild(this._gestureLabel);
    this._uiRoot.appendChild(this._previewWrap);

    // 状态栏
    this._statusBar = document.createElement('div');
    this._statusBar.id = 'sg-status';
    this._statusBar.style.cssText =
      'padding:6px 10px;font-size:10px;color:rgba(128,180,220,0.5);display:flex;gap:8px;' +
      'border-top:1px solid rgba(64,196,255,0.08);';
    this._statusBar.innerHTML = '<span>旋转: --</span><span>发散: 0%</span>';
    this._uiRoot.appendChild(this._statusBar);

    this._container.appendChild(this._uiRoot);

    // 拖动逻辑
    this._makeDraggable(this._titleBar, this._uiRoot);

    // 关闭按钮
    this._titleBar.querySelector('#sg-close').addEventListener('click', function(e) {
      e.stopPropagation();
      self.stop();
    });

    // 注入全局样式
    if (!document.getElementById('sg-styles')) {
      var style = document.createElement('style');
      style.id = 'sg-styles';
      style.textContent =
        '#sg-root * { box-sizing:border-box;font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif; }' +
        '#sg-root::before{content:"";position:absolute;inset:0;border-radius:10px;' +
        'border:1px solid transparent;background:linear-gradient(135deg,rgba(64,196,255,0.3),transparent 50%,rgba(255,215,64,0.2)) border-box;' +
        '-webkit-mask:linear-gradient(#fff 0 0) padding-box,linear-gradient(#fff 0 0);mask:linear-gradient(#fff 0 0) padding-box,linear-gradient(#fff 0 0);' +
        '-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;}';
      document.head.appendChild(style);
    }
  };

  StardustGesture.prototype._makeDraggable = function(handle, target) {
    var self = this;
    var isDragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;

    handle.addEventListener('pointerdown', function(e) {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      var rect = target.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener('pointermove', function(e) {
      if (!isDragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      target.style.left = (origLeft + dx) + 'px';
      target.style.top = (origTop + dy) + 'px';
      target.style.right = 'auto';
    });

    handle.addEventListener('pointerup', function() { isDragging = false; });
    handle.addEventListener('pointercancel', function() { isDragging = false; });
  };

  /* ================================================================
   *  启动/停止
   * ================================================================ */
  StardustGesture.prototype.start = function() {
    var self = this;
    if (self._active) return Promise.resolve();
    self._uiRoot.style.display = 'block';
    self._gestureLabel.textContent = '启动摄像头...';
    self._initState = 'loading';

    // 【关键修复】先请求摄像头（必须在用户点击后同步调用 getUserMedia，浏览器安全策略）
    return self._startCamera().then(function() {
      self._gestureLabel.textContent = '加载AI引擎...';
      return self._loadAIEngine();
    }).then(function() {
      self._active = true;
      self._initState = 'ready';
      self._gestureLabel.textContent = '🖐 张开五指';
      self._processLoop();
    }).catch(function(err) {
      self._lastError = err.message;
      self._gestureLabel.textContent = '❌ ' + err.message;
      self._initState = 'error';
      throw err;
    });
  };

  StardustGesture.prototype.stop = function() {
    this._active = false;
    if (this._requestId) { cancelAnimationFrame(this._requestId); this._requestId = null; }
    if (this._stream) {
      this._stream.getTracks().forEach(function(t) { t.stop(); });
      this._stream = null;
    }
    if (this._videoEl) {
      this._videoEl.pause();
      this._videoEl.srcObject = null;
    }
    this._handLandmarker = null;
    if (this._uiRoot) {
      this._uiRoot.remove();
      this._uiRoot = null;
    }

    // 重置状态
    if (this._onRotate) this._onRotate(0, 0);
    if (this._onDisperse) this._onDisperse(0);
    this._dispersionAmount = 0;
    this._targetDispersion = 0;
  };

  /* ================================================================
   *  AI引擎加载
   * ================================================================ */
  StardustGesture.prototype._loadAIEngine = function() {
    var self = this;
    if (window.__sgVision && window.__sgVision.HandLandmarker) {
      self._visionModule = window.__sgVision;
      return self._initHandLandmarker();
    }
    var visionPath = absUrl('vision_bundle.mjs');
    return import(visionPath).then(function(vision) {
      window.__sgVision = vision;
      self._visionModule = vision;
      if (!vision.FilesetResolver || !vision.HandLandmarker) {
        var v = vision.default || vision;
        if (v && v.FilesetResolver && v.HandLandmarker) {
          window.__sgVision = v;
          self._visionModule = v;
        } else {
          throw new Error('vision_bundle 缺少 HandLandmarker');
        }
      }
      return self._initHandLandmarker();
    }).catch(function(err) {
      console.error('[StardustGesture] AI引擎加载失败:', err.message);
      throw new Error('AI引擎加载失败');
    });
  };

  StardustGesture.prototype._initHandLandmarker = function() {
    var self = this;
    var vision = self._visionModule || window.__sgVision;
    var wasmBase = absUrl('wasm');
    var modelPath = absUrl('hand_landmarker.task');

    function tryDelegate(idx) {
      var delegates = ['GPU', 'CPU'];
      if (idx >= delegates.length) throw new Error('所有 delegate 初始化失败');
      var delegate = delegates[idx];
      return vision.FilesetResolver.forVisionTasks(wasmBase).then(function(resolver) {
        return vision.HandLandmarker.createFromOptions(resolver, {
          baseOptions: { modelAssetPath: modelPath, delegate: delegate },
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          runningMode: 'VIDEO'
        });
      }).then(function(hl) {
        self._handLandmarker = hl;
      }).catch(function() {
        return tryDelegate(idx + 1);
      });
    }
    return tryDelegate(0);
  };

  /* ================================================================
   *  摄像头
   * ================================================================ */
  StardustGesture.prototype._startCamera = function() {
    var self = this;

    // 检查浏览器是否支持摄像头
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('浏览器不支持摄像头（需HTTPS或localhost）'));
    }

    // 15秒超时：防止权限弹窗被忽略时无限等待
    var timeoutId;
    var timeoutPromise = new Promise(function(_, reject) {
      timeoutId = setTimeout(function() {
        reject(new Error('摄像头启动超时，请检查权限弹窗'));
      }, 15000);
    });

    return Promise.race([
      timeoutPromise,
      navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' }
      })
    ]).then(function(stream) {
      clearTimeout(timeoutId);
      self._stream = stream;
      self._videoEl = document.createElement('video');
      self._videoEl.setAttribute('playsinline', '');
      self._videoEl.setAttribute('autoplay', '');
      self._videoEl.setAttribute('muted', '');
      self._videoEl.srcObject = stream;
      return self._videoEl.play();
    }).then(function() {
      self._ctx = self._canvasEl.getContext('2d');
    }).catch(function(err) {
      // 友好的中文错误提示
      var name = err.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        throw new Error('摄像头权限被拒绝，请在浏览器设置中允许');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new Error('未检测到摄像头设备');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        throw new Error('摄像头被其他应用占用');
      } else if (name === 'OverconstrainedError') {
        throw new Error('摄像头分辨率不匹配');
      } else if (name === 'AbortError') {
        throw new Error('摄像头启动被中断');
      }
      throw new Error('摄像头启动失败: ' + (err.message || '未知错误'));
    });
  };

  /* ================================================================
   *  主处理循环
   * ================================================================ */
  StardustGesture.prototype._processLoop = function() {
    var self = this;
    if (!self._active) return;
    self._requestId = requestAnimationFrame(function() { self._processLoop(); });
    self._frameCount++;
    if (self._frameCount % CONFIG.frameSkip !== 0) return;
    if (self._isProcessing) return;
    self._processFrame();
  };

  StardustGesture.prototype._processFrame = function() {
    var self = this;
    if (!self._handLandmarker || !self._videoEl || self._videoEl.readyState < 2) return;

    self._isProcessing = true;
    try {
      var results = self._handLandmarker.detectForVideo(self._videoEl, performance.now());
      self._onResults(results);
    } catch (e) {
      // 非致命错误，跳过当前帧（摄像头未就绪或模型未加载）
      if (self._frameCount % 60 === 0) console.warn('[StardustGesture] 手势检测跳过:', e.message);
    }
    self._isProcessing = false;
  };

  StardustGesture.prototype._onResults = function(results) {
    var self = this;
    var now = performance.now();

    // 绘制预览
    self._drawPreview(results);

    if (results && results.landmarks && results.landmarks.length > 0) {
      var landmarks = results.landmarks[0];
      self._landmarks = landmarks;
      self._handVisible = true;
      self._handLost = false;

      // 更新手部位置
      var wrist = landmarks[LANDMARK.WRIST];
      self._rawHandPos.x = wrist.x;
      self._rawHandPos.y = wrist.y;

      // 平滑位置
      self._handPos.x += (self._rawHandPos.x - self._handPos.x) * CONFIG.smoothing;
      self._handPos.y += (self._rawHandPos.y - self._handPos.y) * CONFIG.smoothing;

      // 计算旋转
      var dx = self._handPos.x - self._prevHandPos.x;
      var dy = self._handPos.y - self._prevHandPos.y;
      self._prevHandPos.x = self._handPos.x;
      self._prevHandPos.y = self._handPos.y;

      // 映射手部位置到旋转角度
      self._targetRotY = (self._handPos.x - 0.5) * Math.PI * CONFIG.rotationSpeed * (CONFIG.invertX ? -1 : 1);
      self._targetRotX = (self._handPos.y - 0.5) * Math.PI * 0.7 * CONFIG.rotationSpeed * (CONFIG.invertY ? -1 : 1);

      // 手势检测
      var fs = self._detectFingerStates(landmarks);
      var gesture = self._classifyGesture(fs, landmarks, now);
      self._processGesture(gesture, fs, now);

      // 发散控制（五指张开时）
      if (gesture === GESTURE.OPEN_PALM) {
        var openness = self._calcOpenness(landmarks, fs);
        self._targetDispersion = Math.max(0, (openness - 0.3) / 0.7); // 0.3~1.0 → 0~1
      } else {
        self._targetDispersion = 0;
      }

    } else {
      // 手部丢失
      if (self._handVisible) {
        self._handLostTime = now;
        self._handVisible = false;
      }
      if (now - self._handLostTime > CONFIG.handLostTimeout) {
        if (!self._handLost) {
          self._handLost = true;
          self._targetDispersion = 0;
          self._targetRotX = 0;
          self._targetRotY = 0;
        }
      }
    }

    // 平滑发散
    self._dispersionAmount += (self._targetDispersion - self._dispersionAmount) * CONFIG.dispersionSmooth;

    // 平滑旋转
    self._currentRotX += (self._targetRotX - self._currentRotX) * CONFIG.rotSmoothing;
    self._currentRotY += (self._targetRotY - self._currentRotY) * CONFIG.rotSmoothing;

    // 回调
    if (self._onRotate && self._handVisible) {
      self._onRotate(self._currentRotX, self._currentRotY);
    }
    if (self._onDisperse) {
      self._onDisperse(self._dispersionAmount);
    }

    // 更新状态栏
    self._updateStatusBar();
  };

  /* ================================================================
   *  手指状态检测（复用现有算法）
   * ================================================================ */
  StardustGesture.prototype._detectFingerStates = function(landmarks) {
    if (!landmarks) return { thumb:0, index:0, middle:0, ring:0, pinky:0 };
    var wrist = landmarks[LANDMARK.WRIST];
    var idxMcp = landmarks[LANDMARK.INDEX_MCP];
    var pinkyMcp = landmarks[LANDMARK.PINKY_MCP];
    var pw = Math.sqrt(Math.pow(idxMcp.x - pinkyMcp.x, 2) + Math.pow(idxMcp.y - pinkyMcp.y, 2));
    if (pw < 0.01) pw = 0.01;

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
        var tipDist = Math.sqrt(Math.pow(tip.x - idxMcp.x, 2) + Math.pow(tip.y - idxMcp.y, 2));
        var ipDist  = Math.sqrt(Math.pow(pip.x - idxMcp.x, 2) + Math.pow(pip.y - idxMcp.y, 2));
        states[f.name] = (tipDist > ipDist * 1.0) ? 1 : 0;
      } else {
        var tipDist = Math.sqrt(Math.pow(tip.x - wrist.x, 2) + Math.pow(tip.y - wrist.y, 2));
        var pipDist = Math.sqrt(Math.pow(pip.x - wrist.x, 2) + Math.pow(pip.y - wrist.y, 2));
        states[f.name] = (tipDist > pipDist * 1.05) ? 1 : 0;
      }
    }
    return states;
  };

  /* ================================================================
   *  手势分类
   * ================================================================ */
  StardustGesture.prototype._classifyGesture = function(fs, landmarks, now) {
    var extCount = fs.thumb + fs.index + fs.middle + fs.ring + fs.pinky;

    // 比心：拇指和食指指尖靠近，其余手指弯曲
    if (this._isHeartGesture(landmarks, fs)) {
      return GESTURE.HEART;
    }

    // 握拳：所有手指弯曲
    if (extCount === 0) {
      return GESTURE.FIST;
    }

    // 五指张开：所有手指伸直
    if (extCount === 5) {
      return GESTURE.OPEN_PALM;
    }

    // 仅食指：只有食指伸直
    if (fs.index === 1 && fs.middle === 0 && fs.ring === 0 && fs.pinky === 0) {
      return GESTURE.INDEX_ONLY;
    }

    // 食指+中指：食指和中指伸直，其余弯曲
    if (fs.index === 1 && fs.middle === 1 && fs.ring === 0 && fs.pinky === 0) {
      return GESTURE.INDEX_MIDDLE;
    }

    return GESTURE.NONE;
  };

  /* ================================================================
   *  比心手势检测
   *  拇指尖和食指尖靠近，其余手指弯曲
   * ================================================================ */
  StardustGesture.prototype._isHeartGesture = function(landmarks, fs) {
    if (!landmarks) return false;
    // 拇指和食指指尖距离
    var thumbTip = landmarks[LANDMARK.THUMB_TIP];
    var indexTip = landmarks[LANDMARK.INDEX_TIP];
    var dist = Math.sqrt(Math.pow(thumbTip.x - indexTip.x, 2) + Math.pow(thumbTip.y - indexTip.y, 2));

    // 手掌宽度（归一化参考）
    var idxMcp = landmarks[LANDMARK.INDEX_MCP];
    var pinkyMcp = landmarks[LANDMARK.PINKY_MCP];
    var palmW = Math.sqrt(Math.pow(idxMcp.x - pinkyMcp.x, 2) + Math.pow(idxMcp.y - pinkyMcp.y, 2));

    // 指尖距离小于手掌宽度的25% → 比心
    // 且中指、无名指、小指弯曲
    return dist < palmW * 0.25 && fs.middle === 0 && fs.ring === 0 && fs.pinky === 0;
  };

  /* ================================================================
   *  计算手掌张开程度（0~1）
   * ================================================================ */
  StardustGesture.prototype._calcOpenness = function(landmarks, fs) {
    var wrist = landmarks[LANDMARK.WRIST];
    var tips = [LANDMARK.THUMB_TIP, LANDMARK.INDEX_TIP, LANDMARK.MIDDLE_TIP, LANDMARK.RING_TIP, LANDMARK.PINKY_TIP];
    var totalDist = 0;
    for (var i = 0; i < tips.length; i++) {
      var t = landmarks[tips[i]];
      totalDist += Math.sqrt(Math.pow(t.x - wrist.x, 2) + Math.pow(t.y - wrist.y, 2));
    }
    var avgDist = totalDist / tips.length;
    var idxMcp = landmarks[LANDMARK.INDEX_MCP];
    var pinkyMcp = landmarks[LANDMARK.PINKY_MCP];
    var palmWidth = Math.sqrt(Math.pow(idxMcp.x - pinkyMcp.x, 2) + Math.pow(idxMcp.y - pinkyMcp.y, 2));
    return avgDist / Math.max(palmWidth, 0.01);
  };

  /* ================================================================
   *  手势处理状态机
   * ================================================================ */
  StardustGesture.prototype._processGesture = function(gesture, fs, now) {
    var self = this;

    // 稳定性检测
    if (gesture === self._currentGesture) {
      self._gestureStableCount++;
    } else {
      self._currentGesture = gesture;
      self._gestureStableCount = 1;
    }

    // 只有稳定帧数足够才确认手势
    if (self._gestureStableCount < CONFIG.gestureStableFrames) return;
    if (gesture === GESTURE.NONE) return;

    // 冷却检查
    if (now - self._lastGestureTime < CONFIG.gestureCooldown) return;

    // 握拳 → 爆炸（需要保持一定时间）
    if (gesture === GESTURE.FIST) {
      if (self._fistStartTime === 0) {
        self._fistStartTime = now;
      }
      if (now - self._fistStartTime >= CONFIG.fistHoldTime && self._stableGesture !== GESTURE.FIST) {
        self._stableGesture = GESTURE.FIST;
        self._lastGestureTime = now;
        if (self._onGesture) self._onGesture(GESTURE.FIST, {});
        self._gestureLabel.textContent = '✊ 爆炸！';
        self._fistStartTime = 0;
      }
      return;
    } else {
      self._fistStartTime = 0;
    }

    // 五指张开 → 发散
    if (gesture === GESTURE.OPEN_PALM) {
      if (self._stableGesture !== GESTURE.OPEN_PALM) {
        self._stableGesture = GESTURE.OPEN_PALM;
        self._lastGestureTime = now;
        if (self._onGesture) self._onGesture(GESTURE.OPEN_PALM, {});
      }
      self._gestureLabel.textContent = '🖐 发散中';
      return;
    }

    // 仅食指 → 下一个
    if (gesture === GESTURE.INDEX_ONLY) {
      if (now - self._lastSwitchTime < CONFIG.switchCooldown) return;
      self._stableGesture = GESTURE.INDEX_ONLY;
      self._lastGestureTime = now;
      self._lastSwitchTime = now;
      if (self._onGesture) self._onGesture(GESTURE.INDEX_ONLY, {});
      self._gestureLabel.textContent = '☝ 下一个';
      return;
    }

    // 食指+中指 → 上一个
    if (gesture === GESTURE.INDEX_MIDDLE) {
      if (now - self._lastSwitchTime < CONFIG.switchCooldown) return;
      self._stableGesture = GESTURE.INDEX_MIDDLE;
      self._lastGestureTime = now;
      self._lastSwitchTime = now;
      if (self._onGesture) self._onGesture(GESTURE.INDEX_MIDDLE, {});
      self._gestureLabel.textContent = '✌ 上一个';
      return;
    }

    // 比心 → 爱心特效
    if (gesture === GESTURE.HEART) {
      if (now - self._lastHeartTime < CONFIG.heartCooldown) return;
      self._stableGesture = GESTURE.HEART;
      self._lastGestureTime = now;
      self._lastHeartTime = now;
      if (self._onHeart) self._onHeart();
      if (self._onGesture) self._onGesture(GESTURE.HEART, {});
      self._gestureLabel.textContent = '❤ 比心！';
      return;
    }

    // 手势变回none
    if (self._stableGesture !== GESTURE.NONE && self._currentGesture === GESTURE.NONE) {
      self._stableGesture = GESTURE.NONE;
      self._gestureLabel.textContent = '🖐 张开五指';
    }
  };

  /* ================================================================
   *  更新状态栏
   * ================================================================ */
  StardustGesture.prototype._updateStatusBar = function() {
    if (!this._statusBar) return;
    var rotX = (this._currentRotX * 180 / Math.PI).toFixed(0);
    var rotY = (this._currentRotY * 180 / Math.PI).toFixed(0);
    var disp = (this._dispersionAmount * 100).toFixed(0);
    this._statusBar.innerHTML = '<span>旋转: ' + rotX + '°/' + rotY + '°</span><span>发散: ' + disp + '%</span>';
  };

  /* ================================================================
   *  绘制预览（骨骼+手势）
   * ================================================================ */
  StardustGesture.prototype._drawPreview = function(results) {
    var self = this;
    var ctx = self._ctx;
    if (!ctx) return;
    var cw = CONFIG.previewWidth, ch = CONFIG.previewHeight;

    // 绘制摄像头画面
    if (self._videoEl && self._videoEl.readyState >= 2) {
      ctx.drawImage(self._videoEl, 0, 0, cw, ch);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
    }

    // 绘制骨骼
    if (results && results.landmarks) {
      for (var h = 0; h < results.landmarks.length; h++) {
        self._drawHand(ctx, results.landmarks[h], cw, ch, CONFIG.skeletonColor);
      }
    }
  };

  StardustGesture.prototype._drawHand = function(ctx, landmarks, w, h, color) {
    // 绘制连线
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (var i = 0; i < SKELETON_CONNECTIONS.length; i++) {
      var conn = SKELETON_CONNECTIONS[i];
      var a = landmarks[conn[0]];
      var b = landmarks[conn[1]];
      ctx.beginPath();
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
      ctx.stroke();
    }

    // 绘制关节点
    for (var j = 0; j < landmarks.length; j++) {
      var lm = landmarks[j];
      var x = lm.x * w, y = lm.y * h;
      ctx.fillStyle = (j === LANDMARK.WRIST || j === LANDMARK.INDEX_TIP ||
        j === LANDMARK.MIDDLE_TIP) ? CONFIG.skeletonJointColor : color;
      ctx.beginPath();
      ctx.arc(x, y, (j === LANDMARK.WRIST) ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  /* ================================================================
   *  公开API
   * ================================================================ */
  StardustGesture.prototype.isActive = function() { return this._active; };
  StardustGesture.prototype.getHandPos = function() { return { x: this._handPos.x, y: this._handPos.y }; };
  StardustGesture.prototype.getGesture = function() { return this._stableGesture; };
  StardustGesture.prototype.getDispersion = function() { return this._dispersionAmount; };

  global.StardustGesture = StardustGesture;
})(window);