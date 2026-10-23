// Fixed Qzone protocol adapter. Credentials stay in memory and are never returned.
import https from 'node:https';
import { PatrolError } from './state.mjs';

const endpoint = 'https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds';

export function buildReplyRequest({ cookie, self, targetUin = self, tid, commentId, commentUin, content }) {
  if (typeof targetUin !== 'string' || !/^[1-9]\d{0,15}$/.test(targetUin) || !Number.isSafeInteger(Number(targetUin))) {
    throw new PatrolError('target_invalid', '说说属主标识无效；未发送回复');
  }
  const parts = Object.fromEntries(String(cookie).split(';').map(p => p.trim()).filter(p => p.includes('='))
    .map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  const key = parts.p_skey || parts.skey;
  const cookieAccount = String(parts.uin || parts.p_uin || '').replace(/^o0*/, '');
  if (!key || cookieAccount !== self) throw new PatrolError('cookie_account_invalid', '空间登录凭据与当前账号不一致；未发送回复');
  let gtk = 5381;
  for (const character of key) gtk = (gtk * 33 + character.charCodeAt(0)) | 0;
  const body = new URLSearchParams({
    topicId: `${targetUin}_${tid}__1`, uin: self, hostUin: targetUin,
    feedsType: '100', inCharset: 'utf-8', outCharset: 'utf-8', plat: 'qzone',
    source: 'ic', platformid: '52', format: 'fs', ref: 'feeds',
    content, commentId, commentUin, richval: '', richtype: '', private: '0', paramstr: '2',
    qzreferrer: `https://user.qzone.qq.com/${targetUin}/main`,
  }).toString();
  return { url: `${endpoint}?g_tk=${gtk & 0x7fffffff}`, body, headers: {
    Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    Referer: 'https://user.qzone.qq.com/', Origin: 'https://user.qzone.qq.com',
    'User-Agent': 'Mozilla/5.0',
  } };
}

export function parseReplyResponse(status, body) {
  if (status !== 200) return { acknowledged: false };
  const code = /["']code["']\s*:\s*(-?\d+)/.exec(body)?.[1];
  if (code === undefined || Number(code) !== 0) return { acknowledged: false };
  const subcode = /["']subcode["']\s*:\s*(-?\d+)/.exec(body)?.[1];
  if (subcode !== undefined && Number(subcode) !== 0) return { acknowledged: false };
  const id = /["']commentid["']\s*:\s*["']?([1-9]\d*)(?=["',}\s]|$)/i.exec(body)?.[1];
  return { acknowledged: Boolean(id) };
}

export async function sendNativeReply(input) {
  const { url, body, headers } = buildReplyRequest(input);
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'POST', headers }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) request.destroy(new Error('response_limit'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(parseReplyResponse(response.statusCode, Buffer.concat(chunks).toString('utf8'))));
    });
    request.setTimeout(15000, () => request.destroy(new Error('timeout')));
    request.on('error', () => reject(new PatrolError('reply_unknown', '回复结果未明；保留预占，不会重试')));
    request.end(body);
  });
}
