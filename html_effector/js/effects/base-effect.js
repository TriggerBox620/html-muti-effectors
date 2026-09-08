/**
 * base-effect.js — 效果器基类（可扩展性的核心抽象）。
 *
 * 设计要点：
 *  1. 每个效果器是一个「单元」：
 *        nodeIn ──► [内部处理链 fxIn … fxOut] ──► nodeOut
 *     nodeIn / nodeOut 是每个单元永久保留的进出端子（增益节点），
 *     外部信号链只与 nodeIn / nodeOut 打交道，内部实现完全封装。
 *
 *  2. 旁路（Bypass）由基类统一实现：
 *        enabled = true  : nodeIn → fxIn … fxOut → nodeOut
 *        enabled = false : nodeIn → nodeOut（直通），内部链静默
 *     新效果无需自己写任何旁路逻辑。
 *
 *  3. 参数系统由静态描述符驱动：
 *        { key, label, type:'range'|'toggle', min, max, step, def, unit, log? }
 *     UI 层据此自动生成控件；子类只需覆写 onParam(key, value) 把参数
 *     应用到自己的 AudioNode 上。想新增一个效果，等于回答三个问题：
 *     叫什么、有哪些参数、怎么接线 —— 见文件尾部注释。
 *
 *  4. 生命周期：_build() 创建节点 → dispose() 统一释放，防止重复构建
 *     时旧节点泄漏在 AudioContext 里。
 */
