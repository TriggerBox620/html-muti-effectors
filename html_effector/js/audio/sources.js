/**
 * sources.js — 音源组件：
 *   BufferPlayer  通用缓冲播放器（演示音色 / 上传文件共用）
 *   makeDemoRiff  离线合成一段 A 小调五声音阶 RIFF，方便不开麦克风也能试效果
 */
FX.BufferPlayer = class BufferPlayer {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioBuffer} buffer
   * @param {boolean} loop
   */
  constructor(ctx, buffer, loop = true) {
    this.ctx = ctx;
    this.buffer = buffer;
    this.loop = loop;
    this.label = '';
    this.playing = false;
    this._src = null;
    this.out = ctx.createGain();   // 播放器输出，供引擎接入 inGain
    this.out.gain.value = 1;
  }

  start() {
    if (!this.buffer || this.playing) return;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.loop;
    src.onended = () => { if (this._src === src) { this._src = null; this.playing = false; } };
    src.connect(this.out);
    src.start();
    this._src = src;
    this.playing = true;
  }

  stop() {
    if (this._src) {
      try { this._src.onended = null; this._src.stop(); } catch (e) { /* noop */ }
      try { this._src.disconnect(); } catch (e) { /* noop */ }
      this._src = null;
    }
    this.playing = false;
  }

  toggle() { this.playing ? this.stop() : this.start(); }
};

/**
 * 用纯数学合成一小段「拨弦式」A 小调五声音阶 RIFF。
 * 每个音符 = 指数衰减包络 × 带少量谐波的基频正弦，接近吉他拨弦质感。
 */
FX.makeDemoRiff = function makeDemoRiff(ctx) {
  const sr = ctx.sampleRate;

  // 音符表：[频率 Hz, 持续拍数(八分音符), 衰减秒数]
  // A2=110, C3=130.8, D3=146.8, E3=164.8, G3=196, A3=220, C4=261.6
  const BPM = 112;
  const eighth = 60 / BPM / 2;                       // 一个八分音符时长(s)
  const NOTES = [
    [110,   1, 0.30], [220,   1, 0.20], [164.8, 1, 0.20], [220,   1, 0.20],
    [130.8, 1, 0.28], [196,   1, 0.20], [220,   2, 0.50],
    [110,   1, 0.30], [220,   1, 0.20], [164.8, 1, 0.20], [220,   1, 0.20],
    [146.8, 2, 0.40], [130.8, 1, 0.20],
    [110,   2, 0.50], [146.8, 1, 0.20], [220,   1, 0.20], [164.8, 1, 0.20],
    [220,   1, 0.20], [110,   2, 0.55], [220,   2, 0.55]
  ];

  let totalSec = 0.6;                                 // 尾部留白
  for (const n of NOTES) totalSec += n[1] * eighth;

  const len = Math.ceil(totalSec * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);

  let t = 0.05;                                       // 开头留一点点空白
  for (const [freq, beats, decay] of NOTES) {
    const dur = beats * eighth;
    const n0 = Math.floor(t * sr);
    const n1 = Math.min(len - 1, Math.floor((t + dur) * sr));
    const attack = Math.max(1, Math.floor(sr * 0.004));   // 4ms 起音
    for (let i = n0; i < n1; i++) {
      const tt = (i - n0) / sr;                       // 音符内时间
      const env = Math.min(1, tt / 0.004) * Math.exp(-tt / decay);
      // 拨弦音色：基频 + 2 次、3 次谐波（幅度递减）
      const w = 2 * Math.PI * freq * tt;
      const sig = Math.sin(w) + 0.45 * Math.sin(2 * w) + 0.18 * Math.sin(3 * w);
      data[i] += env * sig * 0.55;
    }
    t += dur;
  }

  // 归一化到峰值 ~0.9
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) {
    const g = 0.9 / peak;
    for (let i = 0; i < len; i++) data[i] *= g;
  }
  return buf;
};
