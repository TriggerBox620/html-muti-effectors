/**
 * cdp-probe.js — 用真实 Chrome(CDP) 冒烟验证 PEDAL·LAB：
 *   1) 页面初始化是否报错    2) 演示音源是否出声(RMS>0)
 *   3) 信号链添加模块是否热重连  4) 真实文件上传路径是否可读可播
 * 运行：node tools/cdp-probe.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 9333;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(ROOT, '.chrome-tmp');
const WAV = path.join(ROOT, 'assets', 'solo-dry-guitar.wav');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 启动 Chrome ----------
const proc = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1000,1600', URL
], { stdio: 'ignore' });

async function waitPageWs(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* chrome 还没起好 */ }
    await sleep(150);
  }
  throw new Error('chrome devtools 超时未就绪');
}

// ---------- 极简 CDP 客户端 ----------
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error('ws error'));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        for (const fn of (this.handlers.get(msg.method) || [])) fn(msg.params);
      }
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      return { __err: (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text };
    }
    return r.result.value;
  }
}

(async () => {
  let cdp;
  const errors = [];        // 页面 JS 异常
  const consoleLogs = [];   // console.error/warn 输出
  try {
    const wsUrl = await waitPageWs();
    cdp = new CDP(wsUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Console.enable');

    cdp.on('Runtime.exceptionThrown', (p) =>
      errors.push((p.exceptionDetails.exception || {}).description || p.exceptionDetails.text));
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'warning') {
        consoleLogs.push(`[${p.type}] ` + p.args.map(a => a.value ?? a.description ?? '').join(' '));
      }
    });

    await sleep(1500); // 等初始化

    const step = (name) => console.log('\n==== ' + name + ' ====');

    // 1. 初始化
    step('1 页面初始化');
    const init = await cdp.eval(`(() => {
      const g = window.__GFX__;
      return {
        gfx: !!g,
        palette: document.querySelectorAll('.chip').length,
        entries: g ? g.model.entries.map(e => e.id + (e.enabled ? '' : '(旁路)')) : [],
        units: g ? g.engine.units.length : -1,
        status: document.getElementById('status').textContent.slice(0, 60)
      };
    })()`);
    console.log(JSON.stringify(init, null, 1));

    // 2. 点击演示音源
    step('2 点击演示音源');
    console.log(await cdp.eval(`(async () => {
      const g = window.__GFX__;
      document.getElementById('srcDemo').click();
      await new Promise(r => setTimeout(r, 900));
      const eng = g.engine;
      return {
        ctx: !!eng.ctx, state: eng.ctx ? eng.ctx.state : null,
        kind: eng.kind, playing: eng.player ? eng.player.playing : null,
        rmsOut: eng.ctx ? +FX.AudioEngine.readRms(eng.masterVU).toFixed(4) : null,
        units: eng.units.map(u => u.effect.id)
      };
    })()`));

    // 3. 添加过载模块（重复添加）
    step('3 添加失真/三重合唱并检查热重连');
    console.log(await cdp.eval(`(async () => {
      const g = window.__GFX__;
      const chips = document.querySelectorAll('.chip');
      chips[2].querySelector('.chip-add').click();     // Distortion
      chips[3].querySelector('.chip-add').click();     // Tri-Chorus
      await new Promise(r => setTimeout(r, 500));
      const eng = g.engine;
      const tri = eng.units.find(u => u.effect.id === 'tricorus');
      return {
        entries: g.model.entries.map(e => e.id),
        units: eng.units.map(u => u.effect.id),
        triVoices: tri ? tri.effect._voices.length : -1,
        rmsOut: +FX.AudioEngine.readRms(eng.masterVU).toFixed(4),
        bypassOk: eng.units.length === g.model.entries.length
      };
    })()`));

    // 4. 真实文件上传路径（DOM.setFileInputFiles 等价于用户在文件框选文件）
    step('4 上传 WAV 文件');
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const q = await cdp.send('DOM.querySelector',
      { nodeId: doc.root.nodeId, selector: '#fileInput' });
    await cdp.send('DOM.setFileInputFiles',
      { nodeId: q.nodeId, files: [WAV] });
    await sleep(1200);
    console.log(await cdp.eval(`(() => {
      const g = window.__GFX__;
      const eng = g.engine;
      return {
        kind: eng.kind,
        playing: eng.player ? eng.player.playing : null,
        name: document.getElementById('bufName').textContent,
        rmsOut: +FX.AudioEngine.readRms(eng.masterVU).toFixed(4),
        status: document.getElementById('status').textContent.slice(0, 80),
        fileCount: eng.ctx ? g.model.entries.length : -1
      };
    })()`));

    // 5. 清空信号链（两步确认按钮，不依赖原生 confirm）
    step('5 清空信号链（两步确认）');
    console.log(await cdp.eval(`(async () => {
      const g = window.__GFX__;
      const btn = document.getElementById('btnClear');
      btn.click();                                    // 第一次：进入武装态
      const armed = btn.dataset.armed === '1' && btn.textContent.includes('确认清空');
      btn.click();                                    // 第二次：真正清空
      await new Promise(r => setTimeout(r, 500));
      const eng = g.engine;
      return {
        armed,
        btnTextAfter: btn.textContent,
        entries: g.model.entries.length,
        units: eng.units.length,
        rmsOut: +FX.AudioEngine.readRms(eng.masterVU).toFixed(4),  // 空链应直通仍有声
        paletteDisabled: document.querySelectorAll('.chip-add:disabled').length === 0
      };
    })()`));

    // 6. 音量滑杆：百分比映射应正常（50→50%，增益≈1.0），不得出现 5700%
    step('6 音量滑杆映射');
    console.log(await cdp.eval(`(async () => {
      const g = window.__GFX__;
      const eng = g.engine;
      const set = (id, val) => {
        const el = document.getElementById(id);
        el.value = String(val);
        el.dispatchEvent(new Event('input'));
      };
      set('volIn', 50); set('volOut', 60);
      await new Promise(r => setTimeout(r, 150));
      const r1 = {
        inLabel: document.getElementById('volInVal').textContent,
        outLabel: document.getElementById('volOutVal').textContent,
        inGain: +eng.inGain.gain.value.toFixed(3),
        outGain: +eng.masterGain.gain.value.toFixed(3)
      };
      set('volIn', 57); set('volOut', 33);
      await new Promise(r => setTimeout(r, 700));
      const r2 = {
        inLabel: document.getElementById('volInVal').textContent,
        outLabel: document.getElementById('volOutVal').textContent,
        inGain: +eng.inGain.gain.value.toFixed(3),
        outGain: +eng.masterGain.gain.value.toFixed(3)
      };
      // 对照组：直接 value 赋值 vs automate，确认是否 automation 未生效
      eng.inGain.gain.value = 1.5;
      await new Promise(r => setTimeout(r, 80));
      const directGain = +eng.inGain.gain.value.toFixed(3);
      eng.inGain.gain.value = 1.0;
      // 直接调用 FX.utils.automate（绕过 onVolume）再测一次
      FX.utils.automate(eng.inGain.gain, 1.37, 0.02);
      await new Promise(r => setTimeout(r, 400));
      const autoGain = +eng.inGain.gain.value.toFixed(3);
      eng.inGain.gain.value = 1.0;
      // 检查 AudioParam.context 是否存在 + 原生 setTargetAtTime 直测
      const p = eng.inGain.gain, c = p.context;
      if (c) p.setTargetAtTime(1.23, c.currentTime, 0.02);
      await new Promise(r => setTimeout(r, 400));
      const rawAuto = +p.value.toFixed(3);
      p.value = 1.0;
      return { at50_60: r1, at57_33: r2, directGain, autoGain, hasCtx: !!c, rawAuto };
    })()`));

    // 7. 虚拟电吉他：点击第 3 弦第 7 品 → 自动切音源并直连效果链发声
    step('7 虚拟电吉他点击发声');
    console.log(await cdp.eval(`(async () => {
      const g = window.__GFX__;
      const ui = g.ui;
      await ui.guitarPlay(2, 7);                   // 第3弦7品 ≈ D4
      await new Promise(r => setTimeout(r, 220));
      const eng = g.engine;
      return {
        kind: eng.kind,
        note: document.getElementById('gtrNote').textContent.slice(0, 70),
        rmsOut: +FX.AudioEngine.readRms(eng.masterVU).toFixed(4),
        pluckCache: eng._pluckCache.size
      };
    })()`));

    // 7b. 弦序视觉验证：点最上一行应为 1弦(高音e)，点最下一行应为 6弦(低音E)
    console.log(await cdp.eval(`(async () => {
      const cv = document.getElementById('fretboard');
      const r = cv.getBoundingClientRect();
      const scale = r.height / cv.height;      // CSS→canvas 内部缩放
      const F = { padTop: 22, H: 196, padBot: 10, openW: 58 };
      const areaH = F.H - F.padTop - F.padBot;
      const rowH = areaH / 6;
      const clickAt = (rowVisual, fret) => {
        const x = (F.openW + (fret - 0.5) * ((920 - F.openW) / 24)) * (r.width / cv.width) + r.left;
        const y = (F.padTop + (rowVisual + 0.5) * rowH) * scale + r.top;
        cv.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
      };
      clickAt(0, 5);                            // 视觉最上 = 1 弦
      await new Promise(res => setTimeout(res, 120));
      const top = document.getElementById('gtrNote').textContent;
      clickAt(5, 5);                            // 视觉最下 = 6 弦
      await new Promise(res => setTimeout(res, 120));
      const bottom = document.getElementById('gtrNote').textContent;
      return { top: top.slice(0, 40), bottom: bottom.slice(0, 40) };
    })()`));

    // 8. 录音并导出 WAV（主输出采样，包含效果链）
    step('8 录音并导出 WAV');
    console.log(await cdp.eval(`(async () => {
      const g = window.__GFX__;
      const ui = g.ui;
      document.getElementById('recBtn').click();   // 开始
      await new Promise(r => setTimeout(r, 900));
      document.getElementById('recBtn').click();   // 停止并导出 WAV
      await new Promise(r => setTimeout(r, 350));
      const info = document.getElementById('recInfo');
      return {
        lastExport: ui._lastExport,
        info: info.textContent.slice(0, 100),
        infoErr: info.className
      };
    })()`));

    // 8b. MP3 导出：离线时应给出“改用 WAV”回退提示而不是崩溃（联网环境则正常导出）
    step('8b MP3 导出（离线回退/联网编码）');
    console.log(await cdp.eval(`(async () => {
      const g = window.__GFX__;
      const ui = g.ui;
      document.getElementById('recFmt').value = 'mp3';
      document.getElementById('recBtn').click();
      await new Promise(r => setTimeout(r, 500));
      document.getElementById('recBtn').click();
      await new Promise(r => setTimeout(r, 5000));   // 等待 CDN 尝试/编码
      const info = document.getElementById('recInfo');
      return {
        lastExport: ui._lastExport,
        info: info.textContent.slice(0, 120),
        infoErr: info.className
      };
    })()`));

  } catch (e) {
    console.log('测试流程异常：', e.message);
  } finally {
    console.log('\n==== 收集的页面异常 ====');
    console.log(errors.length ? errors : '(无)');
    console.log('\n==== console.error/warn ====');
    console.log(consoleLogs.length ? consoleLogs : '(无)');
    try { cdp && cdp.ws.close(); } catch (e) {}
    proc.kill();
    // 清理临时 profile
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
})();
