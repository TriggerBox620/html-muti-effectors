/**
 * tricorus-effect.js — 三重合唱模块（Tri-Chorus）。
 *
 * 原理：输入分成 3 路短延迟调制声部，各声部正弦 LFO 速率/深度错开、
 * 相位互不重叠（120°），叠加产生宽阔平滑的合唱/镶边质感。
 *
 * 音色要点（相比粗糙的深调制版本）：
 *  - 调制深度控制在 ~2-3ms 量级 → 是“合唱般的微妙波动”而非明显颤音/机械镶边；
 *  - 每声部延迟后接 6.5~8kHz 柔化低通 → 抑制延迟线 comb 的高频金属味；
 *  - 三声部速率比例 1 / 1.4 / 1.8 → 无规则“打架”，产生合唱特有的厚度感。
 * 信号链：
 *   fxIn ─┬─► dry ──────────────────────────► sum ─► fxOut
 *         ├─► dly#0 ─► lp#0 ─► vg0 ─► wet ──┘
 *         ├─► dly#1 ─► lp#1 ─► vg1 ─► wet
 *         └─► dly#2 ─► lp#2 ─► vg2 ─► wet   （LFO→Gain→delayTime 做音频率调制）
 */
FX.TriChorusEffect = class TriChorusEffect extends FX.BaseEffect {

  static id = 'tricorus';
  static name = '三重合唱 Tri-Chorus';
  static description = '三路 LFO 错相调制的平滑三重合唱，宽厚不刺耳，适合铺底与清音旋律。';
  static category = 'modulation';

  static params = [
    { key: 'rate',  label: '速率', type: 'range', min: 0.1, max: 6,   step: 0.05, def: 0.5, unit: 'Hz' },
    { key: 'depth', label: '深度', type: 'range', min: 0,   max: 100, step: 1,    def: 40,  unit: '%' },
    { key: 'mix',   label: '混合', type: 'range', min: 0,   max: 100, step: 1,    def: 45,  unit: '%' }
  ];

  // 三个声部结构参数：中心延迟 / 最大调制深度(秒) / 速率倍率 / 柔化低通频率
  static VOICES = [
    { center: 0.020, depth: 0.0018, rateMul: 1.00, colorHz: 8000 },
    { center: 0.023, depth: 0.0024, rateMul: 1.40, colorHz: 7200 },
    { center: 0.026, depth: 0.0030, rateMul: 1.80, colorHz: 6500 }
  ];

  _build(ctx) {
    this._voices = [];

    this.dry = this._own(ctx.createGain());
    this.wet = this._own(ctx.createGain());
    this.sum = this._own(ctx.createGain());
    this.fxIn = this._own(ctx.createGain());

    this.fxIn.connect(this.dry);

    TriChorusEffect.VOICES.forEach((cfg, i) => {
      const dly = this._own(ctx.createDelay(0.09));
      dly.delayTime.value = cfg.center;

      const color = this._own(ctx.createBiquadFilter());   // 高频柔化
      color.type = 'lowpass';
      color.frequency.value = cfg.colorHz;
      color.Q.value = 0.4;

      const lfo = this._own(ctx.createOscillator());
      lfo.type = 'sine';
      lfo.frequency.value = this._values.rate * cfg.rateMul;

      const lfoGain = this._own(ctx.createGain());         // 调制深度（秒）
      lfo.connect(lfoGain);
      lfoGain.connect(dly.delayTime);

      const vg = this._own(ctx.createGain());
      vg.gain.value = 1 / 3;

      this.fxIn.connect(dly);
      dly.connect(color);
      color.connect(vg);
      vg.connect(this.wet);

      // 相位 120° 错开：以 start 时刻偏移实现（offset = phase/(2π·f)）
      const phaseSec = (i / 3) / lfo.frequency.value;
      lfo.start(ctx.currentTime + 0.05 + phaseSec);

      this._voices.push({ dly, color, lfo, lfoGain, vg, cfg, index: i });
    });

    this.dry.connect(this.sum);
    this.wet.connect(this.sum);
    this.fxOut = this.sum;
  }

  onParam(key, value) {
    if (key === 'rate') {
      for (const v of this._voices) {
        FX.utils.automate(v.lfo.frequency, value * v.cfg.rateMul, 0.05);
      }
    } else if (key === 'depth') {
      const ratio = value / 100;
      for (const v of this._voices) {
        // 中心 20~26ms，最大调制 1.8~3ms → 平滑合唱，不产生明显颤音
        FX.utils.automate(v.lfoGain.gain, v.cfg.depth * ratio, 0.05);
      }
    } else if (key === 'mix') {
      const m = value / 100;
      FX.utils.automate(this.dry.gain, Math.cos(m * Math.PI / 2), 0.03);
      FX.utils.automate(this.wet.gain, Math.sin(m * Math.PI / 2), 0.03);
    }
  }

  dispose() {
    for (const v of this._voices) {
      try { v.lfo.stop(); } catch (e) { /* noop */ }
    }
    super.dispose();
  }
};
