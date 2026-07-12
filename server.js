var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var url = require('url');

// 配置
var PORT = 9999;
var HOST = 'localhost';

// 静态文件服务根目录
var ROOT_DIR = __dirname;

// 需要下载的 MediaPipe 文件列表
var DOWNLOAD_FILES = [
    {
        url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs',
        local: 'libs/mediapipe/vision_bundle.mjs'
    },
    {
        url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm/vision_wasm_internal.js',
        local: 'libs/mediapipe/wasm/vision_wasm_internal.js'
    },
    {
        url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm/vision_wasm_internal.wasm',
        local: 'libs/mediapipe/wasm/vision_wasm_internal.wasm'
    },
    {
        url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm/vision_wasm_nosimd_internal.js',
        local: 'libs/mediapipe/wasm/vision_wasm_nosimd_internal.js'
    },
    {
        url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm/vision_wasm_nosimd_internal.wasm',
        local: 'libs/mediapipe/wasm/vision_wasm_nosimd_internal.wasm'
    },
    {
        url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        local: 'libs/mediapipe/hand_landmarker.task'
    }
];

// MIME 类型映射表
var MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.wasm': 'application/wasm',
    '.task': 'application/octet-stream',
    '.txt': 'text/plain',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.glb': 'model/gltf-binary'
};

/**
 * 获取文件的 MIME 类型
 */
function getMimeType(filePath) {
    var ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * 安全检查：防止目录穿越攻击
 * 确保解析后的绝对路径在 ROOT_DIR 范围内
 */
function isSafePath(requestedPath) {
    var resolved = path.resolve(ROOT_DIR, requestedPath);
    var normalized = path.normalize(resolved);
    return normalized.indexOf(ROOT_DIR) === 0;
}

/**
 * 发送 HTTP 响应
 */
function sendResponse(res, statusCode, content, contentType) {
    var headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (contentType) {
        headers['Content-Type'] = contentType;
    }
    res.writeHead(statusCode, headers);
    res.end(content);
}

/**
 * 静态文件服务
 */
function serveStaticFile(req, res) {
    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
        sendResponse(res, 204);
        return;
    }

    var parsedUrl = url.parse(req.url);
    var pathname = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;

    // 安全检查
    if (!isSafePath(pathname)) {
        console.log('[安全] 拒绝访问: ' + pathname);
        sendResponse(res, 403, '403 Forbidden', 'text/plain');
        return;
    }

    var filePath = path.join(ROOT_DIR, pathname);

    // 检查文件是否存在
    fs.stat(filePath, function (err, stats) {
        if (err) {
            sendResponse(res, 404, '404 Not Found', 'text/plain');
            return;
        }

        if (stats.isDirectory()) {
            sendResponse(res, 403, '403 Forbidden', 'text/plain');
            return;
        }

        var mimeType = getMimeType(filePath);
        var readStream = fs.createReadStream(filePath);

        readStream.on('error', function () {
            sendResponse(res, 500, '500 Internal Server Error', 'text/plain');
        });

        res.writeHead(200, {
            'Content-Type': mimeType,
            'Content-Length': stats.size,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
        });

        readStream.pipe(res);
    });
}

/**
 * 下载单个文件（支持 HTTP 重定向）
 */
function downloadFile(fileInfo, callback) {
    var localPath = fileInfo.local;
    var fileUrl = fileInfo.url;
    var tmpPath = localPath + '.tmp';

    // 确保本地目录存在
    var dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // 如果文件已存在且大于 1000 字节，跳过下载
    if (fs.existsSync(localPath)) {
        var stats = fs.statSync(localPath);
        if (stats.size > 1000) {
            console.log('[跳过] 已存在: ' + localPath + ' (' + stats.size + ' 字节)');
            callback(null);
            return;
        }
    }

    console.log('[下载] 开始: ' + fileUrl);
    console.log('[下载] 保存到: ' + localPath);

    // 发起下载请求（自动处理重定向）
    doDownload(fileUrl, tmpPath, 0, function (err) {
        if (err) {
            console.error('[错误] 下载失败: ' + fileUrl + ' - ' + err.message);
            // 清理临时文件
            if (fs.existsSync(tmpPath)) {
                fs.unlinkSync(tmpPath);
            }
            callback(err);
            return;
        }

        // 原子操作：重命名临时文件
        try {
            if (fs.existsSync(localPath)) {
                fs.unlinkSync(localPath);
            }
            fs.renameSync(tmpPath, localPath);
            var finalStats = fs.statSync(localPath);
            console.log('[完成] ' + localPath + ' (' + finalStats.size + ' 字节)');
        } catch (e) {
            console.error('[错误] 重命名失败: ' + e.message);
            callback(e);
            return;
        }

        callback(null);
    });
}

/**
 * 执行下载（自动处理 HTTP 重定向，最多 5 次）
 */
