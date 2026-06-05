import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { isJidBroadcast, downloadMediaMessage } from '@whiskeysockets/baileys';
import ffmpegPath from 'ffmpeg-static';

// Detect a system ffmpeg that has drawtext (libfreetype) support.
// ffmpeg-static is compiled without libfreetype so drawtext filter fails.
// We try common system paths first; fall back to ffmpeg-static for non-text effects.
const _detectDrawtextFfmpeg = () => {
  const candidates = ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/nix/var/nix/profiles/default/bin/ffmpeg'];
  // Also check PATH-resolved ffmpeg from yt-dlp env
  try {
    const fromEnv = process.env.FFMPEG_PATH || '';
    if (fromEnv) candidates.unshift(fromEnv);
  } catch (_) {}
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['-filters'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (out.includes('drawtext')) { console.log(`[ffmpeg] drawtext-capable binary: ${bin}`); return bin; }
    } catch (_) {}
  }
  console.log('[ffmpeg] drawtext not found in system ffmpeg — text effects may fail');
  return ffmpegPath;
};
const DRAWTEXT_FFMPEG = _detectDrawtextFfmpeg();
import QRCode from 'qrcode';
import { readXp, xpToLevel, rankBadge, xpForNextLevel, xpForLevel } from './xpSystem.js';
import { askAI, clearAIHistory } from './aiHelper.js';
import { generateImage } from './aiImageHelper.js';
import { textToSpeech, VOICES as TTS_VOICES } from './aiTtsHelper.js';
import { getDefaultLogoDataUrl, getDefaultLogoBuffer, getDefaultAliveDataUrl } from './logoHelper.js';

const execFileAsync = promisify(execFile);

// ── Bot config (channel forward branding) ──────────────────────────────────
// Used to make menus / .alive / .csong replies look like they were forwarded
// from the official Dark Thila Bot WhatsApp channel.
export const BOT_CONFIG = {
  CHANNEL_NAME: 'Dark Thila X MD ×̷̷͜×̷',
  CHANNEL_JID: '120363426946947326@newsletter',
  SERVER_MSG_ID: 143,
};

// Build the contextInfo block that makes a message render as
// "Forwarded many times" + a "View channel" button.
const buildChannelForwardContext = (mentions = []) => ({
  forwardingScore: 999,
  isForwarded: true,
  mentionedJid: mentions,
  forwardedNewsletterMessageInfo: {
    newsletterJid: BOT_CONFIG.CHANNEL_JID,
    newsletterName: BOT_CONFIG.CHANNEL_NAME,
    serverMessageId: BOT_CONFIG.SERVER_MSG_ID,
  },
});

// ── Group settings & auto-reply helpers ────────────────────────────────────
const getGroupSettings = (sessionDir, groupJid) => {
  const safe = groupJid.replace(/[^a-zA-Z0-9]/g, '_');
  const file = path.join(sessionDir, `grp-${safe}.json`);
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) {}
  return {};
};
const saveGroupSettings = (sessionDir, groupJid, settings) => {
  const safe = groupJid.replace(/[^a-zA-Z0-9]/g, '_');
  fs.writeFileSync(path.join(sessionDir, `grp-${safe}.json`), JSON.stringify(settings, null, 2));
};
const getAutoReplies = (sessionDir) => {
  const file = path.join(sessionDir, 'auto-replies.json');
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) {}
  return {};
};
const saveAutoReplies = (sessionDir, replies) => {
  fs.writeFileSync(path.join(sessionDir, 'auto-replies.json'), JSON.stringify(replies, null, 2));
};
const URL_REGEX = /https?:\/\/[^\s]+|www\.[a-z0-9.-]+\.[a-z]{2,}[^\s]*/gi;
const containsLink = (text) => { URL_REGEX.lastIndex = 0; return URL_REGEX.test(text); };

// ── Interactive menu state (per chat+user) ────────────────────────────────
// Tracks who is currently navigating an interactive menu so numeric replies
// like "1" / "0" can be routed to the right sub-menu. Auto-expires after 5min.
//   state: 'owner'  → omenu navigation
//   state: 'public' → public menu navigation
const MENU_TTL_MS = 5 * 60 * 1000;
const menuStates = new Map(); // key: `${jid}|${sender}` → { state, expires }

const menuKey = (msg) => {
  const jid = msg.key.remoteJid || '';
  const sender = msg.key.participant || jid;
  return `${jid}|${sender}`;
};
const setMenuState = (msg, state) => {
  menuStates.set(menuKey(msg), { state, expires: Date.now() + MENU_TTL_MS });
};
const getMenuState = (msg) => {
  const k = menuKey(msg);
  const s = menuStates.get(k);
  if (!s) return null;
  if (s.expires < Date.now()) { menuStates.delete(k); return null; }
  return s.state;
};
const clearMenuState = (msg) => { menuStates.delete(menuKey(msg)); };
// ───────────────────────────────────────────────────────────────────────────

/**
 * Uploads a file buffer to catbox.moe (anonymous, permanent URL).
 * Returns the public URL string, e.g. 'https://files.catbox.moe/abc123.mp3'
 */
const uploadToCatbox = async (buffer, filename, mimeType) => {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', new Blob([buffer], { type: mimeType }), filename);
  const resp = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`Catbox upload failed: HTTP ${resp.status}`);
  const url = (await resp.text()).trim();
  if (!url.startsWith('https://')) throw new Error(`Catbox returned unexpected response: ${url}`);
  return url;
};

/**
 * Injects WhatsApp sticker pack metadata (name + author) into a WebP buffer
 * as an EXIF chunk. WhatsApp reads this to display the sticker pack name.
 */
const injectStickerExif = (webpBuffer, packName, author) => {
  try {
    if (webpBuffer.slice(0, 4).toString() !== 'RIFF' || webpBuffer.slice(8, 12).toString() !== 'WEBP') {
      return webpBuffer; // Not a valid WebP — return unchanged
    }

    const json = {
      'sticker-pack-id': 'com.darktila.bot.stickers',
      'sticker-pack-name': packName,
      'sticker-pack-publisher': author,
      'android-app-store-link': '',
      'ios-app-store-link': '',
    };

    // TIFF little-endian header + one IFD entry with a custom WhatsApp tag (0x5741)
    const exifAttr = Buffer.from([
      0x49, 0x49, 0x2A, 0x00, // TIFF LE magic
      0x08, 0x00, 0x00, 0x00, // Offset to first IFD = 8
      0x01, 0x00,             // 1 IFD entry
      0x41, 0x57,             // Tag 0x5741 = WhatsApp custom tag
      0x07, 0x00,             // Type = UNDEFINED (raw bytes)
      0x00, 0x00, 0x00, 0x00, // Count — filled below
      0x16, 0x00, 0x00, 0x00, // Value offset = 22 (immediately after IFD)
    ]);

    const jsonBuf = Buffer.from(JSON.stringify(json), 'utf-8');
    exifAttr.writeUInt32LE(jsonBuf.length, 14);
    const exifData = Buffer.concat([exifAttr, jsonBuf]);

    const padding = exifData.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    const chunkSize = Buffer.allocUnsafe(4);
    chunkSize.writeUInt32LE(exifData.length, 0);
    const exifChunk = Buffer.concat([Buffer.from('EXIF'), chunkSize, exifData, padding]);

    const originalContent = webpBuffer.slice(12);
    const newBody = Buffer.concat([originalContent, exifChunk]);
    const newRiffSize = Buffer.allocUnsafe(4);
    newRiffSize.writeUInt32LE(4 + newBody.length, 0);

    return Buffer.concat([Buffer.from('RIFF'), newRiffSize, Buffer.from('WEBP'), newBody]);
  } catch (_) {
    return webpBuffer; // If anything fails, return the original unchanged
  }
};

/**
 * Converts any image or short video buffer to an animated/static WebP sticker.
 * Returns a Buffer of the WebP file.
 */
const toStickerWebp = async (inputBuffer, isVideo) => {
  const tmpIn = path.join(os.tmpdir(), `sticker_in_${Date.now()}${isVideo ? '.mp4' : '.jpg'}`);
  const tmpOut = path.join(os.tmpdir(), `sticker_out_${Date.now()}.webp`);

  try {
    fs.writeFileSync(tmpIn, inputBuffer);

    const scaleFilter = 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';

    const args = isVideo
      ? [
          '-y', '-i', tmpIn,
          '-vf', scaleFilter,
          '-vcodec', 'libwebp',
          '-lossless', '0',
          '-qscale', '50',
          '-loop', '0',
          '-preset', 'default',
          '-an',
          '-t', '6',
          '-vsync', '0',
          tmpOut,
        ]
      : [
          '-y', '-i', tmpIn,
          '-vf', scaleFilter,
          '-vcodec', 'libwebp',
          '-lossless', '0',
          '-qscale', '75',
          '-preset', 'default',
          '-an',
          tmpOut,
        ];

    await execFileAsync(ffmpegPath, args, { timeout: 60000 });

    if (!fs.existsSync(tmpOut)) throw new Error('WebP output file not created.');
    return fs.readFileSync(tmpOut);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  }
};

/**
 * Extracts the target media message (from direct content or quoted reply).
 * Returns { mediaMsg, mediaType } or null.
 */
const resolveMediaTarget = (msg) => {
  // Direct message media (image/video sent with .sticker as caption)
  if (msg.message?.imageMessage) return { mediaMsg: msg, mediaType: 'image' };
  if (msg.message?.videoMessage) return { mediaMsg: msg, mediaType: 'video' };
  if (msg.message?.stickerMessage) return { mediaMsg: msg, mediaType: 'sticker' };

  // Quoted reply media
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;
  if (!quoted) return null;

  const fakeKey = { ...msg.key, id: ctx.stanzaId, participant: ctx.participant };
  if (quoted.imageMessage) return { mediaMsg: { key: fakeKey, message: quoted }, mediaType: 'image' };
  if (quoted.videoMessage) return { mediaMsg: { key: fakeKey, message: quoted }, mediaType: 'video' };
  if (quoted.stickerMessage) return { mediaMsg: { key: fakeKey, message: quoted }, mediaType: 'sticker' };

  return null;
};

const reply = async (sock, msg, text, mentions) => {
  const jid = msg.key.remoteJid;
  const msgContent = mentions && mentions.length > 0 ? { text, mentions } : { text };
  await sock.sendMessage(jid, msgContent, { quoted: msg });
};

const react = async (sock, msg, emoji) => {
  const jid = msg.key.remoteJid;
  await sock.sendMessage(jid, {
    react: { text: emoji, key: msg.key }
  });
};

const sendImage = async (sock, jid, url, caption, quotedMsg, extra) => {
  // If no URL provided, just send caption as plain text
  if (!url) {
    await sock.sendMessage(jid, { text: caption, ...(extra || {}) }, quotedMsg ? { quoted: quotedMsg } : {});
    return;
  }
  try {
    let imgBuffer, mime;

    if (url.startsWith('data:')) {
      // Data URL (base64 uploaded image) — decode directly, no network needed
      const [header, base64] = url.split(',');
      mime = (header.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
      imgBuffer = Buffer.from(base64, 'base64');
    } else {
      // Remote URL — download via axios
      const imgResp = await axios.get(url, { responseType: 'arraybuffer', timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      imgBuffer = Buffer.from(imgResp.data);
      mime = (imgResp.headers['content-type'] || 'image/jpeg').split(';')[0];
    }

    await sock.sendMessage(jid, { image: imgBuffer, caption, mimetype: mime, ...(extra || {}) }, quotedMsg ? { quoted: quotedMsg } : {});
  } catch (_) {
    // Failed — send caption as text only
    try {
      await sock.sendMessage(jid, { text: caption, ...(extra || {}) }, quotedMsg ? { quoted: quotedMsg } : {});
    } catch (_2) {}
  }
};

// sendMenuWithImage — sends menu text as image caption (ONE combined message).
// If image fails or is not a valid image, falls back to plain text.
const sendMenuWithImage = async (sock, jid, url, caption, quotedMsg) => {
  // Attach channel-forward context so the menu renders as
  // "Forwarded many times" with a "View channel" button.
  const contextInfo = buildChannelForwardContext();

  if (url) {
    try {
      let imgBuffer, mime;
      if (url.startsWith('data:')) {
        const [header, base64] = url.split(',');
        mime = (header.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
        imgBuffer = Buffer.from(base64, 'base64');
      } else {
        const imgResp = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 10000,
          maxRedirects: 5,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        });
        mime = (imgResp.headers['content-type'] || '').split(';')[0].trim();
        if (mime.startsWith('image/')) {
          imgBuffer = Buffer.from(imgResp.data);
        }
      }
      if (imgBuffer) {
        await sock.sendMessage(
          jid,
          { image: imgBuffer, caption, mimetype: mime, contextInfo },
          quotedMsg ? { quoted: quotedMsg } : {}
        );
        return;
      }
    } catch (_) { /* fall through to text */ }
  }
  // Fallback — plain text only (still tagged as channel-forwarded)
  await sock.sendMessage(
    jid,
    { text: caption, contextInfo },
    quotedMsg ? { quoted: quotedMsg } : {}
  );
};

// ── Owner sub-menu renderer ───────────────────────────────────────────────
// Builds and sends the requested owner sub-menu (1–7) or returns to the
// main owner menu (0). Caller must verify owner status before invoking.
const sendOwnerSubMenu = async (sock, msg, choice, ctx) => {
  const { meta, prefix, mode, footer } = ctx;
  const jid = msg.key.remoteJid;

  const back = `
╰────────────────────
✨ _Reply *0* to return to the owner menu_
> ${footer}`;

  let body = '';
  switch (choice) {
    case '0':
      // Re-show the main owner menu
      await sendOwnerMainMenu(sock, msg, ctx);
      return;

    case '1': // Broadcast
      body =
`╭──❒ 📡 *𝘽𝙍𝙊𝘼𝘿𝘾𝘼𝙎𝙏* ❒──
│
│ ✦ ${prefix}bcgc [msg]   ❯ All groups
│ ✦ ${prefix}bcpc [msg]   ❯ All contacts
│ ✦ ${prefix}bc [msg]     ❯ Group broadcast
${back}`;
      break;

    case '2': // Tools
      body =
`╭──❒ 💥 *𝙊𝙒𝙉𝙀𝙍 𝙏𝙊𝙊𝙇𝙎* ❒──
│
│ ✦ ${prefix}boom [n] [msg]  ❯ Text bomb
│ ✦ ${prefix}boom [n]        ❯ 🖼️ Image bomb _(reply img)_
│ ✦ ${prefix}boom [n]        ❯ 🎟️ Sticker bomb _(reply stk)_
│ ✦ ${prefix}ctest [JID]     ❯ Test channel
${back}`;
      break;

    case '3': // Monitor
      body =
`╭──❒ 📊 *𝙈𝙊𝙉𝙄𝙏𝙊𝙍* ❒──
│
│ ✦ ${prefix}system   ❯ Server & RAM info
│ ✦ ${prefix}groups   ❯ All groups
│ ✦ ${prefix}users    ❯ Private chats
${back}`;
      break;

    case '4': // Permissions
      body =
`╭──❒ 🔐 *𝙋𝙀𝙍𝙈𝙄𝙎𝙎𝙄𝙊𝙉𝙎* ❒──
│
│ ✦ ${prefix}permit @user     ❯ Grant access
│ ✦ ${prefix}unpermit @user   ❯ Revoke access
│ ✦ ${prefix}permitlist       ❯ View list
${back}`;
      break;

    case '5': // Auto-Join
      body =
`╭──❒ 🔗 *𝘼𝙐𝙏𝙊-𝙅𝙊𝙄𝙉* ❒──
│
│ ✦ ${prefix}addgroup [link]
│ ✦ ${prefix}delgroup [no]
│ ✦ ${prefix}addchannel [jid]
│ ✦ ${prefix}delchannel [no]
│ ✦ ${prefix}autojoinlist
${back}`;
      break;

    case '6': // Status
      body =
`╭──❒ 📺 *𝙎𝙏𝘼𝙏𝙐𝙎 𝙎𝙔𝙎𝙏𝙀𝙈* ❒──
│
│ ✦ ${prefix}viewstatus              ❯ Auto-view
│ ✦ ${prefix}reactstatus [on/off]    ❯ Auto-react
│ ✦ ${prefix}replystatus [on/off]    ❯ Auto-reply
│ ✦ ${prefix}setstatusreact [emoji]
│ ✦ ${prefix}setstatusreplymsg [text]
│ ✦ ${prefix}statusinfo              ❯ Settings
${back}`;
      break;

    case '7': // Bot Settings
      body =
`╭──❒ ⚙️ *𝘽𝙊𝙏 𝙎𝙀𝙏𝙏𝙄𝙉𝙂𝙎* ❒──
│
│ ✦ ${prefix}setbotname [name]
│ ✦ ${prefix}setfooter [text]
│ ✦ ${prefix}setprefix [char]
│ ✦ ${prefix}setmode [all|private|group]
│ ✦ ${prefix}setlogo [url]
│ ✦ ${prefix}setownermenulogo [url]
│ ✦ ${prefix}setaliveimg   _(reply to img / URL)_
│ ✦ ${prefix}setalivevideo _(reply to video)_
│ ✦ ${prefix}setpingimg    _(reply to img / URL)_
│ ✦ ${prefix}autoreadmessages [on|off]
│ ✦ ${prefix}callblock [on|off]
│ ✦ ${prefix}setcallrejectimg _(reply / URL)_
│ ✦ ${prefix}setcallrejectmsg [text]
│ ✦ ${prefix}resetcallrejectimg
│ ✦ ${prefix}connectmsg [on|off]
│ ✦ ${prefix}setconnectmsg [text]
│ ✦ Owner editing → Admin Dashboard
${back}`;
      break;

    case '8': // Premium Management (alias to public option 9)
      body =
`╭──❒ ⭐ *𝙋𝙍𝙀𝙈𝙄𝙐𝙈 𝙈𝙂𝙈𝙏* ❒──
│
│ ✦ ${prefix}addpremium <num> [days]
│ ✦ ${prefix}addpremium [days]   _(reply)_
│ ✦ ${prefix}delpremium <num>
│ ✦ ${prefix}premiumlist
│ ✦ ${prefix}premium             ❯ Check status
│
│ 💎 _Omit days for lifetime access_
${back}`;
      break;

    case '9': // Multi-Session (operate on all connected bots)
      body =
`╭──❒ 🌐 *𝙈𝙐𝙇𝙏𝙄-𝙎𝙀𝙎𝙎𝙄𝙊𝙉* ❒──
│
│ ✦ ${prefix}botstatus              ❯ All bots status
│ ✦ ${prefix}followall [link]       ❯ All sessions follow
│ ✦ ${prefix}unfollowall [link]     ❯ All sessions unfollow
│ ✦ ${prefix}reactpost [link]       ❯ All sessions react
│ ✦ ${prefix}statusboom    _(reply)_  ❯ Post status on all
│ ✦ ${prefix}boomlog                ❯ Last 5 boom logs
│ ✦ ${prefix}restart                ❯ Restart all bots
│
│ 🔗 _Accepts WhatsApp channel link or numeric JID_
│ 💬 _reactpost needs a post link with msgId_
│ 🖼️ _statusboom: reply to image/video/text_
${back}`;
      break;

    default:
      body =
`╭──❒ ❓ *𝙄𝙉𝙑𝘼𝙇𝙄𝘿 𝙊𝙋𝙏𝙄𝙊𝙉* ❒──
│
│ Reply *1–9* to open a section
│ Reply *0* for the main owner menu
╰────────────────────
> ${footer}`;
  }

  await sock.sendMessage(jid, { text: body }, { quoted: msg });
};

// ── Owner main menu (numbered) ────────────────────────────────────────────
const sendOwnerMainMenu = async (sock, msg, ctx) => {
  const { meta, prefix, footer } = ctx;
  const jid = msg.key.remoteJid;

  const text =
`╔═══════════════════════════╗
║    🔴 *OWNER ONLY MENU*    ║
╚═══════════════════════════╝

╭─❑ ⭐ *PREMIUM MANAGE*
│ ${prefix}addpremium [number]
│ ${prefix}removepremium [number]
│ ${prefix}listpremium » Premium list
╰──────────────────

╭─❑ 💥 *STATUS BOMB*
│ ${prefix}statusboom » Bomb all sessions
│ ${prefix}boomlog » Bomb log
│ ${prefix}autostatusview on/off
│ ${prefix}autostatusreact on/off
│ ${prefix}autostatusreply on/off
│ ${prefix}setstatusreact [emoji]
│ ${prefix}setstatusreplymsg [msg]
╰──────────────────

╭─❑ 📢 *CHANNEL TOOLS*
│ ${prefix}followall [link]
│ ${prefix}unfollowall [link]
│ ${prefix}addchannel » Add channel
│ ${prefix}delchannel » Remove channel
│ ${prefix}csong » Post song to channel
│ ${prefix}channelsong » Channel song
│ ${prefix}toaudio » Convert to audio
╰──────────────────

╭─❑ 🔒 *SESSION MANAGE*
│ ${prefix}pair [number] » Pair new bot
│ ${prefix}delsession » Delete session
│ ${prefix}restartall » Restart all bots
│ ${prefix}restart » Restart bot
│ ${prefix}botstatus » All bots status
│ ${prefix}autojoinlist » Auto join list
│ ${prefix}mutelist » Muted list
╰──────────────────

╭─❑ 🚪 *GROUP PROTECTION*
│ ${prefix}antilink on/off » Delete links by non-admins
│ ${prefix}antidelete on/off » Restore deleted messages
╰──────────────────

╭─❑ ⚙️ *BOT SETTINGS*
│ ${prefix}setbotname [name]
│ ${prefix}setfooter [text]
│ ${prefix}setprefix [.]
│ ${prefix}setmode public/private
│ ${prefix}setlogo [image reply]
│ ${prefix}setaliveimg [image reply]
│ ${prefix}setalivevideo [video reply]
│ ${prefix}setpingimg [image reply]
│ ${prefix}setconnectmsg [msg]
│ ${prefix}autoreadmessages on/off
│ ${prefix}callblock on/off
│ ${prefix}setcallrejectmsg [msg]
│ ${prefix}setcallrejectimg [img]
╰──────────────────

╭─❑ 🎨 *AI IMAGE*
│ ${prefix}ai » Chat with AI
│ ${prefix}aimg » AI image gen
│ ${prefix}imgen » Image generate
│ ${prefix}imagine » Imagine prompt
│ ${prefix}gen » Generate image
│ ${prefix}colorizer » Colorize image
╰──────────────────

╭─❑ 🎭 *REACT & MISC*
│ ${prefix}customreact » Set reaction
│ ${prefix}reactlog » React history
│ ${prefix}reactpost [link]
│ ${prefix}numbers » Get numbers list
│ ${prefix}users » Get users list
│ ${prefix}boom » Fun effect
│ ${prefix}v » View once
│ ${prefix}vv » Forward view once
╰──────────────────

╭─❑ 🔒 *USER CONTROL*
│ ${prefix}permit @user » Permit user
│ ${prefix}unpermit @user » Unpermit
│ ${prefix}permitlist » Permitted list
│ ${prefix}pp » Set profile photo
│ ${prefix}steal » Steal sticker
╰──────────────────

╭─❑ 📊 *BOT STATS*
│ ${prefix}system » System info
│ ${prefix}stats » Bot statistics
│ ${prefix}botstatus » Sessions status
╰──────────────────

> *${footer}*`;

  clearMenuState(msg);
  const ownerLogoUrl = meta.ownerLogo || meta.logo || DEFAULT_LOGO_IMG_URL;
  await sendMenuWithImage(sock, jid, ownerLogoUrl, text, msg);
};

// ── Public sub-menu renderer ──────────────────────────────────────────────
// Builds and sends the requested public sub-menu (1–7) or returns to the
// main public menu (0). Available to all users.
const sendPublicSubMenu = async (sock, msg, choice, ctx) => {
  const { meta, prefix, mode, footer } = ctx;
  const jid = msg.key.remoteJid;
  const back = `
╰────────────────────
✨ _Reply *0* to return to main menu_
> ${footer}`;

  let body = '';
  switch (choice) {
    case '0':
      await sendPublicMainMenu(sock, msg, ctx);
      return;

    case '1': // Group Admin & Settings
      body =
`╭──❒ 🛡️ *𝙂𝙍𝙊𝙐𝙋 𝘼𝘿𝙈𝙄𝙉* ❒──
│
│ ✦ ${prefix}kick           ❯ Remove member _(reply)_
│ ✦ ${prefix}add [no]       ❯ Add member
│ ✦ ${prefix}promote        ❯ Make admin _(reply)_
│ ✦ ${prefix}demote         ❯ Remove admin _(reply)_
│ ✦ ${prefix}tagall         ❯ Mention all
│ ✦ ${prefix}hidetag [msg]  ❯ Silent notify
│ ✦ ${prefix}warn @user [reason]
│ ✦ ${prefix}warns @user
│ ✦ ${prefix}resetwarn @user
│ ✦ ${prefix}setwarnlimit [1-10]
│ ✦ ${prefix}mute / ${prefix}unmute @user
│ ✦ ${prefix}mutelist
│ ✦ ${prefix}pin _(reply, e.g. 7d)_
│ ✦ ${prefix}unpin _(reply)_
│
├──❒ ⚙️ *𝙂𝙍𝙊𝙐𝙋 𝙎𝙀𝙏𝙏𝙄𝙉𝙂𝙎* ❒──
│
│ ✦ ${prefix}setname [text]
│ ✦ ${prefix}setdesc [text]
│ ✦ ${prefix}setgroupdp
│ ✦ ${prefix}open / ${prefix}close
│ ✦ ${prefix}link / ${prefix}revoke
│ ✦ ${prefix}groupinfo
│ ✦ ${prefix}setwelcome [on/off/text]
│ ✦ ${prefix}setgoodbye [on/off/text]
│ ✦ ${prefix}setwelcomeimg [url|reset|off]
│ ✦ ${prefix}setwelcomemsg [text|reset]
│ ✦ ${prefix}setgoodbyeimg [url|reset|off]
│ ✦ ${prefix}setgoodbyemsg [text|reset]
│ ✦ ${prefix}antilink [on/off]
│ ✦ ${prefix}addword / ${prefix}delword / ${prefix}wordlist
${back}`;
      break;

    case '2': // Media & Image FX
      body =
`╭──❒ 🎨 *𝙈𝙀𝘿𝙄𝘼 & 𝙄𝙈𝘼𝙂𝙀 𝙁𝙓* ❒──
│
│ ✦ ${prefix}sticker      ❯ Image/video → sticker
│ ✦ ${prefix}steal        ❯ Steal sticker _(reply)_
│ ✦ ${prefix}toimg        ❯ Sticker → image _(reply)_
│ ✦ ${prefix}toaudio      ❯ Video → audio _(reply)_
│ ✦ ${prefix}enhance      ❯ HD upscale _(reply)_
│ ✦ ${prefix}colorizer    ❯ B&W → color _(reply)_
│ ✦ ${prefix}cartoon      ❯ Cartoon style _(reply)_
│ ✦ ${prefix}triggered    ❯ Triggered GIF _(reply)_
│ ✦ ${prefix}wasted       ❯ GTA Wasted _(reply)_
│ ✦ ${prefix}pp           ❯ Get profile photo
│ ✦ ${prefix}send         ❯ Save status _(reply)_
│ ✦ ${prefix}vv           ❯ Reveal view-once _(reply)_
${back}`;
      break;

    case '3': // Downloads
      body =
`╭──❒ 📥 *𝘿𝙊𝙒𝙉𝙇𝙊𝘼𝘿𝙎* ❒──
│
│ ✦ ${prefix}fbdl [url]    ❯ Facebook video
│ ✦ ${prefix}ttdl [url]    ❯ TikTok video
│ ✦ ${prefix}ytdl [url]    ❯ YouTube video
│ ✦ ${prefix}igdl [url]    ❯ Instagram reel
│ ✦ ${prefix}vdl [url]     ❯ Any site video
│ ✦ ${prefix}song [query]  ❯ YouTube MP3
${back}`;
      break;

    case '4': // Fun & Games + Group Activity
      body =
`╭──❒ 🎮 *𝙁𝙐𝙉 & 𝙂𝘼𝙈𝙀𝙎* ❒──
│
│ ✦ ${prefix}joke              ❯ Random joke
│ ✦ ${prefix}quote             ❯ Motivational quote
│ ✦ ${prefix}fact              ❯ Random fact
│ ✦ ${prefix}8ball [question]  ❯ Magic 8-ball
│ ✦ ${prefix}ship @u1 @u2      ❯ Love %
│ ✦ ${prefix}truth             ❯ Truth question
│ ✦ ${prefix}dare              ❯ Dare challenge
│ ✦ ${prefix}rps [r/p/s]       ❯ Rock paper scissors
│
├──❒ ✨ *𝙍𝙀𝘼𝘾𝙏 𝙋𝘼𝘾𝙆𝙎* _(reply)_ ❒──
│
│ ✦ ${prefix}heart             ❯ ❤️🧡💛💚💙💜
│ ✦ ${prefix}numbers           ❯ 0️⃣1️⃣2️⃣...🔟
│ ✦ ${prefix}face              ❯ 😀😂🥰😎🥳
│ ✦ ${prefix}custom 🔥💯⚡    ❯ Your own pack
│
├──❒ 🏆 *𝙂𝙍𝙊𝙐𝙋 𝘼𝘾𝙏𝙄𝙑𝙄𝙏𝙔* ❒──
│
│ ✦ ${prefix}level             ❯ Your XP & level
│ ✦ ${prefix}rank @user        ❯ Check level
│ ✦ ${prefix}leaderboard / ${prefix}lb / ${prefix}top
${back}`;
      break;

    case '5': // Tools & Utility
      body =
`╭──❒ 🛠️ *𝙏𝙊𝙊𝙇𝙎 & 𝙐𝙏𝙄𝙇𝙄𝙏𝙔* ❒──
│
│ ✦ ${prefix}calc [expression]   ❯ Calculator
│ ✦ ${prefix}qr [text/url]       ❯ QR code
│ ✦ ${prefix}weather [city]      ❯ Weather info
│ ✦ ${prefix}currency [a] [f] [t]
│ ✦ ${prefix}tr [lang] [text]    ❯ Translate
│ ✦ ${prefix}alive               ❯ Bot status
│ ✦ ${prefix}ping                ❯ Response time
│ ✦ ${prefix}stats               ❯ Usage stats
│ ✦ ${prefix}jid                 ❯ Chat JID
│ ✦ ${prefix}setreply [kw] | [reply]
│ ✦ ${prefix}delreply [kw]
│ ✦ ${prefix}replylist
│
├──❒ 🔮 *𝘼𝙄 𝙏𝙊𝙊𝙇𝙎* ❒──
│
│ ✦ ${prefix}ai [question]       ❯ AI chat
│ ✦ ${prefix}imagine <prompt>    ❯ ⭐ AI image gen
│ ✦ ${prefix}tts <text>          ❯ ⭐ Voice generate
${back}`;
      break;

    case '6': // Status
      body =
`╭──❒ 📺 *𝙎𝙏𝘼𝙏𝙐𝙎 𝙎𝙔𝙎𝙏𝙀𝙈* ❒──
│
│ ✦ ${prefix}statusinfo           ❯ Settings
│ ✦ ${prefix}viewstatus           ❯ Auto-view
│ ✦ ${prefix}reactstatus [on/off]
│ ✦ ${prefix}replystatus [on/off]
│ ✦ ${prefix}setstatusreact [emoji]
│ ✦ ${prefix}setstatusreplymsg [text]
${back}`;
      break;

    case '7': // Privacy & Security
      body =
`╭──❒ 🔐 *𝙋𝙍𝙄𝙑𝘼𝘾𝙔 & 𝙎𝙀𝘾𝙐𝙍𝙄𝙏𝙔* ❒──
│
│ ✦ ${prefix}hidetag [msg]            ❯ Silent notify
│ ✦ ${prefix}disappear [s] [msg]      ❯ Self-destruct
│ ✦ ${prefix}encrypt [pass] [msg]     ❯ AES encrypt
│ ✦ ${prefix}decrypt [pass] [payload] ❯ Decode
${back}`;
      break;

    case '8': // Owner Info
      body =
`╭──❒ 👑 *𝙊𝙒𝙉𝙀𝙍 𝙄𝙉𝙁𝙊* ❒──
│
│ ✦ ${prefix}owner   ❯ Show bot owner details
│            (name, number, vCard)
${back}`;
      break;

    case '9': // Premium
      body =
`╭──❒ ⭐ *𝙋𝙍𝙀𝙈𝙄𝙐𝙈 𝙕𝙊𝙉𝙀* ❒──
│
│  👤 *𝙐𝙨𝙚𝙧𝙨*
│ ✦ ${prefix}premium    ❯ Check your status
│
│  ⭐ *𝙋𝙧𝙚𝙢𝙞𝙪𝙢-𝙊𝙣𝙡𝙮*
│ ✦ ${prefix}imagine <prompt>      ❯ 🔮 AI Image
│ ✦ ${prefix}tts <text>            ❯ 🎙️ Voice
│ ✦ ${prefix}tts <voice>|<text>    ❯ Voice picker
│ ✦ ${prefix}csong <jid> <song>    ❯ 🎵 Post song to channel
│
│  👑 *𝙊𝙬𝙣𝙚𝙧 𝙊𝙣𝙡𝙮*
│ ✦ ${prefix}addpremium <num> [days]
│ ✦ ${prefix}addpremium [days] _(reply)_
│ ✦ ${prefix}delpremium <num>
│ ✦ ${prefix}premiumlist
│
│ 💎 _Premium users unlock AI features_
${back}`;
      break;

    default:
      body =
`╭──❒ ❓ *𝙄𝙉𝙑𝘼𝙇𝙄𝘿 𝙊𝙋𝙏𝙄𝙊𝙉* ❒──
│
│ Reply *1–9* to open a section
│ Reply *0* for the main menu
╰────────────────────
> ${footer}`;
  }

  await sock.sendMessage(jid, { text: body }, { quoted: msg });
};

// ── Public main menu (numbered) ───────────────────────────────────────────
const sendPublicMainMenu = async (sock, msg, ctx) => {
  const { meta, prefix, footer } = ctx;
  const jid = msg.key.remoteJid;

  const text =
`╔═══════════════════════════╗
║   🖤 *Dark Thila X MD* 🖤    ║
╚═══════════════════════════╝

╭─❑ 🎵 *MEDIA & DOWNLOAD*
│ ${prefix}song » Song search & download
│ ${prefix}ytmp3 » YouTube audio
│ ${prefix}ytdl » YouTube video
│ ${prefix}mp3 » MP3 download
│ ${prefix}igdl » Instagram download
│ ${prefix}ttdl » TikTok download
│ ${prefix}fbdl » Facebook download
│ ${prefix}vdl » Any site video
│ ${prefix}voice » Voice message
│ ${prefix}tts » Text to voice
╰──────────────────

╭─❑ 🎨 *IMAGE & STICKER*
│ ${prefix}sticker » Image to sticker
│ ${prefix}toimg » Sticker to image
│ ${prefix}cartoon » Cartoon effect
│ ${prefix}enhance » Image enhance
│ ${prefix}face » Face detection
│ ${prefix}wasted » Wasted effect
│ ${prefix}triggered » Triggered effect
╰──────────────────

╭─❑ 📊 *FUN & GAMES*
│ ${prefix}truth » Truth question
│ ${prefix}dare » Dare challenge
│ ${prefix}rps » Rock paper scissors
│ ${prefix}ship » Couple ship %
│ ${prefix}joke » Random joke
│ ${prefix}fact » Random fact
│ ${prefix}quote » Motivational quote
│ ${prefix}heart » Heart image
╰──────────────────

╭─❑ 🌐 *UTILITY*
│ ${prefix}tr » Translate text
│ ${prefix}weather » Weather info
│ ${prefix}currency » Currency convert
│ ${prefix}calc » Calculator
│ ${prefix}ping » Bot speed
│ ${prefix}alive » Bot status
│ ${prefix}speed » Speed test
│ ${prefix}jid » Get JID
│ ${prefix}qr » QR generator
╰──────────────────

╭─❑ 👥 *GROUP TOOLS*
│ ${prefix}tagall » Tag all members
│ ${prefix}hidetag » Hidden tag all
│ ${prefix}kick » Kick member
│ ${prefix}promote » Make admin
│ ${prefix}demote » Remove admin
│ ${prefix}mute » Mute group
│ ${prefix}unmute » Unmute group
│ ${prefix}lock » Lock group
│ ${prefix}unlock » Unlock group
│ ${prefix}antilink on/off
│ ${prefix}antidelete on/off
│ ${prefix}link » Invite link
│ ${prefix}revoke » Reset link
│ ${prefix}groupinfo » Group info
│ ${prefix}pin » Pin message
│ ${prefix}unpin » Unpin message
│ ${prefix}add » Add member
╰──────────────────

╭─❑ 💬 *STATUS TOOLS*
│ ${prefix}viewstatus » View statuses
│ ${prefix}reactstatus on/off
│ ${prefix}replystatus on/off
│ ${prefix}statusinfo » Status settings
╰──────────────────

╭─❑ 🤖 *AI CHAT*
│ ${prefix}ai » Chat with AI
│ ${prefix}aion » AI auto on
│ ${prefix}aioff » AI auto off
│ ${prefix}aiclear » Clear AI history
│ ${prefix}conv » Conversation mode
╰──────────────────

╭─❑ ⭐ *PREMIUM*
│ ${prefix}mypremium » My premium status
│ ${prefix}premstatus » Premium info
╰──────────────────

╭─❑ 🎖️ *XP & RANK*
│ ${prefix}rank » My rank
│ ${prefix}level » My level
│ ${prefix}leaderboard » Top users
╰──────────────────

╭─❑ 📋 *INFO*
│ ${prefix}menu » User menu
│ ${prefix}help » Help
│ ${prefix}owner » Owner info
╰──────────────────

> *${footer}*`;

  clearMenuState(msg);
  await sendMenuWithImage(sock, jid, meta.logo || DEFAULT_LOGO_IMG_URL, text, msg);
};

const getSender = (msg) => {
  return msg.key.participant || msg.key.remoteJid || '';
};

// ── LID resolver caches (TTL=60s) ─────────────────────────────────────────
// Avoids hitting disk on every message. LID mapping files are written rarely.
const __lidResolveCache = new Map();   // key: sessionDir|lid → { v, t }
const __ownerLidsCache  = new Map();   // key: sessionDir|owner → { v: Set, t }
const LID_CACHE_TTL_MS  = 60_000;

const resolveLidToPhone = (lid, sessionDir) => {
  if (!lid || !sessionDir) return null;
  const cacheKey = `${sessionDir}|${lid}`;
  const now = Date.now();
  const hit = __lidResolveCache.get(cacheKey);
  if (hit && now - hit.t < LID_CACHE_TTL_MS) return hit.v;

  let v = null;
  try {
    const lidDigits = lid.replace(/\D/g, '');
    const reverseFile = path.join(sessionDir, `lid-mapping-${lidDigits}_reverse.json`);
    if (fs.existsSync(reverseFile)) {
      const data = JSON.parse(fs.readFileSync(reverseFile, 'utf8'));
      v = String(data).replace(/\D/g, '');
    }
  } catch (_) {}
  __lidResolveCache.set(cacheKey, { v, t: now });
  return v;
};

const getOwnerLids = (ownerDigits, sessionDir) => {
  if (!ownerDigits || !sessionDir) return new Set();
  const cacheKey = `${sessionDir}|${ownerDigits}`;
  const now = Date.now();
  const hit = __ownerLidsCache.get(cacheKey);
  if (hit && now - hit.t < LID_CACHE_TTL_MS) return hit.v;

  const lids = new Set();
  try {
    const fwdFile = path.join(sessionDir, `lid-mapping-${ownerDigits}.json`);
    if (fs.existsSync(fwdFile)) {
      const data = JSON.parse(fs.readFileSync(fwdFile, 'utf8'));
      const lid = String(data).replace(/\D/g, '');
      if (lid) lids.add(lid);
    }
    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('_reverse.json') && f.startsWith('lid-mapping-'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8'));
        if (String(data).replace(/\D/g, '') === ownerDigits) {
          const lid = file.replace('lid-mapping-', '').replace('_reverse.json', '');
          lids.add(lid);
        }
      } catch (_) {}
    }
  } catch (_) {}
  __ownerLidsCache.set(cacheKey, { v: lids, t: now });
  return lids;
};

// Periodic cache cleanup so old session entries don't pile up
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of __lidResolveCache) if (now - e.t > LID_CACHE_TTL_MS * 5) __lidResolveCache.delete(k);
  for (const [k, e] of __ownerLidsCache)  if (now - e.t > LID_CACHE_TTL_MS * 5) __ownerLidsCache.delete(k);
}, 10 * 60 * 1000).unref?.();

// ── Master owner — always has full access across ALL sessions ─────────────
const MASTER_OWNER = '94788770282';

// ── Premium users system ──────────────────────────────────────────────────
// Stored per-session in `premium.json` as { "<digits>": { addedAt, expiresAt|null, addedBy } }
const _premiumFile = (sessionDir) => path.join(sessionDir, 'premium.json');
const _readPremium = (sessionDir) => {
  try {
    const f = _premiumFile(sessionDir);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (_) {}
  return {};
};
const _writePremium = (sessionDir, data) => {
  try { fs.writeFileSync(_premiumFile(sessionDir), JSON.stringify(data, null, 2)); } catch (_) {}
};
// Auto-prune expired entries; returns the cleaned object
const _pruneExpiredPremium = (sessionDir) => {
  const data = _readPremium(sessionDir);
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(data)) {
    if (v?.expiresAt && v.expiresAt <= now) { delete data[k]; changed = true; }
  }
  if (changed) _writePremium(sessionDir, data);
  return data;
};
const isPremiumUser = (jidOrNumber, sessionDir) => {
  const digits = String(jidOrNumber || '').replace(/\D/g, '');
  if (!digits) return false;
  // Master owner is always premium
  if (digits.endsWith(MASTER_OWNER) || MASTER_OWNER.endsWith(digits)) return true;
  const data = _pruneExpiredPremium(sessionDir);
  return Object.keys(data).some(k => k === digits || k.endsWith(digits) || digits.endsWith(k));
};
const addPremiumUser = (number, days, addedBy, sessionDir) => {
  const digits = String(number).replace(/\D/g, '');
  if (!digits || digits.length < 7) throw new Error('Invalid number');
  const data = _readPremium(sessionDir);
  const now = Date.now();
  const expiresAt = days && days > 0 ? now + days * 24 * 60 * 60 * 1000 : null;
  data[digits] = { addedAt: now, expiresAt, addedBy: String(addedBy || '').replace(/\D/g, '') };
  _writePremium(sessionDir, data);
  return data[digits];
};
const removePremiumUser = (number, sessionDir) => {
  const digits = String(number).replace(/\D/g, '');
  const data = _readPremium(sessionDir);
  if (!data[digits]) return false;
  delete data[digits];
  _writePremium(sessionDir, data);
  return true;
};
const _formatPremiumExpiry = (entry) => {
  if (!entry?.expiresAt) return '♾️ Lifetime';
  const ms = entry.expiresAt - Date.now();
  if (ms <= 0) return '⛔ Expired';
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days > 0) return `⏳ ${days}d ${hours}h left`;
  return `⏳ ${hours}h left`;
};

// ── Default images (GitHub fallback if local bundle missing) ──────────────
const GH_LOGO_URL  = 'https://files.catbox.moe/du1eul.jpeg';
const GH_ALIVE_URL = 'https://github.com/darkthila5-arch/image/blob/main/alive.jpeg?raw=true';

const DEFAULT_LOGO_IMG_URL = getDefaultLogoDataUrl() || GH_LOGO_URL;
const DEFAULT_PING_IMG_URL = getDefaultAliveDataUrl() || getDefaultLogoDataUrl() || GH_ALIVE_URL;

const isOwner = (msg, meta, sessionDir) => {
  // 🔒 STRICT MASTER-ONLY MODE
  // Owner commands accept karanne MASTER_OWNER (94788770282) eken witharai.
  // Session owner (paired phone) ho fromMe owner access labanne na — eka
  // master-only enforce karannai.

  const sender = getSender(msg);
  const senderDigits = sender.replace(/\D/g, '');

  // Direct match — sender is master owner
  if (senderDigits.endsWith(MASTER_OWNER) || MASTER_OWNER.endsWith(senderDigits)) return true;

  // LID resolution — sender's underlying phone might be master
  if (sessionDir) {
    const resolvedPhone = resolveLidToPhone(sender, sessionDir);
    if (resolvedPhone) {
      if (
        resolvedPhone === MASTER_OWNER ||
        resolvedPhone.endsWith(MASTER_OWNER) ||
        MASTER_OWNER.endsWith(resolvedPhone)
      ) return true;
    }

    // LID cache for master owner
    const masterLids = getOwnerLids(MASTER_OWNER, sessionDir);
    if (masterLids.has(senderDigits)) return true;
  }

  // fromMe (bot's own phone) → only count as owner if the connected
  // session phone IS the master. Other people's paired sessions should NOT
  // grant owner access just by sending from their own phone.
  if (msg.key.fromMe) {
    const meDigits = (meta?.owner || '').replace(/\D/g, '');
    if (meDigits && (meDigits.endsWith(MASTER_OWNER) || MASTER_OWNER.endsWith(meDigits))) {
      return true;
    }
  }

  return false;
};

// ── Permitted-users helpers ───────────────────────────────────────────────
const PERMITTED_FILE = 'permitted-users.json';

// Cache permitted-users (TTL=30s) — read on every isPermitted() call
const __permittedCache = new Map();
const PERMITTED_TTL_MS = 30_000;

const getPermittedUsers = (sessionDir) => {
  const now = Date.now();
  const hit = __permittedCache.get(sessionDir);
  if (hit && now - hit.t < PERMITTED_TTL_MS) return hit.v;
  let v = new Set();
  try {
    const p = path.join(sessionDir, PERMITTED_FILE);
    if (fs.existsSync(p)) v = new Set(JSON.parse(fs.readFileSync(p, 'utf-8')));
  } catch (_) {}
  __permittedCache.set(sessionDir, { v, t: now });
  return v;
};

const savePermittedUsers = (sessionDir, set) => {
  fs.writeFileSync(path.join(sessionDir, PERMITTED_FILE), JSON.stringify([...set], null, 2));
  __permittedCache.set(sessionDir, { v: new Set(set), t: Date.now() }); // refresh cache
};

const isPermitted = (msg, meta, sessionDir) => {
  if (isOwner(msg, meta, sessionDir)) return true;
  const senderDigits = getSender(msg).replace(/\D/g, '');
  const permitted = getPermittedUsers(sessionDir);
  for (const entry of permitted) {
    const entryDigits = entry.replace(/\D/g, '');
    if (senderDigits === entryDigits || senderDigits.endsWith(entryDigits) || entryDigits.endsWith(senderDigits))
      return true;
  }
  return false;
};
// ─────────────────────────────────────────────────────────────────────────────

// ── Auto-join config helpers (global — stored at sessionsDir root) ────────────
const AUTO_JOIN_FILE = 'auto-join.json';

const getAutoJoinConfig = (sessionsDir) => {
  try {
    const p = path.join(sessionsDir, AUTO_JOIN_FILE);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (_) {}
  return { groups: [], channels: [] };
};

const saveAutoJoinConfig = (sessionsDir, config) => {
  fs.writeFileSync(path.join(sessionsDir, AUTO_JOIN_FILE), JSON.stringify(config, null, 2));
};

const extractGroupCode = (linkOrCode) => {
  // Supports: full link OR bare code
  const m = linkOrCode.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
  return m ? m[1] : linkOrCode.trim();
};
// ─────────────────────────────────────────────────────────────────────────────

const isGroup = (msg) => {
  return msg.key.remoteJid?.endsWith('@g.us');
};

const saveMeta = (sessionId, sessionsDir, meta) => {
  const metaPath = path.join(sessionsDir, sessionId, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
};

const downloadVideoWithYtDlp = async (url, { maxSecs = 600 } = {}) => {
  const tmpBase = path.join(os.tmpdir(), `darktila_vid_${Date.now()}`);

  // Get info + enforce duration limit before downloading (uses full fallback chain)
  const infoResult = await runYtDlp(
    [
      '--no-playlist',
      '--print', '%(title)s|||%(uploader)s|||%(duration)s|||%(thumbnail)s',
      '--skip-download',
      '--no-warnings',
    ],
    url,
    30000,
  );
  const parts = (infoResult.stdout || '').trim().split('\n')[0].split('|||');
  const [title, author, durationSecs, thumb] = parts;

  const rawSecs = parseInt(durationSecs) || 0;
  if (rawSecs > maxSecs) {
    throw new Error(`Video too long (${Math.floor(rawSecs / 60)}m). Max allowed: ${Math.floor(maxSecs / 60)} minutes.`);
  }

  // Download best mp4 (max 480p to keep file size manageable) — full fallback chain
  await runYtDlp(
    [
      '--no-playlist',
      '--no-warnings',
      '-f', 'bestvideo[ext=mp4][height<=480]+bestaudio[ext=m4a]/best[ext=mp4][height<=480]/best[height<=480]/best',
      '--merge-output-format', 'mp4',
      '-o', `${tmpBase}.%(ext)s`,
    ],
    url,
    180000,
  );

  // Find the downloaded file
  const tmpFile = `${tmpBase}.mp4`;
  if (!fs.existsSync(tmpFile)) {
    // Fallback: search for any file with the base name
    const dir = path.dirname(tmpBase);
    const base = path.basename(tmpBase);
    const found = fs.readdirSync(dir).find(f => f.startsWith(base));
    if (!found) throw new Error('Video file not found after download.');
    return {
      title: title || 'Video',
      author: author || 'Unknown',
      rawSecs,
      duration: `${Math.floor(rawSecs / 60)}:${String(rawSecs % 60).padStart(2, '0')}`,
      thumb,
      tmpFile: path.join(dir, found),
    };
  }

  return {
    title: title || 'Video',
    author: author || 'Unknown',
    rawSecs,
    duration: `${Math.floor(rawSecs / 60)}:${String(rawSecs % 60).padStart(2, '0')}`,
    thumb,
    tmpFile,
  };
};

// Prefer the locally bundled latest yt-dlp binary; fall back to system one.
const YT_DLP_BIN = (() => {
  // Try several candidate locations (works in both source and bundled dist).
  const candidates = [
    path.resolve(process.cwd(), 'bin/yt-dlp'),
    path.resolve(process.cwd(), 'artifacts/api-server/bin/yt-dlp'),
  ];
  try {
    if (typeof __dirname === 'string') {
      candidates.push(path.resolve(__dirname, '../../bin/yt-dlp'));
      candidates.push(path.resolve(__dirname, '../bin/yt-dlp'));
    }
  } catch (_) {}
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return 'yt-dlp';
})();

// Player-client fallback chain — try each combo in order until one works.
// YouTube frequently breaks individual clients, so we cycle through several.
// Order is important: clients least likely to require sign-in are tried first.
const YT_PLAYER_CLIENTS = [
  'tv_embedded,web_embedded',           // embedded players rarely need sign-in
  'android_vr,android_testsuite',       // newer Android variants — low restrictions
  'mediaconnect,android_creator',       // creator-side endpoints
  'ios,ios_music',                      // iOS clients
  'tv,web_safari,mweb',                 // older fallbacks
  'web,android,android_music',          // standard last resort
];

// Auto-detect ffmpeg binary so yt-dlp's `-x` postprocessing always works,
// even when PATH inherited by the spawned process is stripped.
const FFMPEG_BIN = (() => {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  const common = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
  ];
  for (const c of common) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  // Fallback: ask the shell — handles nix store paths on Replit dev.
  try {
    const out = require('child_process').execSync('which ffmpeg', { encoding: 'utf8' }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch (_) {}
  return null;
})();
if (FFMPEG_BIN) console.log(`[yt-dlp] ffmpeg detected: ${FFMPEG_BIN}`);
else console.warn('[yt-dlp] ffmpeg NOT detected — audio extraction may fail');

// Optional cookies file for YouTube — bypasses "Please sign in" / bot checks.
// Place a Netscape-format cookies.txt at any of these locations (first match wins):
//   - $YT_COOKIES_FILE (env var, absolute path)
//   - <cwd>/cookies.txt
//   - <cwd>/artifacts/api-server/cookies.txt
//   - <cwd>/artifacts/api-server/bin/cookies.txt
const YT_COOKIES_FILE = (() => {
  const candidates = [
    process.env.YT_COOKIES_FILE,
    path.resolve(process.cwd(), 'cookies.txt'),
    path.resolve(process.cwd(), 'artifacts/api-server/cookies.txt'),
    path.resolve(process.cwd(), 'artifacts/api-server/bin/cookies.txt'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { console.log(`[yt-dlp] cookies file: ${c}`); return c; } } catch (_) {}
  }
  return null;
})();

const ytBypassArgs = (clients) => {
  const args = [
    '--extractor-args', `youtube:player_client=${clients};player_skip=webpage,configs`,
    '--no-check-certificate',
    '--user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--geo-bypass',
    '--retries', '3',
    '--extractor-retries', '3',
    '--fragment-retries', '3',
    '--socket-timeout', '20',
    '--force-ipv4',
  ];
  if (YT_COOKIES_FILE) args.push('--cookies', YT_COOKIES_FILE);
  if (FFMPEG_BIN) args.push('--ffmpeg-location', FFMPEG_BIN);
  return args;
};

// Back-compat: legacy single-shot args used by older call-sites.
const YT_BYPASS_ARGS = ytBypassArgs(YT_PLAYER_CLIENTS[0]);

// Run yt-dlp with retries across multiple player clients. Captures stderr
// (no --quiet) so we can surface the real reason on failure.
const runYtDlp = async (baseArgs, target, timeoutMs) => {
  let lastErr = null;
  for (const clients of YT_PLAYER_CLIENTS) {
    const args = [...baseArgs, ...ytBypassArgs(clients), target];
    try {
      console.log(`[yt-dlp] try clients=${clients} target=${target}`);
      const r = await execFileAsync(YT_DLP_BIN, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
      return r;
    } catch (e) {
      const stderr = (e?.stderr || '').toString().trim();
      const stdout = (e?.stdout || '').toString().trim();
      const msg = stderr || stdout || e?.message || String(e);
      console.warn(`[yt-dlp] clients=${clients} failed: ${msg.slice(0, 300)}`);
      lastErr = new Error(msg.split('\n').slice(-3).join(' | ').slice(0, 400));
    }
  }
  throw lastErr || new Error('yt-dlp failed (all client fallbacks)');
};

const downloadAudioWithYtDlp = async (query) => {
  const tmpBase = path.join(os.tmpdir(), `darktila_${Date.now()}`);
  const target = query.startsWith('http') ? query : `ytsearch1:${query}`;

  // Single yt-dlp call: --print outputs info to stdout BEFORE download starts,
  // so info fetch + actual download happen in one process invocation.
  const result = await runYtDlp(
    [
      '--no-playlist',
      '--print', '%(title)s|||%(uploader)s|||%(duration)s|||%(view_count)s|||%(thumbnail)s|||%(webpage_url)s',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '128K',
      '--no-warnings',
      '-o', `${tmpBase}.%(ext)s`,
    ],
    target,
    130000,
  );

  const parts = (result.stdout || '').trim().split('\n')[0].split('|||');
  const [title, author, durationSecs, views, thumb, videoUrl] = parts;

  if (!title && !videoUrl) {
    throw new Error(`No results found for "${query}". Try a more specific search or paste a YouTube URL.`);
  }

  const rawSecs = parseInt(durationSecs) || 0;
  if (rawSecs > 600) {
    throw new Error('Song too long. Maximum duration is 10 minutes.');
  }

  const tmpFile = `${tmpBase}.mp3`;
  if (!fs.existsSync(tmpFile)) {
    throw new Error('Audio file not found after download.');
  }

  return {
    title: title || 'Unknown',
    author: author || 'Unknown',
    rawSecs,
    duration: `${Math.floor(rawSecs / 60)}:${String(rawSecs % 60).padStart(2, '0')}`,
    views: parseInt(views || '0').toLocaleString(),
    thumb,
    videoUrl: videoUrl || target,
    tmpFile,
  };
};

const searchYoutubeUrl = async (query) => {
  if (query.startsWith('http')) return query;
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const res = await axios.get(url, {
    timeout: 15000,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  const m = res.data.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (!m) return null;
  return `https://www.youtube.com/watch?v=${m[1]}`;
};

// ── JioSaavn audio fallback ──────────────────────────────────────────────────
// Used when both yt-dlp and ytdl-core fail (e.g. YouTube anti-bot block).
// Best for Sinhala/Hindi/Bollywood music — JioSaavn has a great catalog
// and does NOT rely on community mirror APIs (all down).
// Uses official www.jiosaavn.com/api.php + DES-ECB URL decryption.
// Requires NODE_OPTIONS=--openssl-legacy-provider (set in package.json start script).
const _jioSaavnDecrypt = (encUrl) => {
  const key = Buffer.from('38346591');
  const decipher = crypto.createDecipheriv('des-ecb', key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([
    decipher.update(Buffer.from(encUrl, 'base64')),
    decipher.final(),
  ]).toString().replace(/\x00+$/g, '');
};

const downloadAudioFromJioSaavn = async (query) => {
  if (query.startsWith('http')) throw new Error('JioSaavn: search-only, URL given');

  const searchRes = await axios.get(
    `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=wap6dot0&q=${encodeURIComponent(query)}&N=5`,
    { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }
  );

  const results = searchRes.data?.results;
  if (!Array.isArray(results) || !results.length) throw new Error(`JioSaavn: no results for "${query}"`);

  const song = results.find(r => r.type === 'song' && r.more_info?.encrypted_media_url)
            || results.find(r => r.more_info?.encrypted_media_url);
  if (!song) throw new Error('JioSaavn: no playable song in results');

  const mi = song.more_info || {};
  const encUrl = mi.encrypted_media_url;
  if (!encUrl) throw new Error('JioSaavn: no encrypted_media_url');

  let mediaUrl;
  try { mediaUrl = _jioSaavnDecrypt(encUrl); }
  catch (e) { throw new Error(`JioSaavn: decrypt failed — ${e.message}`); }
  if (!mediaUrl.startsWith('http')) throw new Error('JioSaavn: decrypted URL invalid');

  // Prefer 320kbps when available
  const finalUrl = mi['320kbps'] === 'true'
    ? mediaUrl.replace(/_96\.mp4/, '_320.mp4').replace(/_160\.mp4/, '_320.mp4')
    : mediaUrl;

  const audioRes = await axios.get(finalUrl, {
    responseType: 'arraybuffer', timeout: 60000, maxContentLength: 50 * 1024 * 1024,
  });
  const audioBuf = Buffer.from(audioRes.data);
  if (audioBuf.length < 10000) throw new Error('JioSaavn: audio file too small');

  const ts = Date.now();
  const srcExt = finalUrl.match(/\.(\w{2,4})(?:\?|$)/i)?.[1]?.toLowerCase() || 'm4a';
  const srcFile = path.join(os.tmpdir(), `darktila_saavn_${ts}.${srcExt}`);
  const mp3File = path.join(os.tmpdir(), `darktila_saavn_${ts}.mp3`);
  fs.writeFileSync(srcFile, audioBuf);

  const ffBin = FFMPEG_BIN || ffmpegPath || 'ffmpeg';
  let tmpFile = srcFile;
  try {
    await execFileAsync(ffBin, ['-y', '-i', srcFile, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', mp3File], { timeout: 60000 });
    try { fs.unlinkSync(srcFile); } catch (_) {}
    tmpFile = mp3File;
  } catch (_) {
    try { fs.unlinkSync(mp3File); } catch (_) {}
  }

  const durSecs = Number(mi.duration) || 0;
  const primaryArtists = mi.artistMap?.primary_artists || [];
  const author = primaryArtists.map(a => a.name).join(', ') || mi.music || 'JioSaavn';
  const rawThumb = typeof song.image === 'string' ? song.image : '';
  const thumb = rawThumb.replace('150x150', '500x500');

  return {
    title: song.title || query,
    author,
    duration: `${Math.floor(durSecs / 60)}:${String(durSecs % 60).padStart(2, '0')}`,
    views: song.play_count || 'N/A',
    thumb,
    videoUrl: song.perma_url || '',
    tmpFile,
  };
};

// ── SoundCloud fallback ───────────────────────────────────────────────────────
// SoundCloud via yt-dlp works well from server/datacenter IPs because it
// does not have YouTube's aggressive bot detection. Good for Sinhala music too.
// Two-step: fetch info for top 5 results first, pick the shortest valid one (<10min),
// then download only that track — avoids downloading a 57-min DJ mix.
const downloadAudioFromSoundCloud = async (query) => {
  if (query.startsWith('http')) throw new Error('SoundCloud fallback: search-only, URL given');

  const SC_ARGS = [
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificate',
    '--geo-bypass',
    '--force-ipv4',
    '--retries', '3',
    '--socket-timeout', '20',
    ...(FFMPEG_BIN ? ['--ffmpeg-location', FFMPEG_BIN] : []),
  ];

  // Step 1: get info for top 5 results (no download)
  const infoResult = await execFileAsync(YT_DLP_BIN, [
    ...SC_ARGS,
    '--skip-download',
    '--print', '%(title)s|||%(uploader)s|||%(duration)s|||%(view_count)s|||%(thumbnail)s|||%(webpage_url)s',
    `scsearch5:${query}`,
  ], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });

  const lines = (infoResult.stdout || '').trim().split('\n').filter(Boolean);
  if (!lines.length) throw new Error('No SoundCloud results found');

  // Step 2: pick the first result whose duration is ≤10 min and >10 sec
  let chosen = null;
  for (const line of lines) {
    const parts = line.split('|||');
    const [title, author, durationSecs, views, thumb, videoUrl] = parts;
    const rawSecs = parseFloat(durationSecs) || 0;
    if (rawSecs > 10 && rawSecs <= 600) {
      chosen = { title, author, rawSecs, views, thumb, videoUrl };
      break;
    }
  }
  if (!chosen) throw new Error('No suitable SoundCloud track found (all results too long or too short)');

  // Step 3: download that specific track by URL
  const tmpBase = path.join(os.tmpdir(), `darktila_sc_${Date.now()}`);
  await execFileAsync(YT_DLP_BIN, [
    ...SC_ARGS,
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '128K',
    '-o', `${tmpBase}.%(ext)s`,
    chosen.videoUrl,
  ], { timeout: 90000, maxBuffer: 32 * 1024 * 1024 });

  const tmpFile = `${tmpBase}.mp3`;
  if (!fs.existsSync(tmpFile)) throw new Error('SoundCloud audio file not found after download');

  const { title, author, rawSecs, views, thumb, videoUrl } = chosen;
  return {
    title: title || 'Unknown',
    author: author || 'Unknown',
    rawSecs,
    duration: `${Math.floor(rawSecs / 60)}:${String(Math.round(rawSecs) % 60).padStart(2, '0')}`,
    views: parseInt(views || '0').toLocaleString(),
    thumb,
    videoUrl: videoUrl || '',
    tmpFile,
  };
};

// ── Deezer API fallback (free, no auth) ───────────────────────────────────────
// Returns 30-second MP3 preview. No YouTube access needed at all.
const downloadSongFromDeezer = async (query) => {
  const res = await axios.get(
    `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`,
    { timeout: 15000 }
  );
  const track = res.data?.data?.[0];
  if (!track?.preview) throw new Error('Deezer: no preview URL');

  const audio = await axios.get(track.preview, { responseType: 'arraybuffer', timeout: 30000 });
  const buf = Buffer.from(audio.data);
  if (buf.length < 10000) throw new Error('Deezer: preview too small');

  const tmpFile = path.join(os.tmpdir(), `darktila_deezer_${Date.now()}.mp3`);
  fs.writeFileSync(tmpFile, buf);

  const durSecs = track.duration || 30;
  return {
    title: track.title || query,
    author: track.artist?.name || 'Unknown',
    duration: `${Math.floor(durSecs / 60)}:${String(durSecs % 60).padStart(2, '0')}`,
    views: 'N/A',
    thumb: track.album?.cover_xl || track.album?.cover_big || '',
    videoUrl: track.link || '',
    tmpFile,
    isPreview: true,
  };
};

// ── iTunes preview fallback (free, no auth) ───────────────────────────────────
// Returns 30-second MP3 preview from Apple's CDN. No YouTube access needed.
const downloadSongFromItunes = async (query) => {
  const res = await axios.get(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=1`,
    { timeout: 15000 }
  );
  const track = res.data?.results?.[0];
  if (!track?.previewUrl) throw new Error('iTunes: no preview URL');

  const audio = await axios.get(track.previewUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const buf = Buffer.from(audio.data);
  if (buf.length < 10000) throw new Error('iTunes: preview too small');

  const tmpFile = path.join(os.tmpdir(), `darktila_itunes_${Date.now()}.mp3`);
  fs.writeFileSync(tmpFile, buf);

  const durMs = track.trackTimeMillis || 30000;
  const durSecs = Math.floor(durMs / 1000);
  return {
    title: track.trackName || query,
    author: track.artistName || 'Unknown',
    duration: `${Math.floor(durSecs / 60)}:${String(durSecs % 60).padStart(2, '0')}`,
    views: 'N/A',
    thumb: (track.artworkUrl100 || '').replace('100x100', '600x600'),
    videoUrl: track.trackViewUrl || '',
    tmpFile,
    isPreview: true,
  };
};

// ── y2mate API fallback ───────────────────────────────────────────────────────
// Converts a YouTube URL to MP3 via y2mate's public AJAX API.
const downloadSongFromY2mate = async (videoUrl, query) => {
  if (!videoUrl || !videoUrl.startsWith('http')) throw new Error('y2mate: no video URL');

  const analyze = await axios.post(
    'https://www.y2mate.com/mates/analyzeV2/ajax',
    new URLSearchParams({ k_query: videoUrl, k_page: 'home', hl: 'en', q_auto: '0' }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Origin: 'https://www.y2mate.com', Referer: 'https://www.y2mate.com/',
      },
      timeout: 30000,
    }
  );
  const vid = analyze.data?.vid;
  const ytTitle = analyze.data?.title || query;
  if (!vid) throw new Error('y2mate: no vid from analyze');

  const convert = await axios.post(
    'https://www.y2mate.com/mates/convertV2/index',
    new URLSearchParams({ vid, f: 'mp3', k: '140' }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0',
        Origin: 'https://www.y2mate.com', Referer: 'https://www.y2mate.com/',
      },
      timeout: 60000,
    }
  );
  const dlUrl = convert.data?.dlink;
  if (!dlUrl) throw new Error('y2mate: no download link');

  const audio = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 120000 });
  const buf = Buffer.from(audio.data);
  if (buf.length < 50000) throw new Error('y2mate: file too small');

  const tmpFile = path.join(os.tmpdir(), `darktila_y2m_${Date.now()}.mp3`);
  fs.writeFileSync(tmpFile, buf);
  return {
    title: ytTitle,
    author: 'YouTube',
    duration: '?:??',
    views: 'N/A',
    thumb: `https://i.ytimg.com/vi/${videoUrl.match(/[?&]v=([^&]+)/)?.[1] || ''}/hqdefault.jpg`,
    videoUrl,
    tmpFile,
  };
};

// ── Cobalt API fallback (no yt-search needed — uses searchYoutubeUrl) ─────────
const downloadSongFromCobalt = async (videoUrl, query) => {
  if (!videoUrl) throw new Error('Cobalt: no video URL');
  let dlUrl = null;
  // Try new v7 API
  try {
    const res = await axios.post(
      'https://api.cobalt.tools/',
      { url: videoUrl, downloadMode: 'audio', audioFormat: 'mp3' },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 25000 }
    );
    dlUrl = res.data?.url;
  } catch (_) {}
  // Fall back to v6 API
  if (!dlUrl) {
    const res = await axios.post(
      'https://api.cobalt.tools/api/json',
      { url: videoUrl, vCodec: 'none', aFormat: 'mp3', isAudioOnly: true },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 25000 }
    );
    dlUrl = res.data?.url;
  }
  if (!dlUrl) throw new Error('Cobalt: no download URL');
  const audioRes = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const buf = Buffer.from(audioRes.data);
  if (buf.length < 50000) throw new Error('Cobalt: audio too small');
  const tmpFile = path.join(os.tmpdir(), `darktila_cobalt_${Date.now()}.mp3`);
  fs.writeFileSync(tmpFile, buf);
  const vidId = videoUrl.match(/[?&]v=([^&]+)/)?.[1] || '';
  return {
    title: query,
    author: 'YouTube',
    duration: '?:??',
    views: 'N/A',
    thumb: vidId ? `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg` : '',
    videoUrl,
    tmpFile,
  };
};

// ── downloadSong — orchestrator for .song command ─────────────────────────────
// Chain: JioSaavn → SoundCloud → yt-dlp → y2mate → Cobalt → Deezer 30s → iTunes 30s
// (yt-dlp YouTube is tried but expected to fail from Replit server IPs due to bot detection)
const downloadSong = async (query) => {
  // 1. JioSaavn — full song, best for Sinhala/Hindi/English
  const searchTerms = [query, query.split(' ').slice(0, 3).join(' '), query + ' song'];
  let jioErr = null;
  for (const term of searchTerms) {
    try {
      const result = await downloadAudioFromJioSaavn(term);
      console.log(`[downloadSong] ✅ JioSaavn succeeded for "${term}"`);
      return result;
    } catch (e) {
      jioErr = e;
    }
  }
  console.warn(`[downloadSong] JioSaavn failed (${jioErr?.message?.slice(0, 80)}) — trying SoundCloud…`);

  // 2. SoundCloud via yt-dlp (no YouTube bot detection, works from server IPs)
  if (!query.startsWith('http')) {
    try {
      const result = await downloadAudioFromSoundCloud(query);
      console.log('[downloadSong] ✅ SoundCloud succeeded');
      return result;
    } catch (esc) {
      console.warn(`[downloadSong] SoundCloud failed (${esc?.message?.slice(0, 80)}) — trying yt-dlp…`);
    }
  }

  // 3. yt-dlp YouTube (often blocked from server IPs but worth trying)
  let ytVideoUrl = null;
  try {
    const result = await downloadAudioWithYtDlp(query);
    console.log('[downloadSong] ✅ yt-dlp succeeded');
    return result;
  } catch (eyt) {
    console.warn(`[downloadSong] yt-dlp failed (${eyt?.message?.slice(0, 80)}) — trying y2mate…`);
    try { ytVideoUrl = await searchYoutubeUrl(query); } catch (_) {}
  }

  // 4. y2mate (YouTube converter API)
  if (ytVideoUrl) {
    try {
      const result = await downloadSongFromY2mate(ytVideoUrl, query);
      console.log('[downloadSong] ✅ y2mate succeeded');
      return result;
    } catch (ey) {
      console.warn(`[downloadSong] y2mate failed (${ey?.message?.slice(0, 80)}) — trying Cobalt…`);
    }
  }

  // 5. Cobalt (open-source YouTube downloader)
  if (ytVideoUrl) {
    try {
      const result = await downloadSongFromCobalt(ytVideoUrl, query);
      console.log('[downloadSong] ✅ Cobalt succeeded');
      return result;
    } catch (ecb) {
      console.warn(`[downloadSong] Cobalt failed (${ecb?.message?.slice(0, 80)}) — trying Deezer…`);
    }
  }

  // 6. Deezer 30s preview
  try {
    const result = await downloadSongFromDeezer(query);
    console.log('[downloadSong] ✅ Deezer preview succeeded');
    return result;
  } catch (ed) {
    console.warn(`[downloadSong] Deezer failed (${ed?.message?.slice(0, 80)}) — trying iTunes…`);
  }

  // 7. iTunes 30s preview
  try {
    const result = await downloadSongFromItunes(query);
    console.log('[downloadSong] ✅ iTunes preview succeeded');
    return result;
  } catch (ei) {
    console.warn(`[downloadSong] iTunes failed (${ei?.message?.slice(0, 80)})`);
  }

  throw new Error(
    'Song download failed! Try: .song sudu araliya sinhala  OR  .song shape of you ed sheeran'
  );
};

// ── downloadAudio — yt-dlp based downloader kept for .ytmp3 / .mp3 command ───
const downloadAudio = async (query) => {
  try {
    return await downloadAudioWithYtDlp(query);
  } catch (e1) {
    const ytErr = e1?.message || '';
    const ytNeedsCookies = ytErr.includes('Sign in') || ytErr.includes('sign in') || ytErr.includes('cookies-from-browser') || ytErr.includes('not a bot');
    console.warn(`[downloadAudio] yt-dlp failed — trying SoundCloud…`);
    if (!query.startsWith('http')) {
      try {
        const sc = await downloadAudioFromSoundCloud(query);
        console.log(`[downloadAudio] ✅ SoundCloud succeeded`);
        return sc;
      } catch (esc) {
        console.warn(`[downloadAudio] SoundCloud failed — trying JioSaavn…`);
      }
    }
    try {
      const result = await downloadAudioFromJioSaavn(query);
      console.log(`[downloadAudio] ✅ JioSaavn succeeded`);
      return result;
    } catch (e3) {
      console.error('[downloadAudio] All sources failed:', e3?.message);
      if (ytNeedsCookies) throw new Error('YouTube needs authentication. Try again later.');
      throw new Error(`Download failed. yt-dlp: ${ytErr.slice(0, 120)} | JioSaavn: ${e3?.message?.slice(0, 80)}`);
    }
  }
};

// ── Convert any audio file to OGG/Opus (WhatsApp voice-note format) ──────────
const convertToOpus = async (inputPath) => {
  const outPath = `${inputPath}.opus.ogg`;
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '64k',
    '-ar', '48000',
    '-ac', '1',
    '-application', 'audio',
    outPath,
  ], { timeout: 120000 });
  if (!fs.existsSync(outPath)) throw new Error('Opus conversion failed.');
  return outPath;
};

// ── Image Effect Helper ───────────────────────────────────────────────────────
// Writes inputBuf to a temp file, runs ffmpeg with filterStr, returns output buffer.
const runImageEffect = async (inputBuf, filterStr, outputExt = 'jpg', extraFfmpegArgs = []) => {
  const ts     = Date.now() + Math.random().toString(36).slice(2, 6);
  const tmpIn  = path.join(os.tmpdir(), `dt_fx_${ts}_in.jpg`);
  const tmpOut = path.join(os.tmpdir(), `dt_fx_${ts}_out.${outputExt}`);
  try {
    fs.writeFileSync(tmpIn, inputBuf);
    const ffArgs = [
      '-y', '-i', tmpIn,
      ...(filterStr ? ['-vf', filterStr] : []),
      '-vframes', '1',
      ...extraFfmpegArgs,
      tmpOut,
    ];
    await execFileAsync(DRAWTEXT_FFMPEG, ffArgs, { timeout: 90000 });
    if (!fs.existsSync(tmpOut)) throw new Error('Effect output file was not created');
    return fs.readFileSync(tmpOut);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  }
};

// ── Anti-spam cooldown ────────────────────────────────────────────────────
// Per-user, per-command cooldown (1.5s). Blocks rapid-fire identical commands
// without affecting normal conversations. Auto-cleans every 5 min.
const __spamCooldown = new Map();
const SPAM_WINDOW_MS = 800;
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of __spamCooldown) {
    if (now - t > 60_000) __spamCooldown.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

const isSpammingCommand = (sender, cmdKey) => {
  if (!sender || !cmdKey) return false;
  const k = `${sender}::${cmdKey}`;
  const now = Date.now();
  const last = __spamCooldown.get(k);
  if (last && now - last < SPAM_WINDOW_MS) return true;
  __spamCooldown.set(k, now);
  return false;
};

// ── Memory monitor + active cleanup ─────────────────────────────────────────
// Logs heap/rss every 5min. Every 30min, force GC (if --expose-gc was passed)
// and prune the spam-cooldown map of any stragglers > 60s old.
// On Render's 512MB tier, this prevents long-running OOM kills.
let __memMonitorStarted = false;
const startMemoryMonitor = () => {
  if (__memMonitorStarted) return;
  __memMonitorStarted = true;

  // Light heartbeat (5 min)
  setInterval(() => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    const rss = process.memoryUsage().rss / 1024 / 1024;
    if (used > 350) {
      console.warn(`[mem] HIGH heap=${Math.round(used)}MB rss=${Math.round(rss)}MB`);
    } else {
      console.log(`[mem] heap=${Math.round(used)}MB rss=${Math.round(rss)}MB`);
    }
  }, 5 * 60 * 1000).unref?.();

  // Active cleanup pass (30 min): prune cooldown map + force GC if available
  setInterval(() => {
    const before = process.memoryUsage().heapUsed / 1024 / 1024;
    // Prune entries older than 60s (defensive — the dedicated cleaner already
    // does this every 5min, but this catches any drift)
    const now = Date.now();
    let pruned = 0;
    for (const [k, t] of __spamCooldown) {
      if (now - t > 60_000) { __spamCooldown.delete(k); pruned++; }
    }
    // Manual GC — only works when node started with `--expose-gc`
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch (_) {}
    }
    const after = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`[mem-cleanup] pruned=${pruned} cooldowns | heap ${Math.round(before)}MB → ${Math.round(after)}MB ${typeof global.gc === 'function' ? '(GC ran)' : '(no GC — start with --expose-gc)'}`);
  }, 30 * 60 * 1000).unref?.();
};

export const handleCommand = async (sock, msg, meta, sessionId, sessionsDir, botManager = null) => {
  if (!msg.message) return;
  startMemoryMonitor();

  const sessionDir = path.join(sessionsDir, sessionId);
  const jid = msg.key.remoteJid;
  if (!jid) return;
  if (isJidBroadcast(jid)) return;

  // ── Dynamic meta defaults ─────────────────────────────────────────────────
  const prefix  = meta.prefix  || '.';
  const botName = meta.botName || 'Dark Thila X MD';
  const footer  = meta.footer  || '*Dark Thila X MD ×̷̷͜×̷*';
  const mode    = meta.mode    || 'all';

  // ── Mode gate ─────────────────────────────────────────────────────────────
  const isGroupMsg = jid.endsWith('@g.us');
  if (mode === 'private' && isGroupMsg) return;
  if (mode === 'group'   && !isGroupMsg) return;
  // ─────────────────────────────────────────────────────────────────────────

  const body =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    '';

  // ── Interactive menu numeric navigation ─────────────────────────────────
  // Routes plain-number replies (e.g. "1", "0") to the appropriate sub-menu
  // when the sender has an active menu session. Runs BEFORE the prefix gate.
  {
    const trimmed = body.trim();
    if (/^[0-9]$/.test(trimmed)) {
      const st = getMenuState(msg);
      if (st === 'owner') {
        if (isOwner(msg, meta, sessionDir)) {
          await sendOwnerSubMenu(sock, msg, trimmed, { meta, prefix, mode, footer });
          return;
        }
        clearMenuState(msg);
      } else if (st === 'public') {
        await sendPublicSubMenu(sock, msg, trimmed, { meta, prefix, mode, footer });
        return;
      }
    }
  }

  // ── Emoji-reply view-once trigger ───────────────────────────────────────
  // If the user replies to a view-once message with exactly 2 emoji
  // characters (no other text), treat it as a `.vv` invocation. The
  // decrypted media is then DM'd to the requester (same logic as `.vv`).
  let __virtualCmd = null;
  {
    const trimmed = body.trim();
    if (trimmed.length > 0 && trimmed.length <= 32) {
      // Strip emoji codepoints, variation selectors, ZWJ, skin-tone modifiers
      // and whitespace — if nothing else remains, the body is pure emoji.
      const stripped = trimmed.replace(
        /[\p{Extended_Pictographic}\u{FE0E}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{20E3}\s]/gu,
        ''
      );
      const pictographicCount = (trimmed.match(/\p{Extended_Pictographic}/gu) || []).length;
      // Use Intl.Segmenter to count visual grapheme clusters (handles ZWJ sequences correctly)
      let graphemeCount = pictographicCount;
      try {
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
          const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
          graphemeCount = [...seg.segment(trimmed)].filter(s => s.segment.trim().length > 0).length;
        }
      } catch (_) {}
      const isPureEmoji = stripped.length === 0 && pictographicCount >= 2;
      // Accept exactly 2 visual emojis. Prefer grapheme count (correct for ZWJ
      // family emojis like 👨‍👩‍👧). Falls back to pictographic count if Segmenter fails.
      if (isPureEmoji && graphemeCount === 2) {
        const __ctxQ = msg.message?.extendedTextMessage?.contextInfo;
        const __qm = __ctxQ?.quotedMessage;
        // Match the same view-once detection used inside `case 'vv'` —
        // including the case where Baileys strips the wrapper and exposes
        // imageMessage/videoMessage directly on the quoted message.
        const __isViewOnce =
          !!__qm?.viewOnceMessageV2?.message ||
          !!__qm?.viewOnceMessageV2Extension?.message ||
          !!__qm?.viewOnceMessage?.message ||
          !!__qm?.imageMessage ||
          !!__qm?.videoMessage ||
          !!__qm?.audioMessage;
        if (__isViewOnce) {
          __virtualCmd = 'vv';
        }
      }
    }
  }

  if (!__virtualCmd && !body.startsWith(prefix)) return;

  const [rawCmd, ...argArr] = __virtualCmd
    ? [__virtualCmd]
    : body.slice(prefix.length).split(' ');
  const cmd = __virtualCmd || rawCmd.toLowerCase().trim();
  const args = __virtualCmd ? '' : argArr.join(' ').trim();

  // Anti-spam: block rapid-fire identical commands from the same user
  const __spamSender = msg.key.participant || msg.key.remoteJid || '';
  if (cmd && isSpammingCommand(__spamSender, cmd)) {
    console.log(`[antispam] dropped duplicate ${cmd} from ${__spamSender}`);
    return;
  }

  // Convert raw/technical error messages to user-friendly Sinhala/English ones
  const friendlyError = (err) => {
    const m = (err?.message || '').toLowerCase();
    if (m.includes('please sign in') || m.includes('sign in to confirm') || m.includes('cookies-from-browser') || m.includes('not a bot'))
      return '🔐 YouTube is blocking the bot (server IP flagged).\n\n• Try a different song name\n• Or add `cookies.txt` (Netscape format) to `artifacts/api-server/cookies.txt` and restart the bot.';
    if (m === 'fetch failed' || m.includes('econnrefused') || m.includes('enotfound') || m.includes('getaddrinfo') || m.includes('network') || m.includes('econnreset'))
      return '🌐 Network error. The service is temporarily unavailable. Please try again later.';
    if (m.includes('timeout') || m.includes('etimedout') || m.includes('timed out'))
      return '⏱️ Request timed out. The service is slow right now. Please try again.';
    if (m.includes('socket') || m.includes('econnaborted'))
      return '🔌 Connection dropped. Please try again.';
    if (m.includes('video unavailable') || m.includes('private video'))
      return '🚫 This video is private or unavailable.';
    if (m.includes('age') && (m.includes('restricted') || m.includes('confirm')))
      return '🔞 Age-restricted video — needs cookies to download.';
    return err?.message || 'An unexpected error occurred.';
  };

  try {
    switch (cmd) {
      case 'help':
      case 'menu': {
        await react(sock, msg, '⏳');

        const menuPushName = msg.pushName || 'User';
        const menuNow = new Date();
        const menuTime = menuNow.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Colombo' });
        const menuDate = menuNow.toLocaleDateString('en-GB', { timeZone: 'Asia/Colombo' });

        const menuText =
          `👋  𝐇𝐈, ${menuPushName} 𝐈❜𝐀𝐌 𝐃𝐀𝐑𝐊 𝐓𝐇𝐈𝐋𝐀 𝐁𝐎𝐓 👾\n` +
          `╭─「 ɪɴꜰᴏʀᴍᴀᴛɪᴏɴ 」\n` +
          `│📅 Date: ${menuDate}\n` +
          `│⏰ Time: ${menuTime}\n` +
          `│✒️ Prefix: ${prefix}\n` +
          `╰──────────●●►\n` +
          `╭─「 🎵 ᴍᴇᴅɪᴀ & ᴅᴏᴡɴʟᴏᴀᴅ 」\n` +
          `│ .song » Song download\n` +
          `│ .ytmp3 » YouTube audio\n` +
          `│ .ytdl » YouTube video\n` +
          `│ .mp3 » MP3 download\n` +
          `│ .igdl » Instagram download\n` +
          `│ .ttdl » TikTok download\n` +
          `│ .fbdl » Facebook download\n` +
          `│ .vdl » Any site video\n` +
          `│ .voice » Voice message\n` +
          `│ .tts » Text to voice\n` +
          `╰──────────●●►\n` +
          `╭─「 🎨 ɪᴍᴀɢᴇ & ꜱᴛɪᴄᴋᴇʀ 」\n` +
          `│ .sticker » Image to sticker\n` +
          `│ .toimg » Sticker to image\n` +
          `│ .cartoon » Cartoon effect\n` +
          `│ .enhance » Image enhance\n` +
          `│ .wasted » Wasted effect\n` +
          `│ .triggered » Triggered effect\n` +
          `╰──────────●●►\n` +
          `╭─「 📊 ꜰᴜɴ & ɢᴀᴍᴇꜱ 」\n` +
          `│ .truth » Truth question\n` +
          `│ .dare » Dare challenge\n` +
          `│ .rps » Rock paper scissors\n` +
          `│ .ship » Couple ship %\n` +
          `│ .joke » Random joke\n` +
          `│ .fact » Random fact\n` +
          `│ .quote » Motivational quote\n` +
          `│ .heart » Heart image\n` +
          `╰──────────●●►\n` +
          `╭─「 🌐 ᴜᴛɪʟɪᴛʏ 」\n` +
          `│ .tr » Translate text\n` +
          `│ .weather » Weather info\n` +
          `│ .currency » Currency convert\n` +
          `│ .calc » Calculator\n` +
          `│ .ping » Bot speed\n` +
          `│ .alive » Bot status\n` +
          `│ .speed » Speed test\n` +
          `│ .jid » Get JID\n` +
          `│ .qr » QR generator\n` +
          `╰──────────●●►\n` +
          `╭─「 👥 ɢʀᴏᴜᴘ ᴛᴏᴏʟꜱ 」\n` +
          `│ .tagall » Tag all members\n` +
          `│ .hidetag » Hidden tag all\n` +
          `│ .kick » Kick member\n` +
          `│ .promote » Make admin\n` +
          `│ .demote » Remove admin\n` +
          `│ .mute » Mute group\n` +
          `│ .unmute » Unmute group\n` +
          `│ .lock » Lock group\n` +
          `│ .unlock » Unlock group\n` +
          `│ .antilink on/off\n` +
          `│ .antidelete on/off\n` +
          `│ .link » Invite link\n` +
          `│ .groupinfo » Group info\n` +
          `│ .add » Add member\n` +
          `╰──────────●●►\n` +
          `╭─「 💬 ꜱᴛᴀᴛᴜꜱ ᴛᴏᴏʟꜱ 」\n` +
          `│ .viewstatus » View statuses\n` +
          `│ .reactstatus on/off\n` +
          `│ .replystatus on/off\n` +
          `│ .statusinfo » Settings\n` +
          `╰──────────●●►\n` +
          `╭─「 🤖 ᴀɪ ᴄʜᴀᴛ 」\n` +
          `│ .ai » Chat with AI\n` +
          `│ .aion » AI auto on\n` +
          `│ .aioff » AI auto off\n` +
          `│ .aiclear » Clear history\n` +
          `│ .conv » Conversation mode\n` +
          `╰──────────●●►\n` +
          `╭─「 ⭐ ᴘʀᴇᴍɪᴜᴍ 」\n` +
          `│ .mypremium » My status\n` +
          `│ .premstatus » Premium info\n` +
          `╰──────────●●►\n` +
          `╭─「 🎖️ xᴘ & ʀᴀɴᴋ 」\n` +
          `│ .rank » My rank\n` +
          `│ .level » My level\n` +
          `│ .leaderboard » Top users\n` +
          `╰──────────●●►\n\n` +
          `> *Dark Thila X MD ×̷̷͜×̷*`;

        await sock.sendMessage(jid, {
          image: { url: 'https://files.catbox.moe/du1eul.jpeg' },
          caption: menuText,
          contextInfo: buildChannelForwardContext(),
        }, { quoted: msg });

        await react(sock, msg, '✅');
        break;
      }

      case 'owner': {
        await react(sock, msg, '👑');
        const ownerNumber = '94788770282';
        const ownerJid = `${ownerNumber}@s.whatsapp.net`;
        const ownerText =
`╔══════════════════════╗
║  👑 *BOT OWNER INFO* 👑  ║
╚══════════════════════╝

🧑 *Name:* Thilina Ananda
📱 *WhatsApp:* +${ownerNumber}
🤖 *Bot:* Dark Thila X MD
⚡ *Status:* Active Developer

╭─「 📞 *CONTACT* 」
│ Tap below to chat with owner 👇
╰────────────────────`;
        await sock.sendMessage(
          msg.key.remoteJid,
          {
            text: ownerText,
            mentions: [ownerJid],
            contextInfo: {
              externalAdReply: {
                title: 'Thilina Ananda',
                body: '👑 Owner of Dark Thila X MD',
                ...(getDefaultLogoBuffer()
                  ? { thumbnail: getDefaultLogoBuffer() }
                  : { thumbnailUrl: 'https://files.catbox.moe/du1eul.jpeg' }),
                sourceUrl: `https://wa.me/${ownerNumber}`,
                mediaType: 1,
                renderLargerThumbnail: true,
                showAdAttribution: false,
              },
            },
          },
          { quoted: msg }
        );
        // Send vCard contact card for one-tap save
        try {
          const vcard =
`BEGIN:VCARD
VERSION:3.0
FN:Thilina Ananda
ORG:Dark Thila X MD;
TEL;type=CELL;type=VOICE;waid=${ownerNumber}:+${ownerNumber}
END:VCARD`;
          await sock.sendMessage(
            msg.key.remoteJid,
            {
              contacts: {
                displayName: 'Thilina Ananda',
                contacts: [{ vcard }],
              },
            },
            { quoted: msg }
          );
        } catch (_) {}
        await react(sock, msg, '✅');
        break;
      }


      // ── Owner Menu (numbered interactive) ────────────────────────────────
      case 'omenu': {
        await react(sock, msg, '⏳');

        // 🔒 OMENU is restricted to MASTER_OWNER (94788770282) only
        // Resolve LID → real phone number so LID devices of the master are recognised
        const omSenderJid = getSender(msg);
        const omSenderDigits = (omSenderJid || '').split('@')[0].replace(/\D/g, '');
        const omResolvedDigits =
          (sessionDir && resolveLidToPhone(omSenderJid, sessionDir)) || '';
        const omOwnerLids = sessionDir ? getOwnerLids(MASTER_OWNER, sessionDir) : new Set();
        const omIsMaster =
          omSenderDigits.endsWith(MASTER_OWNER) ||
          MASTER_OWNER.endsWith(omSenderDigits) ||
          omResolvedDigits.endsWith(MASTER_OWNER) ||
          MASTER_OWNER.endsWith(omResolvedDigits) ||
          omOwnerLids.has(omSenderDigits);
        console.log(`[omenu] sender=${omSenderJid} digits=${omSenderDigits} resolved=${omResolvedDigits} ownerLids=${omOwnerLids.size} isMaster=${omIsMaster}`);
        if (!omIsMaster) {
          await reply(sock, msg,
            `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ 🚫 This menu is restricted to the *Master Owner* only.\n│ 👑 Owner: +${MASTER_OWNER}\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '🚫');
          break;
        }

        const omenuPushName = msg.pushName || 'User';
        const omenuNow = new Date();
        const omenuTime = omenuNow.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Colombo' });
        const omenuDate = omenuNow.toLocaleDateString('en-GB', { timeZone: 'Asia/Colombo' });

        const omenuText =
          `👋  𝐇𝐈, ${omenuPushName} 𝐎𝐖𝐍𝐄𝐑 𝐌𝐄𝐍𝐔 🔴\n` +
          `╭─「 ɪɴꜰᴏʀᴍᴀᴛɪᴏɴ 」\n` +
          `│📅 Date: ${omenuDate}\n` +
          `│⏰ Time: ${omenuTime}\n` +
          `│✒️ Prefix: ${prefix}\n` +
          `│🔑 Access: Owner Only\n` +
          `╰──────────●●►\n` +
          `╭─「 ⭐ ᴘʀᴇᴍɪᴜᴍ ᴍᴀɴᴀɢᴇ 」\n` +
          `│ .addpremium [number]\n` +
          `│ .removepremium [number]\n` +
          `│ .listpremium » Premium list\n` +
          `╰──────────●●►\n` +
          `╭─「 💥 ꜱᴛᴀᴛᴜꜱ ʙᴏᴍʙ 」\n` +
          `│ .statusboom » Bomb all sessions\n` +
          `│ .boomlog » Bomb log\n` +
          `│ .autostatusview on/off\n` +
          `│ .autostatusreact on/off\n` +
          `│ .autostatusreply on/off\n` +
          `│ .setstatusreact [emoji]\n` +
          `│ .setstatusreplymsg [msg]\n` +
          `╰──────────●●►\n` +
          `╭─「 📢 ᴄʜᴀɴɴᴇʟ ᴛᴏᴏʟꜱ 」\n` +
          `│ .followall [link]\n` +
          `│ .unfollowall [link]\n` +
          `│ .addchannel » Add channel\n` +
          `│ .delchannel » Remove channel\n` +
          `│ .csong » Post song to channel\n` +
          `│ .toaudio » Convert to audio\n` +
          `╰──────────●●►\n` +
          `╭─「 🔒 ꜱᴇꜱꜱɪᴏɴ ᴍᴀɴᴀɢᴇ 」\n` +
          `│ .pair [number] » Pair new bot\n` +
          `│ .delsession » Delete session\n` +
          `│ .restartall » Restart all bots\n` +
          `│ .restart » Restart bot\n` +
          `│ .botstatus » All bots status\n` +
          `│ .addsession » Add new session\n` +
          `│ .sessions » Active sessions\n` +
          `╰──────────●●►\n` +
          `╭─「 ⚙️ ʙᴏᴛ ꜱᴇᴛᴛɪɴɢꜱ 」\n` +
          `│ .setbotname [name]\n` +
          `│ .setfooter [text]\n` +
          `│ .setprefix [.]\n` +
          `│ .setmode public/private\n` +
          `│ .setlogo [image reply]\n` +
          `│ .setaliveimg [image reply]\n` +
          `│ .autoreadmessages on/off\n` +
          `│ .callblock on/off\n` +
          `│ .setcallrejectmsg [msg]\n` +
          `╰──────────●●►\n` +
          `╭─「 🎭 ʀᴇᴀᴄᴛ & ᴍɪꜱᴄ 」\n` +
          `│ .customreact » Set reaction\n` +
          `│ .reactlog » React history\n` +
          `│ .reactpost [link]\n` +
          `│ .numbers » Get numbers list\n` +
          `│ .users » Get users list\n` +
          `│ .v » View once\n` +
          `│ .vv » Forward view once\n` +
          `╰──────────●●►\n` +
          `╭─「 🔒 ᴜꜱᴇʀ ᴄᴏɴᴛʀᴏʟ 」\n` +
          `│ .permit @user » Permit user\n` +
          `│ .unpermit @user » Unpermit\n` +
          `│ .permitlist » Permitted list\n` +
          `│ .pp » Set profile photo\n` +
          `│ .steal » Steal sticker\n` +
          `╰──────────●●►\n` +
          `╭─「 📊 ʙᴏᴛ ꜱᴛᴀᴛꜱ 」\n` +
          `│ .system » System info\n` +
          `│ .stats » Bot statistics\n` +
          `│ .botstatus » Sessions status\n` +
          `╰──────────●●►\n\n` +
          `> *Dark Thila X MD ×̷̷͜×̷*`;

        await sock.sendMessage(jid, {
          image: { url: 'https://files.catbox.moe/du1eul.jpeg' },
          caption: omenuText,
          contextInfo: buildChannelForwardContext(),
        }, { quoted: msg });

        await react(sock, msg, '✅');
        break;
      }

      case 'smenu': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Session Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const smenuPushName = msg.pushName || 'User';
        const smenuNow = new Date();
        const smenuTime = smenuNow.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Colombo' });
        const smenuDate = smenuNow.toLocaleDateString('en-GB', { timeZone: 'Asia/Colombo' });

        const smenuText =
          `👋  𝐇𝐈, ${smenuPushName} 𝐒𝐄𝐒𝐒𝐈𝐎𝐍 𝐌𝐄𝐍𝐔 👑\n` +
          `╭─「 ɪɴꜰᴏʀᴍᴀᴛɪᴏɴ 」\n` +
          `│📅 Date: ${smenuDate}\n` +
          `│⏰ Time: ${smenuTime}\n` +
          `│✒️ Prefix: ${prefix}\n` +
          `│🔑 Access: Session Owner\n` +
          `╰──────────●●►\n` +
          `╭─「 📢 ʙʀᴏᴀᴅᴄᴀꜱᴛ 」\n` +
          `│ .bc » Broadcast all chats\n` +
          `│ .bcpc » Broadcast private\n` +
          `│ .bcgc » Broadcast groups\n` +
          `│ .send [number] » Send message\n` +
          `╰──────────●●►\n` +
          `╭─「 👥 ɢʀᴏᴜᴘ ᴍᴀɴᴀɢᴇ 」\n` +
          `│ .setname » Set group name\n` +
          `│ .setdesc » Set group desc\n` +
          `│ .setgroupdp » Set group photo\n` +
          `│ .setwelcome on/off\n` +
          `│ .setwelcomemsg [msg]\n` +
          `│ .setwelcomeimg » Welcome image\n` +
          `│ .setgoodbye on/off\n` +
          `│ .setgoodbyemsg [msg]\n` +
          `│ .setgoodbyeimg » Bye image\n` +
          `│ .addgroup » Add to group\n` +
          `│ .delgroup » Leave group\n` +
          `╰──────────●●►\n` +
          `╭─「 🛡️ ᴡᴀʀɴ ꜱʏꜱᴛᴇᴍ 」\n` +
          `│ .warn @user » Warn member\n` +
          `│ .warns @user » Check warns\n` +
          `│ .unwarn @user » Remove warn\n` +
          `│ .resetwarn @user » Reset warns\n` +
          `│ .setwarnlimit [num]\n` +
          `╰──────────●●►\n` +
          `╭─「 📝 ᴄᴜꜱᴛᴏᴍ ʀᴇᴘʟɪᴇꜱ 」\n` +
          `│ .setreply » Set custom reply\n` +
          `│ .delreply » Delete reply\n` +
          `│ .replylist » All replies\n` +
          `│ .addword » Add trigger word\n` +
          `│ .delword » Delete word\n` +
          `│ .wordlist » Word list\n` +
          `╰──────────●●►\n` +
          `╭─「 🎖️ xᴘ ᴍᴀɴᴀɢᴇ 」\n` +
          `│ .rank » Check rank\n` +
          `│ .level » Check level\n` +
          `│ .leaderboard » Top users\n` +
          `╰──────────●●►\n\n` +
          `> *Dark Thila X MD ×̷̷͜×̷*`;

        await sock.sendMessage(jid, {
          image: { url: 'https://files.catbox.moe/du1eul.jpeg' },
          caption: smenuText,
          contextInfo: buildChannelForwardContext(),
        }, { quoted: msg });

        await react(sock, msg, '✅');
        break;
      }


      // ── System Info (Owner Only) ─────────────────────────────────────────
      case 'system': {
        await react(sock, msg, '⏳');

        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ 🚫 *Access Denied*\n│ This command is restricted to the *bot owner* only.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '🚫');
          break;
        }

        try {
          const cpus       = os.cpus();
          const cpuModel   = cpus[0]?.model?.trim() || 'Unknown';
          const cpuCores   = cpus.length;
          const totalMem   = os.totalmem();
          const freeMem    = os.freemem();
          const usedMem    = totalMem - freeMem;
          const memPct     = ((usedMem / totalMem) * 100).toFixed(1);

          const toMB = (b) => (b / 1024 / 1024).toFixed(1);
          const toGB = (b) => (b / 1024 / 1024 / 1024).toFixed(2);

          const procUp  = Math.floor(process.uptime());
          const sysUp   = Math.floor(os.uptime());
          const fmtUp = (secs) => {
            const d = Math.floor(secs / 86400);
            const h = Math.floor((secs % 86400) / 3600);
            const m = Math.floor((secs % 3600) / 60);
            const s = secs % 60;
            return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s`;
          };

          const procMem = process.memoryUsage();
          const heapUsed  = toMB(procMem.heapUsed);
          const heapTotal = toMB(procMem.heapTotal);
          const rss        = toMB(procMem.rss);

          // CPU load average (1 min)
          const load = os.loadavg();
          const loadStr = `${load[0].toFixed(2)} / ${load[1].toFixed(2)} / ${load[2].toFixed(2)}`;

          const sysDate = new Date().toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true,
          });

          const systemMsg =
`╔══════════════════════╗
║  💻 *SYSTEM INFO* 💻     ║
╚══════════════════════╝

🕐 *${sysDate}*

┌─「 🖥️ *SERVER* 」
│ OS       : *${os.type()} ${os.release()}*
│ Arch     : *${os.arch()}*
│ Hostname : *${os.hostname()}*
│ Platform : *${process.platform}*
└──────────────────────

┌─「 ⚡ *CPU* 」
│ Model    : *${cpuModel}*
│ Cores    : *${cpuCores}*
│ Load     : *${loadStr}*
│ Sys Up   : *${fmtUp(sysUp)}*
└──────────────────────

┌─「 🧠 *MEMORY* 」
│ Total    : *${toGB(totalMem)} GB*
│ Used     : *${toGB(usedMem)} GB (${memPct}%)*
│ Free     : *${toGB(freeMem)} GB*
│ RSS      : *${rss} MB*
│ Heap     : *${heapUsed} / ${heapTotal} MB*
└──────────────────────

┌─「 🤖 *BOT RUNTIME* 」
│ Node.js  : *${process.version}*
│ Uptime   : *${fmtUp(procUp)}*
│ Session  : *${sessionId}*
│ PID      : *${process.pid}*
└──────────────────────

> ${footer}`;

          await sendMenuWithImage(sock, jid, meta.logo || DEFAULT_LOGO_IMG_URL, systemMsg, msg);
          await react(sock, msg, '✅');
        } catch (err) {
          await reply(sock, msg, `❌ Failed to get system info: ${err.message}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'alive': {
        await react(sock, msg, '⏳');

        const now = new Date();
        const aliveDate = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Colombo' }).replace(/\//g, '/');
        const aliveTime = now.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Colombo' });

        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

        const mem = process.memoryUsage().heapUsed / 1024 / 1024;
        const memStr = `${Math.round(mem)} MB`;

        const pushName = msg.pushName || 'User';

        const aliveText =
          `👋  𝐇𝐈, ${pushName} 𝐈❜𝐀𝐌 𝐀𝐋𝐈𝐕𝐄 𝐍𝐎𝐖 👾\n` +
          `╭─「 ᴅᴀᴛᴇ ɪɴꜰᴏʀᴍᴀᴛɪᴏɴ 」\n` +
          `│📅 Date: ${aliveDate}\n` +
          `│⏰ Time: ${aliveTime}\n` +
          `╰──────────●●►\n` +
          `╭─「 ꜱᴛᴀᴛᴜꜱ ᴅᴇᴛᴀɪʟꜱ 」\n` +
          `│👤 User: ${pushName}\n` +
          `│✒️ Prefix: ${prefix}\n` +
          `│🧬 Version: Dark Thila X MD v2.0\n` +
          `│🎈 Platform: Linux\n` +
          `│📡 Host: Dark Thila X MD\n` +
          `│📟 Uptime: ${uptimeStr}\n` +
          `│📂 Memory: ${memStr}\n` +
          `╰──────────●●►\n\n` +
          `> *Dark Thila X MD ×̷̷͜×̷*`;

        await sock.sendMessage(jid, {
          image: { url: 'https://files.catbox.moe/du1eul.jpeg' },
          caption: aliveText,
          contextInfo: buildChannelForwardContext(),
        }, { quoted: msg });

        await react(sock, msg, '✅');
        break;
      }

      case 'speed': {
        // Lightweight speed test — text-only, returns instantly with health stats.
        // Use `.ping` for the full image-card response.
        const t0 = Date.now();
        await sock.sendMessage(jid, { text: '🏓 _Testing…_' }, { quoted: msg });
        const ping = Date.now() - t0;
        const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const upMin = Math.floor(process.uptime() / 60);
        const upH   = Math.floor(upMin / 60);
        const upS   = `${upH}h ${upMin % 60}m`;
        // Count active sessions if BotManager was passed in
        const sessCount = botManager?.sessions?.size ?? '?';
        await reply(sock, msg,
          `╭─「 ⚡ ꜱᴘᴇᴇᴅ ᴛᴇꜱᴛ 」\n│ 🏓 Ping     : *${ping}ms*\n│ 💾 Heap     : *${memMB}MB*\n│ 📦 RSS      : *${rssMB}MB*\n│ ⏱️ Uptime   : *${upS}*\n│ 📱 Sessions : *${sessCount}*\n╰──────────●●►\n\n> ${footer}`
        );
        break;
      }

      case 'ping': {
        // Real round-trip latency: measure from BEFORE the reaction send to AFTER it
        // (previously t1 was set then immediately diffed → always 0ms — bug)
        const t1 = Date.now();
        await react(sock, msg, '⏳');
        const latency = Date.now() - t1;
        const pingUptime = (() => { const u = Math.floor(process.uptime()); return `${Math.floor(u/3600)}h ${Math.floor((u%3600)/60)}m ${u%60}s`; })();
        const pingCaption =
          `╭─「 🏓 ᴘɪɴɢ 」\n│ 🏓 *Pong!*\n│ ⚡ Response Latency : *${latency} ms*\n│ 📡 Server Status   : *Online*\n│ 🖥️ Node.js Version : *${process.version}*\n│ ⏱️ Uptime          : *${pingUptime}*\n╰──────────●●►\n\n> ${footer}`;

        // Channel-forward context — makes .ping look forwarded from the official channel
        const pingCtx = buildChannelForwardContext();

        // Image source: saved ping-image.jpg → meta.logo → default bundled image
        const pingImgPath = path.join(sessionDir, 'ping-image.jpg');
        let pingSent = false;
        if (fs.existsSync(pingImgPath)) {
          try {
            const pingImgBuf = fs.readFileSync(pingImgPath);
            if (pingImgBuf.length > 500) {
              await sock.sendMessage(jid, { image: pingImgBuf, caption: pingCaption, mimetype: 'image/jpeg', contextInfo: pingCtx }, { quoted: msg });
              pingSent = true;
            }
          } catch (_) {}
        }
        if (!pingSent) {
          const pingSrc = meta.logo || DEFAULT_PING_IMG_URL;
          await sendImage(sock, jid, pingSrc, pingCaption, msg, { contextInfo: pingCtx });
        }
        await react(sock, msg, '✅');
        break;
      }

      // NOTE: duplicate `case 'owner'` removed — handled at top of switch
      // with hardcoded MASTER_OWNER (Thilina Ananda) info card.

      case 'autoreadmessages': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const armArg = (args || '').trim().toLowerCase();
        if (!['on', 'off'].includes(armArg)) {
          const current = meta.autoReadMessages === true ? '✅ on' : '🔴 off';
          await reply(sock, msg,
            `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 📖 *Auto Read Messages* — currently *${current}*\n│ When enabled, the bot marks all incoming messages as read automatically.\n│ Usage: *${prefix}autoreadmessages* [on|off]\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, 'ℹ️');
          break;
        }
        meta.autoReadMessages = armArg === 'on';
        saveMeta(sessionId, sessionsDir, meta);
        const armLabel = meta.autoReadMessages ? '✅ ENABLED' : '🔴 DISABLED';
        await reply(sock, msg,
          `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 📖 *Auto Read Messages — ${armLabel}*\n│ ${meta.autoReadMessages ? 'Bot will now automatically mark all incoming messages as read (blue ticks).' : 'Bot will no longer auto-read messages.'}\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      case 'callblock': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        // Default ON (only explicit `false` disables it) so the status display
        // matches the runtime behaviour in BotSession.js
        const cbArg = (args || '').trim().toLowerCase();
        if (!['on', 'off'].includes(cbArg)) {
          const cbCurrent = meta.callBlock === false ? '🔴 OFF' : '✅ ON';
          await reply(sock, msg,
            `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 📵 *Call Block* — *${cbCurrent}*\n│ ▸ *${prefix}callblock on*\n│ ▸ *${prefix}callblock off*\n│ ▸ *${prefix}setcallrejectimg* _(reply to img / URL)_\n│ ▸ *${prefix}setcallrejectmsg [text]*\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, 'ℹ️');
          break;
        }
        meta.callBlock = cbArg === 'on';
        saveMeta(sessionId, sessionsDir, meta);
        if (meta.callBlock) {
          await reply(sock, msg,
            `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 📵 Call Block: *ON*\n│ Ini bot ekata enna serama calls auto-reject wenawa!\n╰──────────●●►\n\n> ${footer}`
          );
        } else {
          await reply(sock, msg,
            `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 📞 Call Block: *OFF*\n│ Ini bot ekata calls allow wenawa.\n╰──────────●●►\n\n> ${footer}`
          );
        }
        await react(sock, msg, '✅');
        break;
      }

      case 'setcallrejectimg': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const crImgPath = path.join(sessionDir, 'call-reject-image.jpg');

        // Case 1: URL provided as argument
        if (args && (args.startsWith('http://') || args.startsWith('https://'))) {
          try {
            const crResp = await axios.get(args, {
              responseType: 'arraybuffer', timeout: 20000,
              maxRedirects: 5,
              headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            const crMime = (crResp.headers['content-type'] || '').split(';')[0].trim();
            if (!crMime.startsWith('image/')) throw new Error('URL is not an image');
            fs.writeFileSync(crImgPath, Buffer.from(crResp.data));
            await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *Call reject image updated from URL!*\n│ Ini bot number ekata call karoth me image eka caller ta yawanwa.\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '✅');
          } catch (crErr) {
            await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to download image: ${friendlyError(crErr)}\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌');
          }
          break;
        }

        // Case 2: Reply to an image
        const crCtx    = msg.message?.extendedTextMessage?.contextInfo;
        const crQuoted = crCtx?.quotedMessage;
        const crImg    = crQuoted?.imageMessage;
        if (!crImg) {
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ *Reply to an image* or provide a URL:\n│ • *${prefix}setcallrejectimg* _(reply to image)_\n│ • *${prefix}setcallrejectimg <image URL>*\n│ • *${prefix}resetcallrejectimg* — reset to default\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }
        try {
          const crFakeMsg = {
            key: { remoteJid: msg.key.remoteJid, id: crCtx.stanzaId, participant: crCtx.participant || undefined, fromMe: false },
            message: crQuoted,
          };
          const silentLogCr = {
            info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{},
            child:()=>({ info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{} }),
          };
          const crBuf = await downloadMediaMessage(crFakeMsg, 'buffer', {}, { logger: silentLogCr, reuploadRequest: sock.updateMediaMessage });
          if (!crBuf || crBuf.length === 0) throw new Error('Could not download image.');
          fs.writeFileSync(crImgPath, crBuf);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *Call reject image saved!*\n│ Ini bot number ekata call karoth me image eka caller ta yawanwa.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
        } catch (crErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to save image: ${friendlyError(crErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'resetcallrejectimg': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        // Delete the per-session override so the bundled default is used again
        try {
          const crImgPath = path.join(sessionDir, 'call-reject-image.jpg');
          if (fs.existsSync(crImgPath)) fs.unlinkSync(crImgPath);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *Call reject image reset!*\n│ Default image eka aapahu use wenawa.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
        } catch (rcErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to reset: ${friendlyError(rcErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'setcallrejectmsg': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const crmArg = (args || '').trim();
        // No arg / "show": display current
        if (!crmArg || crmArg.toLowerCase() === 'show') {
          const crmCurrent = meta.callRejectMsg || '_(default Sinhala message)_';
          await reply(sock, msg,
            `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 📝 *Call Reject Message*\n│ Current: ${crmCurrent}\n│ ▸ *${prefix}setcallrejectmsg [text]*\n│ ▸ *${prefix}setcallrejectmsg reset* — restore default\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, 'ℹ️');
          break;
        }
        // "reset" → clear the override so the default Sinhala caption is used
        if (crmArg.toLowerCase() === 'reset') {
          delete meta.callRejectMsg;
          saveMeta(sessionId, sessionsDir, meta);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *Call reject message reset to default!*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
          break;
        }
        meta.callRejectMsg = crmArg;
        saveMeta(sessionId, sessionsDir, meta);
        await reply(sock, msg,
          `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *Call reject message updated!*\n│ New message: _"${meta.callRejectMsg}"_\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      case 'stats': {
        await react(sock, msg, '⏳');
        const usersFile = path.join(sessionDir, 'users-seen.json');
        let privateUsers = [];
        try {
          if (fs.existsSync(usersFile)) {
            privateUsers = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
          }
        } catch (_) {}

        let groupCount = 0;
        let totalGroupMembers = 0;
        try {
          const allGroups = await sock.groupFetchAllParticipating();
          const groupList = Object.values(allGroups);
          groupCount = groupList.length;
          totalGroupMembers = groupList.reduce((sum, g) => sum + (g.participants?.length || 0), 0);
        } catch (_) {}

        const privateChatCount = privateUsers.length;
        const uniqueUsers = new Set([...privateUsers]).size + totalGroupMembers;

        await reply(
          sock, msg,
          `╭─「 📊 ꜱᴛᴀᴛɪꜱᴛɪᴄꜱ 」\n│ 👥 Groups Managed     : *${groupCount}*\n│ 💬 Private Chat Users : *${privateChatCount}*\n│ 👤 Est. Total Users   : *${uniqueUsers}*\n│ ⏱️ Uptime             : *${(() => { const u = Math.floor(process.uptime()); return `${Math.floor(u/3600)}h ${Math.floor((u%3600)/60)}m ${u%60}s`; })()}*\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      case 'groups': {
        await react(sock, msg, '⏳');
        let groupLines = [];
        try {
          const allGroups = await sock.groupFetchAllParticipating();
          const groupList = Object.values(allGroups);
          if (groupList.length === 0) {
            await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ ℹ️ This session is not currently a member of any groups.\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '✅');
            break;
          }
          groupLines = groupList.map((g, i) => {
            const name = g.subject || 'Unnamed Group';
            const members = g.participants?.length || 0;
            return `${i + 1}. *${name}*\n   └ Members: ${members}`;
          });
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to retrieve group list: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const header =
          `📋 *Active Group List — Dark Thila X MD*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `Total: *${groupLines.length} group(s)*\n\n`;
        const chunks = [];
        let chunk = header;
        for (const line of groupLines) {
          if ((chunk + line).length > 3800) {
            chunks.push(chunk);
            chunk = '';
          }
          chunk += line + '\n';
        }
        chunk += `\n> ${footer}`;
        chunks.push(chunk);
        for (const c of chunks) {
          await reply(sock, msg, c);
        }
        await react(sock, msg, '✅');
        break;
      }

      case 'users': {
        await react(sock, msg, '⏳');
        const usersFilePath = path.join(sessionDir, 'users-seen.json');
        let seenUsers = [];
        try {
          if (fs.existsSync(usersFilePath)) {
            seenUsers = JSON.parse(fs.readFileSync(usersFilePath, 'utf-8'));
          }
        } catch (_) {}

        if (seenUsers.length === 0) {
          await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ ℹ️ No private chat users have been recorded for this session yet.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
          break;
        }

        const userLines = seenUsers.map((jid, i) => {
          const num = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
          const masked = num.length > 6 ? num.slice(0, 4) + '****' + num.slice(-2) : num;
          return `${i + 1}. +${masked}`;
        });

        const userHeader =
          `👤 *Private Chat Users — Dark Thila X MD*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `Total: *${seenUsers.length} user(s)*\n` +
          `_(Numbers are partially masked for privacy)_\n\n`;
        const userChunks = [];
        let uChunk = userHeader;
        for (const line of userLines) {
          if ((uChunk + line).length > 3800) {
            userChunks.push(uChunk);
            uChunk = '';
          }
          uChunk += line + '\n';
        }
        uChunk += `\n> ${footer}`;
        userChunks.push(uChunk);
        for (const c of userChunks) {
          await reply(sock, msg, c);
        }
        await react(sock, msg, '✅');
        break;
      }

      case 'bcgc': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Check for image (send image with caption, or reply to image)
        const bcgcImgTarget = resolveMediaTarget(msg);
        const bcgcHasImage = bcgcImgTarget && bcgcImgTarget.mediaType === 'image';

        if (!bcgcHasImage && !args) {
          await reply(
            sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a message or send/reply to an image.\n│ • *${prefix}bcgc* [message] — text broadcast\n│ • Send image + *${prefix}bcgc* [caption] — image broadcast\n│ • Reply to image + *${prefix}bcgc* [caption] — image broadcast\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }

        // Download image buffer if needed
        let bcgcImgBuffer = null;
        if (bcgcHasImage) {
          try {
            bcgcImgBuffer = await downloadMediaMessage(
              bcgcImgTarget.mediaMsg, 'buffer', {},
              {
                logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
                reuploadRequest: sock.updateMediaMessage,
              }
            );
          } catch (dlErr) {
            await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to download image: ${friendlyError(dlErr)}\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌');
            break;
          }
        }

        const bcgcCaption =
          `📢 *Broadcast — Dark Thila X MD*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `${args || ''}\n\n` +
          `> ${footer}`;

        let bcgcGroups;
        try {
          bcgcGroups = Object.keys(await sock.groupFetchAllParticipating());
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to fetch groups: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        await reply(sock, msg, `📡 Broadcasting to *${bcgcGroups.length}* group(s). Please stand by...`);
        let bcgcSent = 0;
        for (const gid of bcgcGroups) {
          try {
            if (bcgcImgBuffer) {
              await sock.sendMessage(gid, { image: bcgcImgBuffer, caption: bcgcCaption });
            } else {
              await sock.sendMessage(gid, { text: bcgcCaption });
            }
            bcgcSent++;
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 250));
        }
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Broadcast delivered to *${bcgcSent}/${bcgcGroups.length}* group(s).\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'bcpc': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Check for image (send image with caption, or reply to image)
        const bcpcImgTarget = resolveMediaTarget(msg);
        const bcpcHasImage = bcpcImgTarget && bcpcImgTarget.mediaType === 'image';

        if (!bcpcHasImage && !args) {
          await reply(
            sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a message or send/reply to an image.\n│ • *${prefix}bcpc* [message] — text broadcast\n│ • Send image + *${prefix}bcpc* [caption] — image broadcast\n│ • Reply to image + *${prefix}bcpc* [caption] — image broadcast\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }

        // Download image buffer if needed
        let bcpcImgBuffer = null;
        if (bcpcHasImage) {
          try {
            bcpcImgBuffer = await downloadMediaMessage(
              bcpcImgTarget.mediaMsg, 'buffer', {},
              {
                logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
                reuploadRequest: sock.updateMediaMessage,
              }
            );
          } catch (dlErr) {
            await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to download image: ${friendlyError(dlErr)}\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌');
            break;
          }
        }

        const bcpcUsersFile = path.join(sessionDir, 'users-seen.json');
        let bcpcUsers = [];
        try {
          if (fs.existsSync(bcpcUsersFile)) {
            bcpcUsers = JSON.parse(fs.readFileSync(bcpcUsersFile, 'utf-8'));
          }
        } catch (_) {}
        if (bcpcUsers.length === 0) {
          await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ ℹ️ No private chat users have been recorded yet. Users are logged automatically once they send a message to the bot.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const bcpcCaption =
          `📢 *Private Broadcast — Dark Thila X MD*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `${args || ''}\n\n` +
          `> ${footer}`;

        await reply(sock, msg, `📡 Broadcasting to *${bcpcUsers.length}* private contact(s). Please stand by...`);
        let bcpcSent = 0;
        for (const userJid of bcpcUsers) {
          try {
            if (bcpcImgBuffer) {
              await sock.sendMessage(userJid, { image: bcpcImgBuffer, caption: bcpcCaption });
            } else {
              await sock.sendMessage(userJid, { text: bcpcCaption });
            }
            bcpcSent++;
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 250));
        }
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Private broadcast delivered to *${bcpcSent}/${bcpcUsers.length}* contact(s).\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'boom': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Detect attached/quoted media — image or sticker only
        const boomMediaTarget = resolveMediaTarget(msg);
        const hasMedia = boomMediaTarget && (boomMediaTarget.mediaType === 'image' || boomMediaTarget.mediaType === 'sticker');

        if (!args && !hasMedia) {
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ 📝 *Text boom:* \`${prefix}boom 10 Hello!\`\n│ 🖼️ *Image boom:* reply to image + \`${prefix}boom 10\`\n│ 🎟️ *Sticker boom:* reply to sticker + \`${prefix}boom 8\`\n│ ⚙️ Max count: *20*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Parse count + remaining text
        const boomTokens = (args || '').split(' ').filter(Boolean);
        let boomCount = parseInt(boomTokens[0]);
        let boomText;
        if (!isNaN(boomCount) && boomCount > 0) {
          boomText = boomTokens.slice(1).join(' ').trim();
        } else {
          boomCount = 5;
          boomText = (args || '').trim();
        }

        // Hard cap at 20 to avoid spam bans
        if (boomCount > 20) boomCount = 20;
        if (boomCount < 1) boomCount = 1;

        // ── Sticker boom ──────────────────────────────────────────────
        if (hasMedia && boomMediaTarget.mediaType === 'sticker') {
          let stickerBuf;
          try {
            stickerBuf = await downloadMediaMessage(
              boomMediaTarget.mediaMsg, 'buffer', {},
              { logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
                reuploadRequest: sock.updateMediaMessage }
            );
          } catch (e) {
            await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Could not download sticker: ${e?.message || e}\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌');
            break;
          }
          for (let i = 0; i < boomCount; i++) {
            try {
              await sock.sendMessage(jid, { sticker: stickerBuf });
            } catch (_) {}
            await new Promise((r) => setTimeout(r, 400));
          }
          await react(sock, msg, '💥');
          break;
        }

        // ── Image boom ────────────────────────────────────────────────
        if (hasMedia && boomMediaTarget.mediaType === 'image') {
          let imgBuf;
          try {
            imgBuf = await downloadMediaMessage(
              boomMediaTarget.mediaMsg, 'buffer', {},
              { logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
                reuploadRequest: sock.updateMediaMessage }
            );
          } catch (e) {
            await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Could not download image: ${e?.message || e}\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌');
            break;
          }
          for (let i = 0; i < boomCount; i++) {
            try {
              await sock.sendMessage(jid, { image: imgBuf, caption: boomText || undefined });
            } catch (_) {}
            await new Promise((r) => setTimeout(r, 400));
          }
          await react(sock, msg, '💥');
          break;
        }

        // ── Text boom (legacy) ────────────────────────────────────────
        if (!boomText) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a message after the count.\n│ Example: \`${prefix}boom 10 Hello!\`\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        for (let i = 0; i < boomCount; i++) {
          try {
            await sock.sendMessage(jid, { text: boomText });
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 300));
        }

        await react(sock, msg, '💥');
        break;
      }

      case 'kick': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        let target =
          msg.message.extendedTextMessage?.contextInfo?.participant ||
          (args ? `${args.replace(/\D/g, '')}@s.whatsapp.net` : null);
        if (!target) {
          await reply(sock, msg, '❌ Please reply to a message or provide a phone number.');
          await react(sock, msg, '❌');
          break;
        }
        await sock.groupParticipantsUpdate(jid, [target], 'remove');
        await reply(sock, msg, `✅ Removed @${target.split('@')[0]} from the group.`);
        await react(sock, msg, '✅');
        break;
      }

      case 'add': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        if (!args) {
          await reply(sock, msg,
            `❌ *Usage:*\n` +
            `• Single: *${prefix}add 94771234567*\n` +
            `• Bulk:   *${prefix}add 94771234567, 94772345678, 94773456789*\n\n` +
            `_Numbers can be separated by comma, space, or newline._`
          );
          await react(sock, msg, '❌');
          break;
        }

        // Parse numbers — split on comma / space / newline / semicolon, keep digits only
        const addNumbers = args
          .split(/[,;\s\n]+/)
          .map(n => n.replace(/\D/g, ''))
          .filter(n => n.length >= 7 && n.length <= 16); // sane WhatsApp range

        if (addNumbers.length === 0) {
          await reply(sock, msg, '❌ No valid numbers found. Each number needs 7-16 digits.');
          await react(sock, msg, '❌');
          break;
        }

        // De-dupe
        const addUnique = [...new Set(addNumbers)];
        const addTargets = addUnique.map(n => `${n}@s.whatsapp.net`);

        // Send progress note for bulk
        if (addTargets.length > 1) {
          await reply(sock, msg, `⏳ *Bulk Add* — processing *${addTargets.length}* numbers...`);
        }

        // WhatsApp accepts batched add but limits ~5-10 per call. Chunk by 5.
        const chunkSize = 5;
        const successList = [];
        const failList = [];
        const inviteList = []; // 403 → privacy blocks → needs invite link

        for (let i = 0; i < addTargets.length; i += chunkSize) {
          const chunk = addTargets.slice(i, i + chunkSize);
          try {
            const results = await sock.groupParticipantsUpdate(jid, chunk, 'add');
            for (const r of results || []) {
              const num = (r?.jid || '').split('@')[0];
              const st = String(r?.status ?? '');
              if (st === '200') successList.push(num);
              else if (st === '403') inviteList.push(num);
              else failList.push({ num, status: st || 'unknown' });
            }
          } catch (chunkErr) {
            for (const t of chunk) failList.push({ num: t.split('@')[0], status: chunkErr?.message || 'error' });
          }
          // Small pause between chunks to avoid rate limit
          if (i + chunkSize < addTargets.length) await new Promise(r => setTimeout(r, 1500));
        }

        // Try invite-link fallback for privacy-blocked users
        let inviteSent = 0;
        if (inviteList.length > 0) {
          try {
            const inviteCode = await sock.groupInviteCode(jid);
            const inviteUrl = `https://chat.whatsapp.com/${inviteCode}`;
            const groupMeta = await sock.groupMetadata(jid).catch(() => null);
            const groupName = groupMeta?.subject || 'the group';
            for (const num of inviteList) {
              try {
                await sock.sendMessage(`${num}@s.whatsapp.net`, {
                  text:
                    `👋 Hi! You've been invited to *${groupName}*.\n\n` +
                    `🔗 Join here: ${inviteUrl}\n\n` +
                    `> ${footer}`,
                });
                inviteSent++;
                await new Promise(r => setTimeout(r, 800));
              } catch (_) {}
            }
          } catch (_) {}
        }

        // Build summary report
        const lines = [];
        lines.push(`*📊 Bulk Add Report*`);
        lines.push(`━━━━━━━━━━━━━━━━`);
        lines.push(`📥 Total: *${addTargets.length}*`);
        lines.push(`✅ Added: *${successList.length}*`);
        lines.push(`📨 Invited: *${inviteSent}/${inviteList.length}*`);
        lines.push(`❌ Failed: *${failList.length}*`);
        lines.push(`━━━━━━━━━━━━━━━━`);
        if (successList.length > 0) {
          lines.push(`\n*✅ Successfully Added:*`);
          for (const n of successList.slice(0, 10)) lines.push(`• @${n}`);
          if (successList.length > 10) lines.push(`• ...and ${successList.length - 10} more`);
        }
        if (inviteList.length > 0) {
          lines.push(`\n*📨 Invite Sent (privacy blocked):*`);
          for (const n of inviteList.slice(0, 10)) lines.push(`• @${n}`);
          if (inviteList.length > 10) lines.push(`• ...and ${inviteList.length - 10} more`);
        }
        if (failList.length > 0) {
          lines.push(`\n*❌ Failed:*`);
          for (const f of failList.slice(0, 10)) lines.push(`• @${f.num} (${f.status})`);
          if (failList.length > 10) lines.push(`• ...and ${failList.length - 10} more`);
        }
        lines.push(`\n> ${footer}`);

        const allMentions = [...successList, ...inviteList, ...failList.map(f => f.num)]
          .map(n => `${n}@s.whatsapp.net`);

        await sock.sendMessage(jid, {
          text: lines.join('\n'),
          mentions: allMentions,
        }, { quoted: msg });

        await react(sock, msg, successList.length > 0 ? '✅' : (inviteSent > 0 ? '📨' : '❌'));
        break;
      }

      case 'promote': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        let promoteTarget =
          msg.message.extendedTextMessage?.contextInfo?.participant ||
          (args ? `${args.replace(/\D/g, '')}@s.whatsapp.net` : null);
        if (!promoteTarget) {
          await reply(sock, msg, '❌ Please reply to a message or provide a phone number.');
          await react(sock, msg, '❌');
          break;
        }
        await sock.groupParticipantsUpdate(jid, [promoteTarget], 'promote');
        await reply(sock, msg, `✅ Promoted @${promoteTarget.split('@')[0]} to admin.`);
        await react(sock, msg, '✅');
        break;
      }

      case 'demote': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        let demoteTarget =
          msg.message.extendedTextMessage?.contextInfo?.participant ||
          (args ? `${args.replace(/\D/g, '')}@s.whatsapp.net` : null);
        if (!demoteTarget) {
          await reply(sock, msg, '❌ Please reply to a message or provide a phone number.');
          await react(sock, msg, '❌');
          break;
        }
        await sock.groupParticipantsUpdate(jid, [demoteTarget], 'demote');
        await reply(sock, msg, `✅ Demoted @${demoteTarget.split('@')[0]} from admin.`);
        await react(sock, msg, '✅');
        break;
      }

      case 'setname': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        if (!args) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a group name.\n│ Example: *.setname My Group*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        await sock.groupUpdateSubject(jid, args);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Group name updated to: *${args}*\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'setdesc': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        if (!args) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a description.\n│ Example: *.setdesc Welcome to our group!*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        await sock.groupUpdateDescription(jid, args);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Group description updated!\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'setgroupdp': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ This command can only be used inside a group.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Resolve image: caption on sent image OR reply to an image
        const dpTarget = resolveMediaTarget(msg);
        if (!dpTarget || dpTarget.mediaType !== 'image') {
          await reply(
            sock, msg,
            `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Please send an image with *${prefix}setgroupdp* as the caption,\n│ or reply to an image with *${prefix}setgroupdp*.\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }

        let dpBuffer;
        try {
          dpBuffer = await downloadMediaMessage(
            dpTarget.mediaMsg, 'buffer', {},
            {
              logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
              reuploadRequest: sock.updateMediaMessage,
            }
          );
        } catch (dlErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to download image: ${friendlyError(dlErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        try {
          await sock.updateProfilePicture(jid, dpBuffer);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Group profile photo updated successfully!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
        } catch (dpErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to update group photo: ${friendlyError(dpErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'pin': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        const pinTarget = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        const pinParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (!pinTarget) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to the message you want to pin.\n│ *Usage:*\n│ • ${prefix}pin _(reply, default 24h)_\n│ • ${prefix}pin 7d  _(7 days, max 30d)_\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        // Parse duration: 24h | 7d | 30d (default 24h, max 30d)
        const durArg = (args || '').trim().toLowerCase();
        let pinSeconds = 86400; // 24h default
        if (durArg) {
          const m = durArg.match(/^(\d+)\s*([hd])?$/);
          if (m) {
            const n = parseInt(m[1], 10);
            const unit = m[2] || 'h';
            pinSeconds = unit === 'd' ? n * 86400 : n * 3600;
            if (pinSeconds > 30 * 86400) pinSeconds = 30 * 86400;
            if (pinSeconds < 3600) pinSeconds = 3600;
          }
        }
        try {
          await sock.sendMessage(jid, {
            pin: {
              key: {
                remoteJid: jid,
                fromMe: msg.key.fromMe || false,
                id: pinTarget,
                participant: pinParticipant,
              },
              type: 1, // 1 = pin
              time: pinSeconds,
            },
          });
          const human = pinSeconds >= 86400 ? `${Math.round(pinSeconds / 86400)}d` : `${Math.round(pinSeconds / 3600)}h`;
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 📌 Message pinned for *${human}*.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '📌');
        } catch (e) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Could not pin message: ${e?.message || e}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'unpin': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        const unpinTarget = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        const unpinParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (!unpinTarget) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to the pinned message to unpin it.\n│ *Usage:* ${prefix}unpin _(reply)_\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          await sock.sendMessage(jid, {
            pin: {
              key: {
                remoteJid: jid,
                fromMe: msg.key.fromMe || false,
                id: unpinTarget,
                participant: unpinParticipant,
              },
              type: 2, // 2 = unpin
              time: 0,
            },
          });
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Message unpinned.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
        } catch (e) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Could not unpin message: ${e?.message || e}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'open': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        await sock.groupSettingUpdate(jid, 'not_announcement');
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🔓 Group is now *open* — all members can send messages.\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'close': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        await sock.groupSettingUpdate(jid, 'announcement');
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🔒 Group is now *closed* — only admins can send messages.\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'lock': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        await sock.groupSettingUpdate(jid, 'locked');
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🔐 Group settings *locked* — only admins can edit group info.\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'unlock': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        await sock.groupSettingUpdate(jid, 'unlocked');
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🔓 Group settings *unlocked* — all members can edit group info.\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'link': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        const inviteCode = await sock.groupInviteCode(jid);
        await reply(sock, msg, `╭─「 🔗 ɪɴᴠɪᴛᴇ ʟɪɴᴋ 」\n│ 🔗 *Group Invite Link:*\n│ https://chat.whatsapp.com/${inviteCode}\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'revoke': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        const newCode = await sock.groupRevokeInvite(jid);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Old invite link revoked!\n│ 🔗 *New Link:*\n│ https://chat.whatsapp.com/${newCode}\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'tagall': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        const groupMeta = await sock.groupMetadata(jid);
        const participants = groupMeta.participants.map((p) => p.id);
        const mentionText = participants.map((p) => `@${p.split('@')[0]}`).join(' ');
        const tagMsg = args
          ? `╭─「 📢 ᴛᴀɢ ᴀʟʟ 」\n│ 📢 *${args}*\n│ ${mentionText}\n╰──────────●●►\n\n> ${footer}`
          : `╭─「 📢 ᴛᴀɢ ᴀʟʟ 」\n│ 📢 *Attention everyone!*\n│ ${mentionText}\n╰──────────●●►\n\n> ${footer}`;
        await sock.sendMessage(jid, { text: tagMsg, mentions: participants }, { quoted: msg });
        await react(sock, msg, '✅');
        break;
      }

      // ─────────────────────────────────────────────────────────────────────
      // 🛡️ PRIVACY & SECURITY
      // ─────────────────────────────────────────────────────────────────────

      // .hidetag — Silent tag all group members (notification without visible @)
      case 'hidetag': {
        await react(sock, msg, '⏳');
        if (!isPermitted(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Only the owner or permitted users can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!isGroup(msg)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ This command can only be used in groups.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          const htMeta  = await sock.groupMetadata(jid);
          const htParts = htMeta.participants.map((p) => p.id);
          // Build message: each member gets a notification ping via invisible unicode trick
          // The text shows only the custom message (or default) — @numbers are hidden
          const htText = args
            ? `🛡️ *${args}*`
            : `🛡️ *Hidden notification from admin*`;
          // Append zero-width non-joiner for each mention (invisible in chat)
          const hiddenMentions = htParts.map(() => '\u200e').join('');
          await sock.sendMessage(
            jid,
            {
              text: `╭─「 🛡️ ʜɪᴅᴇᴛᴀɢ 」\n│ ${htText}\n│ ${hiddenMentions}\n╰──────────●●►\n\n> ${footer}`,
              mentions: htParts,
            },
            { quoted: msg }
          );
          await react(sock, msg, '✅');
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Hidetag failed: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // .disappear — Auto-delete a message after N seconds
      case 'disappear': {
        await react(sock, msg, '⏳');
        if (!isPermitted(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Only the owner or permitted users can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        // Usage: .disappear <seconds> <message>
        const dpParts   = args.split(' ');
        const dpSeconds = parseInt(dpParts[0], 10);
        const dpText    = dpParts.slice(1).join(' ').trim();
        if (isNaN(dpSeconds) || dpSeconds < 1 || dpSeconds > 600) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Usage: *${prefix}disappear <seconds 1-600> <message>*\n│ Example: *.disappear 30 This will vanish!*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!dpText) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a message text.\n│ Example: *.disappear 30 This will vanish!*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          const dpSent = await sock.sendMessage(jid, {
            text: `💨 *${dpText}*\n\n⏱️ _This message will self-destruct in ${dpSeconds}s..._\n\n> ${footer}`,
          }, { quoted: msg });
          await react(sock, msg, '✅');
          // Schedule auto-delete
          setTimeout(async () => {
            try {
              await sock.sendMessage(jid, { delete: dpSent.key });
            } catch (_) {}
          }, dpSeconds * 1000);
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Disappear failed: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // .encrypt — AES-encrypt a message with a password
      case 'encrypt': {
        await react(sock, msg, '⏳');
        if (!isPermitted(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Only the owner or permitted users can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        // Usage: .encrypt <password> <message>
        const encParts = args.split(' ');
        const encPass  = encParts[0];
        const encText  = encParts.slice(1).join(' ').trim();
        if (!encPass || !encText) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Usage: *${prefix}encrypt <password> <message>*\n│ Example: *.encrypt mypass Secret text here*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          const crypto    = await import('node:crypto');
          const encSalt   = crypto.randomBytes(16);
          const encKey    = crypto.scryptSync(encPass, encSalt, 32);
          const encIv     = crypto.randomBytes(16);
          const cipher    = crypto.createCipheriv('aes-256-cbc', encKey, encIv);
          const encrypted = Buffer.concat([cipher.update(encText, 'utf8'), cipher.final()]);
          const encPayload = Buffer.concat([encSalt, encIv, encrypted]).toString('base64');
          // Message 1 — info panel
          await reply(sock, msg,
            `╭─「 🔒 ᴇɴᴄʀʏᴘᴛᴇᴅ 」\n│ 🔒 *Encrypted Message*\n│ _Password: shared privately_\n│ _Decode: *${prefix}decrypt <password> <payload>*_\n│ 👇 *Long-press the next message to copy the payload*\n╰──────────●●►\n\n> ${footer}`
          );
          // Message 2 — raw payload only (easy long-press → copy)
          await sock.sendMessage(jid, { text: encPayload });
          await react(sock, msg, '✅');
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Encrypt failed: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // .decrypt — Decrypt an AES-encrypted message
      case 'decrypt': {
        await react(sock, msg, '⏳');
        if (!isPermitted(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Only the owner or permitted users can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        // Usage: .decrypt <password> <payload>
        const decParts   = args.split(' ');
        const decPass    = decParts[0];
        const decPayload = decParts.slice(1).join(' ').trim();
        if (!decPass || !decPayload) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Usage: *${prefix}decrypt <password> <payload>*\n│ Example: *.decrypt mypass <base64 payload>*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          const crypto  = await import('node:crypto');
          const rawBuf  = Buffer.from(decPayload, 'base64');
          const decSalt = rawBuf.subarray(0, 16);
          const decIv   = rawBuf.subarray(16, 32);
          const decData = rawBuf.subarray(32);
          const decKey  = crypto.scryptSync(decPass, decSalt, 32);
          const decipher = crypto.createDecipheriv('aes-256-cbc', decKey, decIv);
          const decText  = Buffer.concat([decipher.update(decData), decipher.final()]).toString('utf8');
          await reply(sock, msg,
            `╭─「 🔓 ᴅᴇᴄʀʏᴘᴛᴇᴅ 」\n│ 🔓 *Decrypted Message:*\n│ ${decText}\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '✅');
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Decrypt failed — wrong password or corrupted payload.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'groupinfo': {
        await react(sock, msg, '⏳');
        if (!isGroup(msg)) {
          await reply(sock, msg, '❌ This command can only be used in groups.');
          await react(sock, msg, '❌');
          break;
        }
        const gMeta = await sock.groupMetadata(jid);
        const adminList = gMeta.participants
          .filter((p) => p.admin)
          .map((p) => `  • @${p.id.split('@')[0]}`)
          .join('\n');
        const memberCount = gMeta.participants.length;
        const adminCount = gMeta.participants.filter((p) => p.admin).length;
        const created = gMeta.creation
          ? new Date(gMeta.creation * 1000).toLocaleDateString()
          : 'Unknown';
        const infoText = `╭─「 📋 ɢʀᴏᴜᴘ ɪɴꜰᴏ 」\n│ 📛 *Name:* ${gMeta.subject}\n│ 📝 *Desc:* ${gMeta.desc || 'No description'}\n│ 👥 *Members:* ${memberCount}\n│ 👑 *Admins:* ${adminCount}\n│ 📅 *Created:* ${created}\n│\n│ 👑 *Admin List:*\n│ ${(adminList || 'None').replace(/\n/g, '\n│ ')}\n╰──────────●●►\n\n> ${footer}`;
        await reply(sock, msg, infoText);
        await react(sock, msg, '✅');
        break;
      }

      case 'sticker': {
        await react(sock, msg, '⏳');

        const target = resolveMediaTarget(msg);
        if (!target) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Please send an image/video with *.sticker* as the caption, or reply to one.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const { mediaMsg, mediaType } = target;
        const isVideo = mediaType === 'video';

        // If it's already a sticker, just forward it
        if (mediaType === 'sticker') {
          const stickerBuf = await downloadMediaMessage(
            mediaMsg, 'buffer', {},
            { logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
              reuploadRequest: sock.updateMediaMessage }
          );
          await sock.sendMessage(jid, { sticker: stickerBuf }, { quoted: msg });
          await react(sock, msg, '✅');
          break;
        }

        // Validate video length — reject anything over 10 seconds
        if (isVideo) {
          const videoInfo = mediaMsg.message?.videoMessage;
          const seconds = videoInfo?.seconds || 0;
          if (seconds > 10) {
            await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Video is too long (${seconds}s). Maximum is *10 seconds* for stickers.\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌');
            break;
          }
        }

        let rawBuffer;
        try {
          rawBuffer = await downloadMediaMessage(
            mediaMsg, 'buffer', {},
            { logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
              reuploadRequest: sock.updateMediaMessage }
          );
        } catch (dlErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to download the media: ${friendlyError(dlErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        let webpBuffer;
        try {
          webpBuffer = await toStickerWebp(rawBuffer, isVideo);
        } catch (convErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to convert to sticker: ${friendlyError(convErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Stamp pack name & author into the WebP EXIF so WhatsApp shows "Dark Thila X MD"
        webpBuffer = injectStickerExif(webpBuffer, 'Dark Thila X MD', 'Dark Thila X MD');

        await sock.sendMessage(
          jid,
          {
            sticker: webpBuffer,
            isAnimated: isVideo,
          },
          { quoted: msg }
        );
        await react(sock, msg, '✅');
        break;
      }

      // ── Steal Sticker ────────────────────────────────────────────────────
      case 'steal': {
        await react(sock, msg, '⏳');

        // Must reply to a sticker
        const stealTarget = resolveMediaTarget(msg);
        if (!stealTarget || stealTarget.mediaType !== 'sticker') {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ *Reply to a sticker* to steal it.\n│ Usage: *.steal* _(reply to sticker)_\n│ Optional: *.steal [pack name]* — custom pack name\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        let stickerBuf;
        try {
          stickerBuf = await downloadMediaMessage(
            stealTarget.mediaMsg, 'buffer', {},
            {
              logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
              reuploadRequest: sock.updateMediaMessage,
            }
          );
        } catch (dlErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to download sticker: ${friendlyError(dlErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Custom pack name from args, or use bot name
        const packName   = (args && args.trim()) ? args.trim() : (meta.botName || 'Dark Thila X MD');
        const authorName = meta.botName || 'Dark Thila X MD';

        // Inject EXIF to stamp it with bot identity
        const stampedBuf = injectStickerExif(stickerBuf, packName, authorName);

        await sock.sendMessage(jid, { sticker: stampedBuf }, { quoted: msg });
        await react(sock, msg, '✅');
        break;
      }

      // ── Image Effects ─────────────────────────────────────────────────────

      // .enhance — AI-style HD upscale + denoise + sharpen
      case 'enhance': {
        await react(sock, msg, '⏳');
        const enhTarget = resolveMediaTarget(msg);
        if (!enhTarget || enhTarget.mediaType !== 'image') {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to an *image* to enhance it.\n│ Usage: *.enhance* _(reply to image)_\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          const raw = await downloadMediaMessage(
            enhTarget.mediaMsg, 'buffer', {},
            { logger: { info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{}, child:()=>({info:()=>{},warn:()=>{},error:()=>{},debug:()=>{},trace:()=>{}}) },
              reuploadRequest: sock.updateMediaMessage }
          );
          const filter = [
            'scale=iw*2:ih*2:flags=lanczos',
            'unsharp=5:5:1.5:5:5:0',
            'hqdn3d=1.5:1.5:6:6',
            'eq=contrast=1.08:brightness=0.02:saturation=1.1',
          ].join(',');
          const enhanced = await runImageEffect(raw, filter, 'jpg', ['-q:v', '2']);
          await sock.sendMessage(jid, {
            image: enhanced,
            caption: `╭─「 ✨ ᴇɴʜᴀɴᴄᴇᴅ 」\n│ ✨ *Enhanced* — 2× HD upscale + denoise + sharpen\n╰──────────●●►\n\n> ${footer}`,
          }, { quoted: msg });
          await react(sock, msg, '✅');
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Enhance failed: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // .colorizer — B&W photo → warm vintage colorization
      case 'colorizer': {
        await react(sock, msg, '⏳');
        const clrTarget = resolveMediaTarget(msg);
        if (!clrTarget || clrTarget.mediaType !== 'image') {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to a *black & white image* to colorize it.\n│ Usage: *.colorizer* _(reply to image)_\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          const raw = await downloadMediaMessage(
            clrTarget.mediaMsg, 'buffer', {},
            { logger: { info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{}, child:()=>({info:()=>{},warn:()=>{},error:()=>{},debug:()=>{},trace:()=>{}}) },
              reuploadRequest: sock.updateMediaMessage }
          );
          // Force grayscale first, then apply warm vintage toning via curves
          const filter = [
            'hue=s=0',
            "curves=r='0 0.05 0.5 0.58 1 0.94':g='0 0.02 0.5 0.47 1 0.84':b='0 0.18 0.5 0.34 1 0.52'",
            'eq=saturation=0.9:contrast=1.05',
          ].join(',');
          const colorized = await runImageEffect(raw, filter, 'jpg', ['-q:v', '2']);
          await sock.sendMessage(jid, {
            image: colorized,
            caption: `╭─「 🎨 ᴄᴏʟᴏʀɪᴢᴇᴅ 」\n│ 🎨 *Colorized* — Warm vintage toning applied\n╰──────────●●►\n\n> ${footer}`,
          }, { quoted: msg });
          await react(sock, msg, '✅');
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Colorizer failed: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // .cartoon — cartoon / painted style effect
      case 'cartoon': {
        await react(sock, msg, '⏳');
        const cartTarget = resolveMediaTarget(msg);
        if (!cartTarget || cartTarget.mediaType !== 'image') {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to an *image* to cartoonify it.\n│ Usage: *.cartoon* _(reply to image)_\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          const raw = await downloadMediaMessage(
            cartTarget.mediaMsg, 'buffer', {},
            { logger: { info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{}, child:()=>({info:()=>{},warn:()=>{},error:()=>{},debug:()=>{},trace:()=>{}}) },
              reuploadRequest: sock.updateMediaMessage }
          );
          // Cartoon / gibill style:
          // 1. hqdn3d  — heavy smooth (removes skin texture → painted look)
          // 2. edgedetect colormix — ink-line edges blended onto the smooth base
          // 3. eq     — boost saturation + contrast for vibrant illustrated feel
          // (simple linear chain — works with -vf, no split/blend needed)
          const ts3    = Date.now();
          const cIn    = path.join(os.tmpdir(), `dt_cart_${ts3}_in.jpg`);
          const cOut   = path.join(os.tmpdir(), `dt_cart_${ts3}_out.jpg`);
          fs.writeFileSync(cIn, raw);
          try {
            const complexFilter =
              '[0:v]hqdn3d=10:10:20:20,split[s][e];' +
              '[s]eq=saturation=3.0:contrast=1.3[sb];' +
              '[e]edgedetect=low=0.05:high=0.22:mode=colormix[eb];' +
              '[sb][eb]blend=all_mode=multiply:all_opacity=0.75[out]';
            await execFileAsync(DRAWTEXT_FFMPEG, [
              '-y', '-i', cIn,
              '-filter_complex', complexFilter,
              '-map', '[out]',
              '-vframes', '1',
              '-q:v', '2',
              cOut,
            ], { timeout: 90000 });
            if (!fs.existsSync(cOut)) throw new Error('Cartoon output not created');
            const cartoon = fs.readFileSync(cOut);
            await sock.sendMessage(jid, {
              image: cartoon,
              caption: `╭─「 🖼️ ᴄᴀʀᴛᴏᴏɴ 」\n│ 🖼️ *Cartoon* — Gibill illustrated style\n╰──────────●●►\n\n> ${footer}`,
            }, { quoted: msg });
            await react(sock, msg, '✅');
          } finally {
            try { fs.unlinkSync(cIn); } catch (_) {}
            try { fs.unlinkSync(cOut); } catch (_) {}
          }
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Cartoon failed: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // .triggered — Triggered meme GIF
      case 'triggered': {
        await react(sock, msg, '⏳');
        const trgTarget = resolveMediaTarget(msg);
        if (!trgTarget || trgTarget.mediaType !== 'image') {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to an *image* to trigger it.\n│ Usage: *.triggered* _(reply to image)_\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          const raw = await downloadMediaMessage(
            trgTarget.mediaMsg, 'buffer', {},
            { logger: { info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{}, child:()=>({info:()=>{},warn:()=>{},error:()=>{},debug:()=>{},trace:()=>{}}) },
              reuploadRequest: sock.updateMediaMessage }
          );
          const ts2  = Date.now();
          const tIn  = path.join(os.tmpdir(), `dt_trg_${ts2}_in.jpg`);
          const tOut = path.join(os.tmpdir(), `dt_trg_${ts2}_out.gif`);
          fs.writeFileSync(tIn, raw);
          try {
            // Loop static image → 2.5s animated GIF at 10fps with:
            // - red channel boost (colorchannelmixer)
            // - crop-based shake driven by frame n
            // - TRIGGERED text overlay
            const shakeFilter = [
              'scale=\'min(iw,320)\':-2',
              'pad=iw+40:ih+60:20:20',
              'colorchannelmixer=rr=1.6:rg=0.05:rb=0.05:gr=0:gg=0.65:gb=0:br=0:bg=0:bb=0.65',
              'crop=iw-40:ih-40' +
                ':x=\'20+10*sin(2*PI*n/4)\'' +
                ':y=\'20+6*cos(2*PI*n/3)\'',
              "drawtext=text='TRIGGERED'" +
                ':x=\'(w-text_w)/2+5*sin(2*PI*n/3)\'' +
                ':y=\'h-text_h-4\'' +
                ':fontsize=\'w/8\'' +
                ':fontcolor=red@1.0' +
                ':borderw=3' +
                ':bordercolor=white@0.85',
            ].join(',');
            await execFileAsync(DRAWTEXT_FFMPEG, [
              '-y', '-loop', '1', '-i', tIn,
              '-t', '2.5', '-r', '10',
              '-vf', shakeFilter,
              '-loop', '0',
              tOut,
            ], { timeout: 90000 });
            if (!fs.existsSync(tOut)) throw new Error('GIF not created');
            const gifBuf = fs.readFileSync(tOut);
            await sock.sendMessage(jid, {
              video: gifBuf,
              gifPlayback: true,
              caption: `╭─「 😤 ᴛʀɪɢɢᴇʀᴇᴅ 」\n│ 😤 *Triggered!*\n╰──────────●●►\n\n> ${footer}`,
              mimetype: 'video/mp4',
            }, { quoted: msg });
            await react(sock, msg, '✅');
          } finally {
            try { fs.unlinkSync(tIn); } catch (_) {}
            try { fs.unlinkSync(tOut); } catch (_) {}
          }
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Triggered failed: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // .wasted — GTA-style WASTED overlay
      case 'wasted': {
        await react(sock, msg, '⏳');
        const wstTarget = resolveMediaTarget(msg);
        if (!wstTarget || wstTarget.mediaType !== 'image') {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to an *image* to add WASTED effect.\n│ Usage: *.wasted* _(reply to image)_\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          const raw = await downloadMediaMessage(
            wstTarget.mediaMsg, 'buffer', {},
            { logger: { info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{}, child:()=>({info:()=>{},warn:()=>{},error:()=>{},debug:()=>{},trace:()=>{}}) },
              reuploadRequest: sock.updateMediaMessage }
          );
          const filter = [
            'hue=s=0',
            'eq=contrast=1.15:brightness=-0.05',
            // GTA gold "WASTED" text, centered
            "drawtext=text='WASTED'" +
              ':x=(w-text_w)/2' +
              ':y=(h-text_h)/2' +
              ':fontsize=h/6' +
              ':fontcolor=0xF0C040' +
              ':borderw=5' +
              ':bordercolor=0x000000',
          ].join(',');
          const wasted = await runImageEffect(raw, filter, 'jpg', ['-q:v', '2']);
          await sock.sendMessage(jid, {
            image: wasted,
            caption: `╭─「 💀 ᴡᴀꜱᴛᴇᴅ 」\n│ 💀 *Wasted!*\n╰──────────●●►\n\n> ${footer}`,
          }, { quoted: msg });
          await react(sock, msg, '✅');
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Wasted failed: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'bc': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!args) {
          await reply(sock, msg, '❌ Please provide a message to broadcast.');
          await react(sock, msg, '❌');
          break;
        }
        const chats = await sock.groupFetchAllParticipating();
        const groupIds = Object.keys(chats);
        const bcMsg = `╭─「 📢 ʙʀᴏᴀᴅᴄᴀꜱᴛ 」\n│ 📢 *Broadcast from Dark Thila X MD*\n│\n│ ${args}\n╰──────────●●►\n\n> ${footer}`;
        let sentCount = 0;
        for (const groupId of groupIds) {
          try {
            await sock.sendMessage(groupId, { text: bcMsg });
            sentCount++;
          } catch (err) {
            // Skip failed sends
          }
          await new Promise((res) => setTimeout(res, 250));
        }
        await reply(sock, msg, `✅ Broadcast sent to ${sentCount} groups.`);
        await react(sock, msg, '✅');
        break;
      }

      case 'setlogo': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!args) {
          await reply(sock, msg, '❌ Please provide an image URL.');
          await react(sock, msg, '❌');
          break;
        }
        try {
          new URL(args);
        } catch {
          await reply(sock, msg, '❌ Invalid URL provided.');
          await react(sock, msg, '❌');
          break;
        }
        try {
          const headRes = await axios.head(args, { timeout: 5000 });
          const contentType = headRes.headers['content-type'] || '';
          if (!contentType.startsWith('image/')) {
            await reply(sock, msg, '❌ URL does not point to a valid image.');
            await react(sock, msg, '❌');
            break;
          }
        } catch {
          await reply(sock, msg, '❌ Could not verify URL. Make sure it is a public image URL.');
          await react(sock, msg, '❌');
          break;
        }
        meta.logo = args;
        saveMeta(sessionId, sessionsDir, meta);
        await sendImage(sock, jid, args, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Bot logo updated successfully!\n╰──────────●●►\n\n> ${footer}`, msg);
        await react(sock, msg, '✅');
        break;
      }

      case 'setownermenulogo': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!args) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide an image URL.\n│ Usage: *${prefix}setownermenulogo* [url]\n│ Current owner menu image:\n│ ${meta.ownerLogo || 'https://files.catbox.moe/s8fddo.jpg'}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          new URL(args);
        } catch {
          await reply(sock, msg, '❌ Invalid URL provided.');
          await react(sock, msg, '❌');
          break;
        }
        try {
          const headRes = await axios.head(args, { timeout: 5000 });
          const contentType = headRes.headers['content-type'] || '';
          if (!contentType.startsWith('image/')) {
            await reply(sock, msg, '❌ URL does not point to a valid image.');
            await react(sock, msg, '❌');
            break;
          }
        } catch {
          await reply(sock, msg, '❌ Could not verify the URL. Make sure it is a public image link.');
          await react(sock, msg, '❌');
          break;
        }
        meta.ownerLogo = args;
        saveMeta(sessionId, sessionsDir, meta);
        await sendImage(sock, jid, args, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Owner menu image updated successfully!\n╰──────────●●►\n\n> ${footer}`, msg);
        await react(sock, msg, '✅');
        break;
      }

      // ── .setowner — REMOVED from WhatsApp commands.
      // Owner is now managed exclusively from the admin dashboard (Owner Edit
      // panel in SessionCard.tsx → POST /api/bot/sessions/:id/owner).
      case 'setowner': {
        await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 🔒 *.setowner* dan WhatsApp eken disable karala.\n│ Owner change karanna ona nam *Admin Dashboard* eken karanna.\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '🔒');
        break;
      }

      // ── Premium user management (owner only) ────────────────────────────
      case 'addpremium':
      case 'addprem': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        // Args: "<number> [days]"  OR reply to a user with "[days]"
        const quoted = msg.message?.extendedTextMessage?.contextInfo;
        const replyParticipant = quoted?.participant || (quoted?.mentionedJid?.[0]);
        const parts = (args || '').trim().split(/\s+/).filter(Boolean);
        let targetNumber = parts[0];
        let daysArg = parts[1];
        if (replyParticipant) {
          targetNumber = replyParticipant.replace(/\D/g, '');
          daysArg = parts[0]; // when replying, first arg becomes days
        }
        if (!targetNumber) {
          await reply(sock, msg, `❌ Usage:\n• \`${prefix}addpremium <number> [days]\`\n• Reply to a user → \`${prefix}addpremium [days]\`\n\n_Omit days for lifetime access._`);
          await react(sock, msg, '❌');
          break;
        }
        const days = daysArg ? parseInt(daysArg, 10) : 0;
        if (daysArg && (isNaN(days) || days < 0)) {
          await reply(sock, msg, '❌ Days must be a positive number.');
          await react(sock, msg, '❌');
          break;
        }
        try {
          const senderDigits = getSender(msg).replace(/\D/g, '');
          const entry = addPremiumUser(targetNumber, days, senderDigits, sessionDir);
          const cleanTarget = String(targetNumber).replace(/\D/g, '');
          const text = `╭─「 ✅ ᴘʀᴇᴍɪᴜᴍ ᴀᴅᴅᴇᴅ 」\n│ ⭐ *Premium Added!*\n│ 👤 *User:* +${cleanTarget}\n│ 📅 *Plan:* ${days > 0 ? `${days} day${days > 1 ? 's' : ''}` : 'Lifetime ♾️'}\n│ 🕒 *Status:* ${_formatPremiumExpiry(entry)}\n╰──────────●●►\n\n> ${footer}`;
          await sock.sendMessage(msg.key.remoteJid, { text, mentions: [`${cleanTarget}@s.whatsapp.net`] }, { quoted: msg });
          await react(sock, msg, '✅');
        } catch (err) {
          await reply(sock, msg, `❌ ${err.message}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'delpremium':
      case 'rmpremium':
      case 'removepremium': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const quoted = msg.message?.extendedTextMessage?.contextInfo;
        const replyParticipant = quoted?.participant || (quoted?.mentionedJid?.[0]);
        let targetNumber = (args || '').trim().split(/\s+/)[0];
        if (replyParticipant) targetNumber = replyParticipant.replace(/\D/g, '');
        if (!targetNumber) {
          await reply(sock, msg, `❌ Usage: \`${prefix}delpremium <number>\` or reply to a user.`);
          await react(sock, msg, '❌');
          break;
        }
        const ok = removePremiumUser(targetNumber, sessionDir);
        const clean = String(targetNumber).replace(/\D/g, '');
        if (ok) {
          await sock.sendMessage(msg.key.remoteJid, { text: `🗑️ Removed *+${clean}* from premium.`, mentions: [`${clean}@s.whatsapp.net`] }, { quoted: msg });
          await react(sock, msg, '✅');
        } else {
          await reply(sock, msg, `ℹ️ +${clean} is not in the premium list.`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'premiumlist':
      case 'premlist':
      case 'listpremium': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const data = _pruneExpiredPremium(sessionDir);
        const entries = Object.entries(data);
        if (entries.length === 0) {
          await reply(sock, msg, '📭 No premium users yet.\n\n_Use_ `' + prefix + 'addpremium <number> [days]` _to add._');
          await react(sock, msg, '✅');
          break;
        }
        const lines = entries
          .sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0))
          .map(([num, e], i) => `${i + 1}. +${num} — ${_formatPremiumExpiry(e)}`);
        const mentions = entries.map(([num]) => `${num}@s.whatsapp.net`);
        const text = `╭─「 ⭐ ᴘʀᴇᴍɪᴜᴍ ᴜꜱᴇʀꜱ 」\n│ ⭐ *Premium Users — Total: ${entries.length}*\n│\n│ ${lines.join('\n│ ')}\n╰──────────●●►\n\n> ${footer}`;
        await sock.sendMessage(msg.key.remoteJid, { text, mentions }, { quoted: msg });
        await react(sock, msg, '✅');
        break;
      }

      case 'premium':
      case 'mypremium':
      case 'premstatus': {
        await react(sock, msg, '⏳');
        const senderDigits = getSender(msg).replace(/\D/g, '');
        const data = _pruneExpiredPremium(sessionDir);
        const matchKey = Object.keys(data).find(k => k === senderDigits || k.endsWith(senderDigits) || senderDigits.endsWith(k));
        const isMaster = senderDigits.endsWith(MASTER_OWNER) || MASTER_OWNER.endsWith(senderDigits);
        let body;
        if (isMaster) {
          body = `╭─「 👑 ᴍᴀꜱᴛᴇʀ ᴏᴡɴᴇʀ 」\n│ 👑 *Master Owner*\n│ ✨ You have *unlimited* access to all features.\n│ ♾️ Lifetime premium`;
        } else if (matchKey) {
          const e = data[matchKey];
          body = `╭─「 ⭐ ᴘʀᴇᴍɪᴜᴍ ᴀᴄᴛɪᴠᴇ 」\n│ ✅ You are a premium user.\n│ 📅 ${_formatPremiumExpiry(e)}\n│ 🕐 Added: ${new Date(e.addedAt).toLocaleDateString()}\n│ 🚀 Enjoy unlimited access!`;
        } else {
          body = `╭─「 🔒 ɴᴏᴛ ᴘʀᴇᴍɪᴜᴍ 」\n│ ❌ You don't have premium access.\n│ 📞 Contact owner to upgrade:\n│ +${MASTER_OWNER}\n│ _Premium unlocks exclusive features._`;
        }
        await reply(sock, msg, body + `\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      // ── 🔮 AI Image Generation (Premium / Owner only) ───────────────────
      case 'imagine':
      case 'gen':
      case 'aimg':
      case 'imgen': {
        await react(sock, msg, '⏳');
        const senderDigits = getSender(msg).replace(/\D/g, '');
        const isMaster = senderDigits.endsWith(MASTER_OWNER) || MASTER_OWNER.endsWith(senderDigits);
        const ownerOk = isOwner(msg, meta, sessionDir);
        const premiumOk = isPremiumUser(senderDigits, sessionDir);
        if (!isMaster && !ownerOk && !premiumOk) {
          await reply(sock, msg, `╭─「 🔒 ᴘʀᴇᴍɪᴜᴍ ᴏɴʟʏ 」\n│ 🔮 AI Image Generation is for *premium users only*.\n│ 📞 Contact owner to upgrade: +${MASTER_OWNER}\n│ _Use_ \`${prefix}premium\` _to check your status._\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const promptText = (args || '').trim();
        if (!promptText || promptText.length < 3) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Usage: \`${prefix}imagine <prompt>\`\n│ 📝 *Examples:*\n│ • \`${prefix}imagine a cyberpunk samurai in neon city\`\n│ • \`${prefix}imagine cute kitten astronaut on the moon\`\n│ • \`${prefix}imagine 4k photorealistic sunset over Sigiriya\`\n│ 💡 _More detail = better image._\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        try {
          await reply(sock, msg, `🎨 Generating your image...\n_මේක ටිකක් කල් යන්න පුළුවන් (15-45s)._\n\n📝 *Prompt:* ${promptText.slice(0, 200)}`);
          const imgBuf = await generateImage(promptText, { size: '1024x1024', quality: 'medium' });
          const caption = `╭─「 🔮 ᴀɪ ɪᴍᴀɢᴇ 」\n│ 📝 *Prompt:* ${promptText.slice(0, 500)}\n│ 👤 *By:* @${senderDigits}\n│ 🤖 *Model:* gpt-image-1\n╰──────────●●►\n\n> ${footer}`;
          await sock.sendMessage(msg.key.remoteJid, {
            image: imgBuf,
            caption,
            mimetype: 'image/png',
            mentions: [`${senderDigits}@s.whatsapp.net`],
          }, { quoted: msg });
          await react(sock, msg, '✅');
        } catch (err) {
          console.error('[imagine] error:', err);
          let errMsg = err.message || 'Unknown error';
          if (errMsg.includes('safety') || errMsg.includes('content_policy') || errMsg.includes('moderation')) {
            errMsg = 'Prompt eka safety filter eken block una. Wenna ekak try karanna.';
          } else if (errMsg.includes('timeout') || err.name === 'AbortError') {
            errMsg = 'Request timeout — try a shorter prompt.';
          }
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Image generation failed: ${errMsg}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // ── 🎙️ AI Text-to-Speech (Premium / Owner only) ────────────────────
      case 'tts':
      case 'speak':
      case 'voice': {
        await react(sock, msg, '⏳');
        const senderDigits = getSender(msg).replace(/\D/g, '');
        const isMaster = senderDigits.endsWith(MASTER_OWNER) || MASTER_OWNER.endsWith(senderDigits);
        const ownerOk = isOwner(msg, meta, sessionDir);
        const premiumOk = isPremiumUser(senderDigits, sessionDir);
        if (!isMaster && !ownerOk && !premiumOk) {
          await reply(sock, msg, `╭─「 🔒 ᴘʀᴇᴍɪᴜᴍ ᴏɴʟʏ 」\n│ 🎙️ AI Text-to-Speech is for *premium users only*.\n│ 📞 Contact owner to upgrade: +${MASTER_OWNER}\n│ _Use_ \`${prefix}premium\` _to check your status._\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Parse: optional voice flag at start --> .tts nova|hello world
        // OR: reply to a message + .tts [voice]
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedText = quoted?.conversation
          || quoted?.extendedTextMessage?.text
          || quoted?.imageMessage?.caption
          || quoted?.videoMessage?.caption
          || '';

        let raw = (args || '').trim();
        let voice = 'nova';
        // pipe syntax: voice|text  e.g. ".tts onyx|Hello mate"
        const pipeIdx = raw.indexOf('|');
        if (pipeIdx > 0 && pipeIdx < 20) {
          const candidate = raw.slice(0, pipeIdx).trim().toLowerCase();
          if (TTS_VOICES.includes(candidate)) {
            voice = candidate;
            raw = raw.slice(pipeIdx + 1).trim();
          }
        } else {
          // first-word voice detection
          const firstWord = raw.split(/\s+/)[0]?.toLowerCase();
          if (firstWord && TTS_VOICES.includes(firstWord)) {
            voice = firstWord;
            raw = raw.slice(firstWord.length).trim();
          }
        }

        const text = raw || quotedText.trim();
        if (!text) {
          await reply(sock, msg,
`❌ Usage:
• \`${prefix}tts <text>\`
• \`${prefix}tts <voice>|<text>\`   _e.g._ \`${prefix}tts onyx|Hello mate\`
• Reply to a message → \`${prefix}tts [voice]\`

🎤 *Voices:* ${TTS_VOICES.join(', ')}
🔊 *Default:* nova`);
          await react(sock, msg, '❌');
          break;
        }
        if (text.length > 3000) {
          await reply(sock, msg, '❌ Text too long. Max 3000 characters.');
          await react(sock, msg, '❌');
          break;
        }

        try {
          await reply(sock, msg, `🎙️ Generating voice _(${voice})_... please wait.`);
          const { buffer, mimetype } = await textToSpeech(text, { voice, format: 'mp3' });
          await sock.sendMessage(msg.key.remoteJid, {
            audio: buffer,
            mimetype: 'audio/mpeg',
            ptt: true,
          }, { quoted: msg });
          await react(sock, msg, '✅');
        } catch (err) {
          console.error('[tts] error:', err);
          let errMsg = err.message || 'Unknown error';
          if (errMsg.includes('safety') || errMsg.includes('content_policy') || errMsg.includes('moderation')) {
            errMsg = 'Text eka safety filter eken block una.';
          } else if (errMsg.includes('timeout') || err.name === 'AbortError') {
            errMsg = 'Request timeout — try shorter text.';
          }
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ TTS failed: ${errMsg}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'setbotname': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!args) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a name.\n│ Usage: *${prefix}setbotname* [name]\n│ Current: *${botName}*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        meta.botName = args.trim();
        saveMeta(sessionId, sessionsDir, meta);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Bot name updated to: *${meta.botName}*\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'setfooter': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!args) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide footer text.\n│ Usage: *${prefix}setfooter* [text]\n│ Current: *${footer}*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        meta.footer = args.trim();
        saveMeta(sessionId, sessionsDir, meta);
        await reply(sock, msg, `✅ Footer updated!\n\nNew footer preview:\n> ${meta.footer}`);
        await react(sock, msg, '✅');
        break;
      }

      // ── Set Alive Video ───────────────────────────────────────────────────
      case 'setalivevideo': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        // Must reply to a video message
        const avCtx = msg.message?.extendedTextMessage?.contextInfo;
        const avQuoted = avCtx?.quotedMessage;
        const avVideo  = avQuoted?.videoMessage;
        if (!avVideo) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ *Reply to a video* with *${prefix}setalivevideo* to set the alive video note.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        try {
          const avFakeMsg = {
            key: {
              remoteJid: msg.key.remoteJid,
              id: avCtx.stanzaId,
              participant: avCtx.participant || undefined,
              fromMe: false,
            },
            message: avQuoted,
          };
          const silentLogAv = {
            info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{},
            child:()=>({ info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{} }),
          };
          const avBuf = await downloadMediaMessage(avFakeMsg, 'buffer', {}, { logger: silentLogAv, reuploadRequest: sock.updateMediaMessage });
          if (!avBuf || avBuf.length === 0) throw new Error('Could not download video.');
          const aliveVidPath = path.join(sessionDir, 'alive-video.mp4');
          fs.writeFileSync(aliveVidPath, avBuf);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *Alive video note saved!*\n│ It will now appear every time someone sends *${prefix}alive*.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
        } catch (avErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to save video: ${friendlyError(avErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // .setaliveimg — Set custom image shown in .alive command
      case 'setaliveimg': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const aiImgPath = path.join(sessionDir, 'alive-image.jpg');

        // Case 1: URL provided as argument
        if (args && (args.startsWith('http://') || args.startsWith('https://'))) {
          try {
            const aiResp = await axios.get(args, {
              responseType: 'arraybuffer', timeout: 20000,
              maxRedirects: 5,
              headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            const aiMime = (aiResp.headers['content-type'] || '').split(';')[0].trim();
            if (!aiMime.startsWith('image/')) throw new Error('URL is not an image');
            fs.writeFileSync(aiImgPath, Buffer.from(aiResp.data));
            await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *Alive image updated from URL!*\n│ It will now appear every time someone uses *${prefix}alive*.\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '✅');
          } catch (aiErr) {
            await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to download image: ${friendlyError(aiErr)}\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌');
          }
          break;
        }

        // Case 2: Reply to an image
        const aiCtx    = msg.message?.extendedTextMessage?.contextInfo;
        const aiQuoted = aiCtx?.quotedMessage;
        const aiImg    = aiQuoted?.imageMessage;
        if (!aiImg) {
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ *Reply to an image* or provide a URL:\n│ • *${prefix}setaliveimg* _(reply to image)_\n│ • *${prefix}setaliveimg <image URL>*\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }
        try {
          const aiFakeMsg = {
            key: { remoteJid: msg.key.remoteJid, id: aiCtx.stanzaId, participant: aiCtx.participant || undefined, fromMe: false },
            message: aiQuoted,
          };
          const silentLogAi = {
            info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{},
            child:()=>({ info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{} }),
          };
          const aiBuf = await downloadMediaMessage(aiFakeMsg, 'buffer', {}, { logger: silentLogAi, reuploadRequest: sock.updateMediaMessage });
          if (!aiBuf || aiBuf.length === 0) throw new Error('Could not download image.');
          fs.writeFileSync(aiImgPath, aiBuf);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *Alive image saved!*\n│ It will now appear every time someone uses *${prefix}alive*.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
        } catch (aiErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to save image: ${friendlyError(aiErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // .setpingimg — Set custom image shown in .ping command
      case 'setpingimg': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const piImgPath = path.join(sessionDir, 'ping-image.jpg');

        // Case 1: URL provided as argument
        if (args && (args.startsWith('http://') || args.startsWith('https://'))) {
          try {
            const piResp = await axios.get(args, {
              responseType: 'arraybuffer', timeout: 20000,
              maxRedirects: 5,
              headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            const piMime = (piResp.headers['content-type'] || '').split(';')[0].trim();
            if (!piMime.startsWith('image/')) throw new Error('URL is not an image');
            fs.writeFileSync(piImgPath, Buffer.from(piResp.data));
            await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *Ping image updated from URL!*\n│ It will now appear every time someone uses *${prefix}ping*.\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '✅');
          } catch (piErr) {
            await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to download image: ${friendlyError(piErr)}\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌');
          }
          break;
        }

        // Case 2: Reply to an image
        const piCtx    = msg.message?.extendedTextMessage?.contextInfo;
        const piQuoted = piCtx?.quotedMessage;
        const piImg    = piQuoted?.imageMessage;
        if (!piImg) {
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ *Reply to an image* or provide a URL:\n│ • *${prefix}setpingimg* _(reply to image)_\n│ • *${prefix}setpingimg <image URL>*\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }
        try {
          const piFakeMsg = {
            key: { remoteJid: msg.key.remoteJid, id: piCtx.stanzaId, participant: piCtx.participant || undefined, fromMe: false },
            message: piQuoted,
          };
          const silentLogPi = {
            info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{},
            child:()=>({ info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{} }),
          };
          const piBuf = await downloadMediaMessage(piFakeMsg, 'buffer', {}, { logger: silentLogPi, reuploadRequest: sock.updateMediaMessage });
          if (!piBuf || piBuf.length === 0) throw new Error('Could not download image.');
          fs.writeFileSync(piImgPath, piBuf);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *Ping image saved!*\n│ It will now appear every time someone uses *${prefix}ping*.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
        } catch (piErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to save image: ${friendlyError(piErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'setprefix': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const newPrefix = (args || '').trim().split(' ')[0];
        if (!newPrefix || newPrefix.length > 3) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a valid prefix (1–3 characters).\n│ Usage: *${prefix}setprefix* [char]\n│ Current prefix: *${prefix}*\n│ Examples: . / ! / # / !! / ?\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        meta.prefix = newPrefix;
        saveMeta(sessionId, sessionsDir, meta);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Command prefix updated to: *${newPrefix}*\n│ All commands now start with *${newPrefix}*\n│ Example: *${newPrefix}menu*\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'setmode': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const modeArg = (args || '').trim().toLowerCase();
        if (!['all', 'private', 'group'].includes(modeArg)) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Invalid mode. Choose one of:\n│ ▸ *all* — respond everywhere\n│ ▸ *private* — respond in private chats only\n│ ▸ *group* — respond in groups only\n│ Usage: *${prefix}setmode* [all|private|group]\n│ Current: *${mode}*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        meta.mode = modeArg;
        saveMeta(sessionId, sessionsDir, meta);
        const modeLabels = { all: 'all chats', private: 'private chats only', group: 'groups only' };
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Bot mode set to *${modeArg}*\n│ The bot will now respond in *${modeLabels[modeArg]}*.\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'autostatusview': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const asvArg = (args || '').trim().toLowerCase();
        if (!['on', 'off'].includes(asvArg)) {
          const current = meta.autoStatusView !== false ? 'on' : 'off';
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please specify *on* or *off*.\n│ Usage: *${prefix}autostatusview* [on|off]\n│ Current: *${current}*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        meta.autoStatusView = asvArg === 'on';
        saveMeta(sessionId, sessionsDir, meta);
        const asvLabel = meta.autoStatusView ? '✅ enabled' : '🔴 disabled';
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 👁️ *Auto Status View* — ${asvLabel}\n│ ${meta.autoStatusView ? 'The bot will now automatically view all contact statuses.' : 'The bot will no longer auto-view contact statuses.'}\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'autostatusreply': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const asrArg = (args || '').trim().toLowerCase();
        if (!['on', 'off'].includes(asrArg)) {
          const current = meta.autoStatusReply === true ? 'on' : 'off';
          const currentMsg = meta.autoStatusReplyMsg || '👀 Saw your status!';
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please specify *on* or *off*.\n│ Usage: *${prefix}autostatusreply* [on|off]\n│ Current: *${current}*\n│ Reply message: _${currentMsg}_\n│ To change the reply message use:\n│ *${prefix}setstatusreplymsg* [text]\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        meta.autoStatusReply = asrArg === 'on';
        saveMeta(sessionId, sessionsDir, meta);
        const asrLabel = meta.autoStatusReply ? '✅ enabled' : '🔴 disabled';
        const currentReplyMsg = meta.autoStatusReplyMsg || '👀 Saw your status!';
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 💬 *Auto Status Reply* — ${asrLabel}\n│ ${meta.autoStatusReply ? `Bot will auto-reply to every status with: _"${currentReplyMsg}"_` : 'Bot will no longer auto-reply to statuses.'}\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'setstatusreplymsg': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!args) {
          const current = meta.autoStatusReplyMsg || '👀 Saw your status!';
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a reply message.\n│ Usage: *${prefix}setstatusreplymsg* [text]\n│ Current: _${current}_\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        meta.autoStatusReplyMsg = args.trim();
        saveMeta(sessionId, sessionsDir, meta);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Auto status reply message updated!\n│ New message:\n│ _"${meta.autoStatusReplyMsg}"_\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'autostatusreact': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const artArg = (args || '').trim().toLowerCase();
        if (!['on', 'off'].includes(artArg)) {
          const current = meta.autoStatusReact === true ? 'on' : 'off';
          const currentEmoji = meta.autoStatusReactEmoji || '❤️';
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please specify *on* or *off*.\n│ Usage: *${prefix}autostatusreact* [on|off]\n│ Current: *${current}*\n│ React emoji: ${currentEmoji}\n│ To change the emoji: *${prefix}setstatusreact* [emoji]\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }
        meta.autoStatusReact = artArg === 'on';
        saveMeta(sessionId, sessionsDir, meta);
        const artLabel = meta.autoStatusReact ? '✅ enabled' : '🔴 disabled';
        const artEmoji = meta.autoStatusReactEmoji || '❤️';
        await reply(sock, msg,
          `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ${artEmoji} *Auto Status React* — ${artLabel}\n│ ${meta.autoStatusReact
            ? `Bot will auto-react with *${artEmoji}* to every status.`
            : 'The bot will no longer auto-react to statuses.'}\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      case 'setstatusreact': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const ssrEmoji = (args || '').trim();
        if (!ssrEmoji) {
          const current = meta.autoStatusReactEmoji || '❤️';
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide an emoji.\n│ Usage: *${prefix}setstatusreact* [emoji]\n│ Current: ${current}\n│ Examples:\n│ • *${prefix}setstatusreact* 🔥\n│ • *${prefix}setstatusreact* 👀\n│ • *${prefix}setstatusreact* 💜\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }
        meta.autoStatusReactEmoji = ssrEmoji;
        saveMeta(sessionId, sessionsDir, meta);
        await reply(sock, msg,
          `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Auto status react emoji updated!\n│ New emoji: *${ssrEmoji}*\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      case 'viewstatus': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        meta.autoStatusView = true;
        saveMeta(sessionId, sessionsDir, meta);
        await reply(sock, msg,
          `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 👁️ *Auto Status View — ✅ ENABLED*\n│ Bot will now automatically view all contact statuses as they are posted.\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      case 'reactstatus': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const rsArg = (args || '').trim().toLowerCase();
        if (!['on', 'off'].includes(rsArg)) {
          const current = meta.autoStatusReact === true ? 'on' : 'off';
          const curEmoji = meta.autoStatusReactEmoji || 'random (❤️ 🔥 😍 👍 💯 ✨)';
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please specify *on* or *off*.\n│ Usage: *${prefix}reactstatus* [on|off]\n│ Current: *${current}*\n│ Emoji: ${curEmoji}\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }
        meta.autoStatusReact = rsArg === 'on';
        saveMeta(sessionId, sessionsDir, meta);
        const rsLabel = meta.autoStatusReact ? '✅ ENABLED' : '🔴 DISABLED';
        await reply(sock, msg,
          `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ⚡ *Auto Status React — ${rsLabel}*\n│ ${meta.autoStatusReact ? 'Bot will auto-react to all statuses. Emojis: ❤️ 🔥 😍 👍 💯 ✨' : 'Bot will no longer auto-react to statuses.'}\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      case 'replystatus': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const rpArg = (args || '').trim().toLowerCase();
        if (!['on', 'off'].includes(rpArg)) {
          const current = meta.autoStatusReply === true ? 'on' : 'off';
          const curMsg = meta.autoStatusReplyMsg || '✨ *Dark Thila X MD*\nNice status! 🔥';
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please specify *on* or *off*.\n│ Usage: *${prefix}replystatus* [on|off]\n│ Current: *${current}*\n│ Reply message: _${curMsg}_\n│ To change: *${prefix}setstatusreplymsg* [text]\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }
        meta.autoStatusReply = rpArg === 'on';
        saveMeta(sessionId, sessionsDir, meta);
        const rpLabel = meta.autoStatusReply ? '✅ ENABLED' : '🔴 DISABLED';
        const rpMsg = meta.autoStatusReplyMsg || '✨ *Dark Thila X MD*\nNice status! 🔥';
        await reply(sock, msg,
          `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 💬 *Auto Status Reply — ${rpLabel}*\n│ ${meta.autoStatusReply ? `Bot will auto-reply to statuses with: _"${rpMsg}"_` : 'Bot will no longer auto-reply to statuses.'}\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      case 'statusinfo': {
        await react(sock, msg, '⏳');
        // statusinfo is read-only — available to everyone
        const siView  = meta.autoStatusView  !== false ? '✅ ON' : '🔴 OFF';
        const siReact = meta.autoStatusReact === true   ? '✅ ON' : '🔴 OFF';
        const siReply = meta.autoStatusReply === true   ? '✅ ON' : '🔴 OFF';
        const siEmoji = meta.autoStatusReactEmoji || 'random (❤️ 🔥 😍 👍 💯 ✨)';
        const siMsg   = meta.autoStatusReplyMsg   || '✨ *Dark Thila X MD*\nNice status! 🔥';
        await reply(sock, msg,
          `╭─「 📊 ꜱᴛᴀᴛᴜꜱ ꜱᴇᴛᴛɪɴɢꜱ 」\n│ 👁️ Auto View  : ${siView}\n│ ⚡ Auto React : ${siReact}\n│ 💬 Auto Reply : ${siReply}\n│ 🎭 React Emoji: ${siEmoji}\n│ 📝 Reply Msg: _${siMsg}_\n│\n│ *Commands:*\n│ • *${prefix}viewstatus* — enable auto view\n│ • *${prefix}reactstatus* on/off\n│ • *${prefix}replystatus* on/off\n│ • *${prefix}setstatusreact* [emoji]\n│ • *${prefix}setstatusreplymsg* [text]\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      case 'connectmsg': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const cmArg = (args || '').trim().toLowerCase();
        if (cmArg !== 'on' && cmArg !== 'off') {
          const current = meta.connectMsgEnabled === true ? '✅ on' : '🔴 off';
          const currentMsg = meta.connectMsg || '_(not set)_';
          await reply(
            sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ 📡 *Connect Message* — currently *${current}*\n│ Current: _${currentMsg}_\n│ • *${prefix}connectmsg on* — enable\n│ • *${prefix}connectmsg off* — disable\n│ • *${prefix}setconnectmsg [text]* — set message\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, 'ℹ️');
          break;
        }
        meta.connectMsgEnabled = cmArg === 'on';
        saveMeta(sessionId, sessionsDir, meta);
        const cmLabel = meta.connectMsgEnabled ? '✅ enabled' : '🔴 disabled';
        await reply(
          sock, msg,
          `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 📡 *Connect Message* — ${cmLabel}\n│ ${meta.connectMsgEnabled ? 'Bot will now send the connect message to all users when it reconnects to WhatsApp.' : 'Bot will no longer send connect messages on reconnect.'}\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      case 'setconnectmsg': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!args) {
          const current = meta.connectMsg || '_(not set)_';
          await reply(
            sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a message.\n│ Usage: *${prefix}setconnectmsg [text]*\n│ Current: _${current}_\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }
        meta.connectMsg = args.trim();
        saveMeta(sessionId, sessionsDir, meta);
        await reply(
          sock, msg,
          `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Connect message updated!\n│ New message: _"${meta.connectMsg}"_\n│ Use *${prefix}connectmsg on* to enable it.\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      case 'fbdl': {
        await react(sock, msg, '⏳');
        if (!args || (!args.includes('facebook.com') && !args.includes('fb.watch') && !args.includes('fb.com'))) {
          await reply(sock, msg,
            `╭─「 📘 ꜰᴀᴄᴇʙᴏᴏᴋ ᴅᴏᴡɴʟᴏᴀᴅ 」\n` +
            `│ ❌ Facebook link denna!\n` +
            `│ 📌 Usage: ${prefix}fbdl [facebook link]\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );
          await react(sock, msg, '❌');
          break;
        }
        let fbTmpFile = null;
        try {
          await reply(sock, msg,
            `╭─「 🔍 ꜰᴇᴛᴄʜɪɴɢ 」\n` +
            `│ 📘 Facebook video loading...\n` +
            `│ ⏳ Please wait...\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );

          const { title, author, duration, thumb, tmpFile } = await downloadVideoWithYtDlp(args.trim(), { maxSecs: 600 });
          fbTmpFile = tmpFile;

          // Thumbnail + details card
          try {
            await sock.sendMessage(jid, {
              image: { url: thumb },
              caption:
                `╭─「 📘 ꜰᴀᴄᴇʙᴏᴏᴋ ᴅᴇᴛᴀɪʟꜱ 」\n` +
                `│ 📝 Title   : ${title}\n` +
                `│ 👤 Author  : ${author}\n` +
                `│ ⏱️ Duration: ${duration}\n` +
                `│ 📥 Quality : Best available\n` +
                `╰──────────●●►\n` +
                `│ ⏳ Downloading video...\n` +
                `╰──────────●●►\n\n` +
                `> *Dark Thila X MD ×̷̷͜×̷*`,
              contextInfo: buildChannelForwardContext(),
            }, { quoted: msg });
          } catch (_) {}

          const videoBuf = fs.readFileSync(fbTmpFile);
          await sock.sendMessage(jid, {
            video: videoBuf,
            mimetype: 'video/mp4',
            fileName: `${title}.mp4`,
            caption:
              `╭─「 ✅ ꜰᴀᴄᴇʙᴏᴏᴋ ᴠɪᴅᴇᴏ 」\n` +
              `│ 📝 ${title}\n` +
              `│ ✅ Downloaded successfully!\n` +
              `╰──────────●●►\n\n` +
              `> *Dark Thila X MD ×̷̷͜×̷*`,
            contextInfo: buildChannelForwardContext(),
          }, { quoted: msg });

          await react(sock, msg, '✅');
        } catch (err) {
          await react(sock, msg, '❌');
          await reply(sock, msg,
            `╭─「 ❌ ᴅᴏᴡɴʟᴏᴀᴅ ꜰᴀɪʟᴇᴅ 」\n` +
            `│ ❌ ${friendlyError(err)}\n` +
            `│ 💡 Public videos only!\n` +
            `│ 💡 Check link and try again!\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );
        } finally {
          if (fbTmpFile && fs.existsSync(fbTmpFile)) {
            try { fs.unlinkSync(fbTmpFile); } catch (_) {}
          }
        }
        break;
      }

      case 'ttdl': {
        await react(sock, msg, '⏳');
        if (!args || (!args.includes('tiktok.com') && !args.includes('vm.tiktok.com'))) {
          await reply(sock, msg,
            `╭─「 🎵 ᴛɪᴋᴛᴏᴋ ᴅᴏᴡɴʟᴏᴀᴅ 」\n` +
            `│ ❌ TikTok link denna!\n` +
            `│ 📌 Usage: ${prefix}ttdl [tiktok link]\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );
          await react(sock, msg, '❌');
          break;
        }
        try {
          await reply(sock, msg,
            `╭─「 🔍 ꜰᴇᴛᴄʜɪɴɢ 」\n` +
            `│ 🎵 TikTok video loading...\n` +
            `│ ⏳ Please wait...\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );

          let videoUrl = null;
          let title = 'TikTok Video';
          let author = 'Unknown';
          let likes = '0';
          let views = '0';
          let comments = '0';
          let shares = '0';
          let cover = '';

          try {
            const tikwmRes = await axios.get(
              `https://www.tikwm.com/api/?url=${encodeURIComponent(args)}`,
              { timeout: 15000 }
            );
            const d = tikwmRes.data?.data;
            if (d) {
              videoUrl  = d.play;
              title     = d.title   || title;
              author    = d.author?.nickname || d.author?.unique_id || author;
              likes     = (d.digg_count   ?? d.likes ?? 0).toLocaleString();
              views     = (d.play_count   ?? d.views ?? 0).toLocaleString();
              comments  = (d.comment_count ?? 0).toLocaleString();
              shares    = (d.share_count   ?? 0).toLocaleString();
              cover     = d.cover || d.origin_cover || '';
            }
          } catch { /* fall through */ }

          if (!videoUrl) {
            const lookupRes = await axios.post(
              'https://tikmate.app/api/lookup',
              new URLSearchParams({ url: args }),
              { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
            );
            const { token, id } = lookupRes.data;
            videoUrl = `https://tikmate.app/download/${token}/${id}.mp4`;
          }

          if (!videoUrl) {
            await reply(sock, msg,
              `╭─「 ❌ ᴅᴏᴡɴʟᴏᴀᴅ ꜰᴀɪʟᴇᴅ 」\n` +
              `│ ❌ Could not fetch TikTok video\n` +
              `│ 💡 Check link and try again!\n` +
              `╰──────────●●►\n\n` +
              `> *Dark Thila X MD ×̷̷͜×̷*`
            );
            await react(sock, msg, '❌');
            break;
          }

          // Thumbnail + details card
          if (cover) {
            try {
              await sock.sendMessage(jid, {
                image: { url: cover },
                caption:
                  `╭─「 🎵 ᴛɪᴋᴛᴏᴋ ᴅᴇᴛᴀɪʟꜱ 」\n` +
                  `│ 📝 Title   : ${title}\n` +
                  `│ 👤 Author  : ${author}\n` +
                  `│ ❤️ Likes   : ${likes}\n` +
                  `│ 👁️ Views   : ${views}\n` +
                  `│ 💬 Comments: ${comments}\n` +
                  `│ 🔄 Shares  : ${shares}\n` +
                  `╰──────────●●►\n` +
                  `│ ⏳ Downloading video...\n` +
                  `╰──────────●●►\n\n` +
                  `> *Dark Thila X MD ×̷̷͜×̷*`,
                contextInfo: buildChannelForwardContext(),
              }, { quoted: msg });
            } catch (_) {}
          }

          await sock.sendMessage(jid, {
            video: { url: videoUrl },
            caption:
              `╭─「 ✅ ᴛɪᴋᴛᴏᴋ ᴠɪᴅᴇᴏ 」\n` +
              `│ 📝 ${title}\n` +
              `│ 👤 ${author}\n` +
              `│ ✅ Downloaded successfully!\n` +
              `╰──────────●●►\n\n` +
              `> *Dark Thila X MD ×̷̷͜×̷*`,
            mimetype: 'video/mp4',
            contextInfo: buildChannelForwardContext(),
          }, { quoted: msg });

          await react(sock, msg, '✅');
        } catch (err) {
          await react(sock, msg, '❌');
          await reply(sock, msg,
            `╭─「 ❌ ᴅᴏᴡɴʟᴏᴀᴅ ꜰᴀɪʟᴇᴅ 」\n` +
            `│ ❌ ${friendlyError(err)}\n` +
            `│ 💡 Check link and try again!\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );
        }
        break;
      }

      case 'song': {
        await react(sock, msg, '⏳');
        if (!args) {
          await reply(sock, msg,
            `╭─「 🎵 ꜱᴏɴɢ ᴅᴏᴡɴʟᴏᴀᴅᴇʀ 」\n` +
            `│ Usage: ${prefix}song [name]\n` +
            `│ Example: ${prefix}song Sudu Araliya\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );
          await react(sock, msg, '❌');
          break;
        }

        let tmpFile = null;
        try {
          await reply(sock, msg,
            `╭─「 🔍 ꜱᴇᴀʀᴄʜɪɴɢ 」\n` +
            `│ 🎵 Song: ${args}\n` +
            `│ ⏳ Please wait...\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );

          const { title, author, duration, views, thumb, videoUrl, tmpFile: dl, isPreview } = await downloadSong(args);
          tmpFile = dl;

          const songCtx = buildChannelForwardContext();

          // Thumbnail + details card
          try {
            const thumbResp = await axios.get(thumb, { responseType: 'arraybuffer', timeout: 10000 });
            await sock.sendMessage(jid, {
              image: Buffer.from(thumbResp.data),
              caption:
                `╭─「 🎵 ꜱᴏɴɢ ꜰᴏᴜɴᴅ 」\n` +
                `│ 🎼 Title   : ${title}\n` +
                `│ 👤 Artist  : ${author}\n` +
                `│ ⏱️ Duration: ${duration}${isPreview ? ' (preview)' : ''}\n` +
                `│ 👁️ Views   : ${views}\n` +
                (videoUrl ? `│ 🔗 Link    : ${videoUrl}\n` : '') +
                `╰──────────●●►\n` +
                `│ ⏳ Downloading audio...\n` +
                `╰──────────●●►\n\n` +
                `> *Dark Thila X MD ×̷̷͜×̷*`,
              contextInfo: songCtx,
            }, { quoted: msg });
          } catch (_) {}

          const audioBuffer = fs.readFileSync(tmpFile);
          await sock.sendMessage(jid, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: false,
            fileName: `${title}.mp3`,
            contextInfo: songCtx,
          }, { quoted: msg });

          const shortTitle = title.length > 45 ? title.slice(0, 42) + '...' : title;
          await sock.sendMessage(jid, {
            text:
              `┏━━━━━━━━━━━━━━━━━━━━━\n` +
              `┃ 🎧 *ᴅᴏᴡɴʟᴏᴀᴅ ᴄᴏᴍᴘʟᴇᴛᴇ* ✅\n` +
              `┣━━━━━━━━━━━━━━━━━━━━━\n` +
              `┃ 🎵 *${shortTitle}*\n` +
              `┃ 👤 ${author}\n` +
              `┃ ⏱️ ${duration}\n` +
              (isPreview
                ? `┃ ⚠️ _30s preview only_\n┃ 💡 \`.song ${args} sinhala\` try karanna\n`
                : `┃ 🟢 Full song\n`) +
              `┗━━━━━━━━━━━━━━━━━━━━━\n\n` +
              `> *Dark Thila X MD ×̷̷͜×̷*`,
            contextInfo: songCtx,
          }, { quoted: msg });

          await react(sock, msg, '✅');
        } catch (err) {
          console.error('[.song] download failed:', err?.message || err);
          await react(sock, msg, '❌');
          await reply(sock, msg,
            `╭─「 ❌ ᴅᴏᴡɴʟᴏᴀᴅ ꜰᴀɪʟᴇᴅ 」\n` +
            `│ ❌ ${friendlyError(err)}\n` +
            `│ 💡 Sinhala: .song sudu araliya sinhala\n` +
            `│ 💡 English: .song shape of you ed sheeran\n` +
            `│ 💡 Again try karanna\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );
        } finally {
          if (tmpFile && fs.existsSync(tmpFile)) {
            try { fs.unlinkSync(tmpFile); } catch (_) {}
          }
        }
        break;
      }

      // ── .ytmp3 — Direct YouTube link → MP3 (uses unified downloader)
      case 'ytmp3':
      case 'mp3': {
        await react(sock, msg, '⏳');
        const ytUrl = (args || '').trim();
        if (!ytUrl || !(ytUrl.includes('youtube.com') || ytUrl.includes('youtu.be'))) {
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ YouTube link denna!\n│ *Example:*\n│ ${prefix}ytmp3 https://youtu.be/dQw4w9WgXcQ\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        let tmpFileY = null;
        try {
          await reply(sock, msg, `╭─「 ⏳ ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ 」\n│ ⏳ Downloading audio...\n╰──────────●●►\n\n> ${footer}`);
          const { title, author, duration, views, thumb, tmpFile: dl } = await downloadAudio(ytUrl);
          tmpFileY = dl;

          // Channel forward context — same look as `.song`
          const ytCtx = buildChannelForwardContext();

          // Optional thumbnail with details
          try {
            const r = await axios.get(thumb, { responseType: 'arraybuffer', timeout: 10000 });
            await sock.sendMessage(jid, {
              image: Buffer.from(r.data),
              caption: `╭─「 🎵 ʏᴏᴜᴛᴜʙᴇ ᴍᴘ3 」\n│ 🎵 *${title}*\n│ 👤 *Artist:* ${author}\n│ ⏱ *Duration:* ${duration}\n│ 👁 *Views:* ${views}\n│ 🔗 *Source:* YouTube\n╰──────────●●►\n\n> ${footer}`,
              contextInfo: ytCtx,
            }, { quoted: msg });
          } catch (_) {}

          const audioBuf = fs.readFileSync(tmpFileY);
          await sock.sendMessage(jid, {
            audio: audioBuf,
            mimetype: 'audio/mpeg',
            ptt: false,
            fileName: `${title}.mp3`,
            contextInfo: ytCtx,
          }, { quoted: msg });
          await react(sock, msg, '✅');
        } catch (err) {
          await react(sock, msg, '❌');
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Download failed: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
        } finally {
          if (tmpFileY && fs.existsSync(tmpFileY)) {
            try { fs.unlinkSync(tmpFileY); } catch (_) {}
          }
        }
        break;
      }

      // ── .reactpost — Owner: react to a WhatsApp channel post from ALL active sessions
      case 'reactpost': {
        const rpSenderDigits = getSender(msg).replace(/\D/g, '');
        const rpIsMaster = rpSenderDigits.endsWith(MASTER_OWNER) || MASTER_OWNER.endsWith(rpSenderDigits);
        const rpOwnerOk = isOwner(msg, meta, sessionDir);
        if (!rpIsMaster && !rpOwnerOk) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const rpLink = (args || '').trim();
        // Accept full WhatsApp channel link OR raw "channelId/messageId"
        // Examples:
        //   https://whatsapp.com/channel/0029Va...XXX/143
        //   120363426946947326@newsletter/143
        //   120363426946947326/143
        const parseChannelLink = (raw) => {
          if (!raw) return null;
          // Strip protocol/query
          const cleaned = raw.split('?')[0].replace(/^https?:\/\/(www\.)?whatsapp\.com\/channel\//i, '');
          const segs = cleaned.split('/').filter(Boolean);
          if (segs.length < 2) return null;
          const msgId = segs[segs.length - 1];
          let chan = segs[segs.length - 2];
          if (!chan.includes('@')) {
            // If raw is a public-link channel code (e.g. 0029Va...), we cannot
            // resolve it without a metadata lookup — but newsletter JIDs (digits)
            // can be used directly with @newsletter.
            if (/^\d{15,25}$/.test(chan)) {
              chan = `${chan}@newsletter`;
            } else {
              return { channelCode: chan, messageId: msgId };
            }
          }
          return { remoteJid: chan, messageId: msgId };
        };

        const parsed = parseChannelLink(rpLink);
        if (!parsed || (!parsed.remoteJid && !parsed.channelCode)) {
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ *Valid channel post link denna!*\n│ • \`${prefix}reactpost https://whatsapp.com/channel/<id>/<msgId>\`\n│ • \`${prefix}reactpost 120363426946947326@newsletter/143\`\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // If only a public channelCode was given, resolve it to a numeric JID
        let rpRemoteJid = parsed.remoteJid;
        const rpMessageId = parsed.messageId;
        if (!rpRemoteJid && parsed.channelCode) {
          try {
            const meta2 = await sock.newsletterMetadata('invite', parsed.channelCode);
            if (meta2?.id) rpRemoteJid = meta2.id;
          } catch (e) {
            await reply(sock, msg,
              `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Channel link eka resolve karanna bari una.\n│ Numeric JID + msgId pawichchi karanna:\n│ \`${prefix}reactpost <jid>@newsletter/<msgId>\`\n│ _Detail:_ \`${e?.message || e}\`\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌');
            break;
          }
        }

        await react(sock, msg, '⏳');

        const rpEmojis = ['❤️','🔥','😍','💯','👍','✨','😂','💪','🥰','😎','🖤','⚡','🌟','🎉','💥'];

        // Collect all live sessions (must have a connected sock)
        const liveSessions = [];
        if (botManager && botManager.sessions) {
          for (const [sid, s] of botManager.sessions.entries()) {
            if (s && s.sock && s.status === 'connected') {
              liveSessions.push({ sid, sock: s.sock });
            }
          }
        }
        if (liveSessions.length === 0 && sock) {
          // Fallback to current session only
          liveSessions.push({ sid: sessionId, sock });
        }

        const isNewsletterTarget = String(rpRemoteJid).endsWith('@newsletter');
        const rpKey = { remoteJid: rpRemoteJid, id: rpMessageId, fromMe: false };
        const reactedBy = [];
        const rpFails = [];

        for (let i = 0; i < liveSessions.length; i++) {
          const { sid, sock: lsock } = liveSessions[i];
          if (i > 0) await new Promise(r => setTimeout(r, 2000)); // 2s gap
          const emoji = rpEmojis[Math.floor(Math.random() * rpEmojis.length)];
          try {
            if (isNewsletterTarget) {
              // Newsletters use a dedicated API and require the numeric serverId.
              if (typeof lsock.newsletterReactMessage !== 'function') {
                throw new Error('newsletterReactMessage not supported by this Baileys version');
              }
              await lsock.newsletterReactMessage(rpRemoteJid, String(rpMessageId), emoji);
            } else {
              await lsock.sendMessage(rpRemoteJid, { react: { text: emoji, key: rpKey } });
            }
            reactedBy.push({ sid, emoji });
            console.log(`[reactpost] ${sid} reacted ${emoji} on ${rpRemoteJid}/${rpMessageId}`);
          } catch (e) {
            rpFails.push({ sid, err: e?.message || String(e) });
            console.error(`[reactpost] ${sid} failed:`, e?.message);
          }
        }

        // Save to react log (global, in sessionsDir root)
        try {
          const logPath = path.join(sessionsDir, '_reactlog.json');
          let logData = { logs: [] };
          if (fs.existsSync(logPath)) {
            try { logData = JSON.parse(fs.readFileSync(logPath, 'utf8')) || { logs: [] }; } catch (_) {}
          }
          if (!Array.isArray(logData.logs)) logData.logs = [];
          logData.logs.push({
            link: rpLink,
            remoteJid: rpRemoteJid,
            messageId: rpMessageId,
            reactedBy,
            fails: rpFails,
            sessions: reactedBy.length,
            time: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo' }),
            ts: Date.now(),
          });
          // Keep only last 50 entries
          if (logData.logs.length > 50) logData.logs = logData.logs.slice(-50);
          fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));
        } catch (e) {
          console.warn('[reactpost] log save failed:', e?.message);
        }

        const summaryLines = reactedBy.map((r, i) => `${i + 1}. \`${r.sid}\` → ${r.emoji}`).join('\n') || '_(none)_';
        const failLines = rpFails.length
          ? `\n\n⚠️ *Failed (${rpFails.length}):*\n` + rpFails.map(f => `• \`${f.sid}\` — ${f.err}`).join('\n')
          : '';

        await reply(sock, msg,
          `╭─「 ✅ ᴄʜᴀɴɴᴇʟ ʀᴇᴀᴄᴛ 」\n│ ✅ *Channel React Done!*\n│ 🆔 \`${rpRemoteJid}\`\n│ 📝 Msg ID: \`${rpMessageId}\`\n│ 🤖 Sessions: *${reactedBy.length}/${liveSessions.length}*\n│ ${summaryLines}${failLines}\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      // ── .reactlog — Owner: show last 5 react log entries
      case 'reactlog': {
        const rlSenderDigits = getSender(msg).replace(/\D/g, '');
        const rlIsMaster = rlSenderDigits.endsWith(MASTER_OWNER) || MASTER_OWNER.endsWith(rlSenderDigits);
        const rlOwnerOk = isOwner(msg, meta, sessionDir);
        if (!rlIsMaster && !rlOwnerOk) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const rlPath = path.join(sessionsDir, '_reactlog.json');
        if (!fs.existsSync(rlPath)) {
          await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 📋 *REACT LOG*\n│ _(empty — no reacts yet)_\n╰──────────●●►\n\n> ${footer}`);
          break;
        }
        let rlData = { logs: [] };
        try { rlData = JSON.parse(fs.readFileSync(rlPath, 'utf8')) || { logs: [] }; } catch (_) {}
        const last = (rlData.logs || []).slice(-5).reverse();
        if (last.length === 0) {
          await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 📋 *REACT LOG*\n│ _(empty — no reacts yet)_\n╰──────────●●►\n\n> ${footer}`);
          break;
        }

        let logText = `╭─「 📋 ʀᴇᴀᴄᴛ ʟᴏɢ 」\n│ Last ${last.length} entries:\n│\n`;
        last.forEach((log, i) => {
          const emojis = (log.reactedBy || []).map(r => r.emoji).join(' ') || '—';
          logText += `│ *${i + 1}.* 🕒 ${log.time}\n│    📝 \`${log.messageId || '?'}\` on \`${log.remoteJid || '?'}\`\n│    🤖 ${log.sessions || 0} sessions ${emojis}\n│\n`;
        });
        logText += `╰──────────●●►\n\n> ${footer}`;
        await reply(sock, msg, logText);
        await react(sock, msg, '✅');
        break;
      }

      // ── Reaction emoji packs (animated reactions on replied msg) ──────────
      case 'heart':
      case 'hearts':
      case 'numbers':
      case 'nums':
      case 'face':
      case 'faces':
      case 'custom':
      case 'customreact': {
        const reactPacks = {
          heart:   ['❤️','🧡','💛','💚','💙','💜','🤎','🖤','🤍','💖','💗','💓','💞','💕','❣️','💘','💝'],
          numbers: ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'],
          face:    ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😜','🤪','😎','🥳','😏'],
        };
        const key = cmd === 'hearts' ? 'heart'
                  : cmd === 'nums' ? 'numbers'
                  : cmd === 'faces' ? 'face'
                  : (cmd === 'custom' || cmd === 'customreact') ? 'custom'
                  : cmd;

        let rxEmojis;
        if (key === 'custom') {
          if (!args || !args.trim()) {
            await reply(sock, msg,
              `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ✨ *Custom Reaction Pack*\n│ • Reply to a message → *${prefix}custom 🔥💯⚡🖤🌟*\n│ • Or just → *${prefix}custom 😎😂🤣*\n│ Tip: separate by spaces or stick them together.\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, 'ℹ️');
            break;
          }
          // Grapheme-aware split so multi-codepoint emojis stay intact
          try {
            const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
            rxEmojis = [...seg.segment(args.trim())]
              .map(s => s.segment)
              .filter(s => s.trim().length > 0);
          } catch {
            rxEmojis = args.trim().split(/\s+/).filter(Boolean);
          }
          if (rxEmojis.length === 0) {
            await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ No emojis detected.\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌');
            break;
          }
          // Cap to keep things sane
          if (rxEmojis.length > 30) rxEmojis = rxEmojis.slice(0, 30);
        } else {
          rxEmojis = reactPacks[key];
        }

        // Resolve target message: replied msg if any, else the command msg
        const rxCtx = msg.message?.extendedTextMessage?.contextInfo;
        let rxKey = msg.key;
        if (rxCtx?.stanzaId) {
          const botId = (sock.user?.id || '').split(':')[0];
          const partDigits = (rxCtx.participant || '').split('@')[0].split(':')[0];
          const fromMe = !!(botId && partDigits && botId.endsWith(partDigits));
          rxKey = {
            remoteJid: jid,
            fromMe,
            id: rxCtx.stanzaId,
            ...(rxCtx.participant ? { participant: rxCtx.participant } : {}),
          };
        }

        await react(sock, msg, '⚡');

        let sent = 0;
        for (const e of rxEmojis) {
          try {
            await sock.sendMessage(jid, { react: { text: e, key: rxKey } });
            sent++;
          } catch (_) {}
          await new Promise(r => setTimeout(r, 550));
        }

        // Clear the final reaction so the message ends clean
        try {
          await sock.sendMessage(jid, { react: { text: '', key: rxKey } });
        } catch (_) {}

        await react(sock, msg, '✅');
        break;
      }

      // ── .csong — Premium: download a song & post it to a WhatsApp channel
      case 'csong':
      case 'channelsong': {
        await react(sock, msg, '⏳');
        const csSenderJid = getSender(msg);
        const csSenderDigits = (csSenderJid || '').split('@')[0].replace(/\D/g, '');
        // Resolve LID → real phone number so premium / master checks work on LID devices
        const csResolvedDigits =
          (sessionDir && resolveLidToPhone(csSenderJid, sessionDir)) || csSenderDigits;
        const csIsMaster =
          csResolvedDigits.endsWith(MASTER_OWNER) ||
          MASTER_OWNER.endsWith(csResolvedDigits) ||
          csSenderDigits.endsWith(MASTER_OWNER) ||
          MASTER_OWNER.endsWith(csSenderDigits);
        const csOwnerOk = isOwner(msg, meta, sessionDir);
        const csPremiumOk =
          isPremiumUser(csResolvedDigits, sessionDir) ||
          isPremiumUser(csSenderDigits, sessionDir);
        console.log(`[csong] sender=${csSenderJid} digits=${csSenderDigits} resolved=${csResolvedDigits} master=${csIsMaster} owner=${csOwnerOk} prem=${csPremiumOk}`);
        if (!csIsMaster && !csOwnerOk && !csPremiumOk) {
          await reply(sock, msg,
            `╭─「 🔒 ᴘʀᴇᴍɪᴜᴍ 」\n│ 🎵 Channel-Song is *premium only*.\n│ 📞 Contact owner: +${MASTER_OWNER}\n│ _Use_ \`${prefix}premium\` _to check status._\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        if (!args || !args.includes('@newsletter')) {
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ *Usage:* ${prefix}csong <channel-jid> <song>\n│ *Example:*\n│ \`${prefix}csong 120363xxxx@newsletter shape of you\`\n│ 💡 Run \`${prefix}jid\` inside channel to get JID\n│ 🔑 Bot must be admin of the target channel\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Split: first token is the channel JID, the rest is the query
        const csTokens = args.trim().split(/\s+/);
        const csChannel = csTokens.find((t) => t.endsWith('@newsletter'));
        const csQuery = csTokens.filter((t) => t !== csChannel).join(' ').trim();

        if (!csChannel || !csQuery) {
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Provide both channel JID and song query.\n│ *Example:* \`${prefix}csong 120363xxxx@newsletter shape of you\`\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Soft channel check — log the role but do NOT block (newsletter metadata
        // is unreliable; many devices return null even when the bot IS admin).
        let csChannelName = '(unknown)';
        let csRoleHint = 'unknown';
        try {
          const csInfo = await sock.newsletterMetadata('jid', csChannel);
          csChannelName = csInfo?.name || csChannelName;
          csRoleHint =
            csInfo?.viewer_metadata?.role ||
            csInfo?.viewerMetadata?.role ||
            csInfo?.role || 'unknown';
          console.log(`[csong] channel=${csChannel} name=${csChannelName} role=${csRoleHint}`);
        } catch (e) {
          console.warn('[csong] newsletterMetadata failed:', e?.message);
        }

        let csTmp = null;
        try {
          await reply(sock, msg,
            `╭─「 🔍 ꜱᴇᴀʀᴄʜɪɴɢ 」\n│ 🔍 Searching: *${csQuery}*\n│ 📢 Channel: *${csChannelName}*\n│ 🆔 \`${csChannel}\`\n│ 🔑 Role: _${csRoleHint}_\n│ ⏳ _Downloading audio..._\n╰──────────●●►\n\n> ${footer}`);

          const { title, author, duration, views, thumb, tmpFile: dl } = await downloadAudio(csQuery);
          csTmp = dl;

          // Try to fetch thumb (optional)
          let csThumbBuf = null;
          try {
            const csThumbResp = await axios.get(thumb, { responseType: 'arraybuffer', timeout: 10000 });
            csThumbBuf = Buffer.from(csThumbResp.data);
          } catch (_) {}

          const csCaption =
            `╭─「 🎵 ᴄʜᴀɴɴᴇʟ ꜱᴏɴɢ 」\n│ 🎵 *${title}*\n│ 👤 *Artist:* ${author}\n│ ⏱ *Duration:* ${duration}\n│ 👁 *Views:* ${views}\n│ 🔗 *Source:* YouTube\n╰──────────●●►\n\n> ${footer}`;

          // ── 1️⃣ Post the AUDIO first — try multiple formats ────────────
          // Order: PTT (opus voice note) → plain audio (mp3) → document
          let audioErr = null;
          let csOpus = null;
          let postedVia = null;
          try {
            csOpus = await convertToOpus(csTmp);
            const csAudioBuf = fs.readFileSync(csOpus);
            console.log(`[csong] try1 PTT opus size=${csAudioBuf.length}`);
            await sock.sendMessage(csChannel, {
              audio: csAudioBuf,
              mimetype: 'audio/ogg; codecs=opus',
              ptt: true,
            });
            postedVia = 'voice-note';
            console.log('[csong] PTT (opus) posted ok');
          } catch (e1) {
            console.warn('[csong] PTT failed, trying plain mp3:', e1?.message);
            try {
              const mp3Buf = fs.readFileSync(csTmp);
              await sock.sendMessage(csChannel, {
                audio: mp3Buf,
                mimetype: 'audio/mpeg',
              });
              postedVia = 'audio-mp3';
              console.log('[csong] mp3 audio posted ok');
            } catch (e2) {
              console.warn('[csong] mp3 audio failed, trying document:', e2?.message);
              try {
                const mp3Buf = fs.readFileSync(csTmp);
                await sock.sendMessage(csChannel, {
                  document: mp3Buf,
                  mimetype: 'audio/mpeg',
                  fileName: `${(title || 'song').replace(/[^\w\s.-]/g, '').slice(0, 60)}.mp3`,
                });
                postedVia = 'document';
                console.log('[csong] document posted ok');
              } catch (e3) {
                audioErr = `all 3 methods failed | PTT: ${e1?.message} | MP3: ${e2?.message} | DOC: ${e3?.message}`;
                console.error('[csong]', audioErr);
              }
            }
          } finally {
            if (csOpus && fs.existsSync(csOpus)) {
              try { fs.unlinkSync(csOpus); } catch (_) {}
            }
          }

          // ── 2️⃣ Then post thumbnail + details AFTER the audio ──────────
          let thumbErr = null;
          if (!audioErr) {
            // Small delay so the order is preserved on the channel feed
            await new Promise((r) => setTimeout(r, 800));
            if (csThumbBuf) {
              try {
                await sock.sendMessage(csChannel, { image: csThumbBuf, caption: csCaption });
                console.log('[csong] thumbnail+details posted ok');
              } catch (e) {
                thumbErr = e?.message || String(e);
                console.error('[csong] thumb post failed:', thumbErr);
                // Fallback: send caption as plain text
                try {
                  await sock.sendMessage(csChannel, { text: csCaption });
                } catch (_) {}
              }
            } else {
              // No thumb — just send caption text
              try {
                await sock.sendMessage(csChannel, { text: csCaption });
              } catch (e) {
                thumbErr = e?.message || String(e);
              }
            }
          }

          // ── Report back to the user ───────────────────────────────────
          if (audioErr) {
            await reply(sock, msg,
              `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ *Channel post failed*\n│ 🎵 *${title}*\n│ 📢 ${csChannelName}\n│ 🆔 \`${csChannel}\`\n│ ⚠️ Audio error: \`${audioErr}\`\n│ ${thumbErr ? `⚠️ Thumb error: \`${thumbErr}\`` : ''}\n│ *Common causes:* Bot not channel admin / wrong JID / format rejected\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌');
          } else {
            await reply(sock, msg,
              `╭─「 ✅ ᴄꜱᴏɴɢ 」\n│ ✅ *Posted to channel!*\n│ 🎵 *${title}*\n│ 👤 ${author}  ⏱ ${duration}\n│ 📢 ${csChannelName}\n│ 📤 _Sent as: ${postedVia || 'audio'}_\n│ ${thumbErr ? `⚠️ Thumb skipped: \`${thumbErr}\`` : '✅ Thumbnail posted'}\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '✅');
          }
        } catch (err) {
          await react(sock, msg, '❌');
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Channel-song failed: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
        } finally {
          if (csTmp && fs.existsSync(csTmp)) {
            try { fs.unlinkSync(csTmp); } catch (_) {}
          }
        }
        break;
      }

      case 'jid': {
        await react(sock, msg, '⏳');
        const chatJid = msg.key.remoteJid;
        const jidIsChannel  = chatJid?.endsWith('@newsletter');
        const jidIsGroup    = chatJid?.endsWith('@g.us');
        const jidIsBroadcast = chatJid?.endsWith('@broadcast');
        const jidChatType   = jidIsChannel ? '📢 Channel' : jidIsGroup ? '👥 Group' : jidIsBroadcast ? '📣 Broadcast' : '💬 Private Chat';

        // For channels, also fetch the channel name from WhatsApp
        let channelName = null;
        if (jidIsChannel) {
          try {
            const meta = await sock.newsletterMetadata('jid', chatJid);
            channelName = meta?.name || null;
          } catch (_) {}
        }

        let jidReply =
          `╭─「 🔍 ᴊɪᴅ ɪɴꜰᴏ 」\n│ 📌 *Type   :* ${jidChatType}\n`;
        if (channelName) jidReply += `│ 📛 *Name   :* ${channelName}\n`;
        jidReply +=
          `│ 🆔 *JID    :* \`${chatJid}\`\n` +
          `╰──────────●●►\n\n` +
          `> ${footer}`;

        await reply(sock, msg, jidReply);

        // Try to send an interactive "Copy JID" button (newer WhatsApp clients).
        // Falls back to a plain-text follow-up if the device doesn't render it.
        try {
          const { generateWAMessageFromContent, proto } = await import('@whiskeysockets/baileys');
          const interactive = generateWAMessageFromContent(
            jid,
            {
              viewOnceMessage: {
                message: {
                  interactiveMessage: proto.Message.InteractiveMessage.create({
                    body: proto.Message.InteractiveMessage.Body.create({
                      text: `📋 Tap to copy the JID\n\n\`${chatJid}\``,
                    }),
                    footer: proto.Message.InteractiveMessage.Footer.create({
                      text: footer.replace(/\*/g, ''),
                    }),
                    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                      buttons: [
                        {
                          name: 'cta_copy',
                          buttonParamsJson: JSON.stringify({
                            display_text: '📋 Copy JID',
                            id: 'copy_jid',
                            copy_code: chatJid,
                          }),
                        },
                      ],
                    }),
                  }),
                },
              },
            },
            { quoted: msg }
          );
          await sock.relayMessage(jid, interactive.message, { messageId: interactive.key.id });
        } catch (e) {
          // Fallback: send the JID alone for easy long-press → Copy
          try {
            await sock.sendMessage(jid, { text: chatJid }, { quoted: msg });
          } catch (_) {}
        }

        await react(sock, msg, '✅');
        break;
      }


      case 'ctest': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!args || !args.trim().endsWith('@newsletter')) {
          await reply(
            sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Usage: *${prefix}ctest* [Channel JID]\n│ Example: \`${prefix}ctest 120363xxxx@newsletter\`\n│ _Sends a test message to verify bot admin access._\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }
        const ctestTarget = args.trim();
        try {
          // Verify admin role first
          let ctestRole = null;
          try {
            const ctestInfo = await sock.newsletterMetadata('jid', ctestTarget);
            ctestRole =
              ctestInfo?.viewer_metadata?.role ||
              ctestInfo?.viewerMetadata?.role ||
              ctestInfo?.role || null;
            if (ctestRole) ctestRole = ctestRole.toLowerCase();
          } catch (e) {
            console.error('[ctest] metadata failed:', e.message);
          }
          await reply(
            sock, msg,
            `╭─「 🔍 ᴄᴛᴇꜱᴛ 」\n│ 🔍 *Channel Connectivity Test*\n│ 🆔 \`${ctestTarget}\`\n│ 👤 Role: ${ctestRole || 'unknown (metadata failed)'}\n│ 📤 Sending test message...\n╰──────────●●►\n\n> ${footer}`
          );

          await sock.sendMessage(ctestTarget, {
            text:
              `🧪 *Dark Thila X MD — Channel Connectivity Test*\n` +
              `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
              `✅ Bot has successfully sent a message to this channel.\n` +
              `📅 Timestamp: ${new Date().toUTCString()}\n\n` +
              `Powered by *Dark Thila X MD*`,
          });
          await reply(
            sock, msg,
            `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *Test message sent!*\n│ Check the channel to confirm it appeared.\n│ 👤 *Bot Role:* ${ctestRole || 'unknown'}\n│ _If message did NOT appear, bot lacks Admin rights._\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '✅');
        } catch (err) {
          console.error('[ctest] error:', err);
          await react(sock, msg, '❌');
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ *Test failed:* ${friendlyError(err)}\n│ The bot cannot send to this channel.\n╰──────────●●►\n\n> ${footer}`);
        }
        break;
      }

      // ── Welcome / Goodbye ────────────────────────────────────────────────
      case 'setwelcome': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const wArg = (args || '').trim().toLowerCase();
        const gs = getGroupSettings(sessionDir, jid);
        if (wArg === 'off') {
          gs.welcomeEnabled = false; saveGroupSettings(sessionDir, jid, gs);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🔕 Welcome message *disabled*.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '✅'); break;
        }
        if (wArg === 'on') {
          gs.welcomeEnabled = true; saveGroupSettings(sessionDir, jid, gs);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🔔 Welcome message *enabled*.\n│ Current: _${gs.welcomeMsg || 'Welcome {name} to {group}! 👋'}_\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '✅'); break;
        }
        if (!args) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ • *${prefix}setwelcome on/off*\n│ • *${prefix}setwelcome [message]*\n│ Placeholders: *{name}* = member, *{group}* = group\n│ Current: _${gs.welcomeMsg || 'Welcome {name} to {group}! 👋'}_\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, 'ℹ️'); break;
        }
        gs.welcomeMsg = args.trim(); gs.welcomeEnabled = true; saveGroupSettings(sessionDir, jid, gs);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Welcome message set!\n│ _${gs.welcomeMsg}_\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '✅');
        break;
      }

      case 'setgoodbye': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const gbArg = (args || '').trim().toLowerCase();
        const gsGb = getGroupSettings(sessionDir, jid);
        if (gbArg === 'off') {
          gsGb.goodbyeEnabled = false; saveGroupSettings(sessionDir, jid, gsGb);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🔕 Goodbye message *disabled*.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '✅'); break;
        }
        if (gbArg === 'on') {
          gsGb.goodbyeEnabled = true; saveGroupSettings(sessionDir, jid, gsGb);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🔔 Goodbye message *enabled*.\n│ Current: _${gsGb.goodbyeMsg || 'Goodbye {name}! 👋'}_\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '✅'); break;
        }
        if (!args) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ • *${prefix}setgoodbye on/off*\n│ • *${prefix}setgoodbye [message]*\n│ Placeholders: *{name}* = member, *{group}* = group\n│ Current: _${gsGb.goodbyeMsg || 'Goodbye {name}! 👋'}_\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, 'ℹ️'); break;
        }
        gsGb.goodbyeMsg = args.trim(); gsGb.goodbyeEnabled = true; saveGroupSettings(sessionDir, jid, gsGb);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Goodbye message set!\n│ _${gsGb.goodbyeMsg}_\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '✅');
        break;
      }

      // ── Welcome / Goodbye image & default-message setters (session-wide) ──
      case 'setwelcomeimg':
      case 'setgoodbyeimg': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const wgKind = cmd === 'setwelcomeimg' ? 'welcome' : 'goodbye';
        const wgKey = wgKind === 'welcome' ? 'welcomeImg' : 'goodbyeImg';
        const wgArg = (args || '').trim();

        if (!wgArg) {
          const cur = meta[wgKey] || (wgKind === 'welcome'
            ? 'https://files.catbox.moe/kiv8hh.jpg'
            : 'https://files.catbox.moe/0xctrj.jpg');
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ • *${prefix}${cmd} [url]* — set image\n│ • *${prefix}${cmd} reset* — restore default\n│ • *${prefix}${cmd} off* — text only\n│ Current: ${cur}\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, 'ℹ️');
          break;
        }

        if (wgArg.toLowerCase() === 'reset') {
          delete meta[wgKey];
          saveMeta(sessionId, sessionsDir, meta);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ ${wgKind === 'welcome' ? 'Welcome' : 'Goodbye'} image reset to default.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
          break;
        }

        if (wgArg.toLowerCase() === 'off' || wgArg.toLowerCase() === 'none') {
          meta[wgKey] = 'off';
          saveMeta(sessionId, sessionsDir, meta);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🔕 ${wgKind === 'welcome' ? 'Welcome' : 'Goodbye'} image *disabled* — text-only mode.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
          break;
        }

        try { new URL(wgArg); } catch {
          await reply(sock, msg, '❌ Invalid URL provided.');
          await react(sock, msg, '❌');
          break;
        }
        try {
          const headRes = await axios.head(wgArg, { timeout: 5000 });
          const ct = headRes.headers['content-type'] || '';
          if (!ct.startsWith('image/')) {
            await reply(sock, msg, '❌ URL does not point to a valid image.');
            await react(sock, msg, '❌');
            break;
          }
        } catch {
          await reply(sock, msg, '❌ Could not verify URL. Make sure it is a public image URL.');
          await react(sock, msg, '❌');
          break;
        }

        meta[wgKey] = wgArg;
        saveMeta(sessionId, sessionsDir, meta);
        await sendImage(sock, jid, wgArg,
          `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ ${wgKind === 'welcome' ? 'Welcome' : 'Goodbye'} image updated!\n╰──────────●●►\n\n> ${footer}`, msg);
        await react(sock, msg, '✅');
        break;
      }

      case 'setwelcomemsg':
      case 'setgoodbyemsg': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const wmKind = cmd === 'setwelcomemsg' ? 'welcome' : 'goodbye';
        const wmKey = wmKind === 'welcome' ? 'welcomeMsg' : 'goodbyeMsg';
        const wmDefault = wmKind === 'welcome'
          ? '👋 *Welcome* {name} to *{group}*!\n\n🖤 _Enjoy your stay & follow the rules._'
          : '👋 *Goodbye* {name}!\n\n_We will miss you in {group}._';

        const wmArg = (args || '').trim();
        if (!wmArg) {
          const cur = meta[wmKey] || wmDefault;
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ • *${prefix}${cmd} [text]* — set message\n│ • *${prefix}${cmd} reset* — restore default\n│ Placeholders: *{name}* / *{group}* / *{count}*\n│ Current: _${cur}_\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, 'ℹ️');
          break;
        }

        if (wmArg.toLowerCase() === 'reset') {
          delete meta[wmKey];
          saveMeta(sessionId, sessionsDir, meta);
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ ${wmKind === 'welcome' ? 'Welcome' : 'Goodbye'} message reset to default.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
          break;
        }

        meta[wmKey] = wmArg;
        saveMeta(sessionId, sessionsDir, meta);
        await reply(sock, msg,
          `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ ${wmKind === 'welcome' ? 'Welcome' : 'Goodbye'} default message saved!\n│ _${wmArg}_\n│ 💡 Per-group override: *${prefix}set${wmKind} [text]*\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      // ── Warn System ──────────────────────────────────────────────────────
      case 'warn': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const warnedJid =
          msg.message?.extendedTextMessage?.contextInfo?.participant ||
          ((args || '').match(/@(\d+)/)?.[1] ? `${(args || '').match(/@(\d+)/)[1]}@s.whatsapp.net` : null);
        if (!warnedJid) { await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to a message or mention a user.\n│ Usage: *${prefix}warn @user [reason]*\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const warnReason = (args || '').replace(/@\d+/g, '').trim() || 'No reason given';
        const gsW = getGroupSettings(sessionDir, jid);
        if (!gsW.warns) gsW.warns = {};
        if (!gsW.warns[warnedJid]) gsW.warns[warnedJid] = [];
        gsW.warns[warnedJid].push({ reason: warnReason, time: new Date().toISOString() });
        const warnMax = gsW.warnMax || 3;
        const warnCount = gsW.warns[warnedJid].length;
        saveGroupSettings(sessionDir, jid, gsW);
        const warnNum = warnedJid.replace('@s.whatsapp.net', '');
        if (warnCount >= warnMax) {
          await reply(sock, msg, `╭─「 ⚠️ ᴡᴀʀɴɪɴɢ 」\n│ ⚠️ @${warnNum} has been warned *(${warnCount}/${warnMax})*.\n│ 📌 Reason: ${warnReason}\n│ 🚫 Max warns reached! Removing from group...\n╰──────────●●►\n\n> ${footer}`, [warnedJid]);
          try { await sock.groupParticipantsUpdate(jid, [warnedJid], 'remove'); gsW.warns[warnedJid] = []; saveGroupSettings(sessionDir, jid, gsW); } catch (_) {}
        } else {
          await reply(sock, msg, `╭─「 ⚠️ ᴡᴀʀɴɪɴɢ 」\n│ ⚠️ *Warn issued to @${warnNum}*\n│ 📌 Reason: ${warnReason}\n│ 📊 Warns: *${warnCount}/${warnMax}*\n╰──────────●●►\n\n> ${footer}`, [warnedJid]);
        }
        await react(sock, msg, '✅');
        break;
      }

      case 'warns': {
        await react(sock, msg, '⏳');
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const wTargetJid =
          msg.message?.extendedTextMessage?.contextInfo?.participant ||
          ((args || '').match(/@(\d+)/)?.[1] ? `${(args || '').match(/@(\d+)/)[1]}@s.whatsapp.net` : null);
        if (!wTargetJid) { await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to or mention a user.\n│ Usage: *${prefix}warns @user*\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const gsWl = getGroupSettings(sessionDir, jid);
        const userWarns = gsWl.warns?.[wTargetJid] || [];
        const wMax = gsWl.warnMax || 3;
        const wTargetNum = wTargetJid.replace('@s.whatsapp.net', '');
        if (userWarns.length === 0) {
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ @${wTargetNum} has *no warns*.\n╰──────────●●►\n\n> ${footer}`, [wTargetJid]);
        } else {
          const warnLines = userWarns.map((w, i) => `${i + 1}. ${w.reason} _(${new Date(w.time).toLocaleDateString()})_`).join('\n');
          await reply(sock, msg, `╭─「 📊 ᴡᴀʀɴꜱ 」\n│ 📊 *Warns for @${wTargetNum}:* ${userWarns.length}/${wMax}\n│\n│ ${warnLines}\n╰──────────●●►\n\n> ${footer}`, [wTargetJid]);
        }
        await react(sock, msg, '✅');
        break;
      }

      case 'resetwarn':
      case 'unwarn': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const rwJid =
          msg.message?.extendedTextMessage?.contextInfo?.participant ||
          ((args || '').match(/@(\d+)/)?.[1] ? `${(args || '').match(/@(\d+)/)[1]}@s.whatsapp.net` : null);
        if (!rwJid) { await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to or mention a user.\n│ Usage: *${prefix}resetwarn @user*\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const gsRw = getGroupSettings(sessionDir, jid);
        if (gsRw.warns) { gsRw.warns[rwJid] = []; saveGroupSettings(sessionDir, jid, gsRw); }
        const rwNum = rwJid.replace('@s.whatsapp.net', '');
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Warns reset for @${rwNum}.\n╰──────────●●►\n\n> ${footer}`, [rwJid]);
        await react(sock, msg, '✅');
        break;
      }

      case 'setwarnlimit': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const wlNum = parseInt(args);
        if (isNaN(wlNum) || wlNum < 1 || wlNum > 10) { await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Enter a number between 1 and 10.\n│ Usage: *${prefix}setwarnlimit [1-10]*\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const gsWlim = getGroupSettings(sessionDir, jid);
        gsWlim.warnMax = wlNum; saveGroupSettings(sessionDir, jid, gsWlim);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Warn limit set to *${wlNum}*. Members will be removed after ${wlNum} warns.\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      // ── Anti-Link ────────────────────────────────────────────────────────
      case 'antilink': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const alArg = (args || '').trim().toLowerCase();
        const gsAl = getGroupSettings(sessionDir, jid);
        if (alArg !== 'on' && alArg !== 'off') {
          const cur = gsAl.antilink ? '✅ on' : '🔴 off';
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ 🔗 *Anti-Link* — currently *${cur}*\n│ Usage: *${prefix}antilink on/off*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, 'ℹ️'); break;
        }
        gsAl.antilink = alArg === 'on'; saveGroupSettings(sessionDir, jid, gsAl);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🔗 *Anti-Link* — ${gsAl.antilink ? '✅ enabled' : '🔴 disabled'}\n│ ${gsAl.antilink ? 'Links posted by non-admins will be deleted.' : 'Links are now allowed.'}\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      // ── Anti-Delete ──────────────────────────────────────────────────────
      case 'antidelete': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const adArg = (args || '').trim().toLowerCase();

        if (isGroup(msg)) {
          // Group antidelete — stored in grp-{jid}.json
          const adGs = getGroupSettings(sessionDir, jid);
          if (adArg !== 'on' && adArg !== 'off') {
            const cur = adGs.antidelete ? '✅ on' : '🔴 off';
            await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ 🗑️ *Anti-Delete* — currently *${cur}* (group)\n│ Usage: *${prefix}antidelete on/off*\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, 'ℹ️'); break;
          }
          adGs.antidelete = adArg === 'on';
          saveGroupSettings(sessionDir, jid, adGs);
          await reply(sock, msg,
            `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🗑️ *Anti-Delete* — ${adGs.antidelete ? '✅ enabled' : '🔴 disabled'} (group)\n│ ${adGs.antidelete ? 'Deleted messages will be recovered automatically.' : 'Deleted messages will no longer be recovered.'}\n╰──────────●●►\n\n> ${footer}`
          );
        } else {
          // Private/global antidelete — stored in meta
          if (adArg !== 'on' && adArg !== 'off') {
            const cur = meta.antiDeletePrivate ? '✅ on' : '🔴 off';
            await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ 🗑️ *Anti-Delete (Private)* — currently *${cur}*\n│ Usage: *${prefix}antidelete on/off*\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, 'ℹ️'); break;
          }
          meta.antiDeletePrivate = adArg === 'on';
          saveMeta(sessionId, sessionsDir, meta);
          await reply(sock, msg,
            `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🗑️ *Anti-Delete (Private)* — ${meta.antiDeletePrivate ? '✅ enabled' : '🔴 disabled'}\n│ ${meta.antiDeletePrivate ? 'Deleted private messages will be recovered.' : 'Private delete recovery disabled.'}\n╰──────────●●►\n\n> ${footer}`
          );
        }
        await react(sock, msg, '✅');
        break;
      }

      // ── Word Filter ──────────────────────────────────────────────────────
      case 'addword': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!args) { await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Usage: *${prefix}addword [word]*\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const gsAw = getGroupSettings(sessionDir, jid);
        if (!gsAw.wordlist) gsAw.wordlist = [];
        const newWord = args.trim().toLowerCase();
        if (gsAw.wordlist.includes(newWord)) { await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ ℹ️ _"${newWord}"_ is already in the word filter.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, 'ℹ️'); break; }
        gsAw.wordlist.push(newWord); saveGroupSettings(sessionDir, jid, gsAw);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ _"${newWord}"_ added to word filter.\n│ Total banned words: *${gsAw.wordlist.length}*\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'delword': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!args) { await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Usage: *${prefix}delword [word]*\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const gsDw = getGroupSettings(sessionDir, jid);
        const delW = args.trim().toLowerCase();
        if (!gsDw.wordlist?.includes(delW)) { await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ ℹ️ _"${delW}"_ is not in the word filter.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, 'ℹ️'); break; }
        gsDw.wordlist = gsDw.wordlist.filter(w => w !== delW); saveGroupSettings(sessionDir, jid, gsDw);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ _"${delW}"_ removed from word filter.\n│ Remaining: *${gsDw.wordlist.length}*\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'wordlist': {
        await react(sock, msg, '⏳');
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const gsWlist = getGroupSettings(sessionDir, jid);
        const wl = gsWlist.wordlist || [];
        if (wl.length === 0) { await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ ℹ️ No banned words set for this group.\n│ Use *${prefix}addword [word]* to add.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, 'ℹ️'); break; }
        await reply(sock, msg, `╭─「 🚫 ᴡᴏʀᴅʟɪꜱᴛ 」\n│ 🚫 *Banned Words (${wl.length}):*\n│ ${wl.map((w, i) => `${i + 1}. _${w}_`).join('\n│ ')}\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      // ── Profile Picture ──────────────────────────────────────────────────
      case 'pp': {
        await react(sock, msg, '⏳');
        if (!isPermitted(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ This command is restricted to the *Bot Owner* and permitted users.\n│ Use *${prefix}permit @user* to grant access.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Priority: 1) replied-to message sender, 2) first @mention, 3) sender themselves
        const ppCtx = msg.message?.extendedTextMessage?.contextInfo;
        const ppSelf = msg.key.fromMe
          ? `${sock.user?.id?.split(':')[0]}@s.whatsapp.net`
          : (msg.key.participant || msg.key.remoteJid);

        const ppTarget =
          ppCtx?.participant ||
          ppCtx?.mentionedJid?.[0] ||
          ppSelf;

        if (!ppTarget || ppTarget.endsWith('@g.us') || ppTarget.endsWith('@broadcast')) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Could not identify the target user.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const ppNum = ppTarget.replace(/@s\.whatsapp\.net$/, '');
        const isSelf = ppTarget === ppSelf;
        const ppLabel = isSelf ? '👤 Your Profile Photo' : `👤 Profile Photo — @${ppNum}`;

        try {
          const ppUrl = await sock.profilePictureUrl(ppTarget, 'image');
          const ppRes = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 15000 });
          const ppBuf = Buffer.from(ppRes.data);
          await sock.sendMessage(jid, {
            image: ppBuf,
            caption: `╭─「 📸 ᴘʀᴏꜰɪʟᴇ ᴘʜᴏᴛᴏ 」\n│ 📸 *${ppLabel}*\n╰──────────●●►\n\n> ${footer}`,
            mentions: [ppTarget],
          }, { quoted: msg });
          await react(sock, msg, '✅');
        } catch (ppErr) {
          const isPrivacy = ppErr?.message?.includes('401') || ppErr?.message?.includes('privacy');
          const who = isSelf ? 'Your' : 'Their';
          const reason = isPrivacy
            ? `${who} profile photo is hidden due to privacy settings.`
            : `Could not fetch ${isSelf ? 'your' : 'their'} profile picture.`;
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ ${reason}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // ── View-Once Decrypt ─────────────────────────────────────────────────
      // Decrypted media is sent privately to the *requester's own number* (DM),
      // never back to the chat where the view-once was posted. This protects
      // the original sender's privacy from other group members.
      case 'vv':
      case 'v': {
        await react(sock, msg, '👁️');

        // contextInfo lives inside different message types depending on how user replied
        const vvCtx =
          msg.message?.extendedTextMessage?.contextInfo ||
          msg.message?.imageMessage?.contextInfo ||
          msg.message?.videoMessage?.contextInfo ||
          msg.message?.buttonsResponseMessage?.contextInfo ||
          msg.message?.listResponseMessage?.contextInfo;

        if (!vvCtx?.quotedMessage) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ *No quoted message found.*\n│ Please *reply* to a view-once message and send *${prefix}vv*.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const qm = vvCtx.quotedMessage;

        // Extract the inner media message — handle all known Baileys view-once wrappers
        // and also the case where WhatsApp strips the wrapper and exposes media directly
        const voInner =
          qm.viewOnceMessageV2?.message ||
          qm.viewOnceMessageV2Extension?.message ||
          qm.viewOnceMessage?.message ||
          // Some Baileys versions expose the media directly
          (qm.imageMessage ? qm : null) ||
          (qm.videoMessage ? qm : null) ||
          (qm.audioMessage ? qm : null);

        if (!voInner) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ *The quoted message is not a view-once.*\n│ Reply directly to a view-once image, video or audio, then send *${prefix}vv*.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const hasImg = !!voInner.imageMessage;
        const hasVid = !!voInner.videoMessage;
        const hasAudio = !!voInner.audioMessage;

        if (!hasImg && !hasVid && !hasAudio) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ *No media found in the view-once message.*\n│ Only image, video and audio view-once messages are supported.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // ── Resolve the requester's DM JID ────────────────────────────────
        // Group: msg.key.participant is the actual sender's JID
        // Private: msg.key.remoteJid is already the sender's DM
        // fromMe: bot itself sent → DM to the bot's own number
        let requesterJid;
        if (msg.key.fromMe) {
          requesterJid = `${(sock.user?.id || '').split(':')[0].split('@')[0]}@s.whatsapp.net`;
        } else if (msg.key.remoteJid?.endsWith('@g.us')) {
          requesterJid = msg.key.participant;
        } else {
          requesterJid = msg.key.remoteJid;
        }

        // LID → phone number resolution so DM lands at the real WhatsApp number
        if (requesterJid?.endsWith('@lid')) {
          const resolved = sessionDir ? resolveLidToPhone(requesterJid, sessionDir) : null;
          if (resolved) {
            requesterJid = `${resolved}@s.whatsapp.net`;
          }
        }

        if (!requesterJid || requesterJid.endsWith('@g.us') || requesterJid.endsWith('@broadcast')) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Couldn't resolve your phone number for DM delivery.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        try {
          const silentLog = {
            info: () => {}, warn: () => {}, error: () => {},
            debug: () => {}, trace: () => {},
            child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
          };

          // Build fake message for downloadMediaMessage
          const fakeMsg = {
            key: {
              remoteJid: msg.key.remoteJid,
              id: vvCtx.stanzaId,
              participant: vvCtx.participant || undefined,
              fromMe: false,
            },
            message: voInner,
          };

          const buffer = await downloadMediaMessage(
            fakeMsg, 'buffer', {},
            { logger: silentLog, reuploadRequest: sock.updateMediaMessage }
          );

          if (!buffer || buffer.length === 0) throw new Error('Media has expired or is unavailable.');

          const senderNum = (vvCtx.participant || vvCtx.remoteJid || '').replace(/[^0-9]/g, '');
          const fromGroupHint = msg.key.remoteJid?.endsWith('@g.us')
            ? `\n📥 *From group chat*`
            : '';
          const caption = `╭─「 👁️ ᴠɪᴇᴡ ᴏɴᴄᴇ 」\n│ 👁️ *View Once — Decrypted*\n│ 👤 *Originally sent by:* @${senderNum}${fromGroupHint}\n╰──────────●●►\n\n> ${footer}`;
          const mentions = vvCtx.participant ? [vvCtx.participant] : [];

          // Send to requester's DM (NOT the group)
          if (hasImg) {
            await sock.sendMessage(requesterJid, { image: buffer, caption, mentions });
          } else if (hasVid) {
            await sock.sendMessage(requesterJid, {
              video: buffer,
              caption,
              mimetype: voInner.videoMessage?.mimetype || 'video/mp4',
              mentions,
            });
          } else {
            // Audio view-once — WhatsApp audio doesn't support inline captions,
            // so we send the info card as text first, then the audio below it.
            const audioDurSecs = voInner.audioMessage?.seconds || 0;
            const audioMime = voInner.audioMessage?.mimetype || 'audio/ogg; codecs=opus';
            const isVoiceNote = !!voInner.audioMessage?.ptt;
            const audioType = isVoiceNote ? '🎙️ Voice Note' : '🎵 Audio';
            const audioDurFmt = audioDurSecs
              ? `${Math.floor(audioDurSecs / 60)}:${String(audioDurSecs % 60).padStart(2, '0')}`
              : 'N/A';

            const audioCaption =
              `╭─「 👁️ ᴠɪᴇᴡ ᴏɴᴄᴇ ᴀᴜᴅɪᴏ 」\n` +
              `│ 👁️ *View Once — Decrypted*\n` +
              `│ 👤 *Sent by:* @${senderNum}${fromGroupHint}\n` +
              `│ ${audioType}\n` +
              `│ ⏱️ *Duration:* ${audioDurFmt}\n` +
              `╰──────────●●►\n\n` +
              `> ${footer}`;

            await sock.sendMessage(requesterJid, {
              audio: buffer,
              mimetype: audioMime,
              ptt: isVoiceNote,
            });
            await sock.sendMessage(requesterJid, {
              text: audioCaption,
              mentions,
            });
          }

          // Confirm in the original chat (no media leak — text only)
          if (msg.key.remoteJid !== requesterJid) {
            await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🔓 *View-once decrypted and sent to your DM.*\n│ Check your private chat with the bot.\n╰──────────●●►\n\n> ${footer}`);
          }

          // Final react — 👁️ → 🔓 sequence (view-once unlocked)
          await react(sock, msg, '🔓');
        } catch (vvErr) {
          await react(sock, msg, '❌');
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ *Failed to decrypt view-once media.*\n│ ${friendlyError(vvErr)}\n╰──────────●●►\n\n> ${footer}`);
        }
        break;
      }

      // ── Send Status Media ─────────────────────────────────────────────────
      case 'send': {
        await react(sock, msg, '⏳');

        const sendCtx = msg.message?.extendedTextMessage?.contextInfo;
        const isStatusReply = sendCtx?.remoteJid === 'status@broadcast';

        if (!sendCtx || !isStatusReply) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Status reply ekak nä.\n│ Status view karala reply karanna *${prefix}send* kiyala.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const quotedMsg = sendCtx.quotedMessage;
        if (!quotedMsg) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Status content eka detect karanna bäri uuna.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const hasImage = !!quotedMsg.imageMessage;
        const hasVideo = !!quotedMsg.videoMessage;

        if (!hasImage && !hasVideo) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Meka image/video status ekak nä — text status download karanna bäri.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        try {
          // Build a fake message object so downloadMediaMessage can work on the status
          const fakeMsg = {
            key: {
              remoteJid: 'status@broadcast',
              id: sendCtx.stanzaId,
              participant: sendCtx.participant,
              fromMe: false,
            },
            message: quotedMsg,
          };

          const mediaBuf = await downloadMediaMessage(
            fakeMsg, 'buffer', {},
            {
              logger: {
                info: () => {}, warn: () => {}, error: () => {},
                debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
              },
              reuploadRequest: sock.updateMediaMessage,
            }
          );

          if (!mediaBuf || mediaBuf.length === 0) throw new Error('Empty media buffer');

          const posterNum = (sendCtx.participant || '').replace(/[^0-9]/g, '');
          const caption = `╭─「 📤 ꜱᴛᴀᴛᴜꜱ ᴍᴇᴅɪᴀ 」\n│ 📤 *Status Media*\n│ 👤 Posted by: @${posterNum}\n╰──────────●●►\n\n> ${footer}`;

          if (hasImage) {
            await sock.sendMessage(jid, {
              image: mediaBuf,
              caption,
              mentions: sendCtx.participant ? [sendCtx.participant] : [],
            }, { quoted: msg });
          } else {
            await sock.sendMessage(jid, {
              video: mediaBuf,
              caption,
              mimetype: quotedMsg.videoMessage?.mimetype || 'video/mp4',
              mentions: sendCtx.participant ? [sendCtx.participant] : [],
            }, { quoted: msg });
          }

          await react(sock, msg, '✅');
        } catch (sendErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Status download karana kota error eka: ${friendlyError(sendErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // ── Permit / Unpermit (pp access control) ────────────────────────────
      case 'permit': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can grant permissions.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const permitCtx = msg.message?.extendedTextMessage?.contextInfo;
        const permitTarget =
          permitCtx?.participant ||
          permitCtx?.mentionedJid?.[0];
        if (!permitTarget) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ @mention or reply to the user you want to permit.\n│ Usage: *${prefix}permit @user*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const permitList = getPermittedUsers(sessionDir);
        permitList.add(permitTarget);
        savePermittedUsers(sessionDir, permitList);
        const permitNum = permitTarget.replace(/@s\.whatsapp\.net$/, '');
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *@${permitNum}* has been granted permission to use *${prefix}pp*.\n╰──────────●●►\n\n> ${footer}`, [permitTarget]);
        await react(sock, msg, '✅');
        break;
      }

      case 'unpermit': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can revoke permissions.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const unpermitCtx = msg.message?.extendedTextMessage?.contextInfo;
        const unpermitTarget =
          unpermitCtx?.participant ||
          unpermitCtx?.mentionedJid?.[0];
        if (!unpermitTarget) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ @mention or reply to the user you want to unpermit.\n│ Usage: *${prefix}unpermit @user*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        // Use digit-based matching (same as isPermitted) so JID format differences don't matter
        const upTargetDigits = unpermitTarget.replace(/\D/g, '');
        const upList = getPermittedUsers(sessionDir);
        let upRemoved = false;
        for (const entry of [...upList]) {
          const entryDigits = entry.replace(/\D/g, '');
          if (upTargetDigits === entryDigits || upTargetDigits.endsWith(entryDigits) || entryDigits.endsWith(upTargetDigits)) {
            upList.delete(entry);
            upRemoved = true;
          }
        }
        if (!upRemoved) {
          await reply(sock, msg, `╭─「 ⚠️ ᴡᴀʀɴɪɴɢ 」\n│ ⚠️ This user is not in the permit list.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '⚠️');
          break;
        }
        savePermittedUsers(sessionDir, upList);
        const unpermitNum = unpermitTarget.replace(/@s\.whatsapp\.net$/, '').replace(/:\d+$/, '');
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Permission revoked for *@${unpermitNum}*.\n╰──────────●●►\n\n> ${footer}`, [unpermitTarget]);
        await react(sock, msg, '✅');
        break;
      }

      case 'permitlist': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can view the permit list.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const plList = getPermittedUsers(sessionDir);
        if (plList.size === 0) {
          await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 📋 *Permit List*\n│ No users have been granted permission yet.\n│ Use *${prefix}permit @user* to add someone.\n╰──────────●●►\n\n> ${footer}`);
        } else {
          const plLines = [...plList].map((jid, i) => `${i + 1}. @${jid.replace(/@s\.whatsapp\.net$/, '')}`).join('\n');
          await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 📋 *Permitted Users — ${prefix}pp*\n│ ${plLines}\n╰──────────●●►\n\n> ${footer}`, [...plList]);
        }
        await react(sock, msg, '✅');
        break;
      }

      // ── Auto-Join / Auto-Follow management ───────────────────────────────
      case 'addgroup': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Owner only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const agLink = (args || '').trim();
        if (!agLink.includes('chat.whatsapp.com/') && agLink.length < 5) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Provide a valid WhatsApp group invite link.\n│ Example: *${prefix}addgroup https://chat.whatsapp.com/XXXXXX*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        const agCfg = getAutoJoinConfig(sessionsDir);
        if (agCfg.groups.includes(agLink)) {
          await reply(sock, msg, `╭─「 ⚠️ ᴡᴀʀɴɪɴɢ 」\n│ ⚠️ This group link is already in the list.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '⚠️'); break;
        }
        agCfg.groups.push(agLink);
        saveAutoJoinConfig(sessionsDir, agCfg);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Group invite link added to auto-join list.\n│ Total groups: *${agCfg.groups.length}*\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'delgroup': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Owner only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const dgArg = (args || '').trim();
        const dgCfg = getAutoJoinConfig(sessionsDir);
        const dgIdx = parseInt(dgArg, 10) - 1;
        if (isNaN(dgIdx) || dgIdx < 0 || dgIdx >= dgCfg.groups.length) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Provide the number from *${prefix}autojoinlist*.\n│ Example: *${prefix}delgroup 1*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        const dgRemoved = dgCfg.groups.splice(dgIdx, 1)[0];
        saveAutoJoinConfig(sessionsDir, dgCfg);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Removed group #${dgIdx + 1} from auto-join list.\n│ \`${dgRemoved}\`\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'addchannel': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Owner only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const acArg = (args || '').trim();
        if (!acArg) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Provide the channel JID or newsletter link.\n│ Example: *${prefix}addchannel 120363XXXXXXXX@newsletter*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        // Accept newsletter link or bare JID
        let acJid = acArg;
        const acNewsletterMatch = acArg.match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/);
        if (acNewsletterMatch) acJid = acNewsletterMatch[1] + '@newsletter';
        if (!acJid.endsWith('@newsletter')) acJid = acJid + '@newsletter';

        const acCfg = getAutoJoinConfig(sessionsDir);
        if (acCfg.channels.includes(acJid)) {
          await reply(sock, msg, `╭─「 ⚠️ ᴡᴀʀɴɪɴɢ 」\n│ ⚠️ This channel is already in the list.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '⚠️'); break;
        }
        acCfg.channels.push(acJid);
        saveAutoJoinConfig(sessionsDir, acCfg);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Channel added to auto-follow list.\n│ \`${acJid}\`\n│ Total channels: *${acCfg.channels.length}*\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'delchannel': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Owner only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const dcArg = (args || '').trim();
        const dcCfg = getAutoJoinConfig(sessionsDir);
        const dcIdx = parseInt(dcArg, 10) - 1;
        if (isNaN(dcIdx) || dcIdx < 0 || dcIdx >= dcCfg.channels.length) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Provide the number from *${prefix}autojoinlist*.\n│ Example: *${prefix}delchannel 1*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        const dcRemoved = dcCfg.channels.splice(dcIdx, 1)[0];
        saveAutoJoinConfig(sessionsDir, dcCfg);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Removed channel #${dcIdx + 1} from auto-follow list.\n│ \`${dcRemoved}\`\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'autojoinlist': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Owner only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const ajCfg = getAutoJoinConfig(sessionsDir);

        // ── Fetch group details ──────────────────────────────────────────
        let ajGroupLines = [];
        if (ajCfg.groups.length === 0) {
          ajGroupLines.push('_None_');
        } else {
          for (let i = 0; i < ajCfg.groups.length; i++) {
            const gLink = ajCfg.groups[i];
            const gCodeMatch = gLink.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
            const gCode = gCodeMatch ? gCodeMatch[1] : gLink.trim();
            try {
              const gInfo = await sock.groupGetInviteInfo(gCode);
              const gName = gInfo?.subject || 'Unknown Group';
              const gMembers = gInfo?.participants?.length ?? '?';
              const gDesc = gInfo?.desc
                ? `\n    📝 ${gInfo.desc.slice(0, 60)}${gInfo.desc.length > 60 ? '...' : ''}`
                : '';
              ajGroupLines.push(
                `${i + 1}. *${gName}*\n    👥 Members: ${gMembers}${gDesc}\n    🔗 ${gLink}`
              );
            } catch (gErr) {
              ajGroupLines.push(
                `${i + 1}. ⚠️ _(Link may be invalid or expired)_\n    🔗 ${gLink}`
              );
            }
          }
        }

        // ── Fetch channel details ────────────────────────────────────────
        let ajChannelLines = [];
        if (ajCfg.channels.length === 0) {
          ajChannelLines.push('_None_');
        } else {
          for (let i = 0; i < ajCfg.channels.length; i++) {
            const cJid = ajCfg.channels[i];
            try {
              const cRaw = await sock.newsletterMetadata('jid', cJid);
              // Raw response has nested thread_metadata; parsed version has flat fields
              const cName =
                cRaw?.thread_metadata?.name?.text ||
                cRaw?.name ||
                'Unknown Channel';
              const cHandle = cRaw?.thread_metadata?.handle || cRaw?.handle || '';
              const cDescText =
                cRaw?.thread_metadata?.description?.text ||
                cRaw?.description || '';
              const cSubsCount =
                cRaw?.thread_metadata?.subscribers_count != null
                  ? parseInt(cRaw.thread_metadata.subscribers_count, 10)
                  : (cRaw?.subscribers ?? null);
              const cVerified =
                (cRaw?.thread_metadata?.verification || cRaw?.verification) === 'VERIFIED'
                  ? ' ✅' : '';

              const cHandleLine  = cHandle ? `\n    🔖 @${cHandle}` : '';
              const cSubsLine    = cSubsCount != null ? `\n    👥 Subscribers: ${cSubsCount.toLocaleString()}` : '';
              const cDescLine    = cDescText ? `\n    📝 ${cDescText.slice(0, 60)}${cDescText.length > 60 ? '...' : ''}` : '';

              ajChannelLines.push(
                `${i + 1}. *${cName}*${cVerified}${cHandleLine}${cSubsLine}${cDescLine}\n    🆔 \`${cJid}\``
              );
            } catch (cErr) {
              ajChannelLines.push(
                `${i + 1}. ⚠️ _(Could not fetch: ${cErr?.message?.slice(0, 40) || 'unknown error'})_\n    🆔 \`${cJid}\``
              );
            }
          }
        }

        await reply(sock, msg,
          `╭─「 📋 ᴀᴜᴛᴏ-ᴊᴏɪɴ ʟɪꜱᴛ 」\n│ *👥 Groups (${ajCfg.groups.length}):*\n│ ${ajGroupLines.join('\n│ ')}\n│\n│ *📢 Channels (${ajCfg.channels.length}):*\n│ ${ajChannelLines.join('\n│ ')}\n│\n│ ➕ *${prefix}addgroup [link]* | *${prefix}addchannel [jid]*\n│ ➖ *${prefix}delgroup [no]* | *${prefix}delchannel [no]*\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, '✅');
        break;
      }

      // ── Mute / Unmute ────────────────────────────────────────────────────
      case 'mute': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const muteJid =
          msg.message?.extendedTextMessage?.contextInfo?.participant ||
          ((args || '').match(/@(\d+)/)?.[1] ? `${(args || '').match(/@(\d+)/)[1]}@s.whatsapp.net` : null);
        if (!muteJid) { await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to or mention a user.\n│ Usage: *${prefix}mute @user*\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const gsMute = getGroupSettings(sessionDir, jid);
        if (!gsMute.mutelist) gsMute.mutelist = [];
        if (gsMute.mutelist.includes(muteJid)) { await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ ℹ️ This user is already muted.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, 'ℹ️'); break; }
        gsMute.mutelist.push(muteJid); saveGroupSettings(sessionDir, jid, gsMute);
        const muteNum = muteJid.replace('@s.whatsapp.net', '');
        await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 🔇 *@${muteNum} has been muted.*\n│ Their messages will be auto-deleted.\n╰──────────●●►\n\n> ${footer}`, [muteJid]);
        await react(sock, msg, '✅');
        break;
      }

      case 'unmute': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const unmuteJid =
          msg.message?.extendedTextMessage?.contextInfo?.participant ||
          ((args || '').match(/@(\d+)/)?.[1] ? `${(args || '').match(/@(\d+)/)[1]}@s.whatsapp.net` : null);
        if (!unmuteJid) { await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Reply to or mention a user.\n│ Usage: *${prefix}unmute @user*\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const gsUnmute = getGroupSettings(sessionDir, jid);
        if (!gsUnmute.mutelist?.includes(unmuteJid)) { await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ ℹ️ This user is not muted.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, 'ℹ️'); break; }
        gsUnmute.mutelist = gsUnmute.mutelist.filter(u => u !== unmuteJid); saveGroupSettings(sessionDir, jid, gsUnmute);
        const unmuteNum = unmuteJid.replace('@s.whatsapp.net', '');
        await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 🔊 *@${unmuteNum} has been unmuted.*\n╰──────────●●►\n\n> ${footer}`, [unmuteJid]);
        await react(sock, msg, '✅');
        break;
      }

      case 'mutelist': {
        await react(sock, msg, '⏳');
        if (!isGroup(msg)) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Groups only.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const gsMl = getGroupSettings(sessionDir, jid);
        const ml = gsMl.mutelist || [];
        if (ml.length === 0) { await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ ℹ️ No muted members in this group.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, 'ℹ️'); break; }
        const mlLines = ml.map((u, i) => `${i + 1}. @${u.replace('@s.whatsapp.net', '')}`).join('\n');
        await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 🔇 *Muted Members (${ml.length}):*\n│ ${mlLines}\n╰──────────●●►\n\n> ${footer}`, ml);
        await react(sock, msg, '✅');
        break;
      }

      // ── Translate ────────────────────────────────────────────────────────
      case 'tr': {
        await react(sock, msg, '⏳');
        if (!args) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Usage: *${prefix}tr [language] [text]*\n│ Examples:\n│ • *${prefix}tr sinhala hello world*\n│ • *${prefix}tr english ආයුබෝවන්*\n│ • *${prefix}tr tamil hello*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        const trParts = args.split(' ');
        const trLang = trParts[0].toLowerCase();
        let trText = trParts.slice(1).join(' ').trim();
        if (!trText) {
          const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          trText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '';
        }
        if (!trText) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ No text to translate. Provide text or reply to a message.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const langMap = {
          'sinhala': 'si', 'si': 'si', 'english': 'en', 'en': 'en',
          'tamil': 'ta', 'ta': 'ta', 'hindi': 'hi', 'hi': 'hi',
          'arabic': 'ar', 'ar': 'ar', 'french': 'fr', 'fr': 'fr',
          'spanish': 'es', 'es': 'es', 'japanese': 'ja', 'ja': 'ja',
          'chinese': 'zh', 'zh': 'zh', 'korean': 'ko', 'ko': 'ko',
          'german': 'de', 'de': 'de', 'russian': 'ru', 'ru': 'ru',
          'malay': 'ms', 'ms': 'ms', 'indonesian': 'id', 'id': 'id',
        };
        const trCode = langMap[trLang] || trLang;
        try {
          const trRes = await axios.get('https://api.mymemory.translated.net/get', {
            params: { q: trText, langpair: `auto|${trCode}` },
            timeout: 15000,
          });
          const translated = trRes.data?.responseData?.translatedText;
          if (!translated) throw new Error('No translation returned');
          await reply(sock, msg, `╭─「 🌐 ᴛʀᴀɴꜱʟᴀᴛᴇ 」\n│ 🌐 *Translation → ${trLang.toUpperCase()}*\n│ 📝 Original: _${trText}_\n│ ✅ Translated: ${translated}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
        } catch (trErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Translation failed: ${friendlyError(trErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // ── Auto-Reply ───────────────────────────────────────────────────────
      case 'setreply': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!args || !args.includes('|')) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Usage: *${prefix}setreply [keyword] | [response]*\n│ Example: *${prefix}setreply hello | Hey there! 👋*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        const [srKey, ...srValParts] = args.split('|');
        const srKeyword = srKey.trim().toLowerCase();
        const srResponse = srValParts.join('|').trim();
        if (!srKeyword || !srResponse) { await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Both keyword and response are required.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const arSet = getAutoReplies(sessionDir);
        arSet[srKeyword] = srResponse; saveAutoReplies(sessionDir, arSet);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Auto-reply set!\n│ 🔑 Keyword: _${srKeyword}_\n│ 💬 Response: _${srResponse}_\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'delreply': {
        await react(sock, msg, '⏳');
        if (!isOwner(msg, meta, sessionDir)) { await reply(sock, msg, `╭─「 🚫 ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        if (!args) { await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Usage: *${prefix}delreply [keyword]*\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, '❌'); break; }
        const drKey = args.trim().toLowerCase();
        const arDel = getAutoReplies(sessionDir);
        if (!arDel[drKey]) { await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ ℹ️ No auto-reply found for keyword: _${drKey}_\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, 'ℹ️'); break; }
        delete arDel[drKey]; saveAutoReplies(sessionDir, arDel);
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Auto-reply for _"${drKey}"_ removed.\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      case 'replylist': {
        await react(sock, msg, '⏳');
        const arList = getAutoReplies(sessionDir);
        const arKeys = Object.keys(arList);
        if (arKeys.length === 0) { await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ ℹ️ No auto-replies configured.\n│ Use *${prefix}setreply [keyword] | [response]* to add.\n╰──────────●●►\n\n> ${footer}`); await react(sock, msg, 'ℹ️'); break; }
        const arLines = arKeys.map((k, i) => `${i + 1}. 🔑 _${k}_ → ${arList[k]}`).join('\n');
        await reply(sock, msg, `╭─「 🤖 ᴀᴜᴛᴏ-ʀᴇᴘʟʏ 」\n│ 🤖 *Auto-Reply List (${arKeys.length}):*\n│ ${arLines.replace(/\n/g, '\n│ ')}\n╰──────────●●►\n\n> ${footer}`);
        await react(sock, msg, '✅');
        break;
      }

      // ── YouTube Video Download ────────────────────────────────────────────
      case 'ytdl': {
        await react(sock, msg, '⏳');
        if (!args || !args.startsWith('http')) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a YouTube URL.\n│ Usage: *${prefix}ytdl [url]*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        await reply(sock, msg, `╭─「 ⏳ ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ 」\n│ ⬇️ Fetching video info...\n│ ⏳ Please wait...\n╰──────────●●►\n\n> ${footer}`);
        const ytdlBase = path.join(os.tmpdir(), `darktila_ytv_${Date.now()}`);
        let ytdlTmpFile = null;
        try {
          // ── Step 1: fetch info using multi-client fallback ─────────────────
          let ytTitle = 'YouTube Video', ytDurNum = 0, ytAuthor = '', ytThumb = '';
          try {
            const ytdlInfo = await runYtDlp(
              ['--no-playlist', '--print', '%(title)s|||%(uploader)s|||%(duration)s|||%(thumbnail)s', '--skip-download', '--no-warnings'],
              args,
              40000,
            );
            const parts = (ytdlInfo.stdout || '').trim().split('|||');
            ytTitle   = parts[0] || ytTitle;
            ytAuthor  = parts[1] || '';
            ytDurNum  = parseInt(parts[2]) || 0;
            ytThumb   = parts[3] || '';
          } catch (_) {}

          if (ytDurNum > 600) {
            await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Video too long! Maximum is *10 minutes*.\n│ This video is ${Math.floor(ytDurNum / 60)}m ${ytDurNum % 60}s.\n╰──────────●●►\n\n> ${footer}`);
            await react(sock, msg, '❌'); break;
          }

          // Show thumbnail info card
          if (ytThumb) {
            const ytDurFmtPre = ytDurNum
              ? `${Math.floor(ytDurNum / 60)}:${String(ytDurNum % 60).padStart(2, '0')}`
              : 'N/A';
            try {
              await sock.sendMessage(jid, {
                image: { url: ytThumb },
                caption:
                  `╭─「 🎬 ʏᴏᴜᴛᴜʙᴇ ᴅᴇᴛᴀɪʟꜱ 」\n` +
                  `│ 📝 Title   : ${ytTitle}\n` +
                  (ytAuthor ? `│ 👤 Channel : ${ytAuthor}\n` : '') +
                  `│ ⏱️ Duration: ${ytDurFmtPre}\n` +
                  `│ 📥 Quality : Best up to 720p\n` +
                  `╰──────────●●►\n` +
                  `│ ⏳ Downloading video...\n` +
                  `╰──────────●●►\n\n` +
                  `> *Dark Thila X MD ×̷̷͜×̷*`,
                contextInfo: buildChannelForwardContext(),
              }, { quoted: msg });
            } catch (_) {}
          }

          // ── Step 2: download using multi-client fallback ───────────────────
          let ytFile = null;
          let usedFallback = false;
          try {
            await runYtDlp(
              [
                '-f', 'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[height<=720]',
                '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings',
                '-o', `${ytdlBase}.%(ext)s`,
              ],
              args,
              180000,
            );
            ytFile = `${ytdlBase}.mp4`;
            if (!fs.existsSync(ytFile)) {
              const found = fs.readdirSync(os.tmpdir()).find(f => f.startsWith(path.basename(ytdlBase)));
              if (found) ytFile = path.join(os.tmpdir(), found);
              else ytFile = null;
            }
          } catch (ytdlE1) {
            console.warn(`[ytdl] yt-dlp all clients failed — trying ytdl-core fallback: ${ytdlE1?.message?.slice(0, 200)}`);
          }

          // ── Step 3: ytdl-core fallback (video stream) ─────────────────────
          if (!ytFile) {
            const ytdl = getYtdlCore();
            if (ytdl) {
              try {
                const ytdlCoreFile = `${ytdlBase}_core.mp4`;
                const info = await ytdl.getInfo(args);
                const d = info.videoDetails;
                ytTitle = d.title || ytTitle;
                ytAuthor = d.author?.name || ytAuthor;
                ytDurNum = parseInt(d.lengthSeconds) || ytDurNum;
                const videoFmt = ytdl.chooseFormat(info.formats, {
                  quality: 'highest',
                  filter: (f) => f.container === 'mp4' && f.hasVideo,
                });
                await new Promise((res, rej) => {
                  const stream = ytdl.downloadFromInfo(info, { format: videoFmt, highWaterMark: 1 << 25 });
                  const out = fs.createWriteStream(ytdlCoreFile);
                  stream.on('error', rej);
                  out.on('error', rej);
                  out.on('finish', res);
                  stream.pipe(out);
                });
                if (fs.existsSync(ytdlCoreFile) && fs.statSync(ytdlCoreFile).size > 1024) {
                  ytFile = ytdlCoreFile;
                  usedFallback = true;
                }
              } catch (ytdlE2) {
                console.warn(`[ytdl] ytdl-core fallback failed: ${ytdlE2?.message?.slice(0, 200)}`);
              }
            }
          }

          if (!ytFile) throw new Error('Download failed. YouTube may be blocking the request — try again in a moment.');

          ytdlTmpFile = ytFile;
          const ytBuf = fs.readFileSync(ytFile);
          const ytDurFmt = ytDurNum
            ? `${Math.floor(ytDurNum / 60)}:${String(ytDurNum % 60).padStart(2, '0')}`
            : '';
          await sock.sendMessage(jid, {
            video: ytBuf,
            mimetype: 'video/mp4',
            caption:
              `╭─「 ✅ ʏᴏᴜᴛᴜʙᴇ ᴠɪᴅᴇᴏ 」\n` +
              `│ 🎬 *${ytTitle}*\n` +
              (ytAuthor ? `│ 👤 ${ytAuthor}\n` : '') +
              (ytDurFmt ? `│ ⏱️ ${ytDurFmt}\n` : '') +
              `│ ✅ Downloaded successfully!\n` +
              `╰──────────●●►\n\n` +
              `> ${footer}`,
            fileName: `${(ytTitle).replace(/[^a-z0-9]/gi, '_')}.mp4`,
            contextInfo: buildChannelForwardContext(),
          }, { quoted: msg });
          await react(sock, msg, '✅');
        } catch (ytdlErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Download failed: ${friendlyError(ytdlErr)}\n│ 💡 Try again or use a shorter video!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        } finally {
          if (ytdlTmpFile && fs.existsSync(ytdlTmpFile)) {
            try { fs.unlinkSync(ytdlTmpFile); } catch (_) {}
          }
        }
        break;
      }

      // ── Follow All Sessions to a Channel ──────────────────────────────────
      case 'followall':
      case 'unfollowall': {
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const link = (args || '').trim().split(/\s+/)[0] || '';
        if (!link) {
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Valid channel link denna!\n│ • \`${prefix}${cmd} https://whatsapp.com/channel/<id>\`\n│ • \`${prefix}${cmd} 120363xxxxxxxxxxxx@newsletter\`\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }

        // Parse: accept full WA channel link, raw invite code, or numeric JID.
        const parseChannelTarget = (raw) => {
          if (!raw) return null;
          const cleaned = raw.split('?')[0].split('#')[0]
            .replace(/^https?:\/\/(www\.)?whatsapp\.com\/channel\//i, '');
          const token = cleaned.split('/').filter(Boolean)[0] || cleaned;
          if (!token) return null;
          if (token.includes('@')) return { remoteJid: token };
          if (/^\d{15,25}$/.test(token)) return { remoteJid: `${token}@newsletter` };
          return { channelCode: token };
        };

        const parsedCh = parseChannelTarget(link);
        if (!parsedCh) {
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Valid channel link denna!\n│ • \`${prefix}${cmd} https://whatsapp.com/channel/<id>\`\n│ • \`${prefix}${cmd} 120363xxxxxxxxxxxx@newsletter\`\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }

        await react(sock, msg, '⏳');

        // Resolve invite code → numeric newsletter JID via current sock if needed.
        let channelJid = parsedCh.remoteJid;
        if (!channelJid && parsedCh.channelCode) {
          try {
            const chMeta = await sock.newsletterMetadata('invite', parsedCh.channelCode);
            if (chMeta?.id) channelJid = chMeta.id;
          } catch (e) {
            await reply(sock, msg,
              `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Channel link eka resolve karanna bari una.\n│ Numeric JID pawichchi karanna: \`${prefix}${cmd} <id>@newsletter\`\n│ _Detail:_ \`${e?.message || e}\`\n╰──────────●●►\n\n> ${footer}`
            );
            await react(sock, msg, '❌');
            break;
          }
        }
        if (!channelJid) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Could not resolve channel.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const liveSessions = [];
        if (botManager && botManager.sessions) {
          for (const [sid, s] of botManager.sessions.entries()) {
            if (s && s.sock && s.status === 'connected') {
              liveSessions.push({ sid, sock: s.sock });
            }
          }
        }
        if (liveSessions.length === 0) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ No active sessions found.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const isFollow = cmd === 'followall';
        await reply(sock, msg,
          `╭─「 ⏳ ᴘʀᴏᴄᴇꜱꜱɪɴɢ 」\n│ ⏳ All sessions ${isFollow ? 'follow' : 'unfollow'} karanawa...\n│ Sessions: *${liveSessions.length}*\n╰──────────●●►\n\n> ${footer}`
        );

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < liveSessions.length; i++) {
          const { sid, sock: lsock } = liveSessions[i];
          if (i > 0) await new Promise(r => setTimeout(r, 2000));
          try {
            if (isFollow) {
              if (typeof lsock.newsletterFollow !== 'function') {
                throw new Error('newsletterFollow not supported');
              }
              await lsock.newsletterFollow(channelJid);
            } else {
              if (typeof lsock.newsletterUnfollow !== 'function') {
                throw new Error('newsletterUnfollow not supported');
              }
              await lsock.newsletterUnfollow(channelJid);
            }
            successCount++;
            console.log(`[${cmd}] Session ${sid} ${isFollow ? 'followed' : 'unfollowed'}!`);
          } catch (err) {
            failCount++;
            console.log(`[${cmd}] Session ${sid} error:`, err?.message || err);
          }
        }

        const allFailed = successCount === 0 && failCount > 0;
        await reply(sock, msg,
          `╭─「 ${allFailed ? '❌ ꜰᴀɪʟᴇᴅ' : '✅ ᴅᴏɴᴇ'} 」\n│ 📢 ${isFollow ? 'Follow' : 'Unfollow'} All ${allFailed ? 'Failed' : 'Done! 🔥'}\n│ ✅ Success: ${successCount} sessions\n│ ❌ Failed: ${failCount} sessions\n╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, allFailed ? '❌' : '✅');
        break;
      }

      // ── All Bot Sessions Status ───────────────────────────────────────────
      case 'botstatus': {
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        await react(sock, msg, '⏳');

        const allSessions = [];
        if (botManager && botManager.sessions) {
          for (const [sid, s] of botManager.sessions.entries()) {
            allSessions.push({ sid, session: s });
          }
        }

        let statusText = `╭─「 📊 ʙᴏᴛ ꜱᴛᴀᴛᴜꜱ 」\n`;
        let onlineCount = 0;
        let offlineCount = 0;

        for (let i = 0; i < allSessions.length; i++) {
          const { sid, session } = allSessions[i];
          try {
            const user = session?.sock?.user;
            const isOnline = session?.status === 'connected' && user && user.id;
            if (isOnline) {
              const number = String(user.id).split(':')[0].split('@')[0];
              statusText += `│ *${i + 1}.* +${number}\n`;
              statusText += `│    Status: 🟢 Online\n`;
              statusText += `│    Name: ${user.name || 'Unknown'}\n`;
              statusText += `│    ID: \`${sid}\`\n│\n`;
              onlineCount++;
            } else {
              statusText += `│ *${i + 1}.* \`${sid}\`\n`;
              statusText += `│    Status: 🔴 ${session?.status || 'Offline'}\n│\n`;
              offlineCount++;
            }
          } catch (err) {
            statusText += `│ *${i + 1}.* \`${sid}\`\n`;
            statusText += `│    Status: 🔴 Error\n│\n`;
            offlineCount++;
          }
        }

        statusText += `│ 🟢 Online: ${onlineCount} | 🔴 Offline: ${offlineCount} | 📱 Total: ${allSessions.length}\n`;
        statusText += `╰──────────●●►\n\n`;
        statusText += `> ${footer}`;

        await reply(sock, msg, statusText);
        await react(sock, msg, '✅');
        break;
      }

      // ── Restart All Bot Sessions ──────────────────────────────────────────
      case 'restart':
      case 'restartall': {
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (!botManager) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Restart feature not available.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        await react(sock, msg, '⏳');

        // Snapshot session IDs (the map will mutate during restart).
        // Restart the *current* session last so we can still send the result.
        const allIds = Array.from(botManager.sessions.keys());
        const otherIds = allIds.filter(sid => sid !== sessionId);
        const restartCurrent = allIds.includes(sessionId);

        if (allIds.length === 0) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ No active sessions found.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        await reply(sock, msg,
          `╭─「 ⏳ ʀᴇꜱᴛᴀʀᴛɪɴɢ 」\n│ 🔄 Restarting *${allIds.length}* session(s)...\n│ _This may take a few seconds._\n╰──────────●●►\n\n> ${footer}`
        );

        let rsSuccess = 0;
        let rsFail = 0;
        const rsErrors = [];

        for (let i = 0; i < otherIds.length; i++) {
          const sid = otherIds[i];
          if (i > 0) await new Promise(r => setTimeout(r, 1500));
          try {
            const ok = await botManager.restartSession(sid);
            if (ok) {
              rsSuccess++;
              console.log(`[restart] ✅ Session ${sid} restarted`);
            } else {
              rsFail++;
              rsErrors.push(`${sid}: not found`);
            }
          } catch (err) {
            rsFail++;
            const msgErr = err?.message || String(err);
            rsErrors.push(`${sid}: ${msgErr}`);
            console.log(`[restart] ❌ Session ${sid} error:`, msgErr);
          }
        }

        // Send the final summary BEFORE restarting current session
        // (the current sock will be torn down).
        const allFailedRs = rsSuccess === 0 && (rsFail > 0 || !restartCurrent);
        const summary =
          `╭─「 ${allFailedRs ? '❌ ꜰᴀɪʟᴇᴅ' : '✅ ꜱᴜᴄᴄᴇꜱꜱ'} 」\n│ 🔄 Restart ${allFailedRs ? 'Failed' : 'Done! 🔥'}\n│ 📱 Total: ${allIds.length}\n│ ✅ Success: ${rsSuccess}${restartCurrent ? ' (+ current)' : ''}\n│ ❌ Failed: ${rsFail}` +
          (rsErrors.length ? `\n│\n│ _Errors:_\n│ • ${rsErrors.slice(0, 3).join('\n│ • ')}` : '') +
          `\n╰──────────●●►\n\n> ${footer}`;
        try {
          await reply(sock, msg, summary);
          await react(sock, msg, allFailedRs ? '❌' : '✅');
        } catch (_) {}

        // Restart the current session last (fire-and-forget)
        if (restartCurrent) {
          setTimeout(() => {
            botManager.restartSession(sessionId).catch(err => {
              console.log(`[restart] ❌ Current session ${sessionId} error:`, err?.message || err);
            });
          }, 500);
        }
        break;
      }

      // ── Status Boom (post status across all sessions) ─────────────────────
      case 'statusboom': {
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const sbCtx = msg.message?.extendedTextMessage?.contextInfo;
        const sbQuoted = sbCtx?.quotedMessage;
        if (!sbQuoted) {
          await reply(sock, msg,
            `╭─「 ⚠️ ᴡᴀʀɴɪɴɢ 」\n│ ⚠️ *Dark Thila X MD*\n│ Image / Video / Text ekak reply karala *${prefix}statusboom* denna!\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }

        await react(sock, msg, '⏳');

        // Collect live (connected) sessions
        const sbLiveSessions = [];
        if (botManager && botManager.sessions) {
          for (const [sid, s] of botManager.sessions.entries()) {
            if (s && s.sock && s.status === 'connected') {
              sbLiveSessions.push({ sid, sock: s.sock });
            }
          }
        }
        if (sbLiveSessions.length === 0) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ No active sessions found.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        // Build status content based on quoted media type
        let sbContent = null;
        let sbType = 'unknown';
        try {
          if (sbQuoted.imageMessage) {
            const fakeMsg = {
              key: {
                remoteJid: sbCtx.remoteJid || jid,
                id: sbCtx.stanzaId,
                participant: sbCtx.participant,
                fromMe: false,
              },
              message: sbQuoted,
            };
            const silentLog = {
              info: () => {}, warn: () => {}, error: () => {},
              debug: () => {}, trace: () => {},
              child: () => silentLog,
            };
            const sbBuf = await downloadMediaMessage(
              fakeMsg, 'buffer', {},
              { logger: silentLog, reuploadRequest: sock.updateMediaMessage }
            );
            if (!sbBuf || sbBuf.length === 0) throw new Error('Empty image buffer');
            sbType = 'image';
            sbContent = {
              image: sbBuf,
              caption: sbQuoted.imageMessage.caption || `🔥 *Dark Thila X MD*\n\n> ${footer}`,
            };
          } else if (sbQuoted.videoMessage) {
            const fakeMsg = {
              key: {
                remoteJid: sbCtx.remoteJid || jid,
                id: sbCtx.stanzaId,
                participant: sbCtx.participant,
                fromMe: false,
              },
              message: sbQuoted,
            };
            const silentLog = {
              info: () => {}, warn: () => {}, error: () => {},
              debug: () => {}, trace: () => {},
              child: () => silentLog,
            };
            const sbBuf = await downloadMediaMessage(
              fakeMsg, 'buffer', {},
              { logger: silentLog, reuploadRequest: sock.updateMediaMessage }
            );
            if (!sbBuf || sbBuf.length === 0) throw new Error('Empty video buffer');
            sbType = 'video';
            sbContent = {
              video: sbBuf,
              caption: sbQuoted.videoMessage.caption || `🔥 *Dark Thila X MD*\n\n> ${footer}`,
            };
          } else {
            const sbText = sbQuoted.conversation || sbQuoted.extendedTextMessage?.text;
            if (sbText) {
              sbType = 'text';
              sbContent = {
                text: `${sbText}\n\n> ${footer}`,
                font: 4,
                backgroundColor: '#000000',
                textArgb: '#FFFF0000',
              };
            }
          }
        } catch (sbDlErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Media download failed: ${sbDlErr?.message || sbDlErr}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        if (!sbContent) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Supported: Image, Video, Text only!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        await reply(sock, msg,
          `╭─「 ⏳ ꜱᴛᴀᴛᴜꜱ ʙᴏᴏᴍ 」\n│ ⏳ Status Boom start wela...\n│ 📱 Active Sessions: ${sbLiveSessions.length}\n│ 📦 Type: ${sbType.toUpperCase()}\n╰──────────●●►\n\n> ${footer}`
        );

        let sbSuccess = 0;
        let sbFail = 0;

        // Stagger by 2s to avoid rate limits (matches followall pattern)
        const sbResults = await Promise.all(sbLiveSessions.map(async ({ sid, sock: lsock }, i) => {
          await new Promise(r => setTimeout(r, i * 2000));
          try {
            // ── Build a COMPREHENSIVE statusJidList — REQUIRED for visibility ──
            // Status posts only show in the feed of viewers explicitly listed
            // here. Without this, the post "succeeds" but is invisible to
            // everyone, which was the historical bug.
            //
            // Sources (combined + de-duped via Set):
            //   1. Persisted contacts.json (harvested from incoming messages)
            //   2. lsock.contacts (in-memory contact store)
            //   3. ALL participants of ALL groups the bot is in (BIG win — this
            //      typically harvests 10-1000x more JIDs than message history)
            //   4. Owner self (fallback so at least the owner sees it)
            const sbJidSet = new Set();

            // (1) contacts.json
            try {
              const contactsPath = path.join(sessionsDir, sid, 'contacts.json');
              if (fs.existsSync(contactsPath)) {
                const arr = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
                if (Array.isArray(arr)) {
                  for (const c of arr) {
                    if (typeof c === 'string' && c.endsWith('@s.whatsapp.net')) sbJidSet.add(c);
                  }
                }
              }
            } catch (_) {}

            // (2) lsock.contacts in-memory
            try {
              const live = lsock?.contacts || {};
              for (const c of Object.keys(live)) {
                if (c && c.endsWith('@s.whatsapp.net')) sbJidSet.add(c);
              }
            } catch (_) {}

            // (3) Group participants — fetch all groups, harvest all members.
            // This is the biggest source of viewers for most bots and was the
            // missing piece that made statusboom appear to fail.
            try {
              const allGroups = await lsock.groupFetchAllParticipating();
              for (const groupId of Object.keys(allGroups || {})) {
                const grp = allGroups[groupId];
                const parts = grp?.participants || [];
                for (const p of parts) {
                  const pId = p?.id || '';
                  // Group participants may be @s.whatsapp.net OR @lid — only the
                  // phone-number form is valid for status broadcast viewers.
                  if (pId.endsWith('@s.whatsapp.net')) {
                    sbJidSet.add(pId);
                  } else if (pId.endsWith('@lid') && p?.phoneNumber) {
                    // Newer Baileys exposes the resolved phone number on the
                    // participant — use it when available
                    const digits = String(p.phoneNumber).replace(/\D/g, '');
                    if (digits) sbJidSet.add(`${digits}@s.whatsapp.net`);
                  }
                }
              }
            } catch (gErr) {
              console.log(`[statusboom] group fetch failed for ${sid}:`, gErr?.message || gErr);
            }

            // (4) Always include owner self
            try {
              const meId = lsock?.user?.id;
              const meDigits = (meId || '').split(':')[0].replace(/\D/g, '');
              if (meDigits) sbJidSet.add(`${meDigits}@s.whatsapp.net`);
            } catch (_) {}

            const statusJidList = Array.from(sbJidSet);

            // Persist the enriched list back to contacts.json so future calls
            // are fast even before the next group fetch
            try {
              const contactsPath = path.join(sessionsDir, sid, 'contacts.json');
              fs.writeFileSync(contactsPath, JSON.stringify(statusJidList, null, 2));
            } catch (_) {}

            if (statusJidList.length === 0) {
              throw new Error('No viewers available — bot has no contacts and is in no groups.');
            }

            await lsock.sendMessage('status@broadcast', sbContent, {
              statusJidList,
              backgroundColor: sbContent.text ? (sbContent.backgroundColor || '#000000') : undefined,
              font: sbContent.text ? (sbContent.font || 1) : undefined,
            });
            sbSuccess++;
            console.log(`[statusboom] ✅ Session ${sid} → ${statusJidList.length} viewers`);
            return { sid, ok: true, viewers: statusJidList.length };
          } catch (err) {
            sbFail++;
            console.log(`[statusboom] ❌ Session ${sid} error:`, err?.message || err);
            return { sid, ok: false, err: err?.message || String(err) };
          }
        }));

        // Append log
        try {
          const logPath = path.join(sessionsDir, 'statusboomlog.json');
          let logsObj = { logs: [] };
          try {
            if (fs.existsSync(logPath)) {
              const raw = fs.readFileSync(logPath, 'utf8');
              const parsed = JSON.parse(raw || '{}');
              if (parsed && Array.isArray(parsed.logs)) logsObj = parsed;
            }
          } catch (_) {}
          logsObj.logs.push({
            type: sbType,
            totalSessions: sbLiveSessions.length,
            success: sbSuccess,
            failed: sbFail,
            time: new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' }),
          });
          // Keep only last 50 entries
          if (logsObj.logs.length > 50) logsObj.logs = logsObj.logs.slice(-50);
          fs.writeFileSync(logPath, JSON.stringify(logsObj, null, 2));
        } catch (logErr) {
          console.log('[statusboom] log write failed:', logErr?.message || logErr);
        }

        const sbAllFailed = sbSuccess === 0 && sbFail > 0;
        // Sum up viewers across all successful sessions so the owner can see
        // exactly how many people will actually see the status — critical for
        // debugging the "posts but invisible" symptom
        const sbTotalViewers = sbResults.reduce((acc, r) => acc + (r.ok ? (r.viewers || 0) : 0), 0);
        await reply(sock, msg,
          `╭─「 ${sbAllFailed ? '⚠️' : '✅'} ꜱᴛᴀᴛᴜꜱ ʙᴏᴏᴍ 」\n` +
          `│ 💥 Status Boom ${sbAllFailed ? 'Failed' : 'Done!'}\n` +
          `│ 📦 Type: *${sbType.toUpperCase()}*\n` +
          `│ 📱 Total Sessions: ${sbLiveSessions.length}\n` +
          `│ ✅ Success: ${sbSuccess}\n` +
          `│ ❌ Failed: ${sbFail}\n` +
          `│ 👥 Total Viewers: *${sbTotalViewers}*\n` +
          `╰──────────●●►\n\n> ${footer}`
        );
        await react(sock, msg, sbAllFailed ? '❌' : '✅');
        break;
      }

      // ── Status Boom Log ───────────────────────────────────────────────────
      case 'boomlog': {
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Owner command ekak!\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }

        const blPath = path.join(sessionsDir, 'statusboomlog.json');
        let blData = { logs: [] };
        try {
          if (fs.existsSync(blPath)) {
            const raw = fs.readFileSync(blPath, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            if (parsed && Array.isArray(parsed.logs)) blData = parsed;
          }
        } catch (_) {}

        if (!blData.logs.length) {
          await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 📋 *STATUS BOOM LOG*\n│ _No entries yet._\n╰──────────●●►\n\n> ${footer}`);
          break;
        }

        const last5 = blData.logs.slice(-5).reverse();
        let blText = `╭─「 📋 ʙᴏᴏᴍʟᴏɢ 」\n│ 📋 *STATUS BOOM LOG* _(last 5)_\n│\n`;
        last5.forEach((log, i) => {
          blText += `│ *${i + 1}.* ${String(log.type || 'unknown').toUpperCase()}\n`;
          blText += `│    ✅ ${log.success}/${log.totalSessions}`;
          if (log.failed) blText += `   ❌ ${log.failed}`;
          blText += `\n│    🕐 ${log.time}\n│\n`;
        });
        blText += `╰──────────●●►\n\n> ${footer}`;
        await reply(sock, msg, blText);
        await react(sock, msg, '✅');
        break;
      }

      // ── Pair New Session ──────────────────────────────────────────────────
      case 'pair': {
        await react(sock, msg, '⏳');
        if (!botManager) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Pair feature not available.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const pairPhone = (args || '').replace(/\D/g, '');
        if (!pairPhone || pairPhone.length < 7) {
          await reply(sock, msg,
            `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Please provide a valid phone number with country code.\n│ Usage: *${prefix}pair [phone]*\n│ Example: *${prefix}pair 94XXXXXXXXX*\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '❌');
          break;
        }

        const pairSessionId = `pair-${pairPhone}-${Date.now()}`;
        await reply(sock, msg,
          `╭─「 ⏳ ᴘᴀɪʀɪɴɢ 」\n│ ⏳ Generating pairing code for *+${pairPhone}*...\n│ Please wait up to 20 seconds.\n╰──────────●●►\n\n> ${footer}`
        );

        try {
          const pairSession = await botManager.createSession(pairSessionId, pairPhone, 'pairing');

          // Poll for pairing code — max 20 seconds
          let pairCode = null;
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1000));
            pairCode = pairSession.pairingCode;
            if (pairCode) break;
          }

          if (!pairCode) {
            await reply(sock, msg,
              `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Could not get pairing code within 20 seconds.\n│ Try again or check if the phone number is correct.\n╰──────────●●►\n\n> ${footer}`
            );
            await react(sock, msg, '❌');
            break;
          }

          await reply(sock, msg,
            `╭─「 🔑 ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ 」\n│ 🔑 *Pairing Code for +${pairPhone}*\n│ \`\`\`${pairCode}\`\`\`\n│\n│ 📱 *How to use:*\n│ 1. Open WhatsApp on the target phone\n│ 2. Go to *Settings → Linked Devices*\n│ 3. Tap *Link a Device*\n│ 4. Select *Link with phone number instead*\n│ 5. Enter this code\n│\n│ ⚠️ Code expires in *3 minutes*\n│ 🆔 Session ID: \`${pairSessionId}\`\n│ To remove: *${prefix}delsession ${pairSessionId}*\n╰──────────●●►\n\n> ${footer}`
          );
          await react(sock, msg, '✅');
        } catch (pairErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Failed to create session: ${friendlyError(pairErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'delsession': {
        await react(sock, msg, '⏳');
        if (!botManager) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Not available.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const dsId = (args || '').trim();
        if (!dsId) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Usage: *${prefix}delsession [session-id]*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        if (dsId === sessionId) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Cannot delete the current active session.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
          break;
        }
        const dsRemoved = await botManager.removeSession(dsId);
        if (!dsRemoved) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Session *${dsId}* not found.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        } else {
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ Session *${dsId}* removed successfully.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
        }
        break;
      }

      // ── Instagram Download ────────────────────────────────────────────────
      case 'igdl': {
        await react(sock, msg, '⏳');
        if (!args || !(args.includes('instagram.com') || args.includes('instagr.am'))) {
          await reply(sock, msg,
            `╭─「 📸 ɪɴꜱᴛᴀɢʀᴀᴍ ᴅᴏᴡɴʟᴏᴀᴅ 」\n` +
            `│ ❌ Instagram link denna!\n` +
            `│ 📌 Usage: ${prefix}igdl [instagram link]\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );
          await react(sock, msg, '❌');
          break;
        }
        await reply(sock, msg,
          `╭─「 🔍 ꜰᴇᴛᴄʜɪɴɢ 」\n` +
          `│ 📸 Instagram post loading...\n` +
          `│ ⏳ Please wait...\n` +
          `╰──────────●●►\n\n` +
          `> *Dark Thila X MD ×̷̷͜×̷*`
        );
        const igBase = path.join(os.tmpdir(), `darktila_ig_${Date.now()}`);
        try {
          const igDlArgs = [
            '--no-playlist', '--quiet',
            '--no-check-certificate', '--geo-bypass', '--force-ipv4',
            '--retries', '3', '--extractor-retries', '3', '--fragment-retries', '3',
            '--socket-timeout', '20',
            ...(FFMPEG_BIN ? ['--ffmpeg-location', FFMPEG_BIN] : []),
            '-o', `${igBase}.%(ext)s`, args,
          ];
          await execFileAsync(YT_DLP_BIN, igDlArgs, { timeout: 60000 });
          const igFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(path.basename(igBase)));
          if (igFiles.length === 0) throw new Error('No media downloaded.');
          const igFile = path.join(os.tmpdir(), igFiles[0]);
          const igBuf = fs.readFileSync(igFile);
          const igExt = igFiles[0].split('.').pop()?.toLowerCase();
          try { fs.unlinkSync(igFile); } catch (_) {}

          const igCtx = buildChannelForwardContext();
          if (['jpg', 'jpeg', 'png', 'webp'].includes(igExt)) {
            await sock.sendMessage(jid, {
              image: igBuf,
              caption:
                `╭─「 ✅ ɪɴꜱᴛᴀɢʀᴀᴍ ɪᴍᴀɢᴇ 」\n` +
                `│ 📸 Instagram Post\n` +
                `│ ✅ Downloaded successfully!\n` +
                `╰──────────●●►\n\n` +
                `> *Dark Thila X MD ×̷̷͜×̷*`,
              contextInfo: igCtx,
            }, { quoted: msg });
          } else {
            await sock.sendMessage(jid, {
              video: igBuf,
              mimetype: 'video/mp4',
              fileName: 'instagram.mp4',
              caption:
                `╭─「 ✅ ɪɴꜱᴛᴀɢʀᴀᴍ ᴠɪᴅᴇᴏ 」\n` +
                `│ 🎬 Instagram Reel/Video\n` +
                `│ ✅ Downloaded successfully!\n` +
                `╰──────────●●►\n\n` +
                `> *Dark Thila X MD ×̷̷͜×̷*`,
              contextInfo: igCtx,
            }, { quoted: msg });
          }
          await react(sock, msg, '✅');
        } catch (igErr) {
          await react(sock, msg, '❌');
          await reply(sock, msg,
            `╭─「 ❌ ᴅᴏᴡɴʟᴏᴀᴅ ꜰᴀɪʟᴇᴅ 」\n` +
            `│ ❌ ${friendlyError(igErr)}\n` +
            `│ 💡 Private posts download neha!\n` +
            `│ 💡 Public posts only!\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );
        }
        break;
      }

      case 'vdl':
      case 'videodl': {
        await react(sock, msg, '⏳');
        if (!args || !args.startsWith('http')) {
          await reply(sock, msg,
            `╭─「 🎬 ᴠɪᴅᴇᴏ ᴅᴏᴡɴʟᴏᴀᴅ 」\n` +
            `│ ❌ Please provide a valid URL!\n` +
            `│ 📌 Usage: ${prefix}vdl [url]\n` +
            `│ 🌐 Supports: Twitter/X, Reddit,\n` +
            `│    Pinterest, Dailymotion & more\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );
          await react(sock, msg, '❌');
          break;
        }
        await reply(sock, msg,
          `╭─「 🔍 ꜰᴇᴛᴄʜɪɴɢ 」\n` +
          `│ 🎬 Fetching video info...\n` +
          `│ ⏳ Please wait...\n` +
          `╰──────────●●►\n\n` +
          `> *Dark Thila X MD ×̷̷͜×̷*`
        );
        const vdlBase = path.join(os.tmpdir(), `darktila_vdl_${Date.now()}`);
        let vdlTmpFile = null;
        try {
          const vdlInfoArgs = [
            '--no-playlist', '--print', '%(title)s|||%(uploader)s|||%(duration)s|||%(thumbnail)s',
            '--skip-download', '--quiet', args,
          ];
          let vdlTitle = 'Video', vdlAuthor = 'Unknown', vdlDurNum = 0, vdlThumb = '';
          try {
            const vdlInfo = await execFileAsync(YT_DLP_BIN, vdlInfoArgs, { timeout: 20000 });
            const parts = vdlInfo.stdout.trim().split('|||');
            vdlTitle  = parts[0] || vdlTitle;
            vdlAuthor = parts[1] || vdlAuthor;
            vdlDurNum = parseInt(parts[2]) || 0;
            vdlThumb  = parts[3] || '';
          } catch (_) {}

          if (vdlDurNum > 600) {
            await reply(sock, msg,
              `╭─「 ❌ ᴇʀʀᴏʀ 」\n` +
              `│ ❌ Video too long! Max is *10 minutes*.\n` +
              `│ This video is ${Math.floor(vdlDurNum / 60)}m ${vdlDurNum % 60}s.\n` +
              `╰──────────●●►\n\n> ${footer}`
            );
            await react(sock, msg, '❌');
            break;
          }

          if (vdlThumb) {
            try {
              const vdlDurFmt = vdlDurNum
                ? `${Math.floor(vdlDurNum / 60)}:${String(vdlDurNum % 60).padStart(2, '0')}`
                : 'N/A';
              await sock.sendMessage(jid, {
                image: { url: vdlThumb },
                caption:
                  `╭─「 🎬 ᴠɪᴅᴇᴏ ᴅᴇᴛᴀɪʟꜱ 」\n` +
                  `│ 📝 Title   : ${vdlTitle}\n` +
                  `│ 👤 Author  : ${vdlAuthor}\n` +
                  `│ ⏱️ Duration: ${vdlDurFmt}\n` +
                  `│ 📥 Quality : Best available\n` +
                  `╰──────────●●►\n` +
                  `│ ⏳ Downloading video...\n` +
                  `╰──────────●●►\n\n` +
                  `> *Dark Thila X MD ×̷̷͜×̷*`,
                contextInfo: buildChannelForwardContext(),
              }, { quoted: msg });
            } catch (_) {}
          }

          const vdlDlArgs = [
            '-f', 'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[height<=720]',
            '--merge-output-format', 'mp4', '--no-playlist', '--quiet',
            '-o', `${vdlBase}.%(ext)s`, args,
          ];
          await execFileAsync(YT_DLP_BIN, vdlDlArgs, { timeout: 120000 });

          let vdlFile = `${vdlBase}.mp4`;
          if (!fs.existsSync(vdlFile)) {
            const found = fs.readdirSync(os.tmpdir()).find(f => f.startsWith(path.basename(vdlBase)));
            if (found) vdlFile = path.join(os.tmpdir(), found);
            else throw new Error('Downloaded file not found.');
          }
          vdlTmpFile = vdlFile;

          const vdlBuf = fs.readFileSync(vdlFile);
          const vdlDurFmt2 = vdlDurNum
            ? `${Math.floor(vdlDurNum / 60)}:${String(vdlDurNum % 60).padStart(2, '0')}`
            : '';
          await sock.sendMessage(jid, {
            video: vdlBuf,
            mimetype: 'video/mp4',
            fileName: `${(vdlTitle).replace(/[^a-z0-9]/gi, '_')}.mp4`,
            caption:
              `╭─「 ✅ ᴠɪᴅᴇᴏ ᴅᴏᴡɴʟᴏᴀᴅ 」\n` +
              `│ 📝 ${vdlTitle}\n` +
              `│ 👤 ${vdlAuthor}\n` +
              (vdlDurFmt2 ? `│ ⏱️ ${vdlDurFmt2}\n` : '') +
              `│ ✅ Downloaded successfully!\n` +
              `╰──────────●●►\n\n` +
              `> *Dark Thila X MD ×̷̷͜×̷*`,
            contextInfo: buildChannelForwardContext(),
          }, { quoted: msg });

          await react(sock, msg, '✅');
        } catch (vdlErr) {
          await react(sock, msg, '❌');
          await reply(sock, msg,
            `╭─「 ❌ ᴅᴏᴡɴʟᴏᴀᴅ ꜰᴀɪʟᴇᴅ 」\n` +
            `│ ❌ ${friendlyError(vdlErr)}\n` +
            `│ 💡 Make sure the URL is public!\n` +
            `│ 💡 Supported: Twitter/X, Reddit,\n` +
            `│    Pinterest, Dailymotion & more\n` +
            `╰──────────●●►\n\n` +
            `> *Dark Thila X MD ×̷̷͜×̷*`
          );
        } finally {
          if (vdlTmpFile && fs.existsSync(vdlTmpFile)) {
            try { fs.unlinkSync(vdlTmpFile); } catch (_) {}
          }
        }
        break;
      }

      // ══════════════════════════════════════════════════════════════════════
      // 🏆  GROUP ACTIVITY SYSTEM
      // ══════════════════════════════════════════════════════════════════════

      case 'level':
      case 'rank': {
        await react(sock, msg, '⏳');
        if (!jid.endsWith('@g.us')) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ This command only works in *groups*.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }

        // Check if looking up another user (mention or reply)
        const lvMentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const lvReplyJid  = msg.message?.extendedTextMessage?.contextInfo?.participant;
        const lvTargetJid = lvMentioned || lvReplyJid || (msg.key.participant || msg.key.remoteJid);
        const lvTargetNum = lvTargetJid.replace(/[^0-9]/g, '');

        const xpData  = readXp(sessionDir, jid);
        const entry   = xpData[lvTargetJid] || { xp: 0 };
        const lvl     = xpToLevel(entry.xp);
        const badge   = rankBadge(lvl);
        const curXp   = entry.xp;
        const nextXp  = xpForNextLevel(lvl);
        const prevXp  = xpForLevel(lvl);
        const progress = nextXp > prevXp
          ? Math.min(10, Math.floor(((curXp - prevXp) / (nextXp - prevXp)) * 10))
          : 10;
        const bar = '█'.repeat(progress) + '░'.repeat(10 - progress);

        // Calculate rank position
        const sorted = Object.entries(xpData).sort((a, b) => b[1].xp - a[1].xp);
        const rankPos = sorted.findIndex(([uid]) => uid === lvTargetJid) + 1;

        await sock.sendMessage(jid, {
          text:
            `${badge}\n\n` +
            `╭─「 📊 *Level Card* 」\n` +
            `│ 👤 User   : @${lvTargetNum}\n` +
            `│ 🏅 Level  : *${lvl}*\n` +
            `│ ⭐ XP     : *${curXp}*\n` +
            `│ 🎯 Next   : *${nextXp} XP*\n` +
            `│ 📈 Rank   : *#${rankPos}* in group\n` +
            `│\n` +
            `│ [${bar}] ${progress * 10}%\n` +
            `╰──────────●●►\n\n` +
            `> ${footer}`,
          mentions: [lvTargetJid],
        }, { quoted: msg });
        await react(sock, msg, '✅');
        break;
      }

      case 'leaderboard':
      case 'lb':
      case 'top': {
        await react(sock, msg, '⏳');
        if (!jid.endsWith('@g.us')) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ This command only works in *groups*.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }

        const lbData = readXp(sessionDir, jid);
        const sorted = Object.entries(lbData)
          .sort((a, b) => b[1].xp - a[1].xp)
          .slice(0, 10);

        if (sorted.length === 0) {
          await reply(sock, msg, `╭─「 📊 ʟᴇᴀᴅᴇʀʙᴏᴀʀᴅ 」\n│ 📊 No XP data yet! Start chatting to earn XP.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅'); break;
        }

        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
        const mentions = sorted.map(([uid]) => uid);

        let lbText = `🏆 *Group Leaderboard*\n`;
        lbText += `╭────────────────────\n`;
        for (let i = 0; i < sorted.length; i++) {
          const [uid, data] = sorted[i];
          const num = uid.replace(/[^0-9]/g, '');
          const lvl = xpToLevel(data.xp);
          lbText += `│ ${medals[i]} @${num}\n│    Lvl *${lvl}* • *${data.xp} XP*\n`;
          if (i < sorted.length - 1) lbText += `│\n`;
        }
        lbText += `╰────────────────────\n\n> ${footer}`;

        await sock.sendMessage(jid, { text: lbText, mentions }, { quoted: msg });
        await react(sock, msg, '✅');
        break;
      }

      // ══════════════════════════════════════════════════════════════════════
      // 🎮  FUN & GAMES
      // ══════════════════════════════════════════════════════════════════════

      case 'joke': {
        await react(sock, msg, '😂');
        const jokes = [
          "Why don't scientists trust atoms?\nBecause they make up everything! 😄",
          "I told my wife she was drawing her eyebrows too high.\nShe looked surprised! 😮",
          "Why did the scarecrow win an award?\nBecause he was outstanding in his field! 🌾",
          "I'm reading a book about anti-gravity.\nIt's impossible to put down! 📚",
          "Did you hear about the mathematician who's afraid of negative numbers?\nHe'll stop at nothing to avoid them! 🔢",
          "Why do cows wear bells?\nBecause their horns don't work! 🐄",
          "What do you call fake spaghetti?\nAn impasta! 🍝",
          "Why can't you give Elsa a balloon?\nShe'll let it go! 🎈",
          "I used to hate facial hair, but then it grew on me! 🧔",
          "Why did the bicycle fall over?\nBecause it was two-tired! 🚲",
          "What do you call cheese that isn't yours?\nNacho cheese! 🧀",
          "How do you organize a space party?\nYou planet! 🪐",
          "Why did the golfer bring extra pants?\nIn case he got a hole in one! ⛳",
          "What's a vampire's favourite fruit?\nA blood orange! 🍊",
          "I told a joke about construction. I'm still working on it! 🏗️",
        ];
        const joke = jokes[Math.floor(Math.random() * jokes.length)];
        await reply(sock, msg, `╭─「 😂 ᴊᴏᴋᴇ 」\n│ 😂 *Joke of the Day*\n│\n│ ${joke.replace(/\n/g, '\n│ ')}\n╰──────────●●►\n\n> ${footer}`);
        break;
      }

      case 'quote': {
        await react(sock, msg, '💭');
        const quotes = [
          { q: "The only way to do great work is to love what you do.", a: "Steve Jobs" },
          { q: "In the middle of every difficulty lies opportunity.", a: "Albert Einstein" },
          { q: "It does not matter how slowly you go as long as you do not stop.", a: "Confucius" },
          { q: "Life is what happens when you're busy making other plans.", a: "John Lennon" },
          { q: "The future belongs to those who believe in the beauty of their dreams.", a: "Eleanor Roosevelt" },
          { q: "Success is not final, failure is not fatal: it is the courage to continue that counts.", a: "Winston Churchill" },
          { q: "Believe you can and you're halfway there.", a: "Theodore Roosevelt" },
          { q: "Act as if what you do makes a difference. It does.", a: "William James" },
          { q: "You miss 100% of the shots you don't take.", a: "Wayne Gretzky" },
          { q: "Whether you think you can or you think you can't, you're right.", a: "Henry Ford" },
          { q: "The best revenge is massive success.", a: "Frank Sinatra" },
          { q: "I have not failed. I've just found 10,000 ways that won't work.", a: "Thomas Edison" },
          { q: "A person who never made a mistake never tried anything new.", a: "Albert Einstein" },
          { q: "Don't watch the clock; do what it does. Keep going.", a: "Sam Levenson" },
          { q: "Dream big and dare to fail.", a: "Norman Vaughan" },
        ];
        const q = quotes[Math.floor(Math.random() * quotes.length)];
        await reply(sock, msg, `╭─「 💭 ǫᴜᴏᴛᴇ 」\n│ 💭 *Quote of the Day*\n│\n│ _"${q.q}"_\n│ — *${q.a}*\n╰──────────●●►\n\n> ${footer}`);
        break;
      }

      case 'fact': {
        await react(sock, msg, '🤯');
        const facts = [
          "Honey never spoils. Archaeologists have found 3,000-year-old honey in Egyptian tombs that was still edible! 🍯",
          "A day on Venus is longer than a year on Venus. It rotates so slowly! 🪐",
          "Octopuses have three hearts, blue blood, and nine brains! 🐙",
          "The Eiffel Tower can be 15cm taller during the summer due to thermal expansion! 🗼",
          "Bananas are berries, but strawberries are not! 🍌",
          "A group of flamingos is called a 'flamboyance'. 🦩",
          "Crows can recognize and remember human faces for years! 🐦",
          "The human nose can detect over 1 trillion different smells! 👃",
          "Sharks are older than trees — they've existed for over 400 million years! 🦈",
          "There are more possible chess games than atoms in the observable universe! ♟️",
          "Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid! 🏛️",
          "A snail can sleep for 3 years at a time! 🐌",
          "The inventor of the Pringles can is now buried in one! 🥔",
          "Water can boil and freeze at the same time — it's called the triple point! 💧",
          "An average person walks about 100,000 miles in their lifetime — that's four times around Earth! 🌍",
        ];
        const fact = facts[Math.floor(Math.random() * facts.length)];
        await reply(sock, msg, `╭─「 🤯 ꜰᴀᴄᴛ 」\n│ 🤯 *Random Fact*\n│\n│ ${fact.replace(/\n/g, '\n│ ')}\n╰──────────●●►\n\n> ${footer}`);
        break;
      }

      case '8ball': {
        await react(sock, msg, '🎱');
        if (!args) {
          await reply(sock, msg, `╭─「 🎱 ᴍᴀɢɪᴄ 8 ʙᴀʟʟ 」\n│ 🎱 *Magic 8 Ball*\n│ Usage: *${prefix}8ball [your question]*\n│ Example: *${prefix}8ball Will I be rich?*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        const responses8 = [
          "✅ It is certain.", "✅ It is decidedly so.", "✅ Without a doubt.",
          "✅ Yes, definitely!", "✅ You may rely on it.", "✅ As I see it, yes.",
          "✅ Most likely.", "✅ Outlook good.", "✅ Yes!",
          "✅ Signs point to yes.", "🤔 Reply hazy, try again.", "🤔 Ask again later.",
          "🤔 Better not tell you now.", "🤔 Cannot predict now.", "🤔 Concentrate and ask again.",
          "❌ Don't count on it.", "❌ My reply is no.", "❌ My sources say no.",
          "❌ Outlook not so good.", "❌ Very doubtful.",
        ];
        const ans = responses8[Math.floor(Math.random() * responses8.length)];
        await reply(sock, msg, `╭─「 🎱 ᴍᴀɢɪᴄ 8 ʙᴀʟʟ 」\n│ ❓ _${args}_\n│\n│ ${ans}\n╰──────────●●►\n\n> ${footer}`);
        break;
      }

      case 'ship': {
        await react(sock, msg, '💘');
        const mentioned = (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []);
        let shipUsers = [];
        if (mentioned.length >= 2) {
          shipUsers = mentioned.slice(0, 2).map(j => '@' + j.replace('@s.whatsapp.net', ''));
        } else if (args) {
          const parts = args.split(' ').filter(Boolean);
          if (parts.length >= 2) shipUsers = [parts[0], parts[1]];
        }
        if (shipUsers.length < 2) {
          await reply(sock, msg, `╭─「 💘 ꜱʜɪᴘ 」\n│ 💘 *Ship*\n│ Usage: *${prefix}ship @user1 @user2*\n│ or *${prefix}ship Name1 Name2*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        const shipPct = Math.floor(Math.random() * 101);
        const hearts = shipPct >= 80 ? '❤️❤️❤️' : shipPct >= 50 ? '💕💕' : shipPct >= 25 ? '💔' : '🖤';
        const shipBar = '█'.repeat(Math.floor(shipPct / 10)) + '░'.repeat(10 - Math.floor(shipPct / 10));
        const shipMsg =
          shipPct >= 80 ? "Perfect match! 💞" :
          shipPct >= 60 ? "Great chemistry! 💕" :
          shipPct >= 40 ? "There's something there... 🤔" :
          shipPct >= 20 ? "Hmm, not quite... 😅" : "Maybe just friends? 😬";
        await reply(sock, msg, `╭─「 💘 ᴄᴏᴍᴘᴀᴛɪʙɪʟɪᴛʏ 」\n│ ${hearts} *Compatibility Test*\n│ 👤 ${shipUsers[0]}\n│ 💑 ➕\n│ 👤 ${shipUsers[1]}\n│\n│ [${shipBar}] *${shipPct}%*\n│ ${shipMsg}\n╰──────────●●►\n\n> ${footer}`);
        break;
      }

      case 'truth': {
        await react(sock, msg, '🤭');
        const truths = [
          "What's the most embarrassing thing you've ever done in public?",
          "Have you ever lied to get out of trouble? What was the lie?",
          "What's your biggest fear that you've never told anyone?",
          "Have you ever had a crush on a friend's partner?",
          "What's the most childish thing you still do?",
          "What's something you've done that you're not proud of?",
          "Have you ever cheated in a game or exam?",
          "What's the weirdest dream you've ever had?",
          "What's the most expensive thing you've broken accidentally?",
          "Have you ever pretended to be sick to avoid something?",
          "What's your biggest insecurity?",
          "Have you ever read someone's private messages without their knowledge?",
          "What's the worst gift you've ever received but pretended to like?",
          "What's something you do when no one is watching?",
          "Have you ever blamed someone else for something you did?",
        ];
        const t = truths[Math.floor(Math.random() * truths.length)];
        await reply(sock, msg, `╭─「 🤭 ᴛʀᴜᴛʜ 」\n│ 🤭 *Truth*\n│\n│ _${t}_\n╰──────────●●►\n\n> ${footer}`);
        break;
      }

      case 'dare': {
        await react(sock, msg, '😈');
        const dares = [
          "Send a voice note singing your favourite song for 30 seconds!",
          "Change your WhatsApp status to 'I love [last person you texted]' for 10 minutes.",
          "Send a selfie with the most ridiculous face you can make!",
          "Text someone 'I know what you did' and wait for their reply!",
          "Send a voice note saying something in a funny accent!",
          "Post a throwback photo in the group!",
          "Write a 50-word love poem about your phone!",
          "Say the alphabet backwards in a voice note!",
          "Send a compliment to 5 different people right now!",
          "Talk in rhymes for the next 5 minutes!",
          "Send your most recent screenshot!",
          "Do 10 push-ups and send proof!",
          "Change your profile photo to something funny for 30 minutes!",
          "Send a voice note of your best villain laugh!",
          "Write 'I am a potato' 10 times without copying and pasting!",
        ];
        const d = dares[Math.floor(Math.random() * dares.length)];
        await reply(sock, msg, `╭─「 😈 ᴅᴀʀᴇ 」\n│ 😈 *Dare*\n│\n│ _${d}_\n╰──────────●●►\n\n> ${footer}`);
        break;
      }

      case 'rps': {
        await react(sock, msg, '✊');
        const choice = (args || '').toLowerCase().trim();
        const validChoices = ['rock', 'paper', 'scissors', 'r', 'p', 's'];
        if (!choice || !validChoices.includes(choice)) {
          await reply(sock, msg, `╭─「 ✊ ʀᴘꜱ 」\n│ ✊ *Rock Paper Scissors*\n│ Usage: *${prefix}rps [rock/paper/scissors]*\n│ Shortcuts: r / p / s\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        const rpsMap = { r: 'rock', p: 'paper', s: 'scissors' };
        const userPick = rpsMap[choice] || choice;
        const options = ['rock', 'paper', 'scissors'];
        const botPick = options[Math.floor(Math.random() * 3)];
        const emoji = { rock: '✊', paper: '🖐️', scissors: '✌️' };
        let result;
        if (userPick === botPick) result = "🤝 *It's a Draw!*";
        else if (
          (userPick === 'rock' && botPick === 'scissors') ||
          (userPick === 'paper' && botPick === 'rock') ||
          (userPick === 'scissors' && botPick === 'paper')
        ) result = "🎉 *You Win!*";
        else result = "🤖 *Bot Wins!*";
        await reply(sock, msg, `╭─「 ✊ ʀᴘꜱ 」\n│ 👤 You  : ${emoji[userPick]} ${userPick.toUpperCase()}\n│ 🤖 Bot  : ${emoji[botPick]} ${botPick.toUpperCase()}\n│\n│ ${result}\n╰──────────●●►\n\n> ${footer}`);
        break;
      }

      // ══════════════════════════════════════════════════════════════════════
      // 🛠️  TOOLS
      // ══════════════════════════════════════════════════════════════════════

      case 'calc': {
        await react(sock, msg, '⏳');
        if (!args) {
          await reply(sock, msg, `╭─「 🔢 ᴄᴀʟᴄᴜʟᴀᴛᴏʀ 」\n│ 🔢 *Calculator*\n│ Usage: *${prefix}calc [expression]*\n│ • *${prefix}calc 25 * 4 + 10*\n│ • *${prefix}calc (100 / 4) ^ 2*\n│ • *${prefix}calc sqrt(144)*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        try {
          // Safe math evaluation — no eval, use Function with restricted scope
          const expr = args
            .replace(/[^0-9+\-*/()^%. ]/g, '')
            .replace(/\^/g, '**');
          // eslint-disable-next-line no-new-func
          const calcResult = Function(`"use strict"; return (${expr})`)();
          if (typeof calcResult !== 'number' || !isFinite(calcResult)) throw new Error('Invalid expression');
          await reply(sock, msg, `╭─「 🔢 ᴄᴀʟᴄᴜʟᴀᴛᴏʀ 」\n│ 📝 Expression: \`${args}\`\n│ ✅ Result: *${calcResult}*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
        } catch {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ ❌ Invalid expression. Please use numbers and operators only.\n│ Example: *${prefix}calc 25 * 4 + 10*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'qr': {
        await react(sock, msg, '⏳');
        if (!args) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ 📱 *QR Code Generator*\n│ Usage: *${prefix}qr [text or link]*\n│ • *${prefix}qr https://google.com*\n│ • *${prefix}qr Hello World*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        try {
          const qrBuffer = await QRCode.toBuffer(args, { type: 'png', width: 512, margin: 2 });
          await sock.sendMessage(jid, {
            image: qrBuffer,
            caption: `╭─「 📱 ǫʀ ᴄᴏᴅᴇ 」\n│ 📱 *QR Code Generated*\n│ 🔗 Content: _${args}_\n╰──────────●●►\n\n> ${footer}`,
            mimetype: 'image/png',
          }, { quoted: msg });
          await react(sock, msg, '✅');
        } catch (qrErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ QR generation failed. ${friendlyError(qrErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'toimg': {
        await react(sock, msg, '⏳');
        const tiCtx = msg.message?.extendedTextMessage?.contextInfo;
        const tiQuoted = tiCtx?.quotedMessage || msg.message;
        const tiSticker = tiQuoted?.stickerMessage;
        if (!tiSticker) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ 🖼️ *Sticker → Image*\n│ Reply to a *sticker* with *${prefix}toimg* to convert it to an image.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        try {
          const silentLogTi = { info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{}, child:()=>({ info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{} }) };
          const tiFakeMsg = tiCtx ? {
            key: { remoteJid: msg.key.remoteJid, id: tiCtx.stanzaId, participant: tiCtx.participant || undefined, fromMe: false },
            message: tiQuoted,
          } : msg;
          const webpBuf = await downloadMediaMessage(tiFakeMsg, 'buffer', {}, { logger: silentLogTi, reuploadRequest: sock.updateMediaMessage });
          if (!webpBuf || webpBuf.length === 0) throw new Error('Could not download sticker.');
          const tmpDir = os.tmpdir();
          const tmpWebp = path.join(tmpDir, `toimg_${Date.now()}.webp`);
          const tmpPng  = path.join(tmpDir, `toimg_${Date.now()}.png`);
          fs.writeFileSync(tmpWebp, webpBuf);
          await execFileAsync(ffmpegPath, ['-y', '-i', tmpWebp, tmpPng], { timeout: 30000 });
          const pngBuf = fs.readFileSync(tmpPng);
          fs.unlinkSync(tmpWebp); fs.unlinkSync(tmpPng);
          await sock.sendMessage(jid, { image: pngBuf, caption: `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🖼️ *Sticker converted to image!*\n╰──────────●●►\n\n> ${footer}`, mimetype: 'image/png' }, { quoted: msg });
          await react(sock, msg, '✅');
        } catch (tiErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Conversion failed. ${friendlyError(tiErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'toaudio': {
        await react(sock, msg, '⏳');
        const taCtx = msg.message?.extendedTextMessage?.contextInfo;
        const taQuoted = taCtx?.quotedMessage || msg.message;
        const taVideo = taQuoted?.videoMessage;
        if (!taVideo) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ 🎵 *Video → Audio*\n│ Reply to a *video* with *${prefix}toaudio* to extract the audio.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        try {
          const silentLogTa = { info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{}, child:()=>({ info:()=>{}, warn:()=>{}, error:()=>{}, debug:()=>{}, trace:()=>{} }) };
          const taFakeMsg = taCtx ? {
            key: { remoteJid: msg.key.remoteJid, id: taCtx.stanzaId, participant: taCtx.participant || undefined, fromMe: false },
            message: taQuoted,
          } : msg;
          const vidBuf = await downloadMediaMessage(taFakeMsg, 'buffer', {}, { logger: silentLogTa, reuploadRequest: sock.updateMediaMessage });
          if (!vidBuf || vidBuf.length === 0) throw new Error('Could not download video.');
          const tmpDir = os.tmpdir();
          const tmpVid = path.join(tmpDir, `toaudio_${Date.now()}.mp4`);
          const tmpAud = path.join(tmpDir, `toaudio_${Date.now()}.mp3`);
          fs.writeFileSync(tmpVid, vidBuf);
          await execFileAsync(ffmpegPath, ['-y', '-i', tmpVid, '-vn', '-acodec', 'mp3', '-q:a', '2', tmpAud], { timeout: 60000 });
          const audBuf = fs.readFileSync(tmpAud);
          fs.unlinkSync(tmpVid); fs.unlinkSync(tmpAud);
          await sock.sendMessage(jid, { audio: audBuf, mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
          await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🎵 *Audio extracted successfully!*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '✅');
        } catch (taErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Audio extraction failed. ${friendlyError(taErr)}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'weather': {
        await react(sock, msg, '⏳');
        if (!args) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ 🌤️ *Weather*\n│ Usage: *${prefix}weather [city]*\n│ • *${prefix}weather Colombo*\n│ • *${prefix}weather London*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        try {
          const wttrResp = await axios.get(`https://wttr.in/${encodeURIComponent(args)}?format=j1`, { timeout: 15000, headers: { 'User-Agent': 'curl/7.68.0' } });
          const wd = wttrResp.data;
          const cur = wd.current_condition?.[0];
          const area = wd.nearest_area?.[0];
          const city = area?.areaName?.[0]?.value || args;
          const country = area?.country?.[0]?.value || '';
          const tempC = cur?.temp_C || '?';
          const feelsC = cur?.FeelsLikeC || '?';
          const desc = cur?.weatherDesc?.[0]?.value || '?';
          const humidity = cur?.humidity || '?';
          const windKph = cur?.windspeedKmph || '?';
          const visibility = cur?.visibility || '?';
          const uvIndex = cur?.uvIndex || '?';
          const weatherEmoji =
            desc.toLowerCase().includes('sun') || desc.toLowerCase().includes('clear') ? '☀️' :
            desc.toLowerCase().includes('cloud') ? '⛅' :
            desc.toLowerCase().includes('rain') ? '🌧️' :
            desc.toLowerCase().includes('storm') || desc.toLowerCase().includes('thunder') ? '⛈️' :
            desc.toLowerCase().includes('snow') ? '❄️' :
            desc.toLowerCase().includes('fog') || desc.toLowerCase().includes('mist') ? '🌫️' : '🌤️';
          await reply(sock, msg,
            `╭─「 ${weatherEmoji} ᴡᴇᴀᴛʜᴇʀ 」\n` +
            `│ 📍 *${city}, ${country}*\n` +
            `│ 🌡️ Temp       : *${tempC}°C*\n` +
            `│ 🤔 Feels Like : *${feelsC}°C*\n` +
            `│ 🌥️ Condition  : *${desc}*\n` +
            `│ 💧 Humidity   : *${humidity}%*\n` +
            `│ 💨 Wind       : *${windKph} km/h*\n` +
            `│ 👁️ Visibility : *${visibility} km*\n` +
            `│ ☀️ UV Index   : *${uvIndex}*\n` +
            `╰──────────●●►\n\n` +
            `> ${footer}`
          );
          await react(sock, msg, '✅');
        } catch (wErr) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Could not fetch weather for *${args}*. Check the city name and try again.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      case 'currency':
      case 'conv': {
        await react(sock, msg, '⏳');
        const cvParts = (args || '').trim().split(/\s+/);
        if (cvParts.length < 3) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ 💱 *Currency Converter*\n│ Usage: *${prefix}currency [amount] [from] [to]*\n│ • *${prefix}currency 100 USD LKR*\n│ • *${prefix}currency 50 EUR GBP*\n│ • *${prefix}currency 1000 LKR USD*\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        const cvAmt = parseFloat(cvParts[0]);
        const cvFrom = cvParts[1].toUpperCase();
        const cvTo = cvParts[2].toUpperCase();
        if (isNaN(cvAmt) || cvAmt <= 0) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Invalid amount. Please enter a positive number.\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌'); break;
        }
        try {
          const cvResp = await axios.get(`https://api.frankfurter.app/latest?from=${cvFrom}&to=${cvTo}`, { timeout: 15000 });
          const rate = cvResp.data?.rates?.[cvTo];
          if (!rate) throw new Error(`Currency '${cvTo}' not found.`);
          const converted = (cvAmt * rate).toFixed(2);
          await reply(sock, msg,
            `╭─「 💱 ᴄᴜʀʀᴇɴᴄʏ 」\n` +
            `│ 💵 Amount : *${cvAmt} ${cvFrom}*\n` +
            `│ 📈 Rate   : *1 ${cvFrom} = ${rate} ${cvTo}*\n` +
            `│ ✅ Result : *${converted} ${cvTo}*\n` +
            `╰──────────●●►\n\n` +
            `> ${footer}`
          );
          await react(sock, msg, '✅');
        } catch (cvErr) {
          const cvFriendly = friendlyError(cvErr);
          const cvHint = cvFriendly.startsWith('🌐') || cvFriendly.startsWith('⏱️')
            ? cvFriendly
            : `${cvFriendly}\n\nMake sure you use valid currency codes (USD, EUR, LKR, GBP, etc.)`;
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ ${cvHint}\n╰──────────●●►\n\n> ${footer}`);
          await react(sock, msg, '❌');
        }
        break;
      }

      // ── AI Chat ────────────────────────────────────────────────────────────
      case 'ai': {
        if (meta.aiEnabled === false) {
          await reply(sock, msg, `╭─「 ℹ️ ɪɴꜰᴏ 」\n│ 🤖 AI chat is currently *disabled*.\n╰──────────●●►\n\n> ${footer}`);
          break;
        }
        if (!args) {
          await reply(sock, msg, `╭─「 📌 ᴜꜱᴀɢᴇ 」\n│ 🤖 *AI Chat*\n│ Usage: *${prefix}ai <your question>*\n│ Example: *${prefix}ai What is the capital of Sri Lanka?*\n╰──────────●●►\n\n> ${footer}`);
          break;
        }
        await react(sock, msg, '🤖');
        try {
          const senderJid = msg.key.participant || msg.key.remoteJid;
          const aiReply = await askAI(sessionId, senderJid, args);
          await reply(sock, msg, `╭─「 🤖 ᴀɪ ʀᴇᴘʟʏ 」\n│ ${aiReply.replace(/\n/g, '\n│ ')}\n╰──────────●●►\n\n> ${footer}`);
        } catch (err) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ AI error: ${friendlyError(err)}\n╰──────────●●►\n\n> ${footer}`);
        }
        break;
      }

      case 'aion': {
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          break;
        }
        meta.aiEnabled = true;
        saveMeta(sessionId, sessionsDir, meta);
        await react(sock, msg, '✅');
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ ✅ *AI Chat ENABLED*\n│ Users can now use: *${prefix}ai <question>*\n╰──────────●●►\n\n> ${footer}`);
        break;
      }

      case 'aioff': {
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          break;
        }
        meta.aiEnabled = false;
        saveMeta(sessionId, sessionsDir, meta);
        await react(sock, msg, '🔴');
        await reply(sock, msg, `╭─「 🔴 ᴅɪꜱᴀʙʟᴇᴅ 」\n│ 🔴 *AI Chat DISABLED*\n╰──────────●●►\n\n> ${footer}`);
        break;
      }

      case 'aiauto':
      case 'aiautoon': {
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          break;
        }
        const autoArg = cmd === 'aiautoon' ? 'on' : ((args || '').toLowerCase() === 'off' ? 'off' : 'on');
        meta.aiAutoReply = autoArg !== 'off';
        saveMeta(sessionId, sessionsDir, meta);
        const autoLabel = meta.aiAutoReply ? '✅ ENABLED' : '🔴 DISABLED';
        await react(sock, msg, meta.aiAutoReply ? '✅' : '🔴');
        await reply(sock, msg, `╭─「 🤖 ᴀɪ ᴀᴜᴛᴏ-ʀᴇᴘʟʏ 」\n│ 🤖 *AI Auto-Reply ${autoLabel}*\n│ ${meta.aiAutoReply ? 'Bot will auto-reply with AI in private chats.' : 'Auto-reply disabled.'}\n╰──────────●●►\n\n> ${footer}`);
        break;
      }

      case 'aiclr':
      case 'aiclear': {
        if (!isOwner(msg, meta, sessionDir)) {
          await reply(sock, msg, `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Only the owner can use this command.\n╰──────────●●►\n\n> ${footer}`);
          break;
        }
        clearAIHistory(sessionId);
        await react(sock, msg, '🗑️');
        await reply(sock, msg, `╭─「 ✅ ꜱᴜᴄᴄᴇꜱꜱ 」\n│ 🗑️ *AI conversation history cleared* for all users.\n╰──────────●●►\n\n> ${footer}`);
        break;
      }
      // ── end AI Chat ────────────────────────────────────────────────────────

      default: {
        await react(sock, msg, '❓');
        await reply(
          sock,
          msg,
          `╭─「 ❌ ᴇʀʀᴏʀ 」\n│ ❌ Unknown command: *.${cmd}*\n│ Type *.menu* to see all commands.\n╰──────────●●►\n\n> ${footer}`
        );
        break;
      }
    }
  } catch (err) {
    try {
      await react(sock, msg, '❌');
      await reply(sock, msg, `❌ ${friendlyError(err)}`);
    } catch {
      // Ignore
    }
  }
};
