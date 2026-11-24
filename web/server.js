import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function getHttpClient(targetUrl) {
  return targetUrl.protocol === 'https:' ? https : http;
}

function buildProxyHeaders(incomingHeaders, targetUrl, bridgeToken) {
  const headers = { ...incomingHeaders };
  headers.host = targetUrl.host;
  delete headers.cookie;
  if (bridgeToken) {
    headers.authorization = `Bearer ${bridgeToken}`;
  } else {
    delete headers.authorization;
  }
  return headers;
}

/**
 * Creates the AI Office Web UI HTTP + WebSocket reverse-proxy server.
 *
 * @param {{
 *   host?: string,
 *   port?: number,
 *   bridgeUrl?: string,
 *   bridgeToken?: string,
 *   publicDir?: string,
 * }} [options]
 */
export function createWebServer(options = {}) {
  const host = options.host || process.env.OFFICE_WEB_HOST || '0.0.0.0';
  const port =
    options.port !== undefined
      ? Number(options.port)
      : Number(process.env.OFFICE_WEB_PORT || 3000);
  const bridgeUrl = new URL(
    options.bridgeUrl || process.env.OFFICE_BRIDGE_URL || 'http://host.docker.internal:4040'
  );
  const bridgeToken =
    options.bridgeToken !== undefined
      ? options.bridgeToken
      : process.env.OFFICE_BRIDGE_TOKEN || '';
  const publicDir = path.resolve(options.publicDir || DEFAULT_PUBLIC_DIR);

  const client = getHttpClient(bridgeUrl);

  function proxyHttpRequest(req, res) {
    const targetPath = req.url || '/';
    const upstreamReq = client.request(
      {
        protocol: bridgeUrl.protocol,
        hostname: bridgeUrl.hostname,
        port: bridgeUrl.port || (bridgeUrl.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: targetPath,
        headers: buildProxyHeaders(req.headers, bridgeUrl, bridgeToken),
      },
      (upstreamRes) => {
        const resHeaders = { ...upstreamRes.headers, 'cache-control': 'no-store' };
        res.writeHead(upstreamRes.statusCode || 502, resHeaders);
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on('error', () => {
      if (!res.headersSent) {
        const body = JSON.stringify({ error: 'Host Bridge is unreachable' });
        res.writeHead(502, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } else {
        res.destroy();
      }
    });

    req.pipe(upstreamReq);
  }

  async function serveStatic(req, res, pathname) {
    const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolved = path.resolve(publicDir, relPath);
    if (!resolved.startsWith(publicDir + path.sep) && resolved !== path.join(publicDir, 'index.html')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    try {
      const stat = await fs.stat(resolved);
      const filePath = stat.isDirectory() ? path.join(resolved, 'index.html') : resolved;
      const content = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': content.length,
        'Cache-Control': 'no-store',
      });
      res.end(content);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/healthz' && req.method === 'GET') {
      const body = JSON.stringify({ ok: true, service: 'ai-office-web' });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (pathname.startsWith('/api/')) {
      proxyHttpRequest(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    serveStatic(req, res, pathname);
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/ws/')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const upstreamReq = client.request({
      protocol: bridgeUrl.protocol,
      hostname: bridgeUrl.hostname,
      port: bridgeUrl.port || (bridgeUrl.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: req.url || '/',
      headers: buildProxyHeaders(req.headers, bridgeUrl, bridgeToken),
    });

    upstreamReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      const headerLines = [];
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        headerLines.push(`${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}`);
      }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerLines.join('\r\n')}\r\n\r\n`);
      if (proxyHead && proxyHead.length > 0) {
        socket.write(proxyHead);
      }
      if (head && head.length > 0) {
        proxySocket.write(head);
      }

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      const destroyBoth = () => {
        if (!socket.destroyed) socket.destroy();
        if (!proxySocket.destroyed) proxySocket.destroy();
      };
      socket.on('error', destroyBoth);
      proxySocket.on('error', destroyBoth);
      socket.on('close', destroyBoth);
      proxySocket.on('close', destroyBoth);
    });

    upstreamReq.on('response', (proxyRes) => {
      const status = proxyRes.statusCode || 502;
      const statusMessage = proxyRes.statusMessage || 'Bad Gateway';
      socket.write(`HTTP/1.1 ${status} ${statusMessage}\r\nConnection: close\r\n\r\n`);
      proxyRes.resume();
      socket.destroy();
    });

    upstreamReq.on('error', () => {
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    });

    upstreamReq.end();
  });

  return {
    host,
    port,

    async start() {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          if (err && err.code === 'EADDRINUSE') {
            const wrapped = new Error(
              `Web UI failed to start: port ${port} on ${host} is already in use.`
            );
            wrapped.code = 'EADDRINUSE';
            reject(wrapped);
            return;
          }
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });

      const address = server.address();
      return {
        host: address.address,
        port: address.port,
      };
    },

    async stop() {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