function doDownload(downloadUrl, tmpPath, redirectCount, callback) {
    if (redirectCount > 5) {
        callback(new Error('重定向次数过多'));
        return;
    }

    var parsedUrl = url.parse(downloadUrl);
    var isHttps = parsedUrl.protocol === 'https:';
    var transport = isHttps ? https : http;

    var options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.path,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
    };

    var req = transport.request(options, function (res) {
        var statusCode = res.statusCode;

        // 处理重定向
        if (statusCode === 301 || statusCode === 302 || statusCode === 303) {
            var redirectUrl = res.headers.location;
            if (!redirectUrl) {
                callback(new Error('重定向响应缺少 Location 头'));
                return;
            }
            // 处理相对路径重定向
            if (redirectUrl.indexOf('http') !== 0) {
                redirectUrl = (isHttps ? 'https://' : 'http://') +
                    parsedUrl.host + redirectUrl;
            }
            console.log('[重定向] -> ' + redirectUrl);
            doDownload(redirectUrl, tmpPath, redirectCount + 1, callback);
            return;
        }

        if (statusCode !== 200) {
            callback(new Error('HTTP ' + statusCode));
            return;
        }

        var totalSize = parseInt(res.headers['content-length'], 10) || 0;
        var downloaded = 0;
        var fileStream = fs.createWriteStream(tmpPath);

        res.on('data', function (chunk) {
            downloaded += chunk.length;
            if (totalSize > 0) {
                var percent = Math.round((downloaded / totalSize) * 100);
                // 每 10% 输出一次进度
                if (percent % 10 === 0) {
                    process.stdout.write('\r[进度] ' + percent + '% (' + downloaded + '/' + totalSize + ')');
                }
            }
        });

        res.on('end', function () {
            process.stdout.write('\n');
            fileStream.end();
        });

        fileStream.on('finish', function () {
            callback(null);
        });

        fileStream.on('error', function (err) {
            callback(err);
        });

        res.pipe(fileStream);
    });

    req.on('error', function (err) {
        callback(err);
    });

    // 设置超时
    req.setTimeout(30000, function () {
        req.destroy();
        callback(new Error('请求超时'));
    });

    req.end();
}

/**
 * 下载所有 MediaPipe 文件
 */
function downloadAllFiles(callback) {
    var total = DOWNLOAD_FILES.length;
    var completed = 0;
    var hasError = false;

    console.log('[任务] 开始下载 ' + total + ' 个文件...');

    DOWNLOAD_FILES.forEach(function (fileInfo) {
        downloadFile(fileInfo, function (err) {
            completed++;
            if (err) {
                hasError = true;
            }
            if (completed === total) {
                console.log('[任务] 下载完成: ' + completed + '/' + total);
                if (callback) {
                    callback(hasError ? new Error('部分文件下载失败') : null);
                }
            }
        });
    });
}

/**
 * 创建 HTTP 服务器
 */
var server = http.createServer(function (req, res) {
    var parsedUrl = url.parse(req.url, true);

    // 路由: /api/download - 触发下载
    if (parsedUrl.pathname === '/api/download') {
        downloadAllFiles(function (err) {
            if (err) {
                sendResponse(res, 500, JSON.stringify({ status: 'error', message: err.message }), 'application/json');
            } else {
                sendResponse(res, 200, JSON.stringify({ status: 'ok', message: '下载完成' }), 'application/json');
            }
        });
        return;
    }

    // 路由: /api/status - 查看文件状态
    if (parsedUrl.pathname === '/api/status') {
        var statusList = DOWNLOAD_FILES.map(function (f) {
            var exists = fs.existsSync(f.local);
            var size = exists ? fs.statSync(f.local).size : 0;
            return {
                file: f.local,
                exists: exists,
                size: size
            };
        });
        sendResponse(res, 200, JSON.stringify(statusList, null, 2), 'application/json');
        return;
    }

    // 默认：静态文件服务
    serveStaticFile(req, res);
});

// 启动服务器前确保必要目录存在
var dirs = ['libs', 'libs/mediapipe', 'libs/mediapipe/wasm'];
dirs.forEach(function (dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log('[目录] 已创建: ' + dir);
    }
});

// 启动服务器
server.listen(PORT, HOST, function () {
    console.log('========================================');
    console.log('  服务器已启动');
    console.log('  地址: http://' + HOST + ':' + PORT);
    console.log('========================================');
    console.log('');
    console.log('  API 路由:');
    console.log('    GET /api/download  - 下载 MediaPipe 文件');
    console.log('    GET /api/status    - 查看文件下载状态');
    console.log('    GET /*             - 静态文件服务');
    console.log('');

    // 启动时自动下载缺失的文件
    console.log('[启动] 检查并下载缺失的 MediaPipe 文件...');
    downloadAllFiles();
});