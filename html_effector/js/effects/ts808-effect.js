/**
 * ts808-effect.js — Ibanez TS-808 风格过载模拟（808 过载）。
 *
 * 处理方式（按 808 的思路模拟）：
 *  - 中低增益 op-amp 级联 + 双二极管软削波 → 声音“圆润”，无明显毛刺；
 *  - 削波前轻微不对称（负半周增益略低），带来一丝自然泛音；
 *  - 固定中频峰化(≈800Hz) 还原 808 标志性的“中频凸起”，
 *    之后是可变低通「音色 Tone」。
 * 信号链：pre(gain) → ws(tanh 软削波,微不对称) → mid(peaking≈800Hz)
 *        → tone(lowpass) → post(gain)
 */
FX.Ts808Effect = class Ts808Effect extends FX.BaseEffect {

  static id = 'ts808';
  static name = '808 过载 TS-808';
  static description = '按 Ibanez TS-808 过载的处理方式模拟：中频凸起 + 柔和二极管软削波。';
  static category = 'overdrive';

  static params = [
    { key: 'drive', label: '增益', type: 'range', min: 0,   max: 24, step: 0.5, def: 10,   unit: 'dB' },
    { key: 'tone',  label: '音色', type: 'range', min: 350, max: 7000, step: 0, def: 2600, unit: 'Hz', log: true },
    { key: 'level', label: '输出', type: 'range', min: -20, max: 20,  step: 0.5, def: 0,    unit: 'dB' }
  ];

  _build(ctx) {
    this.pre = this._own(ctx.createGain());          // 驱动增益（808 增益不算高）
    this.ws  = this._own(ctx.createWaveShaper());
    this.ws.oversample = '2x';
    this.mid = this._own(ctx.createBiquadFilter());  // 中频峰化（808 音色标志）
    this.mid.type = 'peaking';
    this.mid.frequency.value = 800;
    this.mid.Q.value = 1.2;
    this.mid.gain.value = 3.0;
    this.tone = this._own(ctx.createBiquadFilter()); // 音色低通
    this.tone.type = 'lowpass';
    this.tone.Q.value = 0.55;
    this.post = this._own(ctx.createGain());

    this.pre.connect(this.ws);
    this.ws.connect(this.mid);
    this.mid.connect(this.tone);
    this.tone.connect(this.post);

    this.fxIn  = this.pre;
    this.fxOut = this.post;
    this._rebuildCurve();
  }

  /** 软削波曲线：tanh 归一化 + 负半周 0.92 倍 → 轻微不对称，二极管的温暖感 */
  _rebuildCurve() {
    const k = 2.8;
    const n = 2048;
    const curve = new Float32Array(n);
    const dPos = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      if (x >= 0) {
        curve[i] = Math.tanh(k * x) / dPos;
      } else {
        curve[i] = -Math.tanh(k * Math.abs(x) * 0.92) / dPos;
      }
    }
    this.ws.curve = curve;
  }

  onParam(key, value) {
    if (key === 'drive') {
      FX.utils.automate(this.pre.gain, FX.utils.dbToGain(value), 0.01);
    } else if (key === 'tone') {
      FX.utils.automate(this.tone.frequency, value, 0.02);
    } else if (key === 'level') {
      FX.utils.automate(this.post.gain, FX.utils.dbToGain(value), 0.01);
    }
  }
};
