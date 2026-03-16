/**
 * Cloudflare Worker: 音频代理下载服务
 *
 * 用途：绕过 CDN（如 CloudFront/Spotify）对云服务器 IP 的封锁/限速
 * Cloudflare Worker 使用边缘节点 IP，不会被 CDN 识别为云服务器
 *
 * 部署步骤：
 * 1. 安装 wrangler: npm install -g wrangler
 * 2. 登录: wrangler login
 * 3. 发布: wrangler deploy --name audio-proxy audio-proxy.js
 * 4. 设置密钥: wrangler secret put AUTH_TOKEN
 *    输入你自定义的密钥（例如生成一个随机 UUID）
 * 5. 在 Railway 环境变量中设置:
 *    AUDIO_PROXY_URL=https://audio-proxy.<your-account>.workers.dev
 *
 * 调用方式：
 * GET https://audio-proxy.xxx.workers.dev/?url=<encoded_audio_url>
 * Header: Authorization: Bearer <AUTH_TOKEN>
 *
 * 安全机制：
 * - AUTH_TOKEN 认证，防止被滥用
 * - 只允许代理音频文件（检查 Content-Type）
 * - 响应大小限制（默认 200MB）
 *
 * Cloudflare Workers 免费版限制：
 * - 10ms CPU time / request（但流式传输不计 CPU）
 * - 100,000 requests / day
 * - 对于大文件，建议升级到 Workers Paid ($5/mo)
 */

const MAX_RESPONSE_SIZE = 200 * 1024 * 1024; // 200MB
const ALLOWED_CONTENT_TYPES = [
  'audio/', 'application/octet-stream', 'binary/octet-stream',
  'application/mp3', 'application/x-mpegurl',
];

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization',
        },
      });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    // 认证检查
    if (env.AUTH_TOKEN) {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '');
      if (token !== env.AUTH_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    // 解析目标 URL
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return new Response('Missing "url" query parameter', { status: 400 });
    }

    try {
      // 验证 URL 格式
      new URL(targetUrl);
    } catch {
      return new Response('Invalid target URL', { status: 400 });
    }

    try {
      // 代理下载 - 使用浏览器 User-Agent 模拟正常用户
      const proxyResponse = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'identity', // 不要压缩，保持原始大小
        },
        redirect: 'follow',
      });

      if (!proxyResponse.ok) {
        return new Response(
          `Upstream returned ${proxyResponse.status}: ${proxyResponse.statusText}`,
          { status: 502 }
        );
      }

      // 检查 Content-Type（宽松检查，允许音频和二进制流）
      const contentType = proxyResponse.headers.get('content-type') || '';
      const isAllowed = ALLOWED_CONTENT_TYPES.some(t => contentType.includes(t)) || contentType === '';
      if (!isAllowed) {
        return new Response(
          `Content-Type not allowed: ${contentType}. Only audio files are proxied.`,
          { status: 403 }
        );
      }

      // 检查 Content-Length
      const contentLength = parseInt(proxyResponse.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_RESPONSE_SIZE) {
        return new Response(
          `File too large: ${(contentLength / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_RESPONSE_SIZE / 1024 / 1024}MB limit`,
          { status: 413 }
        );
      }

      // 流式传输响应
      const responseHeaders = new Headers({
        'Content-Type': contentType || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store', // 不缓存，避免 Worker 存储计费
      });

      if (contentLength > 0) {
        responseHeaders.set('Content-Length', String(contentLength));
      }

      return new Response(proxyResponse.body, {
        status: 200,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, { status: 502 });
    }
  },
};
