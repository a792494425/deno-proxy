import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// --- 默认配置 ---
const DEFAULT_PORT = 8080;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_TARGET = "https://libabaasdasd21312asda-web.hf.space";

/**
 * 统一的日志记录函数
 * @param message 要记录的消息
 * @param level 日志级别 (INFO, ERROR, WARN)
 */
function log(message: string, level: "INFO" | "ERROR" | "WARN" = "INFO") {
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
}

/**
 * 创建转发到目标服务器的请求头
 * @param originalHeaders 原始请求头
 * @param targetUrl 目标 URL 对象
 * @param remoteAddr 客户端地址信息
 * @returns {Headers} 新的请求头
 */
function createProxyHeaders(originalHeaders: Headers, targetUrl: URL, remoteAddr: Deno.NetAddr): Headers {
  const newHeaders = new Headers(originalHeaders);

  // 设置 Host 和 Origin，这是反向代理的关键
  newHeaders.set("Host", targetUrl.host);
  newHeaders.set("Origin", targetUrl.origin);

  // 传递客户端真实 IP
  newHeaders.set("X-Forwarded-For", remoteAddr.hostname);
  newHeaders.set("X-Forwarded-Proto", targetUrl.protocol.slice(0, -1));

  // 可选：如果目标服务器需要，可以伪装 User-Agent
  // 如果原始请求有 User-Agent，优先使用它
  if (!newHeaders.has("User-Agent")) {
    const isMobile = newHeaders.get("sec-ch-ua-mobile") === "?1";
    const ua = isMobile
      ? "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    newHeaders.set("User-Agent", ua);
  }

  return newHeaders;
}

/**
 * 处理 HTTP 请求
 * @param req 原始请求
 * @param targetUrl 目标 URL 对象
 * @param remoteAddr 客户端地址
 */
async function handleHttp(req: Request, targetUrl: URL, remoteAddr: Deno.NetAddr): Promise<Response> {
  const proxyHeaders = createProxyHeaders(req.headers, targetUrl, remoteAddr);

  log(`HTTP Proxy: ${req.method} ${req.url} -> ${targetUrl.toString()}`);

  try {
    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: proxyHeaders,
      body: req.body,
      redirect: "manual", // 手动处理重定向，更安全
    });

    // 复制响应头，并设置安全的 CORS 策略
    const responseHeaders = new Headers(response.headers);
    const requestOrigin = req.headers.get("Origin");
    if (requestOrigin) {
      // 优先反射请求的 Origin，比 '*' 更安全
      responseHeaders.set("Access-Control-Allow-Origin", requestOrigin);
      responseHeaders.set("Vary", "Origin");
    } else {
      responseHeaders.set("Access-Control-Allow-Origin", "*");
    }
    responseHeaders.set("Access-Control-Allow-Credentials", "true");
    
    // 移除可能导致问题的 Hop-by-hop headers
    responseHeaders.delete("Content-Encoding");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    log(`HTTP fetch failed: ${error.message}`, "ERROR");
    return new Response(`Proxy Error: ${error.message}`, { status: 502 });
  }
}

/**
 * 处理 WebSocket 升级请求
 * @param req 原始请求
 * @param targetUrl 目标 URL 对象 (ws/wss)
 * @param remoteAddr 客户端地址
 */
