/**
 * engine.js — 音频引擎：单例 AudioContext + 信号链接线 + 电平测量。
 *
 * 拓扑：
 *   source ─► inGain ─┬─► chainIn ─► [fx1] ─► [fx2] ─► … ─► chainOut
 *                     └─► inVU(输入电平)
 *   chainOut ─► masterGain ─► masterVU(输出电平/示波器) ─► ctx.destination
 *
 * 事件：'units'(链已重建) | 'source'(音源切换：kind,name,playing,error)
 */
FX.AudioEngine = class AudioEngine extends FX.Emitter {

  constructor(model) {
    super();
    this.model = model || null;
    this.ctx = null;

    // ---- 图节点（ensure() 时创建）----
    this.inGain = null;     // 输入音量
    this.chainIn = null;    // 第一个效果器接入点
    this.chainOut = null;   // 最后一个效果器输出点
    this.masterGain = null; // 总输出音量
    this.inVU = null;       // 输入分析器
    this.masterVU = null;   // 输出分析器（同时供示波器取数）
    this.guitarOut = null;  // 虚拟电吉他输出（直连 inGain）

    // ---- 运行态 ----
    this.units = [];        // [{ uid, effect }]，与 model.entries 顺序一致
    this.kind = null;       // 'demo' | 'file' | 'mic' | 'guitar'
    this.liveNode = null;   // 当前接入的音源输出节点
    this.player = null;     // BufferPlayer（demo / file 共用）
    this.micStream = null;
    this._pluckCache = new Map();   // 音高 → 拨弦 AudioBuffer
  }

  /** 确保 AudioContext 存在并恢复运行（须由用户手势触发） */
  async start() {
    this.ensure();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  ensure() {
    if (this.ctx) return;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('当前浏览器不支持 Web Audio API');
    const c = this.ctx = new AC();
    FX._ctx = c;                  // 供 FX.utils.automate 取 currentTime（Chrome 的 AudioParam 无 .context）

    this.inGain = c.createGain();   this.inGain.gain.value = 1;
    this.chainIn = c.createGain();
    this.chainOut = c.createGain();
    this.masterGain = c.createGain(); this.masterGain.gain.value = 0.9;
    this.guitarOut = c.createGain();  // 虚拟吉他输出节点（择时接入 inGain）

    this.inVU = c.createAnalyser();     this.inVU.fftSize = 512;   this.inVU.smoothingTimeConstant = 0.35;
    this.masterVU = c.createAnalyser(); this.masterVU.fftSize = 2048; this.masterVU.smoothingTimeConstant = 0.5;

    // 骨架接线（chainIn → chainOut 之间的效果器由 rebuildChain 负责）
    this.inGain.connect(this.chainIn);
    this.inGain.connect(this.inVU);
    this.chainOut.connect(this.masterGain);
    this.masterGain.connect(this.masterVU);
    this.masterVU.connect(c.destination);

    this.rebuildChain();
  }

  /* ================================================================
   * 信号链构建
   * ================================================================ */

  /** 依据 model.entries 全量重建音频链（增删/排序后调用） */
  rebuildChain() {
    if (!this.ctx || !this.model) return;

    for (const u of this.units) { try { u.effect.dispose(); } catch (e) { /* noop */ } }
    this.units = [];

    // 断开旧端子：旧效果器在 dispose 时已拆除各自连线，
    // 这里只需断开 chainIn 的出边（首个效果器接入点）。
    // 注意：不能断开 chainOut —— 它到 masterGain 的边必须常驻。
    try { this.chainIn.disconnect(); } catch (e) { /* noop */ }

    for (const entry of this.model.entries) {
      const Cls = FX.Registry.get(entry.id);
      if (!Cls) continue;

      let fx;
      try {
        fx = new Cls(this.ctx, entry);
      } catch (e) {
        console.error(`[Engine] 创建效果器 ${entry.id} 失败：`, e);
        continue;
      }
      this.units.push({ uid: entry.uid, effect: fx });
    }

    // 串接：chainIn → u0 → u1 → … → chainOut
    let prev = this.chainIn;
    for (const u of this.units) {
      prev.connect(u.effect.nodeIn);
      prev = u.effect.nodeOut;
    }
    prev.connect(this.chainOut);

    this.emit('units', this.units);
  }

  /** 实时把某个参数写到对应模块（UI 拖动旋钮时调用） */
  setChainParam(uid, key, value) {
    const u = this.units.find(x => x.uid === uid);
    if (u) u.effect.setParam(key, value, { audio: true });
  }

  getUnit(uid) {
    return (this.units.find(x => x.uid === uid) || {}).effect || null;
  }

  /* ================================================================
   * 音源管理
   * ================================================================ */

  /** 清场：断开旧音源节点并停掉播放器/麦克风（接入新音源前调用） */
  _teardown() {
    if (this.liveNode) { try { this.liveNode.disconnect(); } catch (e) { /* noop */ } }
    this.liveNode = null;
    this._stopPlayer();
    this._stopMic();
  }

  /** 把已创建好的音源输出节点接到输入级（只负责接线，不碰播放器/麦克风生命周期） */
  _wireLive(node) {
    this.liveNode = node;
    if (node) node.connect(this.inGain);
  }

  _stopPlayer() {
    if (this.player) { try { this.player.stop(); } catch (e) { /* noop */ } }
    this.player = null;
  }

  _stopMic() {
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) { try { t.stop(); } catch (e) { /* noop */ } }
      this.micStream = null;
    }
  }

  /** 演示音色（内置合成 RIFF，无需任何输入设备即可试听） */
  async useDemo(opts = {}) {
    await this.start();
    this._teardown();                 // 停掉旧音源
    this.kind = 'demo';
    const player = new FX.BufferPlayer(this.ctx, FX.makeDemoRiff(this.ctx), opts.loop !== false);
    this.player = player;             // 先登记再接线，避免被清场逻辑误杀
    this._wireLive(player.out);
    player.start();
    this.emit('source', { kind: this.kind, playing: true, name: '内置演示音色' });
  }

  /** 上传的音频文件 */
  async loadFile(arrayBuffer, fileName = '音频文件', loop = true) {
    await this.start();
    let buf;
    try {
      buf = await this.ctx.decodeAudioData(arrayBuffer);
    } catch (e) {
      const err = new Error('音频解码失败（请使用 wav/mp3/ogg 等浏览器支持的格式）');
      err.name = 'DecodeError';
      err.cause = e;
      throw err;
    }
    this._teardown();
    this.kind = 'file';
    const player = new FX.BufferPlayer(this.ctx, buf, loop);
    this.player = player;             // 先登记再接线
    this._wireLive(player.out);
    player.start();
    this.emit('source', { kind: this.kind, playing: true, name: fileName });
    return buf;
  }

  /** 麦克风（需要 https/localhost 环境 + 用户授权） */
  async useMic() {
    await this.start();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前环境不支持麦克风（请通过 https://localhost 打开页面）');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    });
    this._teardown();                 // 释放之前可能存在的播放器/麦克风
    this.micStream = stream;
    const src = this.ctx.createMediaStreamSource(stream);
    this._wireLive(src);
    this.kind = 'mic';
    this.emit('source', { kind: this.kind, playing: true, name: '麦克风' });
  }

  /** 虚拟电吉他：切换为吉他音源（停止其它源，接上吉他输出） */
  async useGuitar() {
    await this.start();
    this._teardown();
    this.kind = 'guitar';
    this._wireLive(this.guitarOut);            // guitarOut → inGain → 效果器链
    this.emit('source', { kind: this.kind, playing: true, name: '虚拟电吉他' });
  }

  /** 拨响一个音高（Hz）。若当前不是吉他音源会自动切换过去；干声直连效果器链。 */
  async pluck(freq) {
    if (!this.ctx) await this.start();
    if (this.kind !== 'guitar' || !this.liveNode) await this.useGuitar();
    if (!this.ctx || !this.guitarOut) return;

    const key = Math.round(freq * 100) / 100;         // 音高键
    let buf = this._pluckCache.get(key);
    if (!buf) {
      buf = FX.makePluckBuffer(this.ctx, key);
      if (this._pluckCache.size > 120) this._pluckCache.clear();  // 内存保护
      this._pluckCache.set(key, buf);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.guitarOut);
    src.start();
  }

  /** 切换缓冲区播放状态（demo / file） */
  togglePlay() {
    if (!this.player) return;
    this.player.toggle();
    this.emit('source', {
      kind: this.kind, playing: this.player.playing, name: this.player.label || ''
    });
  }

  stopPlay() {
    if (!this.player) return;
    this.player.stop();
    this.emit('source', { kind: this.kind, playing: false, name: this.player.label || '' });
  }

  setLoop(v) {
    if (this.player) this.player.loop = v;
  }

  /* ================================================================
   * 电平测量（UI 每帧调用）
   * ================================================================ */

  /** 读取分析器当前 RMS 电平（0..1 左右） */
  static readRms(analyser) {
    if (!analyser) return 0;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  /** 读取波形数据用于示波器绘制（-1..1） */
  static readWave(analyser, out) {
    if (!analyser) return out;
    analyser.getFloatTimeDomainData(out);
    return out;
  }

  destroy() {
    this._stopPlayer();
    this._stopMic();
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
    this.ctx = null;
  }
};
