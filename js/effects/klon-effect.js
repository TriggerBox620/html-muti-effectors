/**
 * klon-effect.js — Klon Centaur 风格过载模拟（金人马过载）。
 *
 * 处理方式（按“金人马/透明过载”的思路模拟）：
 *  - 干声与过载声按固定比例并行混合（Transparent Overdrive 的核心思路），
 *    低频不塌、中频不凸，几乎不染色输入信号；
 *  - 削波级增益很低、曲线平缓 → 过载“顺滑”，只有推大增益才出现砂感；
 *  - 「音色」为高频柔化低通（Klon 的 Treble 特性）。
 * 信号链：
 *   fxIn ─┬─► dry(0.5) ──────────┐
 *         └─► pre ─► ws(软削波) ─► dirt(0.5) ─► sum ─► tone(lp) ─► post ─► fxOut
 */
FX.KlonEffect = class KlonEffect extends FX.BaseEffect {

  static id = 'klon';
  static name = '金人马过载 Klon';
  static description = '按 Klon Centaur 的处理方式模拟：干/湿并行透明过载，音染极小、触感顺滑。';
  static category = 'overdrive';

  static params = [
    { key: 'gain', label: '增益', type: 'range', min: 0,    max: 28, step: 0.5, def: 12,   unit: 'dB' },
    { key: 'tone', label: '音色', type: 'range', min: 500,  max: 10000, step: 0, def: 5600, unit: 'Hz', log: true },
    { key: 'level', label: '输出', type: 'range', min: -20, max: 20,  step: 0.5, def: 0,    unit: 'dB' }
  ];

  _build(ctx) {
    this.pre = this._own(ctx.createGain());           // 削波级驱动增益
    this.ws  = this._own(ctx.createWaveShaper());
    this.ws.oversample = '2x';

    this.dry  = this._own(ctx.createGain()); this.dry.gain.value = 0.5;
    this.dirt = this._own(ctx.createGain()); this.dirt.gain.value = 0.5;
    this.sum  = this._own(ctx.createGain());

    this.tone = this._own(ctx.createBiquadFilter());  // 高频柔化
    this.tone.type = 'lowpass';
    this.tone.Q.value = 0.4;
    this.post = this._own(ctx.createGain());

    this.fxIn = this._own(ctx.createGain());
    this.fxIn.connect(this.pre);
    this.fxIn.connect(this.dry);
    this.pre.connect(this.ws);
    this.ws.connect(this.dirt);
    this.dry.connect(this.sum);
    this.dirt.connect(this.sum);
    this.sum.connect(this.tone);
    this.tone.connect(this.post);

    this.fxOut = this.post;
    this._rebuildCurve();
  }

  /** 平缓 tanh 软削波（k 小 → 几乎线性的低增益透明感） */
  _rebuildCurve() {
    const k = 2.2;
    const n = 2048;
    const curve = new Float32Array(n);
    const d = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / d;
    }
    this.ws.curve = curve;
  }

  onParam(key, value) {
    if (key === 'gain') {
      FX.utils.automate(this.pre.gain, FX.utils.dbToGain(value), 0.01);
    } else if (key === 'tone') {
      FX.utils.automate(this.tone.frequency, value, 0.03);
    } else if (key === 'level') {
      FX.utils.automate(this.post.gain, FX.utils.dbToGain(value), 0.01);
    }
  }
};