async function handleWebSocket(req: Request, targetUrl: URL, remoteAddr: Deno.NetAddr): Promise<Response> {
  log(`WebSocket Proxy: ${req.url} -> ${targetUrl.toString()}`);
  
  // 关键步骤：使用 Deno.upgradeWebSocket 获取客户端的 socket 和响应
  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);
  
  // 创建转发到目标服务器的握手请求头
  const proxyHeaders = createProxyHeaders(req.headers, targetUrl, remoteAddr);

  try {
    // 关键步骤：使用 fetch 向目标服务器发起 WebSocket 握手
    // 这样可以正确传递所有头部信息（如 Cookie, Auth 等）
    const serverResponse = await fetch(targetUrl.toString(), {
      headers: proxyHeaders,
    });

    // 从响应中获取服务器端的 WebSocket
    const serverSocket = serverResponse.webSocket;
    if (!serverSocket) {
      log("Target server did not upgrade to WebSocket.", "ERROR");
      return new Response("WebSocket handshake failed with target server.", { status: 502 });
    }

    // 双向绑定消息、关闭和错误事件
    const forward = (from: WebSocket, to: WebSocket, direction: string) => {
      from.onmessage = (event) => {
        if (to.readyState === WebSocket.OPEN) {
          to.send(event.data);
        }
      };
    };

    forward(clientSocket, serverSocket, "client -> server");
    forward(serverSocket, clientSocket, "server -> client");

    const closeHandler = (event: CloseEvent, side: string) => {
      log(`WebSocket closed from ${side}: ${event.code} ${event.reason}`, "INFO");
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close(event.code, event.reason);
      if (serverSocket.readyState === WebSocket.OPEN) serverSocket.close(event.code, event.reason);
    };

    const errorHandler = (event: Event | ErrorEvent, side: string) => {
      const message = event instanceof ErrorEvent ? event.message : "Unknown error";
      log(`WebSocket error on ${side} side: ${message}`, "ERROR");
      closeHandler({ code: 1011, reason: `${side} error` } as CloseEvent, side);
    };

    clientSocket.onclose = (e) => closeHandler(e, "client");
    serverSocket.onclose = (e) => closeHandler(e, "server");
    clientSocket.onerror = (e) => errorHandler(e, "client");
    serverSocket.onerror = (e) => errorHandler(e, "server");

    // 成功建立双向连接后，返回 Deno 准备好的响应
    return response;

  } catch (error) {
    log(`WebSocket connection to target failed: ${error.message}`, "ERROR");
    clientSocket.close(1011, "Upstream connection error");
    return new Response(`WebSocket Proxy Error: ${error.message}`, { status: 502 });
  }
}

/**
 * 主请求处理函数，根据请求类型分发
 */
function requestHandler(target: string) {
  return (req: Request, connInfo: Deno.ServeHandlerInfo): Promise<Response> => {
    const url = new URL(req.url);
    const targetUrl = new URL(target);
    targetUrl.pathname = url.pathname;
    targetUrl.search = url.search;

    const remoteAddr = connInfo.remoteAddr as Deno.NetAddr;

    // 根据请求头和目标协议判断是否是 WebSocket
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
      return handleWebSocket(req, targetUrl, remoteAddr);
    } else {
      return handleHttp(req, targetUrl, remoteAddr);
    }
  };
}

// --- 程序入口 ---
if (import.meta.main) {
  const args = parse(Deno.args, {
    string: ["port", "hostname", "target"],
    boolean: ["help"],
    alias: { h: "help", p: "port", t: "target" },
    default: {
      port: DEFAULT_PORT.toString(),
      hostname: DEFAULT_HOSTNAME,
      target: DEFAULT_TARGET,
    },
  });

  if (args.help) {
    console.log(`Deno Reverse Proxy
A simple reverse proxy for HTTP and WebSocket.

Usage:
  deno run --allow-net proxy.ts [options]

Options:
  -p, --port <port>          Port to listen on (default: ${DEFAULT_PORT})
      --hostname <hostname>  Hostname to listen on (default: "${DEFAULT_HOSTNAME}")
  -t, --target <url>         Target URL to proxy to (default: "${DEFAULT_TARGET}")
  -h, --help                 Show this help message
`);
    Deno.exit(0);
  }

  const port = Number(args.port);
  const hostname = args.hostname;
  const target = args.target;

  log(`Starting proxy server...`);
  log(`Listening on: http://${hostname}:${port}`);
  log(`Proxying to:  ${target}`);

  serve(requestHandler(target), {
    port,
    hostname,
    onListen: () => {
      log("Server is ready to accept connections.");
    },
  });
}
