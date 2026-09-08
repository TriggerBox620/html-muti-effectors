/**
 * main.js — 应用引导：注册效果器、装配 Engine/ChainModel/UI、持久化恢复。
 */
(function bootstrap() {
  'use strict';

  const STORE_KEY = 'gfx.chain.v2';

  /* ---- 1. 注册全部效果器（新增效果只需在此加一行） ---- */
  FX.Registry.register(FX.Ts808Effect);     // 过载类 · Ibanez TS-808
  FX.Registry.register(FX.KlonEffect);      // 过载类 · Klon Centaur 金人马
  FX.Registry.register(FX.Ds1Effect);       // 失真类 · BOSS DS-1
  FX.Registry.register(FX.TriChorusEffect); // 调制类 · 三重合唱
  FX.Registry.register(FX.DelayEffect);     // 延迟类

  /* ---- 2. 数据模型 ---- */
  const model = new FX.ChainModel();
  const engine = new FX.AudioEngine(model);

  /* ---- 3. 持久化 ---- */
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(model.toJSON())); }
    catch (e) { /* 隐私模式下静默失败 */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /* ---- 4. 恢复保存的信号链；首次访问给一套默认链（过载→延迟） ---- */
  const saved = load();
  if (saved && Array.isArray(saved.entries) && saved.entries.length) {
    model.fromJSON(saved);                       // 触发 UI 重建（UI 尚未创建时无副作用）
  }

  /* ---- 5. 创建 UI（DOM 就绪后） ---- */
  window.addEventListener('DOMContentLoaded', () => {
    const ui = new FX.UI({ engine, model, save });

    if (!model.length) {
      model.add('ts808');
      model.add('delay');
    }

    // 暴露到控制台便于调试/扩展
    window.__GFX__ = { engine, model, FX, ui };
  });
})();
