/**
 * delay-effect.js — 延迟模块。
 *
 * 信号链：
 *   fxIn ─┬─► dry ────────────► sum ─► fxOut   （干声，直达）
 *         └─► delay ─┬─► wet ──► sum            （湿声）
 *                    └─► feedback ─► delay      （反馈回路：产生重复回声）
 *
 * mix 采用等功率混音（dry = cos, wet = sin），0% 全干声、100% 全湿声。
 */
FX.DelayEffect = class DelayEffect extends FX.BaseEffect {

  static id = 'delay';
  static name = '延迟 Delay';
  static description = '数字回声/延迟效果，可调时间、反馈与干湿比，适合铺底与空间感。';
  static category = 'time';

  static params = [
    { key: 'time',     label: '时间',  type: 'range', min: 20, max: 1500, step: 1,  def: 330, unit: 'ms' },
    { key: 'feedback', label: '反馈',  type: 'range', min: 0,  max: 92,   step: 1,  def: 38,  unit: '%' },
    { key: 'mix',      label: '混合',  type: 'range', min: 0,  max: 100,  step: 1,  def: 30,  unit: '%' }
  ];

  _build(ctx) {
    this.dry = this._own(ctx.createGain());
    this.wet = this._own(ctx.createGain());
    this.sum = this._own(ctx.createGain());

    this.dly = this._own(ctx.createDelay(3.0));     // 最大 3 秒
    this.dly.delayTime.value = 0.33;

    this.fb = this._own(ctx.createGain());          // 反馈回路
    this.fb.gain.value = 0.38;

    // 干声旁路 + 延迟主干
    this.dly.connect(this.fb);
    this.fb.connect(this.dly);                      // 反馈闭环
    this.dly.connect(this.wet);

    this.fxIn = this._own(ctx.createGain());        // 统一入口（便于接线）
    this.fxIn.connect(this.dry);
    this.fxIn.connect(this.dly);
    this.dry.connect(this.sum);
    this.wet.connect(this.sum);

    this.fxOut = this.sum;
  }

  onParam(key, value) {
    if (key === 'time') {
      FX.utils.automate(this.dly.delayTime, value / 1000, 0.03);
    } else if (key === 'feedback') {
      FX.utils.automate(this.fb.gain, value / 100, 0.03);
    } else if (key === 'mix') {
      const m = value / 100;
      // 等功率定律：全湿时干声不为 0，避免“抽水”感
      FX.utils.automate(this.dry.gain, Math.cos(m * Math.PI / 2), 0.03);
      FX.utils.automate(this.wet.gain, Math.sin(m * Math.PI / 2), 0.03);
    }
  }
};
