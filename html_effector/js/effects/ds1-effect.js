/**
 * ds1-effect.js — BOSS DS-1 风格失真模拟。
 *
 * 处理方式（按 DS-1 的思路模拟）：
 *  - 输入经高通滤掉多余低频（防“糊”）后进入高增益级；
 *  - 二极管削波刻意「不对称」（负半周被削得更狠）→ 除奇次外还带偶数次谐波，
 *    是 DS-1 那种“硬、利、有咬感”音色的关键；
 *  - 音色旋钮为削波后的低通滤波。
 * 信号链：pre(gain) → hp(低切≈140Hz) → ws(不对称硬削波) → tone(lp) → post(gain)
 */
FX.Ds1Effect = class Ds1Effect extends FX.BaseEffect {

  static id = 'ds1';
  static name = 'BOSS DS-1';
  static description = '按 BOSS DS-1 失真的处理方式模拟：高增益不对称硬削波，利落有咬感。';
  static category = 'distortion';

  static params = [
    { key: 'drive', label: '失真', type: 'range', min: 0,   max: 40, step: 0.5, def: 26,   unit: 'dB' },
    { key: 'tone',  label: '音色', type: 'range', min: 500, max: 7000, step: 0, def: 2400, unit: 'Hz', log: true },
    { key: 'level', label: '输出', type: 'range', min: -20, max: 20,  step: 0.5, def: 0,    unit: 'dB' }
  ];

  _build(ctx) {
    this.pre = this._own(ctx.createGain());
    this.hp  = this._own(ctx.createBiquadFilter());   // 输入低切
    this.hp.type = 'highpass';
    this.hp.frequency.value = 140;
    this.hp.Q.value = 0.6;

    this.ws  = this._own(ctx.createWaveShaper());
    this.ws.oversample = '2x';

    this.tone = this._own(ctx.createBiquadFilter());
    this.tone.type = 'lowpass';
    this.tone.Q.value = 0.7;
    this.post = this._own(ctx.createGain());

    this.pre.connect(this.hp);
    this.hp.connect(this.ws);
    this.ws.connect(this.tone);
    this.tone.connect(this.post);

    this.fxIn  = this.pre;
    this.fxOut = this.post;
    this._rebuildCurve();
  }

  /** 不对称软削波：C(u)=u/(1+|u|)；负半周输入乘以 1.35 → 负向削得更狠（DS-1 特征） */
  _rebuildCurve() {
    const k = 4;
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      if (x >= 0) {
        const u = k * x;
        curve[i] = u / (1 + Math.abs(u));
      } else {
        const u = k * x * 1.35;                       // 负半周更陡
        curve[i] = u / (1 + Math.abs(u));
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
