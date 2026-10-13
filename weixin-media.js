/**
 * im-bridge · 微信（iLink / ClawBot）入站媒体：CDN 下载 + AES-128-ECB 解密 + 落盘。
 *
 * ── 为什么另起一个文件，而不是塞进 media.js ──────────────────────────
 * media.js 是**平台无关**的（只管路径、下载、类型判断）——它自己的文件头就写着
 * "平台相关的那部分留在各自的传输实现里"。而微信这段恰恰是平台相关的：
 * 图片**不是下下来就能看**的，得先去 CDN 取密文、再用消息里带的 aes_key
 * 做一次 AES-128-ECB 解密。放在 media.js 里会把它变成"一半通用一半微信"。
 *
 * ── 为什么这些常量/算法长这样：抄的是官方源码，不是二手逆向 ──────────
 * 来源：`@tencent-weixin/openclaw-weixin@2.4.10`（MIT，author Tencent）
 *   src/api/types.ts           → MessageItemType / CDNMedia / ImageItem 字段名
 *   src/auth/accounts.ts       → CDN_BASE_URL
 *   src/cdn/aes-ecb.ts         → decryptAesEcb
 *   src/cdn/pic-decrypt.ts     → parseAesKey / downloadAndDecryptBuffer
 *   src/cdn/cdn-url.ts         → buildCdnDownloadUrl（含 fallback 开关的语义）
 *   src/media/media-download.ts→ 各类型取哪个字段、图片优先用 image_item.aeskey
 *   src/messaging/inbound.ts   → 取文本的规则（含"语音用自带转写"）
 *
 * ⚠ 这一条是经验库 E34 的教训：协议类结论**一律以官方包源码为准**。
 *   网上流传很广的那篇《微信 Bot API 技术解析》连取二维码的方法都写错了。
 *
 * ── 零第三方依赖 ──────────────────────────────────────────────────
 * 只用 node: 内置（crypto / fs / path）+ 本地 media.js。
 * 插件是 link: 装进 profile 的，引第三方包就可能 ERR_MODULE_NOT_FOUND（E35）。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { mediaDirFor, safeFileName } from './media.js';

/** 微信 CDN 基址（官方 src/auth/accounts.ts 的 CDN_BASE_URL）。 */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** 消息项类型（官方 src/api/types.ts 的 MessageItemType）。 */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
};

/** 单个媒体的下载超时。与 media.js 的 DOWNLOAD_TIMEOUT_MS 取同一个值。 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * AES-128-ECB 解密（PKCS7 padding 是 Node 的默认值，所以第三个参数传 null）。
 * 与官方 aes-ecb.ts 的 decryptAesEcb 等价。
 */
export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 把 CDNMedia.aes_key 解析成 16 字节原始密钥。
 *
 * ⚠ 实测存在**两种编码**，都要处理（官方 pic-decrypt.ts 的注释原文）：
 *   · base64(原始 16 字节)          → 图片走这条
 *   · base64(16 字节的 hex 字符串)  → 文件 / 语音 / 视频走这条
 * 第二种 base64 解出来是 32 个 ASCII 十六进制字符，还得再按 hex 解一次。
 * 只按第一种处理的话，文件和视频会**解出乱码而不是报错**，更难查。
 */
export function parseAesKey(aesKeyBase64, label = 'weixin') {
  const decoded = Buffer.from(String(aesKeyBase64 ?? ''), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`${label}: aes_key 既不是 16 字节原始值也不是 32 位 hex（解出 ${decoded.length} 字节）`);
}

/**
 * 由 encrypt_query_param 拼 CDN 下载 URL。
 *
 * ⚠ 只在服务端**没给** full_url 时才走这条 —— 官方 cdn-url.ts 里
 *   `ENABLE_CDN_URL_FALLBACK = true` 就是这个含义：有 full_url 用 full_url，
 *   没有才回退到客户端拼接。我们保持同样的优先级，不自作主张。
 */
export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl = CDN_BASE_URL) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** 从文件头猜图片扩展名。CDN 不给 content_type，只能看字节。 */
export function sniffImageExt(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  if (b.length >= 6 && b.toString('ascii', 0, 3) === 'GIF') return '.gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (b.length >= 2 && b.toString('ascii', 0, 2) === 'BM') return '.bmp';
  // 认不出来就当 jpg：read_image 之类的读取方会自己按内容判断，
  // 而一个能打开的文件比一个没有扩展名的文件好用。
  return '.jpg';
}

