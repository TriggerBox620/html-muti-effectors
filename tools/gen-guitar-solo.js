/**
 * gen-guitar-solo.js — 生成「测试用 · 干琴清音速弹独奏」WAV（Karplus-Strong 拨弦物理模型）
 *
 * 说明：
 *  - 原创 E 小调风格独奏（风格致敬，非原曲扒带/复刻，避免版权问题）。
 *  - 音色：Karplus-Strong 弦振动模型 —— 噪声激励 + 变长延迟线反馈，
 *    输出带真实琴弦的非谐波泛音、随音的衰减与「拨弦感」；无任何效果处理（纯干声）。
 *  - 支持：拨片/勾弦起音差异、揉弦(延迟线长度调制)、推弦(滑音)、拨片瞬态。
 *  - 运行：node tools/gen-guitar-solo.js  →  assets/solo-dry-guitar.wav
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SR = 44100;
const TOTAL = 31;
const OUT = path.join(__dirname, '..', 'assets', 'solo-dry-guitar.wav');

/* ---------- 可复现伪随机 ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260907);

/* ---------- 音名 -> 频率 ---------- */
const N = {
  E3: 164.81, G3: 196.00, A3: 220.00, B3: 246.94,
  D4: 293.66, E4: 329.63, G4: 392.00, A4: 440.00, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.26, G5: 783.99, A5: 880.00,
  B5: 987.77, D6: 1174.66, E6: 1318.51
};

const buf = new Float64Array(TOTAL * SR);

/**
 * Karplus-Strong 音符渲染。
 * @param t0  起始秒  @param f0  起始频率  @param dur 持续秒
 * @param o { vel 力度, decay 衰减(e-fold 秒), pick 拨片起音, hammer 勾/连音,
 *           vib 揉弦Hz, vibD 揉弦深度(semi), bend 推弦(semi), bendT 到位秒 }
 */
function note(t0, f0, dur, o = {}) {
  const vel = o.vel != null ? o.vel : 1;
  const decayT = o.decay != null ? o.decay : Math.min(1.2, Math.max(0.35, dur * 0.9));
  const vib = o.vib || 0;
  const vibD = o.vibD || 0;
  const bend = o.bend || 0;
  const bendT = o.bendT != null ? o.bendT : Math.min(0.5, dur * 0.5);
  const pick = !!o.pick;
  const hammer = !!o.hammer;
  const detune = (rnd() - 0.5) * 5;                 // ±2.5 音分漂移

  const n0 = Math.max(0, Math.round(t0 * SR));
  const n = Math.min(buf.length - n0, Math.round(dur * SR));
  if (n <= 0) return;

  // 激励噪声段长度 = 弦的初始振动区间，取最低可能频率对应的延迟长度（多留 1.2 半音余量）
  const fMin = f0 * Math.pow(2, -(1.2 + (vibD || 0)) / 12);
  const Lseed = Math.ceil(SR / fMin) + 4;
  const offset = Lseed + 4;                          // 前导历史区
  const arr = new Float64Array(n + offset + 4);      // 单音符弦振动缓冲

  // 初始激励：弦在拨动瞬间的随机位移（白噪声），hammer 力度更弱
  const seedAmp = hammer ? vel * 0.5 : vel * 0.95;
  for (let k = 0; k < Lseed; k++) {
    arr[offset - Lseed + k] = (rnd() * 2 - 1) * seedAmp;
  }

  const damp = Math.exp(-1 / (decayT * SR));         // 每采样点能量衰减 → 决定音长
  const fade = Math.min(0.05, dur * 0.15);           // 提前终止音符时的淡出（防爆音）

  for (let i = 0; i < n; i++) {
    const t = i / SR;

    // ---- 音高轨迹：推弦 + 揉弦（通过改变延迟线长度实现）----
    let semi = 0;
    if (bend) semi = t < bendT ? bend * (0.5 - 0.5 * Math.cos(Math.PI * t / bendT)) : bend;
    let f = f0 * Math.pow(2, (semi + detune / 100) / 12);
    if (vib && vibD) {
      const ramp = t > 0.15 ? Math.min(1, (t - 0.15) / 0.25) : 0;
      f *= Math.pow(2, (vibD * Math.sin(2 * Math.PI * vib * t) * ramp) / 12);
    }

    const d = SR / f;                                // 当前延迟（采样）
    const j = offset + i;
    const iD = Math.floor(d);
    const fr = d - iD;

    // 线性插值读两拍：距离 d 与 d+1（标准 KS 平均低通）
    const a = arr[j - iD];
    const b = arr[j - iD - 1];
    const c = arr[j - iD - 2];
    const v1 = a + (b - a) * fr;
    const v2 = b + (c - b) * fr;
    const ring = 0.5 * (v1 + v2) * damp;             // KS 循环（先存储，保证反馈纯净）

    // 淡出包络（仅作用于输出，不影响反馈回路）
    let ge = 1;
    if (t > dur - fade) ge = Math.max(0, (dur - t) / fade);
    if (i < 2) ge *= i / 2 + 0.2;

    arr[j] = ring;
    buf[n0 + i] += ring * ge * (o.level != null ? o.level : 1);

    // 拨片触弦瞬态：短促宽带噪声咔哒（hammer 无）
    if (pick && t < 0.02) {
      buf[n0 + i] += (rnd() * 2 - 1) * vel * 0.32 * Math.exp(-t / 0.004) * ge;
    }
  }
}

/* ================================================================
 * 作曲（原创 E 小调风格段落）
 * ================================================================ */

