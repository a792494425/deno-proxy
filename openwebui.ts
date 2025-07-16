import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// --- 配置 (可以通过命令行参数或环境变量覆盖) ---
const DEFAULT_PORT = 8080;
const DEFAULT_TARGET_HOST = "libabaasdasd21312asda-web.hf.space";
const DEFAULT_TARGET_SCHEME = "https";

/**
 * 统一的日志记录函数
 * @param message 日志信息
 * @param level 日志级别 (可选)
 */
function log(message: string, level: 'INFO' | 'ERROR' | 'WARN' = 'INFO') {
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
}

/**
 * 处理传入的 HTTP 请求
 * @param req 客户端请求
 * @param connInfo 连接信息，包含远程地址
 * @param config 运行配置
 * @returns {Promise<Response>}
 */
async function handleHttpRequest(
  req: Request,
  remoteAddr: Deno.NetAddr,
  config: { targetHost: string; targetScheme: string; allowedOrigin: string }
): Promise<Response> {
  const url = new URL(req.url);

  // 1. WebSocket 升级请求处理
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return handleWebSocketRequest(req, remoteAddr, config);
  }

  // 2. 普通 HTTP 请求处理
  const targetUrl = `${config.targetScheme}://${config.targetHost}${url.pathname}${url.search}`;
  log(`HTTP请求: ${req.method} ${url.pathname} -> ${targetUrl}`);

  // 准备转发给源服务器的请求头
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("Host", config.targetHost);
  requestHeaders.set("Origin", `${config.targetScheme}://${config.targetHost}`); // 很多服务需要这个
  requestHeaders.set("X-Forwarded-For", remoteAddr.hostname); // 传递真实客户端IP
  requestHeaders.set("X-Forwarded-Proto", url.protocol.slice(0, -1));

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: requestHeaders,
      body: req.body,
      redirect: "manual", // 手动处理重定向更安全
    });

    // 准备返回给客户端的响应头
    const responseHeaders = new Headers(response.headers);

    // --- 安全的 CORS 头部 ---
    // 避免使用 '*'，最好指定允许的源
    responseHeaders.set("Access-Control-Allow-Origin", config.allowedOrigin);
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
    responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    responseHeaders.set("Access-Control-Allow-Credentials", "true");
    
    // 如果是预检请求 (OPTIONS)，直接返回
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    log(`代理请求失败: ${error.message}`, 'ERROR');
    return new Response(`代理错误: ${error.message}`, { status: 502 });
  }
}

/**
 * 处理 WebSocket 握手和代理
 * @param req 客户端请求
 * @param connInfo 连接信息
 * @param config 运行配置
 * @returns {Promise<Response>}
 */
async function handleWebSocketRequest(
  req: Request,
  remoteAddr: Deno.NetAddr,
  config: { targetHost: string; targetScheme: string }
): Promise<Response> {
  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);
  const url = new URL(req.url);
  const targetWsScheme = config.targetScheme === 'https' ? 'wss' : 'ws';
  const targetUrl = `${targetWsScheme}://${config.targetHost}${url.pathname}${url.search}`;
  
  log(`WebSocket 握手: ${remoteAddr.hostname} -> ${targetUrl}`);

  try {
    // 准备发往源服务器的 WebSocket 握手请求头
    const wsHeaders = new Headers(req.headers);
    wsHeaders.set("Host", config.targetHost);
    wsHeaders.set("Origin", `${config.targetScheme}://${config.targetHost}`);

    // 连接到目标 WebSocket 服务器
    const serverSocket = new WebSocket(targetUrl, { headers: wsHeaders });

    const forwardMessage = (source: WebSocket, destination: WebSocket) => {
      source.onmessage = (event) => {
        if (destination.readyState === WebSocket.OPEN) {
          destination.send(event.data);
        }
      };
    };

    const handleClose = (event: CloseEvent, from: string, toSocket: WebSocket) => {
      log(`WebSocket 连接关闭 (来自 ${from}): ${event.code} ${event.reason}`);
      if (toSocket.readyState === WebSocket.OPEN) {
        toSocket.close(event.code, event.reason);
      }
    };

    const handleError = (event: Event | ErrorEvent, side: string) => {
      const message = event instanceof ErrorEvent ? event.message : '未知错误';
      log(`WebSocket 错误 (来自 ${side}): ${message}`, 'ERROR');
    };

    forwardMessage(clientSocket, serverSocket);
    forwardMessage(serverSocket, clientSocket);
    
    clientSocket.onclose = (event) => handleClose(event, '客户端', serverSocket);
    serverSocket.onclose = (event) => handleClose(event, '服务器', clientSocket);

    clientSocket.onerror = (event) => handleError(event, '客户端');
    serverSocket.onerror = (event) => handleError(event, '服务器');
    
    return response;

  } catch (error) {
    log(`WebSocket 连接到目标失败: ${error.message}`, 'ERROR');
    return new Response(`WebSocket 代理错误: ${error.message}`, { status: 502 });
  }
}

/**
 * 启动 HTTP 服务器
 */
async function startServer() {
  const args = parse(Deno.args);

  // ##################
  // ### BUG 修复部分 ###
  // ##################
  // 修正了从参数/环境变量读取配置的逻辑，去掉了错误的 String() 转换
  const port = Number(args.port || args.p || Deno.env.get("PORT")) || DEFAULT_PORT;
  const targetHost = args.host || args.h || Deno.env.get("TARGET_HOST") || DEFAULT_TARGET_HOST;
  const targetScheme = args.scheme || Deno.env.get("TARGET_SCHEME") || DEFAULT_TARGET_SCHEME;
  const allowedOrigin = args.origin || Deno.env.get("ALLOWED_ORIGIN") || "*";

  log(`--- 代理服务器启动配置 ---`);
  log(`端口 (port): ${port}`);
  log(`目标主机 (host): ${targetHost}`);
  log(`目标协议 (scheme): ${targetScheme}`);
  log(`允许的源 (origin): ${allowedOrigin}`);
  log(`--------------------------`);

  await serve((req, connInfo) => {
    return handleHttpRequest(req, connInfo.remoteAddr as Deno.NetAddr, {
      targetHost,
      targetScheme,
      allowedOrigin
    });
  }, {
    port,
    onListen({ hostname, port }) {
      log(`服务已启动，监听于 http://${hostname}:${port}`);
    },
  });
}

if (import.meta.main) {
  startServer();
}
