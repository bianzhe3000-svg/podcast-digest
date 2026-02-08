#!/bin/bash
cd "$(dirname "$0")"

echo "🎙️ Podcast Digest 2 - 启动中..."

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ 未找到 Node.js，请先安装"
  exit 1
fi

# Check ffmpeg
if command -v ffmpeg &> /dev/null; then
  echo "✅ ffmpeg 已安装"
else
  echo "⚠️  ffmpeg 未安装，音频压缩/分割功能不可用"
  echo "   安装方式: brew install ffmpeg"
fi

# Check .env
if [ ! -f .env ]; then
  echo "⚠️  未找到 .env 文件，将使用默认配置"
  echo "   可以复制 .env.example 并配置 API 密钥:"
  echo "   cp .env.example .env"
fi

# Build
echo "📦 编译 TypeScript..."
npm run build

if [ $? -ne 0 ]; then
  echo "❌ 编译失败"
  exit 1
fi

# Create required directories
mkdir -p data tmp logs summaries

# Stop old server if running
if [ -f server.pid ] && kill -0 $(cat server.pid) 2>/dev/null; then
  echo "🔄 停止旧进程 (PID: $(cat server.pid))..."
  kill $(cat server.pid) 2>/dev/null
  sleep 1
fi
# Also kill anything on port 3000
lsof -ti:3000 | xargs kill -9 2>/dev/null
sleep 1

# Start server
echo "🚀 启动服务器..."
nohup node dist/server.js > server.log 2>&1 &
echo $! > server.pid

sleep 2

if kill -0 $(cat server.pid) 2>/dev/null; then
  echo "✅ 服务器已启动 (PID: $(cat server.pid))"
  echo "🌐 访问 http://localhost:3000"
  echo ""
  echo "管理命令:"
  echo "  查看日志: tail -f server.log"
  echo "  停止服务: kill \$(cat server.pid)"
else
  echo "❌ 服务器启动失败，查看 server.log 获取详情"
  exit 1
fi
