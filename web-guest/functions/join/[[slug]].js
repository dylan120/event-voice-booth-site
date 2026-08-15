/**
 * Web Guest 入口必须在边缘先验证短期会话，不能仅让静态页加载后再由浏览器决定。
 * Host stop/revoke 后，本函数返回 410，宾客再次打开二维码不会得到留言页面。
 */
const api = "https://event-voice-booth-web-guest.event-voice-booth-web-guest.workers.dev";

export async function onRequestGet(context) {
  const slug = context.params.slug;
  if (typeof slug !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(slug)) {
    return new Response("This guest link is no longer available.", { status: 410, headers: { "cache-control": "no-store" } });
  }
  const access = await fetch(`${api}/v1/guest/${encodeURIComponent(slug)}/access`, { cache: "no-store" });
  if (!access.ok) {
    // 不透出活动是否曾存在；Host revoke 与自然到期都使用同一失效页。
    return new Response("This guest link is no longer available.", { status: 410, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
  }
  // 静态入口由函数显式返回，避免 `/join/* -> /index.html` rewrite 绕过会话校验。
  const entry = new URL("/index.html", context.request.url);
  const response = await fetch(entry, { headers: { "cache-control": "no-store" } });
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    }
  });
}