FX.BaseEffect = class BaseEffect {

  /* ---- 子类必须覆写的静态元数据 ---- */
  static id = 'base';            // 唯一 id（注册表键、持久化键）
  static name = 'Base Effect';   // 显示名
  static description = '';       // 一句话说明（面板 tooltip）
  static params = [];            // 参数描述符数组

  /**
   * @param {BaseAudioContext} ctx  共享的 AudioContext
   * @param {object} [entry]        配置项 { uid, enabled, params:{} }
   */
  constructor(ctx, entry = {}) {
    if (new.target === FX.BaseEffect) {
      throw new Error('BaseEffect 为抽象类，请继承后使用。');
    }
    this.ctx = ctx;
    this.uid = entry.uid || FX.utils.uid(this.id);

    // ---- 解析参数默认值 / 合并外部配置 ----
    const defs = this.constructor.params;
    this._defs = new Map(defs.map(p => [p.key, p]));
    this._values = {};
    for (const p of defs) {
      const cfgVal = entry.params ? entry.params[p.key] : undefined;
      this._values[p.key] = (cfgVal !== undefined && cfgVal !== null)
        ? this._sanitize(p, cfgVal)
        : p.def;
    }

    // ---- 单元进出端子（永久保留）----
    this._nodes = [];
    this.nodeIn = this._own(ctx.createGain());   // 单元输入
    this.nodeOut = this._own(ctx.createGain());  // 单元输出

    // ---- 子类构建内部处理链（必须给 fxIn / fxOut 赋值）----
    this.fxIn = null;
    this.fxOut = null;
    this._build(ctx);

    if (!this.fxIn || !this.fxOut) {
      throw new Error(`[${this.constructor.name}] _build() 必须给 this.fxIn / this.fxOut 赋值`);
    }

    // ---- 初始路由 + 应用全部参数 ----
    this._enabled = null;
    this.enabled = entry.enabled !== false;   // 触发 setter
    for (const k of Object.keys(this._values)) {
      if (typeof this.onParam === 'function') this.onParam(k, this._values[k]);
    }
  }

  get id() { return this.constructor.id; }

  /* ================================================================
   * 抽象 / 生命周期 —— 子类实现点
   * ================================================================ */

  /**
   * 子类必须实现：在此创建内部节点并接线。
   * 约定内部链的两端为 this.fxIn / this.fxOut。
   */
  _build(/* ctx */) {
    throw new Error(`[${this.constructor.name}] 必须实现 _build(ctx)`);
  }

  /**
   * 参数变化回调（可选覆写）：把值平滑应用到 AudioNode。
   * 实时旋钮/推子时被高频调用，建议一律用 FX.utils.automate 平滑。
   */
  onParam(/* key, value */) {}

  /** 内部节点创建统一走这里登记，dispose 时统一释放 */
  _own(node) {
    this._nodes.push(node);
    return node;
  }

  /** 释放：断开所有内部节点，防止图重建后泄漏 */
  dispose() {
    for (const n of this._nodes) { try { n.disconnect(); } catch (e) { /* noop */ } }
    this._nodes.length = 0;
  }

  /* ================================================================
   * 旁路路由（基类统一实现）
   * ================================================================ */
  set enabled(v) {
    v = !!v;
    if (v === this._enabled) return;
    this._enabled = v;

    try {
      if (v) {
        // 进入处理链
        this.nodeIn.connect(this.fxIn);
        this.fxOut.connect(this.nodeOut);
        // 撤掉直通连接（仅断开 nodeIn → nodeOut 这一条出边之外的直通边，
        // 现代浏览器允许对未连接的边调用 disconnect，安全无副作用）
        try { this.nodeIn.disconnect(this.nodeOut); } catch (e) { /* noop */ }
      } else {
        // 直通（bypass），内部链静音但不销毁（保留如延迟尾音的能量状态）
        this.nodeIn.connect(this.nodeOut);
        try { this.nodeIn.disconnect(this.fxIn); } catch (e) { /* noop */ }
        try { this.fxOut.disconnect(this.nodeOut); } catch (e) { /* noop */ }
      }
    } catch (e) {
      console.warn('[BaseEffect] 旁路切换异常：', e);
    }
  }
  get enabled() { return this._enabled; }

  /* ================================================================
   * 参数读写（对外统一入口）
   * ================================================================ */
  setParam(key, value, opts = {}) {
    const p = this._defs.get(key);
    if (!p) return this._values[key];

    // toggle 型参数直接按布尔处理
    const v = (p.type === 'toggle') ? !!value : this._sanitize(p, value);
    const changed = this._values[key] !== v;
    this._values[key] = v;

    if (changed) {
      if (opts.audio !== false && typeof this.onParam === 'function') {
        this.onParam(key, v);
      }
      if (typeof this.onParamChanged === 'function') this.onParamChanged(key, v);
    }
    return v;
  }

  getParam(key) {
    return this._values[key];
  }

  /** 依据类型与数值范围清洗/对齐数值 */
  _sanitize(p, raw) {
    let v = FX.utils.clamp(Number(raw), p.min, p.max);
    if (p.step > 0) {
      const dec = ((String(p.step).split('.')[1]) || '').length;
      v = Number((Math.round(v / p.step) * p.step).toFixed(dec));
    }
    return v;
  }

  /** 导出可持久化快照（供 localStorage 保存、重建） */
  snapshot() {
    return {
      id: this.id,
      uid: this.uid,
      enabled: this._enabled,
      params: { ...this._values }
    };
  }
};

/* ================================================================
 * 如何扩展一个新效果（例如「合唱 Chorus」）：
 *
 *  // js/effects/chorus-effect.js
 *  FX.ChorusEffect = class ChorusEffect extends FX.BaseEffect {
 *    static id = 'chorus';                       // ① 注册表键
 *    static name = '合唱 Chorus';
 *    static description = '…';
 *    static params = [                           // ② 声明参数（UI 自动生成）
 *      { key: 'depth', label: '深度', type: 'range', min: 0, max: 100, step: 1, def: 40, unit: '%' },
 *      { key: 'rate',  label: '速率', type: 'range', min: 0.05, max: 8, step: 0.05, def: 1.2, unit: 'Hz' }
 *    ];
 *    _build(ctx) {                               // ③ 构建内部处理链
 *      // …创建 LFO + DelayNode 并接线…
 *      this.fxIn = …; this.fxOut = …;
 *    }
 *    onParam(key, v) { /* 把参数映射到节点 * / }
 *  };
 *
 *  // 注册：js/main.js 里加一行
 *  FX.Registry.register(FX.ChorusEffect);        // 立即出现在效果器库、可被拖入信号链
 * ================================================================ */
