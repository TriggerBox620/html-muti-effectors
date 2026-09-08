/**
 * recorder.js — 录音与导出（WAV / MP3）。
 *
 * 录音点：引擎主输出（masterVU 处），因此录到的是「经过效果器链处理后的最终声音」。
 * 实现：
 *  - 录音时把一个 ScriptProcessorNode 串入 masterVU → destination 之间做直通采样；
 *  - WAV：导出为 16bit PCM，纯本地编码，永远可用；
 *  - MP3：用 lamejs（尝试从 CDN 加载一次并缓存）；离线加载失败时给出回退提示。
 */
FX.WavWriter = {
  /** 把 1..N 声道 Float32Array 编码为 16bit PCM WAV Blob */
  encode(channels, sampleRate) {
    const nCh = channels.length;
    const total = channels[0].length;
    const bytes = 44 + total * nCh * 2;
    const ab = new ArrayBuffer(bytes);
    const v = new DataView(ab);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);                       // PCM
    v.setUint16(22, nCh, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * nCh * 2, true);
    v.setUint16(32, nCh * 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, total * nCh * 2, true);
    for (let i = 0; i < total; i++) {
      for (let c = 0; c < nCh; c++) {
        let s = channels[c][i];
        s = Math.max(-1, Math.min(1, s));
        v.setInt16(44 + (i * nCh + c) * 2, Math.round(s * 32767), true);
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }
};

FX.downloadBlob = function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
};

/** 一次性加载 lamejs（多 CDN 尝试，失败抛错提示离线回退） */
FX._lamePromise = null;
FX.loadLame = function loadLame() {
  if (!FX._lamePromise) {
    FX._lamePromise = (async () => {
      if (window.lamejs) return window.lamejs;
      const urls = [
        'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js',
        'https://unpkg.com/lamejs@1.2.1/lame.min.js'
      ];
      for (const url of urls) {
        try {
          await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = res;
            s.onerror = () => rej(new Error('load fail'));
            document.head.appendChild(s);
          });
          if (window.lamejs) return window.lamejs;
        } catch (e) { /* 尝试下一个 CDN */ }
      }
      FX._lamePromise = null;
      throw new Error('MP3 编码库(lamejs)加载失败：当前环境可能离线。请使用 WAV 导出。');
    })();
  }
  return FX._lamePromise;
};

/** Float32 单声道 → MP3 Blob（192kbps） */
FX.encodeMp3Blob = async function encodeMp3Blob(samples, sampleRate) {
  const lame = await FX.loadLame();
  const enc = new lame.Mp3Encoder(1, sampleRate, 192);
  const n = samples.length;
  const left = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    left[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  const block = 1152;
  const parts = [];
  for (let i = 0; i < n; i += block) {
    const chunk = enc.encodeBuffer(left.subarray(i, Math.min(n, i + block)));
    if (chunk && chunk.length) parts.push(chunk);
  }
  const end = enc.flush();
  if (end && end.length) parts.push(end);
  const size = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return new Blob([out], { type: 'audio/mpeg' });
};

/**
 * FX.Recorder — 挂在 engine 主输出上的录音器。
 * start() 把直通采样节点串入 masterVU→destination；
 * stop()  还原接线并返回 { samples: Float32Array(mono), sampleRate, seconds }。
 */
FX.Recorder = class Recorder {
  constructor(engine) {
    this.engine = engine;
    this._proc = null;
    this._chunks = null;
    this.recording = false;
  }

  async start() {
    if (this.recording) return;
    const eng = this.engine;
    if (!eng.ctx) await eng.start();
    const c = eng.ctx;
    const vu = eng.masterVU;
    if (!vu || !c.destination) throw new Error('音频引擎未就绪，无法录音');

    const proc = c.createScriptProcessor(4096, 1, 1);
    this._chunks = [];
    proc.onaudioprocess = (e) => {
      const inData = e.inputBuffer.getChannelData(0);
      // 直通：原样拷贝回输出，保证音量/相位不变
      e.outputBuffer.getChannelData(0).set(inData);
      this._chunks.push(new Float32Array(inData));   // 拷贝留存
    };
    try { vu.disconnect(c.destination); } catch (e) { /* noop */ }
    vu.connect(proc);
    proc.connect(c.destination);
    this._proc = proc;
    this.recording = true;
  }

  stop() {
    if (!this.recording || !this._proc) return null;
    const eng = this.engine;
    const c = eng.ctx;
    const vu = eng.masterVU;
    const proc = this._proc;
    this.recording = false;
    this._proc = null;

    try { vu.disconnect(proc); } catch (e) { /* noop */ }
    try { proc.disconnect(); } catch (e) { /* noop */ }
    if (c && c.destination) vu.connect(c.destination);   // 还原主链

    const chunks = this._chunks || [];
    this._chunks = null;
    let total = 0;
    for (const ch of chunks) total += ch.length;
    const samples = new Float32Array(total);
    let off = 0;
    for (const ch of chunks) { samples.set(ch, off); off += ch.length; }
    return { samples, sampleRate: c ? c.sampleRate : 44100, seconds: total / (c ? c.sampleRate : 44100) };
  }
};