/** 某个媒体项该从哪个字段取 CDN 引用。 */
function cdnRefOf(item) {
  const type = Number(item?.type ?? 0);
  if (type === MessageItemType.IMAGE) return item?.image_item?.media;
  if (type === MessageItemType.VOICE) return item?.voice_item?.media;
  if (type === MessageItemType.FILE) return item?.file_item?.media;
  if (type === MessageItemType.VIDEO) return item?.video_item?.media;
  return undefined;
}

/**
 * 某个媒体项该用哪把密钥（base64 形式）。
 *
 * ⚠ 图片这一条有个坑（官方 media-download.ts 明写）：`image_item.aeskey`
 *   是**原始 16 字节的 hex 字符串**，而且**优先于** `media.aes_key`。
 *   直接拿 aeskey 当 base64 用会解出乱码；要先 hex → bytes → base64。
 */
function aesKeyBase64Of(item) {
  if (Number(item?.type ?? 0) === MessageItemType.IMAGE) {
    const hex = String(item?.image_item?.aeskey ?? '').trim();
    if (hex !== '') return Buffer.from(hex, 'hex').toString('base64');
  }
  const raw = String(cdnRefOf(item)?.aes_key ?? '').trim();
  return raw;
}

/** 下载 URL：full_url 优先，没有才回退拼接；两者都没有则返回空串。 */
function downloadUrlOf(item) {
  const media = cdnRefOf(item);
  const full = String(media?.full_url ?? '').trim();
  if (full !== '') return full;
  const qp = String(media?.encrypt_query_param ?? '').trim();
  if (qp === '') return '';
  return buildCdnDownloadUrl(qp, CDN_BASE_URL);
}

/** 落盘该用什么名字。文件用对方给的原名（洗过），图片/视频没有名字就自己造一个。 */
function fileNameOf(item, ext, index) {
  if (Number(item?.type ?? 0) === MessageItemType.FILE) {
    const raw = String(item?.file_item?.file_name ?? '').trim();
    if (raw !== '') return safeFileName(raw, ext);
  }
  const stem = Number(item?.type ?? 0) === MessageItemType.VIDEO ? 'video' : 'image';
  return `${stem}-${Date.now()}-${index}${ext}`;
}

/** 抓一次 CDN 字节。失败不抛 —— 返回 null 并记事件。 */
async function fetchCdnBytes(url, label, onEvent) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      const body = await response.text().catch(() => '(读不到返回体)');
      onEvent?.('weixin-media-download-failed', {
        label,
        message: `HTTP ${response.status} ${String(body).slice(0, 120)}`,
      });
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    onEvent?.('weixin-media-download-failed', {
      label,
      message: String(error?.message ?? error).slice(0, 200),
    });
    return null;
  }
}

/**
 * 从 item_list 里取"能当正文的文字"。
 *
 * 与官方 bodyFromItemList 的对齐与差异：
 *   · 官方**只取第一个**文本项就 return，我们把**所有**文本项拼起来 ——
 *     一条消息里带两段文字时，宁可都留着，也不要丢掉后半句。
 *   · 语音照官方：`voice_item.text`（微信自带的转写）直接当文字用。
 *     这条很关键 —— 语音我们不解码（见下），但转写文字是免费的。
 */
export function weixinTextOf(itemList) {
  const parts = [];
  for (const item of Array.isArray(itemList) ? itemList : []) {
    const type = Number(item?.type ?? 0);
    if (type === MessageItemType.TEXT) {
      const text = String(item?.text_item?.text ?? '').trim();
      if (text !== '') parts.push(text);
      continue;
    }
    if (type === MessageItemType.VOICE) {
      const text = String(item?.voice_item?.text ?? '').trim();
      if (text !== '') parts.push(text);
    }
  }
  return parts.join('\n');
}

