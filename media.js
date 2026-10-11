/**
 * im-bridge 媒体能力：收进来的落地，发出去前的分类。
 *
 * 为什么单独一个文件：媒体这块只跟"文件"打交道（路径、下载、类型判断），
 * 跟具体平台协议无关。平台相关的那部分（怎么上传、怎么发）留在各自的
 * 传输实现里（QQ 的在 index.js 的 QqClient，其余平台以后各自加）。
 *
 * ── 落地位置（用户 2026-10-12 指定：「保存路径你可以都放桌面上」）──
 *   <桌面>/im-bridge-media/<平台>/<YYYY-MM-DD>/<文件名>
 *   为什么不放 $DSH_HOME：用户明确要求桌面，他最好找。
 *   为什么按平台分目录：五个平台的文件名会撞（都是 image.png 这种）。
 *
 * ── 出站为什么不能直接发本地文件 ──
 *   QQ 的富媒体必须先上传换一个 file_info，再用 msg_type=7 发。
 *   上传有三条路：URL 上传（要求文件已在公网可访问）、分片上传（大文件）、
 *   二进制直传（≤5MB）。本地小文件走第三条，见 `MAX_INLINE_UPLOAD_BYTES`。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';

/** 单次二进制直传的上限（官方规定 5MB）。超过就得走分片上传。 */
export const MAX_INLINE_UPLOAD_BYTES = 5 * 1024 * 1024;

/** 下载单个附件的超时。官方没给建议值，取一个偏大的安全值。 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * 桌面目录。
 *
 * 不用 `os.homedir() + '\\Desktop'` 硬拼：桌面可能被重定向（OneDrive 等）。
 * 但 Node 没有"取系统桌面"的 API，所以两条都试：先看 USERPROFILE\Desktop
 * 存不存在，不存在再退回 homedir\Desktop。都不行就用 homedir。
 */
export function desktopDir() {
  const fromProfile = process.env.USERPROFILE === undefined
    ? undefined
    : join(process.env.USERPROFILE, 'Desktop');
  if (fromProfile !== undefined) {
    try {
      mkdirSync(fromProfile, { recursive: true });
      return fromProfile;
    } catch { /* 落到下面的兜底 */ }
  }
  const fallback = join(homedir(), 'Desktop');
  try { mkdirSync(fallback, { recursive: true }); return fallback; } catch { return homedir(); }
}

/**
 * 某个平台今天该往哪个目录存。**会顺手把目录建出来。**
 * @param {string} platform 平台 id（qq / weixin / ...）
 */
