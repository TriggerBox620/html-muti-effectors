/* 冒烟测试：用桩 AudioContext 验证核心逻辑（对象级出边断言，不依赖浏览器 DOM）
 * 运行：node tests/smoke.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

global.window = global;
global.self = global;

const files = [
  'js/core.js', 'js/effects/base-effect.js',
  'js/effects/ts808-effect.js', 'js/effects/klon-effect.js', 'js/effects/ds1-effect.js',
  'js/effects/tricorus-effect.js', 'js/effects/delay-effect.js',
  'js/effects/registry.js', 'js/audio/engine.js', 'js/audio/sources.js'
];
for (const f of files) eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));

// ---- 桩：带真实出边集合的最小 AudioNode ----
class Node {
  constructor(name) {
    this.name = name;
    this.out = new Set();
    this.gain = new AP(1);
  }
  connect(t) { if (t) this.out.add(t); }
  disconnect(t) { if (t) this.out.delete(t); else this.out.clear(); }
  hasOut(t) { return this.out.has(t); }
}
class AP {
  constructor(v = 0) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; }
  get context() { return G.ctx; }
}
const G = { ctx: null };
G.ctx = {
  currentTime: 0,
  destination: new Node('dest'),
  createGain: () => { const n = new Node('gain'); n.gain = new AP(1); return n; },
  createWaveShaper: () => { const n = new Node('ws'); n.oversample = ''; n.curve = null; return n; },
  createBiquadFilter: () => { const n = new Node('biq'); n.type = ''; n.frequency = new AP(1); n.Q = new AP(1); n.gain = new AP(1); return n; },
  createDelay: () => { const n = new Node('dly'); n.delayTime = new AP(0.3); return n; },
  createAnalyser: () => { const n = new Node('ana'); n.fftSize = 512; n.smoothingTimeConstant = 0; n.getFloatTimeDomainData = (o) => o.fill(0); return n; },
  createBuffer: () => ({}),
  createBufferSource: () => ({})
};

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg); }
};

console.log('== A. Registry + ChainModel ==');
FX.Registry.register(FX.Ts808Effect);
FX.Registry.register(FX.KlonEffect);
FX.Registry.register(FX.Ds1Effect);
FX.Registry.register(FX.TriChorusEffect);
FX.Registry.register(FX.DelayEffect);
assert(FX.Registry.list().length === 5, '注册表含 5 种效果');
assert(FX.Registry.list().every(c => c.category), '所有效果器都有 category 类别元数据');
const model = new FX.ChainModel();
const a1 = model.add('ts808');
const a2 = model.add('delay');
assert(model.length === 2, '默认链 ts808->delay');
assert(model.add('ghost') === null, '未知 id 拒绝添加');
model.move(a1.uid, 1);
assert(model.entries[0].id === 'delay', '排序生效');
model.move(a1.uid, -1);
model.toggle(a1.uid);
assert(model.entries[0].enabled === false, '旁路切换写入模型');
model.toggle(a1.uid);
model.setParam(a1.uid, 'drive', 18);
assert(model.entries[0].params.drive === 18, '参数写入模型');
model.clear();
for (let i = 0; i < 12; i++) model.add('delay');
assert(model.length === FX.ChainModel.MAX_LENGTH, `链长度上限 ${FX.ChainModel.MAX_LENGTH}`);
model.fromJSON({ entries: [{ id: 'delay', enabled: true, params: { time: 500, feedback: 'NaN' } },
                            { id: 'wah', enabled: true, params: {} }] });
assert(model.length === 1 && model.entries[0].params.time === 500, 'fromJSON 跳过未知效果、NaN 回退默认');

console.log('== B. TS-808 构建 + 旁路路由 ==');
const e1 = new FX.Ts808Effect(G.ctx, { uid: 'x1', enabled: true, params: { drive: 20, tone: 2600, level: -6 } });
assert(e1.pre.hasOut(e1.ws) && e1.ws.hasOut(e1.mid) && e1.mid.hasOut(e1.tone) && e1.tone.hasOut(e1.post),
  '808 内部接线 pre->ws->mid(800Hz峰)->tone->post');
assert(e1.nodeIn.hasOut(e1.pre) && e1.post.hasOut(e1.nodeOut), '启用：nodeIn→fxIn, fxOut→nodeOut');
assert(!e1.nodeIn.hasOut(e1.nodeOut), '启用：无直通');
assert(e1.getParam('drive') === 20 && e1.getParam('level') === -6, '参数清洗/对齐');
e1.enabled = false;
assert(!e1.nodeIn.hasOut(e1.pre) && !e1.post.hasOut(e1.nodeOut) && e1.nodeIn.hasOut(e1.nodeOut),
  '旁路：断开处理链并直通');
e1.enabled = true;
assert(e1.nodeIn.hasOut(e1.pre) && !e1.nodeIn.hasOut(e1.nodeOut), '恢复启用');
e1.setParam('drive', 30);
assert(e1.getParam('drive') === 24, '参数越界钳制到 24dB');
e1.setParam('drive', 20);
assert(Math.abs(e1.pre.gain.value - Math.pow(10, 20 / 20)) < 1e-6, 'drive 实时映射到 pre.gain');

console.log('== C. Klon / DS-1 / Delay ==');
const ek = new FX.KlonEffect(G.ctx, { uid: 'x2', enabled: true, params: {} });
assert(ek.fxIn.hasOut(ek.pre) && ek.fxIn.hasOut(ek.dry), 'Klon 干湿并行：干声旁路 + 削波支路');
assert(ek.dry.hasOut(ek.sum) && ek.dirt.hasOut(ek.sum) && ek.sum.hasOut(ek.tone) && ek.tone.hasOut(ek.post),
  'Klon sum->tone->post 拓扑');
assert(ek.dry.gain.value === 0.5 && ek.dirt.gain.value === 0.5, 'Klon 干/湿 50/50 混合');
ek.setParam('gain', 24);
assert(Math.abs(ek.pre.gain.value - Math.pow(10, 24 / 20)) < 1e-6, 'Klon gain 实时映射');

const e3 = new FX.Ds1Effect(G.ctx, { uid: 'x3', enabled: true, params: {} });
assert(e3.pre.hasOut(e3.hp) && e3.hp.hasOut(e3.ws) && e3.ws.hasOut(e3.tone), 'DS-1 内部接线 pre->hp->ws->tone');
assert(e3.ws.curve && e3.ws.curve.length === 2048, 'DS-1 削波曲线已生成');
const pos = e3.ws.curve[1535], neg = e3.ws.curve[512];   // 约 x=+0.5 / -0.5
assert(Math.abs(neg) > Math.abs(pos), 'DS-1 不对称削波（负半周更狠）');

const e4 = new FX.DelayEffect(G.ctx, { uid: 'x4', enabled: true, params: {} });
assert(e4.dly.delayTime.value === 0.33, 'delay 默认 330ms');
e4.setParam('time', 800);
assert(Math.abs(e4.dly.delayTime.value - 0.8) < 1e-9, 'delay time 实时映射');

console.log('== D. 引擎信号链拓扑 ==');
window.AudioContext = class { constructor() { return G.ctx; } };
G.ctx.state = 'suspended';
G.ctx.resume = () => { G.ctx.state = 'running'; };
G.ctx.close = () => {};
const m2 = new FX.ChainModel();
m2.fromJSON({ entries: [{ id: 'ts808', uid: 'u1', enabled: true, params: {} },
                        { id: 'delay', uid: 'u2', enabled: true, params: {} }] });
const engine = new FX.AudioEngine(m2);
engine.ensure();
assert(engine.units.length === 2, '引擎按模型构建 2 个单元');
const A = engine.units[0].effect, B = engine.units[1].effect;
assert(engine.chainIn.hasOut(A.nodeIn) && A.nodeOut.hasOut(B.nodeIn) && B.nodeOut.hasOut(engine.chainOut),
  'chainIn→[ts808]→[delay]→chainOut 拓扑');
engine.setChainParam('u1', 'drive', 15);
assert(Math.abs(A.pre.gain.value - Math.pow(10, 15 / 20)) < 1e-6, '第一模块参数实时生效');
engine.setChainParam('u2', 'time', 500);
assert(Math.abs(B.dly.delayTime.value - 0.5) < 1e-9, '第二模块参数实时生效');
m2.remove('u2');
engine.rebuildChain();
assert(engine.units.length === 1 && engine.units[0].uid === 'u1', '移除模块后重建为 1 单元');
assert(engine.chainIn.hasOut(engine.units[0].effect.nodeIn)
  && engine.units[0].effect.nodeOut.hasOut(engine.chainOut), '重建后正确接入');
assert(engine.chainOut.hasOut(engine.masterGain), '重建不破坏 chainOut→master 输出');

console.log('== E. 回归：音源接入（player 不被清场误杀）+ add() 默认参数 ==');
(async () => {
  G.ctx.sampleRate = 44100;
  G.ctx.createBuffer = (ch, len, sr) => ({ length: len, sampleRate: sr, getChannelData: () => new Float64Array(len) });
  G.ctx.createBufferSource = () => ({
    buffer: null, loop: false, onended: null, started: false,
    connect() {}, start() { this.started = true; }, stop() { this.stopped = true; }, disconnect() {}
  });
  G.ctx.decodeAudioData = async () => ({ length: 1, getChannelData: () => new Float64Array(1) });
  G.ctx.createOscillator = () => ({
    type: 'sine', frequency: new AP(1),
    connect() {}, start() {}, stop() {}, disconnect() {}
  });

  const m3 = new FX.ChainModel();
  const eO = m3.add('ts808');
  const eD = m3.add('delay');
  assert(eO.params.drive === 10 && eO.params.tone === 2600, 'add() 填充 ts808 默认参数');
  assert(eD.params.time === 330 && eD.params.feedback === 38, 'add() 填充 delay 默认参数');

  const engine3 = new FX.AudioEngine(m3);
  let demoThrew = false;
  try { await engine3.useDemo({ loop: true }); }
  catch (err) { demoThrew = true; console.log('  !useDemo 异常：', err.message); }
  assert(!demoThrew, 'useDemo 不抛异常');
  assert(engine3.player && engine3.player.playing === true, 'useDemo 后 player 正在播放');
  assert(engine3.liveNode && engine3.liveNode.hasOut(engine3.inGain), '演示音源节点已接入 inGain');

  let fileThrew = false;
  try { await engine3.loadFile(new ArrayBuffer(8), 'test.wav', true); }
  catch (err) { fileThrew = true; console.log('  !loadFile 异常：', err.message); }
  assert(!fileThrew, 'loadFile 不抛异常');
  assert(engine3.kind === 'file' && engine3.player && engine3.player.playing === true, '文件播放器启动');

  console.log('== F. 型号效果器：DS-1 / Klon / Tri-Chorus 细节 ==');
  const m4 = new FX.ChainModel();
  m4.add('ds1');
  m4.add('klon');
  const pTri = m4.add('tricorus');
  assert(m4.entries[0].params.drive === 26, 'DS-1 add() 默认失真 26dB');
  assert(m4.entries[1].params.gain === 12, 'Klon add() 默认增益 12dB');
  assert(pTri.params.rate === 0.5 && pTri.params.mix === 45, 'TriChorus add() 默认参数');

  const fxTri = new FX.TriChorusEffect(G.ctx, { uid: 'tri1', enabled: true, params: {} });
  assert(fxTri._voices.length === 3, '三重合唱含 3 路声部');
  const v0 = fxTri._voices[0], v2 = fxTri._voices[2];
  assert(Math.abs(v0.lfo.frequency.value - 0.5) < 1e-9 && Math.abs(v2.lfo.frequency.value - 0.9) < 1e-9,
    '声部速率 1 / 1.4 / 1.8 错开');
  assert(v0.color && v0.color.frequency.value === 8000, '声部带高频柔化低通');
  fxTri.setParam('depth', 100);
  assert(Math.abs(v0.lfoGain.gain.value - 0.0018) < 1e-9 && Math.abs(v2.lfoGain.gain.value - 0.003) < 1e-9,
    'depth 映射为平滑的 1.8~3ms 调制');
  fxTri.setParam('mix', 50);
  assert(Math.abs(fxTri.dry.gain.value - Math.cos(Math.PI / 4)) < 1e-9, 'TriChorus 等功率干湿');
  fxTri.dispose();
  assert(fxTri._nodes.length === 0, 'dispose 释放全部节点（含 LFO stop）');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