/**
 * 把一条消息里的所有媒体下载解密到桌面。
 *
 * 返回结构与 media.js 的 saveInboundMedia **完全一致**
 * （`[{kind, path, name, size, note}]`），所以可以直接喂给 withMediaPaths。
 * 这样"媒体怎么拼进给 agent 的文字"只有一份实现。
 *
 * ⚠ 单个媒体失败**不会**让整条消息失败：记事件跳过，其余照常。
 *   宁可少一张图，也不要因为一张图下载失败就把用户的话一起丢了。
 *
 * @param {Array<object>} itemList 微信消息的 item_list
 * @param {(event: string, detail?: object) => void} [onEvent]
 * @returns {Promise<Array<{kind:string,path:string,name:string,size:number,note:string}>>}
 */
export async function saveWeixinInboundMedia(itemList, onEvent) {
  const list = Array.isArray(itemList) ? itemList : [];
  const saved = [];
  const relevant = list.filter((item) => {
    const type = Number(item?.type ?? 0);
    return type === MessageItemType.IMAGE || type === MessageItemType.VOICE
      || type === MessageItemType.FILE || type === MessageItemType.VIDEO;
  });
  if (relevant.length === 0) return saved;

  const dir = mediaDirFor('weixin');

  for (const [index, item] of relevant.entries()) {
    const type = Number(item?.type ?? 0);

    // ── 语音：刻意不落盘 ──────────────────────────────────────────
    // 解密出来是 SILK，本机既播不了也转不了（要 silk-wasm 这个重依赖）。
    // 为它引一个几十 MB 的 SDK 不划算（经验库 E39 就是这么说的），
    // 而微信自带的转写文字已经由 weixinTextOf 取到了 —— 该有的信息没丢。
    if (type === MessageItemType.VOICE) {
      onEvent?.('weixin-media-skipped', { type: 'voice', reason: '语音转码需要 silk-wasm，本轮不引；已取微信自带转写文字' });
      continue;
    }

    const label = type === MessageItemType.IMAGE ? 'image' : type === MessageItemType.VIDEO ? 'video' : 'file';
    const url = downloadUrlOf(item);
    if (url === '') {
      // 既没 full_url 也没 encrypt_query_param：这条没有可下载的东西
      onEvent?.('weixin-media-skip-no-url', { type: label });
      continue;
    }

    const encrypted = await fetchCdnBytes(url, label, onEvent);
    if (encrypted === null) continue;

    const keyBase64 = aesKeyBase64Of(item);
    let data;
    if (keyBase64 === '') {
      // 没带密钥 = 明文（官方同样有这条分支：downloadPlainCdnBuffer）
      onEvent?.('weixin-media-plain', { type: label, bytes: encrypted.length });
      data = encrypted;
    } else {
      let key;
      try {
        key = parseAesKey(keyBase64, label);
      } catch (error) {
        onEvent?.('weixin-media-key-invalid', { type: label, message: String(error?.message ?? error).slice(0, 200) });
        continue;
      }
      try {
        data = decryptAesEcb(encrypted, key);
      } catch (error) {
        // 解密失败时把**密文原件**留在旁边：否则事后完全无从查起
        // （解不出来是密钥不对、还是本来就没加密，只能拿原件去比对）
        let dump = '';
        try {
          dump = join(dir, `failed-${label}-${Date.now()}.enc`);
          writeFileSync(dump, encrypted);
        } catch { dump = ''; }
        onEvent?.('weixin-media-decrypt-failed', {
          type: label,
          bytes: encrypted.length,
          dump,
          message: String(error?.message ?? error).slice(0, 200),
        });
        continue;
      }
    }

    const ext = type === MessageItemType.IMAGE
      ? sniffImageExt(data)
      : type === MessageItemType.VIDEO ? '.mp4' : '';
    const name = fileNameOf(item, ext, index);
    const filePath = join(dir, name);
    try {
      writeFileSync(filePath, data);
    } catch (error) {
      onEvent?.('weixin-media-write-failed', { name, message: String(error?.message ?? error).slice(0, 200) });
      continue;
    }

    const kind = type === MessageItemType.IMAGE ? '图片' : type === MessageItemType.VIDEO ? '视频' : '文件';
    saved.push({ kind, path: filePath, name, size: data.length, note: '' });
    onEvent?.('weixin-media-saved', { kind, name, bytes: data.length });
  }

  return saved;
}
