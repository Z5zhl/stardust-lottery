# ✦ 星尘抽奖 · Stardust Lottery

> 一个基于 Three.js 的 3D 粒子抽奖系统，支持手势控制、22 个星座主题粒子球、稀有度差异化特效，纯静态部署。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v1.0-gold.svg)]()

## 功能特性

- **3D 粒子球** — 22 个星座主题粒子球，3150 粒子/球，四层结构（能量核心 → 球壳 → 光晕 → 流光）
- **手势控制** — 基于 MediaPipe 的单手手势识别，支持摄像头实时操控
- **稀有度差异** — 传说/稀有/普通三级特效，金色粒子皇冠、光柱、冲击波等比缩放
- **零配置奖品** — 文件名即规则，放入文件夹即可，无需修改代码
- **图片奖品** — 支持 PNG/JPG/GIF/WEBP 图片奖品，3D 广告牌 + HTML 弹窗双展示
- **限次奖品** — 文件名加 `_xN` 后缀自动限制抽中次数
- **中奖记录** — 右上角滑出面板，显示稀有度标签、奖品名称和时间戳
- **纯静态部署** — 无需后端服务器，通过 `prizes.json` 加载奖品数据

## 在线体验

🌐 **[https://z5zhl.github.io/stardust-lottery/](https://z5zhl.github.io/stardust-lottery/)**

## 本地运行

### 方法一：通过 HTTP 服务器（推荐）

```bash
# 启动本地服务器
双击 启动服务器.bat

# 浏览器打开
http://localhost:9999/gesture-particles/stardust-lottery.html
```

> 注意：**不支持** `file://` 协议直接打开，奖品加载和手势识别需要通过 HTTP 访问。

### 方法二：使用任意 HTTP 服务器

```bash
# Python
python -m http.server 9999

# Node.js (npx)
npx serve . -p 9999

# VS Code Live Server 插件
右键 → Open with Live Server
```

## 操作指南

### 键盘 & 鼠标

| 操作 | 按键 |
|------|------|
| 下一个粒子球 | `→` 方向键 |
| 上一个粒子球 | `←` 方向键 |
| 抽取奖品 | `空格` |
| 重置 | `R` |
| 自动抽取 | `A` |
| 旋转视角 | 鼠标拖拽 |

### 手势控制（需摄像头）

| 手势 | 功能 |
|------|------|
| 张开五指 | 粒子发散（程度可控） |
| 握拳 | 爆炸抽取奖品 |
| 食指单出 | 下一个粒子球 |
| 食指+中指 | 上一个粒子球 |
| 手部移动 | 360° 旋转粒子球 |

点击右下角 ✋ 按钮开启手势控制面板。

## 奖品配置

### 核心规则：文件名即一切

```
奖品文件命名格式：权重.奖品名.扩展名

  3.鸿运当头.txt    →  权重=3（传说级），文字奖品
  5.星辰大海.png    →  权重=5（稀有级），图片奖品
  8.心想事成_x2.txt →  权重=8（普通级），最多抽中 2 次
```

### 权重 → 稀有度

| 权重 | 稀有度 | 颜色 | 特效 |
|------|--------|------|------|
| 1 ~ 4 | 传说 ★ | 金色 | 5 层冲击波、14 道光柱、粒子皇冠、12 秒展示 |
| 5 ~ 7 | 稀有 ✦ | 蓝色 | 3 层冲击波、6 道光柱、粒子皇冠、8 秒展示 |
| 8+ | 普通 · | 灰色 | 1 层冲击波、无光柱、6 秒展示 |

### 添加新奖品

1. 在 `gesture-particles/prizes/` 文件夹放置文件
2. 在 `gesture-particles/prizes.json` 中添加对应条目
3. 刷新页面生效

## 项目结构

```
stardust-lottery/
├── index.html                          # 入口页
├── gesture-particles/
│   ├── stardust-lottery.html           # 抽奖主页面
│   ├── prizes.json                     # 奖品数据配置
│   ├── prizes/                         # 奖品文件（12个）
│   │   ├── 3.神秘大礼.png              # 传说级图片奖品
│   │   ├── 3.财源广进.txt              # 传说级文字奖品
│   │   └── ...                         # 更多奖品
│   └── js/
│       ├── gesture-controller.js       # MediaPipe 手势识别引擎
│       └── stardust-gesture.js         # 手势控制系统
└── libs/
    ├── threejs-r128/                   # Three.js 3D 渲染库
    └── mediapipe/                      # AI 手势识别模型
```

## 技术栈

- **Three.js 0.160** — 3D 渲染引擎（CDN 加载）
- **MediaPipe Tasks Vision** — 手势关键点识别（GPU 加速）
- **WebGL** — 粒子着色器特效
- **纯静态 HTML/CSS/JS** — 零依赖部署

## 开发

```bash
# 启动本地开发服务器
node server.js

# 或双击
启动服务器.bat
```

## License

MIT © 2026