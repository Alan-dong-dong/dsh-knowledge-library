export class PageAccessError extends Error {
  readonly code = 'PAGE_REQUIRES_BROWSER';
  constructor(site: string) {
    super(`${site}返回了验证页面，尚未获取文章正文。请在浏览器打开原网页，完成验证后粘贴正文，或导入保存的 HTML。后台采集不共享浏览器的验证状态。`);
    this.name = 'PageAccessError';
  }
}

/** Match explicit challenge structure, not keywords occurring in an ordinary article. */
export function assertArticleAccess(document: Document, source: string): void {
  const url = new URL(source);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim();
  const title = document.title?.trim() || '';
  const heading = document.querySelector('h1,h2,.weui-msg__title')?.textContent?.trim() || '';
  const verificationLink = document.querySelector('a[href*="/mp/wappoc_appmsgcaptcha"]');
  let importedWechatChallenge = false;
  if (host === 'import.invalid' && verificationLink) {
    try { importedWechatChallenge = new URL(verificationLink.getAttribute('href') || '', source).hostname === 'mp.weixin.qq.com'; } catch { /* Not a recognizable verification link. */ }
  }
  if (host === 'mp.weixin.qq.com' || importedWechatChallenge) {
    if (/^\/mp\/wappoc_appmsgcaptcha(?:\/|$)/i.test(url.pathname)) throw new PageAccessError('微信');
    const content = document.querySelector('#js_content')?.textContent?.trim() || '';
    const articleText = document.querySelector('article')?.textContent?.trim() || '';
    if (content.length >= 40 || articleText.length >= 300) return;
    const environmentNotice = /当前环境异常/.test(text) && /完成验证|去验证/.test(text);
    if (text.length < 2000 && environmentNotice && (verificationLink || title === '环境异常' || heading === '环境异常')) throw new PageAccessError('微信');
  }
  const challengeTitle = /^(?:just a moment[.!…]*|attention required!?\s*\|\s*cloudflare)$/i.test(title);
  const challengeForm = document.querySelector('#challenge-form,#challenge-running,form[action*="/cdn-cgi/challenge-platform/"]');
  if (text.length < 3000 && challengeTitle && challengeForm) throw new PageAccessError('网站');
}
