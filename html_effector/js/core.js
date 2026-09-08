/**
 * core.js — 全局命名空间、基础工具函数、极简事件总线。
 *
 * 约定：所有模块都挂载到 window.FX 下，互不污染全局。
 * 加载顺序（见 index.html）：core → effects/base → effects/* → registry → audio/* → ui/* → main
 */
window.FX = window.FX || {};

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */
FX.utils = {

  /** 数值钳制 */
  clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  },

  /** 线性插值 */
  lerp(a, b, t) {
    return a + (b - a) * t;
  },

  /** dB -> 线性增益 */
  dbToGain(db) {
    return Math.pow(10, db / 20);
  },

  /** 线性增益 -> dB */
  gainToDb(g) {
    return 20 * Math.log10(Math.max(g, 1e-6));
  },

  /** 百分比换算 0..1 */
  pct(v) {
    return FX.utils.clamp(v, 0, 1);
  },

  /**
   * 平滑设置 AudioParam（消除爆音 / zipper noise）。
   * timeConst 越小响应越快，一般 0.01 ~ 0.05。
   */
  automate(param, value, timeConst = 0.02) {
    if (!param || typeof param.setTargetAtTime !== 'function') return;
    // 注意：Chrome 的 AudioParam 没有 .context 属性，只能通过引擎注册的全局 ctx 取当前时间
    const ctx = param.context || FX._ctx;
    const t = ctx ? ctx.currentTime : 0;
    try { param.setTargetAtTime(value, t, timeConst); } catch (e) { /* noop */ }
  },

  /** HTML 转义（仅用于把静态文案放进 innerHTML 时防注入） */
  esc(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  /** 简单的自增 uid（用于渲染 key、持久化标识） */
  _uidSeed: 0,
  uid(prefix = 'm') {
    FX.utils._uidSeed += 1;
    return prefix + '_' + FX.utils._uidSeed + '_' + Date.now().toString(36);
  },

  /**
   * 参数的通用显示格式化。
   * 参数描述里可提供自定义 fmt(v)，否则按 unit 走默认规则。
   * 对缺失/非法值做防御（历史数据或未初始化时不应抛异常）。
   */
  fmtValue(p, v) {
    const n = Number(v);
    if (v === undefined || v === null || Number.isNaN(n)) return '—';
    if (p.fmt) return p.fmt(n);
    switch (p.unit) {
      case 'dB': return (n > 0 ? '+' : '') + Number(n.toFixed(1)) + ' dB';
      case '%':  return Math.round(n) + '%';
      case 'ms': return Math.round(n) + ' ms';
      case 'Hz':
        return n >= 1000
          ? (n / 1000).toFixed(n % 1000 > 50 ? 2 : 1).replace(/\.?0+$/, '') + ' kHz'
          : Math.round(n) + ' Hz';
      default:
        return Number(Number(n).toFixed(3)).toString();
    }
  }
};

/* ------------------------------------------------------------------ *
 * 极简事件总线（Emiter）：on / once / off / emit
 * ------------------------------------------------------------------ */
FX.Emitter = class Emitter {
  constructor() {
    this._map = new Map();
  }

  on(event, fn) {
    if (!this._map.has(event)) this._map.set(event, new Set());
    this._map.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const wrap = (...args) => { this.off(event, wrap); fn(...args); };
    return this.on(event, wrap);
  }

  off(event, fn) {
    const set = this._map.get(event);
    if (set) set.delete(fn);
  }

  emit(event, ...args) {
    const set = this._map.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (e) { console.error('[FX.Emitter]', event, e); }
    }
  }
};
