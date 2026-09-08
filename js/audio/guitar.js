/**
 * guitar.js — 虚拟电吉他音源。
 *
 * 核心：
 *  - FX.makePluckBuffer(ctx, freq)：把离线生成 RIFF 用的 Karplus-Strong 拨弦模型
 *    搬到浏览器里，按音高实时合成一段干净的拨弦 AudioBuffer（干声，无任何效果），
 *    播放时直连效果器链的输入端，走与麦克风/文件相同的通道。
 *  - 标准调弦 + 24 品音高计算与音名工具，供 fretboard UI 使用。
 */
FX.makePluckBuffer = function makePluckBuffer(ctx, freq) {
  const sr = ctx.sampleRate;
  const dur = 2.4;
  const n = Math.floor(dur * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const out = buf.getChannelData(0);

  // 确定性随机（同一音高永远同一声 → 可缓存）
  let seed = Math.floor(freq * 100);
  const rnd = function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const detune = (rnd() - 0.5) * 4;                 // ±2 音分
  const f = freq * Math.pow(2, detune / 100);

  // KS 弦振动缓冲（与 tools/gen-guitar-solo.js 同算法）
  const Lseed = Math.ceil(sr / (f * 0.94)) + 4;
  const offset = Lseed + 4;
  const arr = new Float64Array(n + offset + 4);
  for (let k = 0; k < Lseed; k++) {
    arr[offset - Lseed + k] = (rnd() * 2 - 1) * 0.95;
  }
  const damp = Math.exp(-1 / (0.9 * sr));
  const fade = Math.min(0.35, dur * 0.25);

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const d = sr / f;
    const j = offset + i;
    const iD = Math.floor(d);
    const fr = d - iD;
    const a = arr[j - iD];
    const b = arr[j - iD - 1];
    const c = arr[j - iD - 2];
    const ring = 0.5 * ((a + (b - a) * fr) + (b + (c - b) * fr)) * damp;

    let ge = 1;
    if (t > dur - fade) ge = Math.max(0, (dur - t) / fade);
    if (i < 2) ge *= 0.2;
    arr[j] = ring;

    out[i] += ring * ge * 0.6;
    // 拨片瞬态
    if (t < 0.02) out[i] += (rnd() * 2 - 1) * 0.30 * Math.exp(-t / 0.004) * ge;
  }
  return buf;
};

/* ---- 标准调弦 + 音高工具（6 弦：低 E → 高 e） ---- */
FX.Guitar = {
  strings: [
    { openFreq: 82.4069,  name: 'E2' },
    { openFreq: 110.00,   name: 'A2' },
    { openFreq: 146.832,  name: 'D3' },
    { openFreq: 195.998,  name: 'G3' },
    { openFreq: 246.942,  name: 'B3' },
    { openFreq: 329.628,  name: 'E4' }
  ],
  frets: 24,

  /** 某弦某品的频率 */
  freqAt(stringIdx, fret) {
    return FX.Guitar.strings[stringIdx].openFreq * Math.pow(2, fret / 12);
  },

  /** 频率 → 最近 MIDI 音名（含八度），如 "D#4" */
  freqToName(freq) {
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const oct = Math.floor(midi / 12) - 1;
    return names[((midi % 12) + 12) % 12] + oct;
  }
};
