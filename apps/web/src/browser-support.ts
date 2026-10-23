/** Fail clearly instead of bypassing encryption on unsupported mobile pages. */
export function encryptedChatIssue(
  secureContext: boolean,
  cryptoApi: { getRandomValues?: unknown; subtle?: unknown } | undefined
): string | null {
  if (!secureContext) return "当前页面不是安全连接。手机聊天需要 HTTPS；http://局域网IP 无法使用必要的加密功能。";
  if (typeof cryptoApi?.getRandomValues !== "function" || !cryptoApi.subtle) {
    return "当前浏览器缺少必要的加密功能。请更新 Safari/Chrome，或用手机系统浏览器打开 HTTPS 链接。";
  }
  return null;
}