export function mediaDirFor(platform, when = new Date()) {
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, '0');
  const d = String(when.getDate()).padStart(2, '0');
  const dir = join(desktopDir(), 'im-bridge-media', platform, `${y}-${m}-${d}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 把文件名洗成一个在本机可用的名字。
 *
 * ⚠ 附件给的 filename 是对方发来的，可能带路径分隔符、`..`、控制字符，
 *   也可能整个是空的。所以只保留基名并剔掉危险字符，最后再用时间戳兜底。
 */
export function safeFileName(rawName, fallbackExt = '') {
  const base = basename(String(rawName ?? '').trim().replace(/[\\/]+/g, '_'));
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (cleaned !== '') return cleaned;
  return `media-${Date.now()}${fallbackExt}`;
}

/**
 * 官方附件 `content_type` → { kind, ext }。
 *
 * 官方文档给的取值：voice / image/jpeg / image/png / image/gif / video/mp4 / file。
 * ⚠ 语音那一条要特别注意：`content_type` 是 `voice`，而文件本身是 silk 格式；
 *   官方另外给了 `voice_wav_url`（转好的 WAV）。我们优先用 WAV —— 因为 silk
 *   本地没法直接播也没法转码（本机没有 ffmpeg），WAV 才能用。
 */
export function classifyAttachment(attachment) {
  const mime = String(attachment?.content_type ?? '').toLowerCase();
  if (mime === 'voice') {
    // 有 wav 就用 wav，没有只能拿原始的 silk
    const wav = String(attachment?.voice_wav_url ?? '').trim();
    return wav === ''
      ? { kind: '语音', ext: '.silk', url: String(attachment?.url ?? ''), note: 'silk 格式，本机无法直接播放' }
      : { kind: '语音', ext: '.wav', url: wav, note: '' };
  }
  if (mime === 'image/jpeg') return { kind: '图片', ext: '.jpg', url: String(attachment?.url ?? ''), note: '' };
  if (mime === 'image/png') return { kind: '图片', ext: '.png', url: String(attachment?.url ?? ''), note: '' };
  if (mime === 'image/gif') return { kind: '图片', ext: '.gif', url: String(attachment?.url ?? ''), note: '' };
  if (mime.startsWith('image/')) return { kind: '图片', ext: `.${mime.slice(6)}`, url: String(attachment?.url ?? ''), note: '' };
  if (mime === 'video/mp4') return { kind: '视频', ext: '.mp4', url: String(attachment?.url ?? ''), note: '' };
  if (mime.startsWith('video/')) return { kind: '视频', ext: `.${mime.slice(6)}`, url: String(attachment?.url ?? ''), note: '' };
  return { kind: '文件', ext: '', url: String(attachment?.url ?? ''), note: '' };
}

/**
 * 落盘该用什么文件名。
 *
 * ⚠ 扩展名以**分类结果**为准，不是附件给的原名。语音那条最典型：
 *   附件名字叫 `v.silk`，但我们下载的是官方转好的 WAV（`voice_wav_url`）——
 *   照原名存就会得到一个「内容是 WAV、扩展名是 silk」的文件，谁都播不了。
 *   这个 bug 是校验脚本第 ④ 段抓出来的。
 *
 * 只在分类结果没有扩展名时（未知类型→文件）才退回原名，因为那时原名里
 * 带着真实扩展名，比我们猜的准。
 */
function fileNameFor(attachment, info) {
  const rawName = String(attachment?.filename ?? '').trim();
  if (info.ext === '' || rawName === '') return safeFileName(rawName, info.ext);
  const stem = basename(rawName).replace(/\.[^.]*$/, '');
  return safeFileName(`${stem}${info.ext}`, info.ext);
}

/**
 * 把一条消息里的所有附件下载到桌面。
 *
 * @returns {Promise<Array<{kind:string, path:string, name:string, size:number, note:string}>>}
 *          下载失败的条目**不会**出现在结果里，但会走 onEvent 报出来 ——
 *          宁可少一个附件，也不要因为一张图下载失败就把整条消息丢掉。
 */
export async function saveInboundMedia(platform, attachments, onEvent) {
  const list = Array.isArray(attachments) ? attachments : [];
  const saved = [];
  if (list.length === 0) return saved;

  const dir = mediaDirFor(platform);
  for (const [index, attachment] of list.entries()) {
    const info = classifyAttachment(attachment);
    if (info.url === '') {
      onEvent?.('media-skip-no-url', { index, contentType: String(attachment?.content_type ?? '') });
      continue;
    }
    const name = fileNameFor(attachment, info);
    // 重名兜底：加序号，避免同一天收到两个 image.png 互相覆盖
    const finalName = index === 0 ? name : `${index}-${name}`;
    const filePath = join(dir, finalName);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      const response = await fetch(info.url, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(filePath, buffer);
      saved.push({ kind: info.kind, path: filePath, name: finalName, size: buffer.length, note: info.note });
      onEvent?.('media-saved', { kind: info.kind, name: finalName, bytes: buffer.length });
    } catch (error) {
      onEvent?.('media-download-failed', {
        index,
        kind: info.kind,
        message: String(error?.message ?? error).slice(0, 200),
      });
    }
  }
  return saved;
}

/**
 * 本地文件 → QQ 的 `file_type`（1图片 / 2视频 / 3语音 / 4文件）。
 *
 * 官方限制：图片 png/jpg（软限 20MB）、视频 mp4（30MB）、语音 silk（20MB）、
 * 文件任意（200MB）。超过软限平台会自动降级成文件类型，所以这里不用自己判大小。
 *
 * ⚠ 官方文档有出入：富媒体概述说图片支持 jpg/png/gif/webp/bmp，
 *   而上传接口的字段表只写 png/jpg。这里按"宽的那个"放行，让平台去拒 ——
 *   反正拒了会有明确的 err_code，比我们自己拦掉一个能发的东西好。
 */
export function qqFileTypeOf(filePath) {
  const ext = extname(String(filePath ?? '')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) return 1;
  if (ext === '.mp4') return 2;
  if (ext === '.silk') return 3;
  return 4;
}

/** 人类可读的体积，用于日志。 */
export function formatBytes(bytes) {
  const n = Number(bytes ?? 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 把收到的媒体**拼进给 agent 的文字里**。
 *
 * 为什么用"路径写进文字"这种笨办法：本机没有别的通道能把一张图交给 agent。
 * DSH 的用户消息目前只能带文本块，而 agent 拿到本地路径后可以自己读图
 * （宿主有 read_image 工具，实测可用）。所以这一版先这么做 ——
 * 能用、能验证、没有新依赖。以后若有原生的图片消息块，再换。
 *
 * 格式（每行一条，agent 一眼能认出）：
 *   [收到图片] C:\Users\...\Desktop\im-bridge-media\qq\2026-10-12\photo.jpg
 */
export function withMediaPaths(text, media) {
  const lines = [];
  const body = String(text ?? '').trim();
  if (body !== '') lines.push(body);
  for (const item of Array.isArray(media) ? media : []) {
    const note = item?.note === undefined || item.note === '' ? '' : `（${item.note}）`;
    lines.push(`[收到${item?.kind ?? '文件'}] ${item?.path ?? ''}${note}`);
  }
  return lines.join('\n');
}
