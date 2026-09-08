/**
 * registry.js — 效果器注册表 + 信号链数据模型。
 *
 * Registry：id → 效果器类。UI 面板 / 序列化 / 信号链构建全部从注册表取类，
 *          因此「新增一种效果」=「注册一个类」，其余代码零改动。
 * ChainModel：纯数据（与音频图解耦），负责增删/排序/参数修改并广播事件。
 */
FX.Registry = {
  _map: new Map(),

  /** 注册一个效果器类（幂等，重复 id 直接覆盖并告警） */
  register(EffectClass) {
    if (!EffectClass || typeof EffectClass !== 'function' || !EffectClass.id) {
      throw new Error('[Registry] 注册对象必须是继承 BaseEffect 的类且带静态 id');
    }
    if (this._map.has(EffectClass.id)) {
      console.warn(`[Registry] 效果器 "${EffectClass.id}" 已存在，将被覆盖。`);
    }
    this._map.set(EffectClass.id, EffectClass);
    return EffectClass;
  },

  get(id) { return this._map.get(id) || null; },
  has(id) { return this._map.has(id); },
  list() { return [...this._map.values()]; }
};

/**
 * 信号链的「配方」模型：entries = [{ uid, id, enabled, params }]
 * 事件：'change'(结构变化) | 'param'(uid, key, value)
 */
FX.ChainModel = class ChainModel extends FX.Emitter {

  static MAX_LENGTH = 8;   // 链长度上限（防呆，防 CPU 过载）

  constructor() {
    super();
    this.entries = [];
  }

  get length() { return this.entries.length; }
  get full() { return this.length >= ChainModel.MAX_LENGTH; }

  /** 依据注册表 id 追加一个模块（末尾）；params 自动填满描述符默认值 */
  add(id) {
    const cls = FX.Registry.get(id);
    if (!cls || this.full) return null;
    const params = {};
    for (const p of (cls.params || [])) params[p.key] = p.def;
    const entry = { uid: FX.utils.uid('fx'), id, enabled: true, params };
    this.entries.push(entry);
    this.emit('change');
    return entry;
  }

  remove(uid) {
    const i = this.entries.findIndex(e => e.uid === uid);
    if (i < 0) return;
    this.entries.splice(i, 1);
    this.emit('change');
  }

  /** 上移 / 下移（-1 或 +1），越界自动忽略 */
  move(uid, dir) {
    const i = this.entries.findIndex(e => e.uid === uid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.entries.length) return;
    const [entry] = this.entries.splice(i, 1);
    this.entries.splice(j, 0, entry);
    this.emit('change');
  }

  /** 旁路开关 */
  toggle(uid) {
    const e = this.entries.find(x => x.uid === uid);
    if (!e) return;
    e.enabled = !e.enabled;
    this.emit('change');
  }

  /** 参数修改（非结构变化，单独广播，避免整条链重建） */
  setParam(uid, key, value) {
    const e = this.entries.find(x => x.uid === uid);
    if (!e) return;
    e.params[key] = value;
    this.emit('param', uid, key, value);
  }

  clear() {
    this.entries.length = 0;
    this.emit('change');
  }

  /** 导出一份可持久化的纯数据副本 */
  toJSON() { return JSON.parse(JSON.stringify({ entries: this.entries })); }

  /** 从持久化数据恢复（带容错） */
  fromJSON(data) {
    this.entries = [];
    if (!data || !Array.isArray(data.entries)) return;
    for (const raw of data.entries) {
      if (!raw || !FX.Registry.has(raw.id)) continue;   // 未知效果直接跳过
      const defs = FX.Registry.get(raw.id).params || [];
      const params = {};
      for (const p of defs) {
        const v = raw.params ? raw.params[p.key] : undefined;
        params[p.key] = (v !== undefined && v !== null && !Number.isNaN(v)) ? v : p.def;
      }
      this.entries.push({
        uid: raw.uid || FX.utils.uid('fx'),
        id: raw.id,
        enabled: raw.enabled !== false,
        params
      });
    }
    this.emit('change'); // 通知 UI 重建
  }
};
