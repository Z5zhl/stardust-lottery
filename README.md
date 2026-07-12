# ✦ 星尘抽奖 · Stardust Lottery

> 基于 Three.js 的 3D 粒子抽奖系统 — 手势控制、22 个星座主题粒子球、稀有度差异化特效、纯静态部署。

<p align="center">
  <img src="https://img.shields.io/badge/version-v1.0-gold" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license">
  <img src="https://img.shields.io/badge/部署-纯静态-green" alt="deploy">
</p>

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/Z5zhl/stardust-lottery.git
cd stardust-lottery

# 2. 启动任意 HTTP 服务器（三选一）
python -m http.server 9999          # Python 自带，无需安装
npx serve . -p 9999                 # Node.js 一行命令
# 或用 VS Code 装 Live Server 插件，右键 → Open with Live Server

# 3. 浏览器打开
# http://localhost:9999/gesture-particles/stardust-lottery.html
```

> ⚠️ **不能**直接用 `file://` 协议打开（浏览器安全策略限制），必须通过 HTTP 访问。

## 在线体验

🌐 **[https://z5zhl.github.io/stardust-lottery/](https://z5zhl.github.io/stardust-lottery/)**

## 操作方式

| 方式 | 操作 | 功能 |
|------|------|------|
| 键盘 | `←` `→` | 切换粒子球（22 个星座主题） |
| 键盘 | `空格` | 抽取奖品 |
| 键盘 | `R` | 重置 |
| 键盘 | `A` | 自动连续抽取 |
| 鼠标 | 拖拽 | 360° 旋转视角 |
| 手势 | 张开五指 | 粒子发散 |
| 手势 | 握拳 | 爆炸抽取 |
| 手势 | 食指单出 | 下一个粒子球 |
| 手势 | 食指+中指 | 上一个粒子球 |
| 手势 | 手部移动 | 旋转粒子球 |

> 手势控制需摄像头，点击页面右下角 ✋ 按钮开启。

## 添加奖品

**规则：文件名即配置，零代码修改。**

```
gesture-particles/prizes/
  ├── 3.神秘大礼.png        → 权重=3（传说级），图片奖品
  ├── 5.星辰大海.png        → 权重=5（稀有级），图片奖品
  ├── 8.心想事成_x2.txt     → 权重=8（普通级），最多抽中 2 次
  └── ...
```

| 权重 | 稀有度 | 特效 |
|------|--------|------|
| 1 ~ 4 | ⭐ 传说 | 金色粒子皇冠、14 道光柱、5 层冲击波、12 秒展示 |
| 5 ~ 7 | ✦ 稀有 | 蓝色粒子皇冠、6 道光柱、3 层冲击波、8 秒展示 |
| 8+ | · 普通 | 灰色粒子、1 层冲击波、6 秒展示 |

**完整流程：**
1. 按格式命名文件放入 `gesture-particles/prizes/`
2. 在 `gesture-particles/prizes.json` 中添加对应条目
3. 刷新页面生效

## 项目结构

```
stardust-lottery/
├── index.html                          # 🏠 入口页
├── gesture-particles/
│   ├── stardust-lottery.html           # 🎯 抽奖主页面
│   ├── prizes.json                     # 📋 奖品数据（12 个预设）
│   ├── prizes/                         # 🎁 奖品文件（图片/文字）
│   └── js/
│       ├── gesture-controller.js       # 🖐 手势识别底层引擎
│       └── stardust-gesture.js         # 🎮 手势控制系统
└── libs/                               # ⚠️ 见下方依赖说明
    ├── threejs-r128/                   # 🔄 可替代
    └── mediapipe/                      # ⚠️ 部分可替代
```

## 依赖说明

### 核心依赖（必需）

| 库 | 用途 | 加载方式 |
|----|------|----------|
| Three.js 0.160 | 3D 粒子渲染 | CDN 自动加载（`unpkg.com`） |
| MediaPipe Vision | 手势关键点识别 | 本地 `libs/mediapipe/` |

### 本地库文件说明

| 路径 | 说明 | 可替代？ |
|------|------|----------|
| `libs/threejs-r128/` | Three.js 及扩展（18 个文件） | ✅ **可删除** — HTML 已从 CDN 加载 Three.js，这些文件仅用于本地离线开发 |
| `libs/mediapipe/vision_bundle.mjs` | AI 手势识别核心 | ❌ 必需 |
| `libs/mediapipe/hand_landmarker.task` | 手部关键点模型 | ❌ 必需 |
| `libs/mediapipe/wasm/` | WebAssembly 运行时（4 个文件） | ❌ 必需 |
| `libs/mediapipe/vision_bundle.js` | 同 `.mjs` 的 CJS 版本 | ✅ 可删除（`.mjs` 已足够） |
| `libs/mediapipe/camera_utils.js` | 旧版 MediaPipe 工具 | ✅ 可删除（未被引用） |
| `libs/mediapipe/drawing_utils.js` | 旧版 MediaPipe 绘图 | ✅ 可删除（未被引用） |
| `libs/mediapipe/hands.js` | 旧版 MediaPipe Hands | ✅ 可删除（已被 Vision 替代） |
| `libs/mediapipe/face_mesh.js` | 面部识别 | ✅ 可删除（未被使用） |
| `libs/mediapipe/pose.js` | 姿态识别 | ✅ 可删除（未被使用） |
| `libs/mediapipe/holistic.js` | 全身识别 | ✅ 可删除（未被使用） |

> **精简建议**：如果你只用 GitHub Pages 部署，可以删除整个 `libs/threejs-r128/` 目录（约 2.8MB），Three.js 会从 CDN 自动加载。MediaPipe 只保留 `vision_bundle.mjs`、`hand_landmarker.task`、`wasm/` 三个即可。

## 技术栈

- **Three.js 0.160** — 3D 渲染（CDN）
- **MediaPipe Tasks Vision** — AI 手势识别（GPU 加速）
- **WebGL** — 粒子着色器
- **纯静态 HTML/CSS/JS** — 零后端依赖

## License

MIT © 2026