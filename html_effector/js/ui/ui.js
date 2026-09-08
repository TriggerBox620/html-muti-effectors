/**
 * ui.js — 界面层：效果器库面板、信号链卡片渲染、参数控件、示波器/电平表。
 *
 * 关键约定：
 *  - 面板与参数控件全部由「注册表 + 静态参数描述符」自动生成，
 *    新增效果后无需改动任何 UI 代码。
 *  - 结构变化（增/删/排序/旁路）走 model 'change' → 整体重绘 + 引擎重建；
 *    参数变化走 model 'param' → 只实时写引擎，不重绘，保证拖动顺滑。
 */
FX.UI = class UI {

  /**
   * @param {object} o { engine, model, save? } save: 有变化时回写持久化
   */
  constructor(o) {
    this.engine = o.engine;
    this.model = o.model;
    this.save = o.save || (() => {});

    // 效果器主题色（可按 id 增加）
    this.accents = {
      ts808: '#ffb020',       // 808 过载 · 琥珀
      klon: '#e0b23c',        // 金人马 · 金
      ds1: '#ff6a3d',         // DS-1 失真 · 橙红
      tricorus: '#6ea8ff',    // 三重合唱 · 蓝
      delay: '#2dd4bf',       // 延迟 · 青
      default: '#a78bfa'
    };

    // 效果器类别（下拉筛选）
    this.categories = [
      { id: 'overdrive',  label: '过载' },
      { id: 'distortion', label: '失真' },
      { id: 'modulation', label: '调制' },
      { id: 'time',       label: '延迟' }
    ];
    this._cat = '';   // 当前筛选类别（'' = 全部）
    this._clearTimer = null;
    this._rec = null;         // FX.Recorder
    this._recTimer = null;    // 录音计时器
    this._recStart = 0;
    this._lastExport = null;  // 供调试/测试读取 { ok, format, seconds, bytes }
    this._gtrFlash = null;    // 指板最近一次发声标记 { s, f, at }

    this.$ = (id) => document.getElementById(id);
    this.rAF = null;
    this._lastTime = 0;
    this._bind();
  }

  /* ================================================================
   * 初始化与事件接线
   * ================================================================ */
  _bind() {
    // 数据模型 → 界面
    this.model.on('change', () => this.onStructureChange());
    this.model.on('param', (uid, key, v) => {
      this.engine.setChainParam(uid, key, v);
      this.save();
    });

    // 引擎 → 界面（音源状态）
    this.engine.on('source', (s) => this.onSourceState(s));

    // 音源按钮
    this.$('srcDemo').addEventListener('click', () => this.runSource('demo'));
    this.$('srcMic').addEventListener('click', () => this.runSource('mic'));
    this.$('srcFile').addEventListener('click', () => this.$('fileInput').click());
    this.$('srcGuitar').addEventListener('click', () => this.runSource('guitar'));
    this.$('fileInput').addEventListener('change', (e) => this.onFilePick(e));

    // 虚拟电吉他指板
    const fb = this.$('fretboard');
    fb.addEventListener('click', (e) => this.onFretboardClick(e));

    // 录音
    this._rec = new FX.Recorder(this.engine);
    this.$('recBtn').addEventListener('click', () => this.recToggle());

    // 缓冲播放控制
    this.$('btnPlay').addEventListener('click', () => this.engine.togglePlay());
    this.$('btnStop').addEventListener('click', () => this.engine.stopPlay());
    this.$('chkLoop').addEventListener('change', (e) => {
      this.engine.setLoop(e.target.checked);
    });

    // 音量
    this.$('volIn').addEventListener('input', (e) => this.onVolume('in', e.target.value));
    this.$('volOut').addEventListener('input', (e) => this.onVolume('out', e.target.value));

    // 类别筛选（combobox）
    this.$('catSel').addEventListener('change', (e) => {
      this._cat = e.target.value;
      this.renderPalette();
    });

    // 工具栏：清空（两步确认，兼容沙箱/iframe 环境禁用的原生 confirm 弹窗）
    this.$('btnClear').addEventListener('click', () => {
      const btn = this.$('btnClear');
      if (btn.dataset.armed) {          // 已武装 → 真正执行清空
        this._resetClearBtn();
        this.model.clear();
        return;
      }
      if (!this.model.length) return;   // 本就为空，无需确认
      btn.dataset.armed = '1';
      btn.classList.add('danger');
      btn.textContent = '确认清空？';
      if (this._clearTimer) clearTimeout(this._clearTimer);
      this._clearTimer = setTimeout(() => this._resetClearBtn(), 3000);
    });

    // 首帧启动动画循环（电平表 + 示波器）
    const tick = (ts) => {
      this.rAF = requestAnimationFrame(tick);
      this.drawMeters(ts);
    };
    tick(performance.now());

    this.renderPalette();
    this.renderBoard();
    this.drawFretboard();
  }

  /* ================================================================
   * 结构变化：重绘信号链 + 面板可用态 + 引擎重建 + 持久化
   * ================================================================ */
  onStructureChange() {
    this.renderPalette();                       // 刷新“添加”可用态
    this.renderBoard();
    if (this.engine.ctx) this.engine.rebuildChain();   // 音频已启动则热重建
    this.save();
  }

  /** 类别 id → 中文名 */
  catLabel(id) {
    const c = this.categories.find(x => x.id === id);
    return c ? c.label : '';
  }

  /** 复位“清空”按钮武装态 */
  _resetClearBtn() {
    const btn = this.$('btnClear');
    if (!btn) return;
    if (this._clearTimer) { clearTimeout(this._clearTimer); this._clearTimer = null; }
    btn.dataset.armed = '';
    btn.classList.remove('danger');
    btn.textContent = '清空';
  }

  accentFor(id) { return this.accents[id] || this.accents.default; }

  /* ================================================================
   * 效果器库面板（注册表驱动 + 类别筛选）
   * ================================================================ */
  renderPalette() {
    const el = this.$('palette');
    el.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (const Cls of FX.Registry.list()) {
      if (this._cat && Cls.category !== this._cat) continue;   // 类别筛选

      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.style.setProperty('--acc', this.accentFor(Cls.id));
      chip.title = Cls.description || '';

      const meta = document.createElement('div');
      meta.className = 'chip-meta';

      const name = document.createElement('div');
      name.className = 'chip-name';
      name.innerHTML = FX.utils.esc(Cls.name);
      if (Cls.category) {
        const tag = document.createElement('span');
        tag.className = 'chip-tag';
        tag.textContent = this.catLabel(Cls.category) || Cls.category;
        name.appendChild(tag);
      }
      meta.appendChild(name);

      if (Cls.description) {
        const desc = document.createElement('div');
        desc.className = 'chip-desc';
        desc.textContent = Cls.description;
        meta.appendChild(desc);
      }
      chip.appendChild(meta);

      const addBtn = document.createElement('button');
      addBtn.className = 'chip-add';
      addBtn.textContent = '+ 添加';
      addBtn.disabled = this.model.full;
      addBtn.addEventListener('click', () => this.model.add(Cls.id));
      chip.appendChild(addBtn);

      frag.appendChild(chip);
    }
    el.appendChild(frag);

    this.$('paletteFull').style.display = this.model.full ? 'block' : 'none';
  }

  /* ================================================================
   * 信号链渲染
   * ================================================================ */
  renderBoard() {
    const board = this.$('board');
    board.innerHTML = '';
    const frag = document.createDocumentFragment();
    const entries = this.model.entries;

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'chain-empty';
      empty.textContent = '信号链为空 — 从上方“效果器库”添加模块，信号将依排列顺序从左到右（自上而下）流过。';
      frag.appendChild(empty);
    }

    entries.forEach((entry, i) => {
      if (i > 0) {
        const arrow = document.createElement('div');
        arrow.className = 'connector';
        arrow.textContent = '▼  信号流向  ▼';
        frag.appendChild(arrow);
      }
      frag.appendChild(this.buildPedal(entry, i));
    });

    board.appendChild(frag);
    this.$('chainCount').textContent = `${entries.length} / ${FX.ChainModel.MAX_LENGTH}`;
  }

  /** 构建一张效果器卡片 */
  buildPedal(entry, index) {
    const Cls = FX.Registry.get(entry.id);
    const card = document.createElement('article');
    card.className = 'pedal' + (entry.enabled ? '' : ' bypassed');
    card.dataset.uid = entry.uid;
    card.style.setProperty('--acc', this.accentFor(entry.id));

    // ---- 头部：LED 旁路 + 名称 + 操作 ----
    const head = document.createElement('header');
    head.className = 'pedal-head';

    const led = document.createElement('button');
    led.className = 'led' + (entry.enabled ? ' on' : '');
    led.title = entry.enabled ? '工作中 — 点击旁路' : '已旁路 — 点击启用';
    led.addEventListener('click', () => this.model.toggle(entry.uid));

    const title = document.createElement('div');
    title.className = 'pedal-title';
    const idx = document.createElement('span');
    idx.className = 'pedal-idx';
    idx.textContent = String(index + 1);
    const nm = document.createElement('span');
    nm.className = 'pedal-name';
    nm.textContent = Cls.name;
    const st = document.createElement('span');
    st.className = 'pedal-state';
    st.textContent = entry.enabled ? '工作中' : '已旁路';
    title.append(idx, nm, st);

    const acts = document.createElement('div');
    acts.className = 'pedal-actions';
    for (const [act, glyph, tip] of [['up', '↑', '上移'], ['down', '↓', '下移'], ['remove', '✕', '移除']]) {
      const b = document.createElement('button');
      b.className = 'act';
      b.textContent = glyph;
      b.title = tip;
      b.dataset.act = act;
      b.addEventListener('click', () => {
        if (act === 'up') this.model.move(entry.uid, -1);
        else if (act === 'down') this.model.move(entry.uid, +1);
        else if (act === 'remove') this.model.remove(entry.uid);
      });
      acts.appendChild(b);
    }
    head.append(led, title, acts);
    card.appendChild(head);

    // ---- 参数区（描述符驱动）----
    const params = document.createElement('div');
    params.className = 'pedal-params';
    for (const p of Cls.params) {
      params.appendChild(this.buildParamRow(p, entry));
    }
    card.appendChild(params);

    return card;
  }

  /** 根据参数描述符生成一行控件 */
  buildParamRow(p, entry) {
    const row = document.createElement('div');
    row.className = 'param-row';
    const cur = entry.params[p.key] !== undefined ? entry.params[p.key] : p.def; // 兜底默认值

    if (p.type === 'toggle') {
      const lab = document.createElement('label');
      lab.className = 'toggle-row';
      lab.innerHTML = `<span class="pname">${FX.utils.esc(p.label)}</span>`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!cur;
      cb.addEventListener('change', () => this.model.setParam(entry.uid, p.key, cb.checked));
      lab.appendChild(cb);
      row.appendChild(lab);
      return row;
    }

    // range 型（含对数刻度）：内部统一用 0..1000 滑块位，映射到参数域
    const lab = document.createElement('div');
    lab.className = 'param-cap';
    lab.innerHTML = `<span class="pname">${FX.utils.esc(p.label)}</span>
                     <span class="pval" data-key="${p.key}"></span>`;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'prange';
    slider.min = 0; slider.max = 1000; slider.step = 1;
    slider.value = String(this._posFromVal(p, cur));

    const setLabel = (v) => {
      const out = lab.querySelector('.pval');
      if (out) out.textContent = FX.utils.fmtValue(p, v);
    };
    setLabel(cur);

    slider.addEventListener('input', () => {
      const v = this._valFromPos(p, Number(slider.value));
      this.model.setParam(entry.uid, p.key, v);
      setLabel(v);
    });

    row.append(lab, slider);
    return row;
  }

  /** 参数值 → 滑块位(0..1000) */
  _posFromVal(p, v) {
    if (p.log) {
      const ln = (x) => Math.log(x);
      const t = (ln(v) - ln(p.min)) / (ln(p.max) - ln(p.min));
      return Math.round(FX.utils.clamp(t, 0, 1) * 1000);
    }
    return Math.round(((v - p.min) / (p.max - p.min)) * 1000);
  }

  /** 滑块位(0..1000) → 参数值 */
  _valFromPos(p, pos) {
    const t = pos / 1000;
    if (p.log) return p.min * Math.pow(p.max / p.min, t);
    return p.min + (p.max - p.min) * t;
  }

  /* ================================================================
   * 音源控制
   * ================================================================ */
  async runSource(kind) {
    const status = this.$('status');
    status.className = 'status';
    status.textContent = '…';

    try {
      if (kind === 'demo') {
        await this.engine.useDemo({ loop: this.$('chkLoop').checked });
      } else if (kind === 'mic') {
        await this.engine.useMic();
      } else if (kind === 'guitar') {
        await this.engine.useGuitar();
      }
      status.textContent = '';
    } catch (err) {
      console.error(err);
      status.className = 'status err';
      if (kind === 'mic') {
        status.textContent = '无法使用麦克风：' +
          (err.name === 'NotAllowedError' ? '授权被拒绝，请在浏览器地址栏允许麦克风权限。' :
           err.name === 'NotFoundError' ? '未检测到麦克风设备。' :
           (err.message || '未知错误')) +
          '（麦克风需要 https:// 或 localhost 环境）';
      } else {
        status.textContent = '启动失败：' + (err.message || err);
      }
    }
  }

  async onFilePick(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';   // 允许再次选择同一文件
    if (!file) return;
    const status = this.$('status');
    status.className = 'status';
    status.textContent = `解码 ${file.name} …`;
    try {
      const buf = await file.arrayBuffer();
      await this.engine.loadFile(buf, file.name, this.$('chkLoop').checked);
      status.textContent = '';
    } catch (err) {
      console.error(err);
      status.className = 'status err';
      status.textContent = `无法加载「${file.name}」：${(err && err.name === 'DecodeError')
        ? err.message
        : ((err && err.message) || '未知错误')}`;
    }
  }

  onSourceState(s) {
    // 激活按钮
    for (const [id, kind] of [['srcDemo', 'demo'], ['srcMic', 'mic'], ['srcFile', 'file'], ['srcGuitar', 'guitar']]) {
      this.$(id).classList.toggle('active', s.kind === kind);
    }
    // 缓冲播放控件显隐
    const isBuffer = s.kind === 'demo' || s.kind === 'file';
    this.$('bufCtl').classList.toggle('hidden', !isBuffer);
    if (isBuffer) {
      this.$('bufName').textContent = s.name || '';
      this.$('btnPlay').textContent = s.playing ? '⏸ 暂停' : '▶ 播放';
    }
  }

  onVolume(kind, v) {
    // range 滑块 value = 0..100，本身就是百分比（此前误乘 100，导致“5700%”显示 + 上百倍增益）
    const pct = FX.utils.clamp(Number(v) || 0, 0, 100);
    if (kind === 'in') {
      this.$('volInVal').textContent = Math.round(pct) + '%';
      const g = (pct / 100) * 2;                        // 50% → 1.0（unity），100% → 2.0
      if (this.engine.inGain) FX.utils.automate(this.engine.inGain.gain, g, 0.02);
    } else {
      this.$('volOutVal').textContent = Math.round(pct) + '%';
      const g = (pct / 100) * 1.5;                      // 60% → 0.9（默认输出）
      if (this.engine.masterGain) FX.utils.automate(this.engine.masterGain.gain, g, 0.02);
    }
  }

  /* ================================================================
   * 电平表 / 示波器（每帧绘制）
   * ================================================================ */
  drawMeters(ts) {
    const eng = this.engine;
    // ~30fps 节流
    if (ts - this._lastTime < 33) return;
    this._lastTime = ts;

    const inRms = eng.ctx ? FX.AudioEngine.readRms(eng.inVU) : 0;
    const outRms = eng.ctx ? FX.AudioEngine.readRms(eng.masterVU) : 0;
    this._setMeter(this.$('vuIn'), inRms, this.$('vuInDb'));
    this._setMeter(this.$('vuOut'), outRms, this.$('vuOutDb'));
    this._drawScope(eng);
  }

  _setMeter(el, rms, dbEl) {
    // -50dB 以下按 0 计；0dB(满幅) = 100%
    const db = rms > 1e-4 ? 20 * Math.log10(rms) : -60;
    const pct = FX.utils.clamp((db + 50) / 50, 0, 1) * 100;
    if (el) el.style.width = pct + '%';
    if (dbEl) dbEl.textContent = db <= -50 ? '-∞' : db.toFixed(1);
  }

  _drawScope(eng) {
    const cv = this.$('scope');
    if (!cv) return;
    const ctx2d = cv.getContext('2d');
    const W = cv.width, H = cv.height;

    ctx2d.clearRect(0, 0, W, H);

    // 网格线
    ctx2d.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let x = 0; x <= W; x += 40) { ctx2d.moveTo(x + 0.5, 0); ctx2d.lineTo(x + 0.5, H); }
    for (let y = 0; y <= H; y += 20) { ctx2d.moveTo(0, y + 0.5); ctx2d.lineTo(W, y + 0.5); }
    ctx2d.stroke();
    // 中线
    ctx2d.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx2d.beginPath();
    ctx2d.moveTo(0, H / 2); ctx2d.lineTo(W, H / 2);
    ctx2d.stroke();

    // 波形
    if (!eng.ctx) return;
    const data = new Float32Array(eng.masterVU.fftSize);
    eng.masterVU.getFloatTimeDomainData(data);

    ctx2d.beginPath();
    const step = Math.max(1, Math.floor(data.length / W));
    for (let x = 0; x < W; x++) {
      const i = Math.min(data.length - 1, x * step);
      const y = H / 2 - data[i] * (H / 2 - 4);
      x === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
    }
    ctx2d.strokeStyle = '#7ef29a';
    ctx2d.lineWidth = 1.6;
    ctx2d.stroke();
  }

  /* ================================================================
   * 虚拟电吉他：指板绘制 / 点击发声（干声直连效果器链）
   * ================================================================ */

  /** 指板几何参数（与 canvas 内部尺寸对应） */
  static FRET = {
    W: 920, H: 196,
    openW: 58,          // 左侧空弦区（含弦名/弦号标签）
    padTop: 22,         // 顶部品数标签高度
    padBot: 10
  };

  /** 依据 canvas 事件坐标换算弦/品 */
  onFretboardClick(e) {
    const cv = this.$('fretboard');
    const rect = cv.getBoundingClientRect();
    const px = (e.offsetX != null ? e.offsetX : (e.clientX - rect.left)) * (cv.width / rect.width);
    const py = (e.offsetY != null ? e.offsetY : (e.clientY - rect.top)) * (cv.height / rect.height);
    const F = UI.FRET;
    const areaH = F.H - F.padTop - F.padBot;
    const rowH = areaH / 6;
    const v = Math.max(0, Math.min(5, Math.floor((py - F.padTop) / rowH)));
    const s = 5 - v;                               // 视觉行(上→下) → 数据弦(0=6弦低E)
    let fret;
    if (px < F.openW) {
      fret = 0;                                  // 空弦区
    } else {
      const cell = (F.W - F.openW) / 24;
      fret = Math.max(1, Math.min(24, Math.floor((px - F.openW) / cell) + 1));
    }
    this.guitarPlay(s, fret);
  }

  /** 拨响 (s=0..5 弦, fret=0..24) */
  async guitarPlay(s, fret) {
    const cv = this.$('fretboard');
    if (!cv) return;
    const freq = FX.Guitar.freqAt(s, fret);
    try {
      await this.engine.pluck(freq);             // 自动激活“电吉他”音源并直连效果链
    } catch (err) {
      console.error(err);
      const st = this.$('status');
      st.className = 'status err';
      st.textContent = '电吉他发声失败：' + (err.message || err);
      return;
    }
    const name = FX.Guitar.freqToName(freq);
    const pos = fret === 0 ? '空弦' : (fret + ' 品');
    this.$('gtrNote').textContent =
      `第 ${6 - s} 弦 (${FX.Guitar.strings[s].name}) · ${pos} → ${name}  ${freq.toFixed(1)} Hz`;
    this._gtrFlash = { s, fret, at: performance.now() };
    this.drawFretboard();
    setTimeout(() => {
      if (this._gtrFlash) { this._gtrFlash = null; this.drawFretboard(); }
    }, 240);
  }

  /** 绘制指板（6 弦 × 24 品 + 空弦区 + 品点） */
  drawFretboard() {
    const cv = this.$('fretboard');
    if (!cv) return;
    const ctx2d = cv.getContext('2d');
    const F = UI.FRET;
    const W = F.W, H = F.H;
    ctx2d.clearRect(0, 0, W, H);

    const x0 = F.openW;
    const cell = (W - F.openW) / 24;
    const areaH = H - F.padTop - F.padBot;
    const rowH = areaH / 6;

    // 琴枕（nut）
    ctx2d.fillStyle = '#cfd6e2';
    ctx2d.fillRect(x0 - 3, F.padTop - 2, 3, areaH + 4);

    // 品丝
    ctx2d.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx2d.lineWidth = 1;
    for (let f = 1; f <= 24; f++) {
      const x = x0 + f * cell;
      ctx2d.beginPath(); ctx2d.moveTo(x + 0.5, F.padTop - 2); ctx2d.lineTo(x + 0.5, H - F.padBot + 2); ctx2d.stroke();
    }
    // 品点标记
    ctx2d.fillStyle = 'rgba(255,255,255,0.22)';
    for (const f of [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]) {
      const x = x0 + (f - 0.5) * cell;
      const ys = f === 12 ? [0.5, 1.5] : [0.5];
      for (const k of ys) {
        const yy = F.padTop + areaH * (f === 12 ? (k === 0.5 ? 0.35 : 0.65) : 0.5);
        ctx2d.beginPath(); ctx2d.arc(x, yy, 4.5, 0, Math.PI * 2); ctx2d.fill();
      }
    }
    // 品数标签
    ctx2d.fillStyle = '#6d7788';
    ctx2d.font = '10px "Cascadia Code", Consolas, monospace';
    ctx2d.textAlign = 'center';
    for (const f of [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]) {
      ctx2d.fillText(String(f), x0 + (f - 0.5) * cell, 12);
    }
    // 空弦区标签 “0”
    ctx2d.textAlign = 'center';
    ctx2d.fillText('0', F.openW / 2, 12);

    // 弦线（低音粗 → 高音细）；布局：6 弦(最粗)在最下、1 弦(最细)在最上
    const widths = [3.4, 2.8, 2.2, 1.7, 1.2, 0.9];     // 按数据弦 0(6弦)…5(1弦)
    for (let s = 0; s < 6; s++) {
      const v = 5 - s;                                  // 数据弦 s → 视觉行 v（上→下）
      const y = F.padTop + (v + 0.5) * rowH;
      // 弦名（含弦号：6弦 E2 … 1弦 E4）
      ctx2d.textAlign = 'left';
      ctx2d.font = '11px "Segoe UI", sans-serif';
      ctx2d.fillStyle = '#8b95a9';
      ctx2d.fillText(`${6 - s}弦 ${FX.Guitar.strings[s].name}`, 4, y + 4);
      // 琴弦
      const grad = ctx2d.createLinearGradient(0, y - widths[s], 0, y + widths[s]);
      grad.addColorStop(0, 'rgba(226,232,240,.88)');
      grad.addColorStop(0.5, 'rgba(148,163,184,.55)');
      grad.addColorStop(1, 'rgba(226,232,240,.88)');
      ctx2d.strokeStyle = grad;
      ctx2d.lineWidth = widths[s];
      ctx2d.beginPath();
      ctx2d.moveTo(x0, y);
      ctx2d.lineTo(W - 2, y);
      ctx2d.stroke();
    }

    // 最近发声闪光标记
    if (this._gtrFlash) {
      const { s, fret } = this._gtrFlash;
      const v = 5 - s;
      const y = F.padTop + (v + 0.5) * rowH;
      const x = fret === 0 ? F.openW / 2 : (x0 + (fret - 0.5) * cell);
      ctx2d.strokeStyle = 'rgba(43,217,110,.95)';
      ctx2d.lineWidth = 2.4;
      ctx2d.beginPath();
      ctx2d.arc(x, y, 9, 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.fillStyle = 'rgba(43,217,110,.22)';
      ctx2d.beginPath();
      ctx2d.arc(x, y, 9, 0, Math.PI * 2);
      ctx2d.fill();
    }
  }

  /* ================================================================
   * 录音与导出（主输出采样：包含效果链处理）
   * ================================================================ */

  async recToggle() {
    const btn = this.$('recBtn');
    const info = this.$('recInfo');
    if (this._rec.recording) {
      await this.recStop();
      return;
    }
    try {
      await this._rec.start();
    } catch (err) {
      info.textContent = '无法开始录音：' + (err.message || err);
      info.className = 'err';
      return;
    }
    this._recStart = performance.now();
    btn.textContent = '⏹ 停止并导出';
    btn.classList.add('recording');
    info.className = '';
    info.textContent = '● 录制中 0:00';
    this._recTimer = setInterval(() => {
      const sec = Math.floor((performance.now() - this._recStart) / 1000);
      info.textContent = `● 录制中 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }, 500);
  }

  async recStop() {
    const btn = this.$('recBtn');
    const info = this.$('recInfo');
    if (this._recTimer) { clearInterval(this._recTimer); this._recTimer = null; }
    btn.textContent = '● 开始录音';
    btn.classList.remove('recording');

    const res = this._rec.stop();
    if (!res || res.samples.length < Math.floor(res.sampleRate * 0.1)) {
      info.className = 'err';
      info.textContent = '录音太短或为空，请先播放/弹奏再录音';
      this._lastExport = { ok: false };
      return;
    }

    const fmt = this.$('recFmt').value;   // wav | mp3
    info.className = '';
    info.textContent = fmt === 'mp3' ? 'MP3 编码中…（需联网加载编码库）' : '编码 WAV 中…';
    try {
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      if (fmt === 'wav') {
        const blob = FX.WavWriter.encode([res.samples], res.sampleRate);
        FX.downloadBlob(blob, `pedallab-${stamp}.wav`);
        info.textContent =
          `已导出 WAV：${res.seconds.toFixed(1)}s / ${(blob.size / 1024 / 1024).toFixed(2)} MB`;
        this._lastExport = { ok: true, format: 'wav', seconds: res.seconds, bytes: blob.size };
      } else {
        const blob = await FX.encodeMp3Blob(res.samples, res.sampleRate);
        FX.downloadBlob(blob, `pedallab-${stamp}.mp3`);
        info.textContent =
          `已导出 MP3：${res.seconds.toFixed(1)}s / ${(blob.size / 1024 / 1024).toFixed(2)} MB`;
        this._lastExport = { ok: true, format: 'mp3', seconds: res.seconds, bytes: blob.size };
      }
    } catch (err) {
      console.error(err);
      info.className = 'err';
      info.textContent = '导出失败：' + (err.message || err);
      this._lastExport = { ok: false, format: fmt, error: err.message };
    }
  }
};
