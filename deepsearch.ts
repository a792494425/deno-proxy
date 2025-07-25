// 文件名: deepsearch.ts

const targetUrl = new URL("https://deep-research.a792494425.buzz");

async function handler(req: Request): Promise<Response> {
  const incomingUrl = new URL(req.url); // 获取访问代理的 URL
  const proxyTargetUrl = new URL(targetUrl); // 目标 URL 基础

  // 组合路径和查询参数
  proxyTargetUrl.pathname = incomingUrl.pathname;
  proxyTargetUrl.search = incomingUrl.search;

  console.log(`请求代理到: ${proxyTargetUrl.href}`);

  // 复制请求头，并正确设置 "host"
  const headers = new Headers(req.headers);
  headers.set("host", proxyTargetUrl.host);
  // Deno Deploy 通常会自动处理 X-Forwarded-For 等头部

  try {
    // 向目标服务器发起请求
    const response = await fetch(proxyTargetUrl.toString(), {
      method: req.method,
      headers: headers,
      body: req.body,
      redirect: "manual", // 对于代理，手动处理重定向很重要
    });

    // 将目标服务器的响应返回给客户端
    // 如果你的前端应用需要，可能在这里修改CORS头部
    const responseHeaders = new Headers(response.headers);
    // 例如: responseHeaders.set("Access-Control-Allow-Origin", "*"); // 谨慎! 允许所有来源

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`代理请求错误: ${error.message}`);
    return new Response("代理服务器出错", { status: 502 }); // 502 Bad Gateway
  }
}

// Deno.serve 会由 Deno Deploy 自动管理端口和启动
Deno.serve(handler);
console.log("反向代理处理程序已配置。Deno Deploy 将启动服务。");
