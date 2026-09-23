// ─────────────────────────────────────────────────────────────
// Pause-and-poke hotspots, shared by every showreel in /films.
// While a film is paused, the drawing helpers (chips, buttons,
// doodle nodes, scene headings) report where they landed on the
// canvas. Labels that the film's HOT_INFO table knows about become
// real buttons over the canvas: hover or focus explains them, click
// plays the moment the film uses them.
//
// A film opts in by defining, before its sketch runs:
//   const HOT_INFO = [{ match: 'Label' | /regex/, text: '…', go: 'sceneId' }, …];
// `go` is optional and defaults to the chapter the element is drawn in.
//
// Clicking a hotspot plays the moment the film uses that control. Scenes
// are pure functions of time, so the engine re-draws the chapter at
// PROBE_STEP intervals (under the paper, before the real frame paints)
// and looks for: the animated cursor clicking on that label, a button's
// own press animation, or failing that the label turning active.
// ─────────────────────────────────────────────────────────────
const Hot = (() => {
  let active = false, scene = null, list = [], sig = '', layer = null, tip = null, hint = null;
  const PROBE_HZ = 10, PROBE_STEP = 1 / PROBE_HZ, PROBES_PER_FRAME = 24, LEAD = 1.2;
  const moments = new Map();            // scene.id → Map(entry → { t, kind })
  let job = null;                       // { item, queue: [scene], s, i, found, prevOn, boxes, clicks }
  let probe = null;                     // per-sample collector while a probe draw runs

  const css = `
.hot-layer { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
.hot { position: absolute; pointer-events: auto; padding: 0; margin: 0; cursor: pointer;
  background: transparent; border: 2px dashed rgba(224, 122, 95, 0.55); border-radius: 12px; }
.hot:hover, .hot:focus-visible { background: rgba(224, 122, 95, 0.12); border-style: solid; border-color: #e07a5f; outline: none; }
.hot-tip { position: absolute; z-index: 4; max-width: min(340px, calc(100% - 16px)); pointer-events: none;
  background: #211d18; color: #fff9ea; border-radius: 10px; padding: 10px 12px 11px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); font: 14px/1.45 var(--mono); }
.hot-tip b { display: block; font: 400 20px/1.1 var(--hand); color: #ffdb75; margin-bottom: 4px; }
.hot-tip small { display: block; margin-top: 8px; color: #e07a5f; font-size: 13px; }
.hot-hint { position: absolute; left: 12px; top: 12px; z-index: 3; pointer-events: none;
  background: rgba(33, 29, 24, 0.82); color: #fff9ea; font: 13px/1 var(--mono);
  padding: 8px 11px; border-radius: 999px; }
@media (max-width: 560px) { .hot-hint { display: none; } }
`;

  function lookup(label) {
    if (typeof HOT_INFO === 'undefined') return null;
    for (const e of HOT_INFO) {
      if (typeof e.match === 'string' ? e.match === label : e.match.test(label)) return e;
    }
    return null;
  }

  // local rect → CSS pixels on the canvas, through whatever push/translate/scale/rotate is live
  function toScreen(x, y, w, h) {
    const m = drawingContext.getTransform(), d = pixelDensity();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      const sx = (m.a * px + m.c * py + m.e) / d, sy = (m.b * px + m.d * py + m.f) / d;
      x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function addHot(label, info, x, y, w, h) {
    const pad = 4, b = toScreen(x - pad, y - pad, w + pad * 2, h + pad * 2);
    if (b.w < 10 || b.h < 10) return;
    if (b.x + b.w < 0 || b.y + b.h < 0 || b.x > width || b.y > height) return;
    if (b.w > width * 0.8) return;
    if (list.some((o) => o.label === label && Math.abs(o.b.x - b.x) < 2 && Math.abs(o.b.y - b.y) < 2)) return;
    list.push({ label, info, b, scene });
  }

  // state: 'press' (button mid-press), 'on' (chip drawn active), or undefined
  function add(label, x, y, w, h, state) {
    if (!label) return;
    // probes accept faint elements: controls are often still fading in when the cursor clicks them
    if (probe) {
      if (GA < 0.1) return;
      const info = lookup(label);
      if (info) probe.boxes.push({ info, state, b: toScreen(x, y, w, h) });
      return;
    }
    if (!active || GA < 0.5) return;
    const info = lookup(label);
    if (info) addHot(label, info, x, y, w, h);
  }

  function heading(title, sub, x, y, w, h) {
    if (probe || !active || GA < 0.5 || !scene) return;
    addHot(title, { title, text: sub, go: scene.id }, x, y, w, h);
  }

  // called from drawCursor: note clicks about to land within this probe sample
  function cursor(t, keys) {
    if (!probe) return;
    const m = drawingContext.getTransform(), d = pixelDensity();
    for (const k of keys) {
      if (!k[3]) continue;
      const dt = k[0] - t;
      if (dt < -1e-6 || dt >= PROBE_STEP - 1e-6) continue;
      probe.clicks.push({ t: k[0], x: (m.a * k[1] + m.c * k[2] + m.e) / d, y: (m.b * k[1] + m.d * k[2] + m.f) / d });
    }
  }

  function chapterOf(id) { return scenes.find((s) => s.id === id) || null; }

  // one probe sample: draw scene s at local time tc, fold what happened into the job
  function sample(s, tc) {
    probe = { boxes: [], clicks: [] };
    const prevGA = GA;
    GA = 1;
    push();
    try { s.draw(tc); } catch (e) { /* a probe must never break playback */ }
    pop();
    GA = prevGA;
    const { boxes, clicks } = probe;
    probe = null;
    const found = job.found, nowOn = new Set();
    const note = (info, t, kind) => {
      const rank = { click: 0, on: 1 }, have = found.get(info);
      if (!have || rank[kind] < rank[have.kind]) found.set(info, { t, kind });
    };
    for (const c of clicks) {
      let best = null;
      for (const o of boxes) {
        if (c.x < o.b.x || c.x > o.b.x + o.b.w || c.y < o.b.y || c.y > o.b.y + o.b.h) continue;
        if (!best || o.b.w * o.b.h < best.b.w * best.b.h) best = o;
      }
      if (best) note(best.info, c.t, 'click');
    }
    for (const o of boxes) {
      if (o.state === 'press') note(o.info, tc, 'click');
      if (o.state === 'on') { nowOn.add(o.info); if (!job.prevOn.has(o.info)) note(o.info, tc, 'on'); }
    }
    job.prevOn = nowOn;
  }

  function finish() {
    const { item } = job;
    job = null;
    document.body.style.cursor = '';
    const go = chapterOf(item.info.go) || item.scene;
    // prefer the chapter you paused in if it uses the control, then the chapter that explains it
    for (const s of [item.scene, go]) {
      const hit = s && moments.get(s.id)?.get(item.info);
      if (hit) {
        const lead = hit.kind === 'click' ? LEAD : LEAD * 0.8;
        seekTo(s.start + s.flight + Math.max(0, hit.t - lead));
        if (!playing) setPlaying(true);
        return;
      }
    }
    if (!go) return;
    seekTo(go.start + go.flight);
    if (!playing) setPlaying(true);
  }

  // runs at the very top of draw(), before the paper is painted over the probes
  function frame() {
    if (!job) return;
    for (let n = 0; n < PROBES_PER_FRAME; n++) {
      if (!job.s) {
        job.s = job.queue.shift();
        if (!job.s) return finish();
        if (moments.has(job.s.id)) { job.s = null; continue; }
        job.i = 0; job.found = new Map(); job.prevOn = new Set();
      }
      const tc = job.i / PROBE_HZ;
      if (tc > job.s.dur) { moments.set(job.s.id, job.found); job.s = null; continue; }
      sample(job.s, tc);
      job.i++;
    }
  }

  function jump(item) {
    if (job) return;
    const go = chapterOf(item.info.go) || item.scene;
    const queue = [item.scene, go].filter((s, k, a) => s && !s.world && a.indexOf(s) === k);
    job = { item, queue, s: null };
    document.body.style.cursor = 'progress';
  }

  function showTip(item, el) {
    const target = chapterOf(item.info.go) || item.scene;
    tip.innerHTML = '';
    const b = document.createElement('b'); b.textContent = item.info.title || item.label; tip.appendChild(b);
    if (item.info.text) tip.appendChild(document.createTextNode(item.info.text));
    if (target) {
      const s = document.createElement('small');
      s.textContent = item.info.title
        ? '▶ click to replay “' + target.chapter + '”'
        : '▶ click to see it in “' + target.chapter + '”';
      tip.appendChild(s);
    }
    tip.hidden = false;
    const stage = tip.offsetParent || tip.parentElement;
    const host = el.parentElement.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = host.left - sr.left + item.b.x + item.b.w / 2 - tw / 2;
    left = Math.max(8, Math.min(sr.width - tw - 8, left));
    let top = host.top - sr.top + item.b.y - th - 10;
    if (top < 8) top = host.top - sr.top + item.b.y + item.b.h + 10;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  function hideTip() { if (tip) tip.hidden = true; }

  function mount() {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    layer = document.createElement('div'); layer.className = 'hot-layer';
    document.getElementById('canvas-host').appendChild(layer);
    const stage = document.getElementById('stage');
    tip = document.createElement('div'); tip.className = 'hot-tip'; tip.hidden = true; tip.setAttribute('role', 'tooltip'); tip.id = 'hot-tip';
    hint = document.createElement('div'); hint.className = 'hot-hint'; hint.hidden = true;
    hint.textContent = 'Paused · hover the dashed outlines to explore';
    stage.appendChild(tip); stage.appendChild(hint);
  }

  function rebuild() {
    hideTip();
    layer.textContent = '';
    list.forEach((item) => {
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'hot';
      el.style.left = item.b.x + 'px'; el.style.top = item.b.y + 'px';
      el.style.width = item.b.w + 'px'; el.style.height = item.b.h + 'px';
      el.setAttribute('aria-label', (item.info.title || item.label) + (item.info.text ? '. ' + item.info.text : ''));
      el.setAttribute('aria-describedby', 'hot-tip');
      el.addEventListener('mouseenter', () => showTip(item, el));
      el.addEventListener('focus', () => showTip(item, el));
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('blur', hideTip);
      el.addEventListener('click', () => { hideTip(); jump(item); });
      layer.appendChild(el);
    });
    hint.hidden = list.length === 0;
  }

  return {
    // called at the top of draw(): collect only on a paused, already-started film
    begin(on) {
      if (!layer) mount();
      active = on; list = []; scene = null;
    },
    setScene(s) { scene = s; },
    add,
    heading,
    cursor,
    frame,
    jump,
    // called at the end of draw(): only touch the DOM when the set of hotspots changed
    end() {
      const next = list.map((o) => o.label + '@' + Math.round(o.b.x) + ',' + Math.round(o.b.y) + ',' + Math.round(o.b.w)).join('|');
      if (next === sig) return;
      sig = next;
      rebuild();
    },
  };
})();
