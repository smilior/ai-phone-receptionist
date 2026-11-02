// Cloudflare Worker版 中継：ブラウザ／電話(Twilio) ⇔ Gemini Live（生のWebSocketプロトコル）
import { SYSTEM_INSTRUCTION } from './prompt.js';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// --- base64 / μ-law 変換（Workersには Buffer が無いので Uint8Array で） ---
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }
function mulawToPcm(u) { u = ~u & 0xff; const sign = u & 0x80, exp = (u >> 4) & 7, man = u & 0x0f; let s = ((man << 3) + 0x84) << exp; s -= 0x84; return sign ? -s : s; }
function pcmToMulaw(s) { const sign = s < 0 ? 0x80 : 0; if (sign) s = -s; s = Math.min(s, 32635) + 0x84; let exp = 7; for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--; const man = (s >> (exp + 3)) & 0x0f; return ~(sign | (exp << 4) | man) & 0xff; }
function twilioToGemini(mu) { const out = new DataView(new ArrayBuffer(mu.length * 4)); for (let i = 0; i < mu.length; i++) { const a = mulawToPcm(mu[i]); const b = i + 1 < mu.length ? mulawToPcm(mu[i + 1]) : a; out.setInt16(i * 4, a, true); out.setInt16(i * 4 + 2, (a + b) >> 1, true); } return new Uint8Array(out.buffer); }
function geminiToTwilio(pcm) { const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength); const n = Math.floor(pcm.length / 6); const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = pcmToMulaw(Math.round((v.getInt16(i * 6, true) + v.getInt16(i * 6 + 2, true) + v.getInt16(i * 6 + 4, true)) / 3)); return out; }

// --- Gemini Live へ接続（setupComplete までに来た送信はキューにためる） ---
async function openGemini(env, h) {
  const res = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error('Gemini接続失敗 status=' + res.status);
  ws.accept();
  let ready = false; const queue = [];
  const send = (obj) => { const s = JSON.stringify(obj); ready ? ws.send(s) : queue.push(s); };
  ws.send(JSON.stringify({ setup: {
    model: 'models/' + (env.GEMINI_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025'),
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
  } }));
  ws.addEventListener('message', async (e) => {
    const text = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data instanceof ArrayBuffer ? e.data : await e.data.arrayBuffer());
    const msg = JSON.parse(text);
    if (msg.setupComplete) { ready = true; queue.splice(0).forEach((s) => ws.send(s)); return; }
    const sc = msg.serverContent; if (!sc) return;
    if (sc.interrupted) h.onInterrupted?.();
    for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) h.onAudio(p.inlineData.data);
  });
  ws.addEventListener('close', (e) => { console.log('Gemini切断', e.code); h.onClose?.(); });
  ws.addEventListener('error', () => h.onClose?.());
  return {
    sendAudio: (b64) => send({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } }),
    sendText: (text) => send({ realtimeInput: { text } }),
    close: () => { try { ws.close(1000); } catch {} },
  };
}

function handleBrowser(env, ws) {
  const g = openGemini(env, {
    onAudio: (b64) => ws.send(b64ToBytes(b64)),
    onInterrupted: () => ws.send(JSON.stringify({ type: 'interrupted' })),
    onClose: () => { try { ws.close(1000); } catch {} },
  });
  g.catch(() => ws.close(1011, 'gemini'));
  ws.addEventListener('message', async (e) => { if (typeof e.data !== 'string') (await g).sendAudio(bytesToB64(new Uint8Array(e.data))); });
  ws.addEventListener('close', async () => (await g).close());
}

function handleTwilio(env, ws) {
  let streamSid = null;
  const g = openGemini(env, {
    onAudio: (b64) => { if (streamSid) ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: bytesToB64(geminiToTwilio(b64ToBytes(b64))) } })); },
    onInterrupted: () => streamSid && ws.send(JSON.stringify({ event: 'clear', streamSid })),
    onClose: () => { try { ws.close(1000); } catch {} },
  });
  g.catch(() => ws.close(1011, 'gemini'));
  ws.addEventListener('message', async (e) => {
    const msg = JSON.parse(e.data); const gem = await g;
    if (msg.event === 'start') { streamSid = msg.start.streamSid; gem.sendText('（電話がつながりました。挨拶してください）'); }
    else if (msg.event === 'media') gem.sendAudio(bytesToB64(twilioToGemini(b64ToBytes(msg.media.payload))));
    else if (msg.event === 'stop') ws.close(1000);
  });
  ws.addEventListener('close', async () => (await g).close());
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/twiml') {
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><Stream url="wss://${url.host}/twilio-media" /></Connect></Response>`, { headers: { 'Content-Type': 'text/xml' } });
    }
    const route = { '/browser': handleBrowser, '/twilio-media': handleTwilio, '/twilio': handleTwilio }[url.pathname];
    if (route) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket only', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      server.binaryType = 'arraybuffer';
      server.accept();
      route(env, server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return env.ASSETS ? env.ASSETS.fetch(req) : new Response('not found', { status: 404 });
  },
};