/* ---- ① 引入：抒情短句 + 揉弦 (0–6.4s) ---- */
note(0.00, N.E4, 0.85, { vib: 5, vibD: 0.3, vel: 0.9, pick: 1, decay: 0.7 });
note(0.98, N.G4, 1.00, { vib: 5.5, vibD: 0.35, vel: 0.85, decay: 0.85 });
note(2.05, N.A4, 0.42, { vel: 0.9, pick: 1, decay: 0.35 });
note(2.52, N.B4, 1.40, { vib: 5.5, vibD: 0.45, vel: 0.95, decay: 1.2 });
note(4.00, N.D5, 0.85, { vel: 1.0, pick: 1, decay: 0.7 });
note(4.88, N.B4, 0.28, { vel: 0.62, hammer: 1, decay: 0.3 });
note(5.18, N.A4, 0.26, { vel: 0.62, hammer: 1, decay: 0.3 });
note(5.48, N.G4, 1.10, { vib: 5, vibD: 0.4, vel: 0.92, decay: 1.0 });

/* ---- ② 第一段 16 分连奏音阶 (6.45–8.6s) ---- */
const u = 0.115;
(function run16() {
  let t = 6.45;
  const seq = ['G4', 'B4', 'D5', 'G5', 'B5', 'D6', 'E6', 'B5', 'G5', 'D5', 'B4', 'G4', 'E4', 'G4', 'A4', 'B4', 'D5', 'E5'];
  seq.forEach((nm, i) => {
    note(t, N[nm], u * 1.9, {
      vel: i % 3 === 0 ? 1.0 : 0.6,
      decay: 0.4,
      pick: i % 3 === 0,
      hammer: i % 3 !== 0
    });
    t += u;
  });
  for (let i = 0; i < 7; i++) {
    note(t, N.E5, 0.16, { vel: i % 2 ? 0.8 : 1.0, decay: 0.12, pick: 1 });
    t += 0.072;
  }
})();

/* ---- ③ 中段：蓝调半音点缀 + 上行 (9.1–15.4s) ---- */
note(9.10, N.A4, 1.05, { vib: 5.5, vibD: 0.45, vel: 0.92, decay: 1.0 });
note(10.22, N.B4, 0.95, { vib: 5, vibD: 0.4, vel: 0.88, decay: 0.9 });
note(11.25, N.C5, 0.32, { vel: 0.95, pick: 1, decay: 0.3 });
note(11.60, N.B4, 1.70, { vib: 5.5, vibD: 0.5, vel: 1.0, decay: 1.5 });
(function climb() {
  let t = 13.30;
  ['D5', 'E5', 'G5', 'B5', 'E6'].forEach((nm) => {
    note(t, N[nm], 0.20, { vel: 0.88, pick: 1, decay: 0.22 });
    t += 0.115;
  });
  note(t, N.E6, 1.75, { vib: 6, vibD: 0.45, vel: 1.0, decay: 1.5 });
})();

/* ---- ④ 高速上下行贯穿段 (15.6–18.9s) ---- */
(function downUp() {
  const down = ['E6', 'D6', 'B5', 'G5', 'D5', 'B4', 'G4', 'E4', 'D4', 'B3', 'G3', 'E3'];
  const up = ['E3', 'G3', 'A3', 'B3', 'D4', 'E4', 'G4', 'A4', 'B4', 'D5', 'E5', 'G5', 'A5', 'B5', 'D6', 'E6'];
  let t = 15.60;
  down.forEach((nm, i) => {
    note(t, N[nm], u * 1.9, { vel: 1.0, pick: 1, decay: 0.42 });
    t += u;
  });
  t += u * 0.5;
  up.forEach((nm, i) => {
    note(t, N[nm], u * 1.8, {
      vel: i % 2 ? 0.6 : 1.0,
      decay: 0.4,
      pick: i % 2 === 0,
      hammer: i % 2 !== 0
    });
    t += u;
  });
})();

/* ---- ⑤ 收束乐句 (19.15–23.2s) ---- */
note(19.15, N.G4, 0.55, { vel: 0.9, pick: 1, decay: 0.5 });
note(19.80, N.B4, 0.45, { vel: 0.85, pick: 1, decay: 0.4 });
note(20.32, N.D5, 1.15, { vib: 5, vibD: 0.35, vel: 0.95, decay: 1.1 });
note(21.55, N.A4, 0.75, { vib: 5.5, vibD: 0.4, vel: 0.88, decay: 0.7 });
note(22.35, N.B4, 0.95, { vib: 5.5, vibD: 0.45, vel: 0.9, decay: 0.9 });

/* ---- ⑥ 尾声：大推弦 + 揉弦，长音收尾 (23.3–30.5s) ---- */
note(23.30, N.G5, 2.30, { bend: 4, bendT: 0.45, vib: 6, vibD: 0.5, vel: 1.0, decay: 2.0, pick: 1 });
note(25.75, N.E5, 0.16, { vel: 0.95, pick: 1, decay: 0.14 });
note(25.92, N.D5, 0.16, { vel: 0.9, pick: 1, decay: 0.14 });
note(26.08, N.B4, 0.18, { vel: 0.9, pick: 1, decay: 0.16 });
note(26.40, N.E4, 3.60, { vib: 5, vibD: 0.45, vel: 0.98, decay: 2.8 });

/* ---------- 归一化 + 写 WAV ---------- */
let peak = 0;
for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
const gain = peak > 0 ? 0.82 / peak : 1;
console.log(`峰值 ${peak.toFixed(3)} → 归一化 0.82，时长 ${TOTAL}s`);

const dataLen = buf.length * 2;
const wav = Buffer.alloc(44 + dataLen);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataLen, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(dataLen, 40);
for (let i = 0; i < buf.length; i++) {
  const s = Math.max(-1, Math.min(1, buf[i] * gain));
  wav.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
}
fs.writeFileSync(OUT, wav);
console.log('已写入：' + OUT + '  (' + (wav.length / 1024 / 1024).toFixed(2) + ' MB)');
