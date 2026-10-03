(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const stage = $('#stage');
  const slides = $$('.slide', stage);
  const N = slides.length;
  let cur = -1;

  // fit the 1920x1080 stage into the window
  const fit = () => stage.style.setProperty('--s', Math.min(innerWidth / 1920, innerHeight / 1080));
  addEventListener('resize', fit); fit();

  // split big titles into letters for a staggered rise
  $$('[data-split]').forEach(h => {
    const t = h.textContent; h.textContent = '';
    [...t].forEach((ch, i) => { const s = document.createElement('span'); s.textContent = ch === ' ' ? ' ' : ch; s.style.setProperty('--i', i); h.appendChild(s); });
  });

  // ---- videos ----
  const loopVideos = s => $$('video[data-src]', s);
  function startVideos(s) {
    loopVideos(s).forEach(v => {
      if (!v.src) { v.src = v.dataset.src; v.preload = 'auto'; }
      try { v.currentTime = 0; } catch (e) {}
      v.play().catch(() => {});
    });
  }
  const stopVideos = s => $$('video', s).forEach(v => v.pause());

  // ---- storyboard: the film plays through the cards in order ----
  const boards = $$('.sb').map(sb => {
    const cards = $$('.sbc', sb), film = sb.dataset.film;
    let k = -1, timer = 0;
    function tick() {
      const c = cards[k]; if (!c) return;
      const v = $('video', c), t0 = +c.dataset.t0, t1 = +c.dataset.t1;
      const p = Math.min(1, Math.max(0, (v.currentTime - t0) / (t1 - t0)));
      $('.bar', c).style.width = (p * 100) + '%';
      if (v.currentTime >= t1 - 0.05 || v.ended) { show((k + 1) % cards.length); return; }
      timer = requestAnimationFrame(tick);
    }
    function show(i) {
      cancelAnimationFrame(timer);
      cards.forEach((c, j) => { if (j !== i) { c.classList.remove('live'); $('video', c).pause(); $('.bar', c).style.width = j < i ? '100%' : '0'; } });
      k = i; const c = cards[i], v = $('video', c);
      if (!v.src) { v.src = film; v.preload = 'auto'; }
      const go = () => { v.currentTime = +c.dataset.t0; v.play().catch(() => {}); c.classList.add('live'); timer = requestAnimationFrame(tick); };
      if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
    }
    cards.forEach((c, i) => c.addEventListener('click', () => show(i)));
    return { el: sb, start: () => show(0), stop: () => { cancelAnimationFrame(timer); cards.forEach(c => { c.classList.remove('live'); $('video', c).pause(); $('.bar', c).style.width = '0'; }); } };
  });

  // ---- Moon Jar phase scrubber (24 frames = 60 s, auto time-lapse in 10 s) ----
  const CURVE = [[0, .042], [6, .088], [12, .181], [18, .344], [24, .692], [28, .909], [31, .917], [34, 1], [37, .911], [40, .803], [43, .455], [45, .249], [47, .11], [49, .033], [51, .005], [53, .003], [55, .003], [57, 0], [58.5, .006], [60, .042]];
  const lit = t => { for (let i = 1; i < CURVE.length; i++) if (t <= CURVE[i][0]) { const [a, va] = CURVE[i - 1], [b, vb] = CURVE[i]; return va + (vb - va) * (t - a) / (b - a); } return CURVE[0][1]; };
  function moonPath(k, waxing) { // illuminated fraction k, lit limb right when waxing
    const r = 11, rx = Math.abs(1 - 2 * k) * r, s = waxing ? 1 : 0, inner = (k > .5) === waxing ? 1 : 0;
    return `M0,${-r} A${r},${r} 0 0 ${s} 0,${r} A${rx},${r} 0 0 ${inner} 0,${-r} Z`;
  }
  const phase = (() => {
    const box = $('#phase'); if (!box) return null;
    const imgs = [];
    for (let i = 0; i < 24; i++) { const im = new Image(); im.src = `media/mj_ph${String(i).padStart(2, '0')}.jpg`; im.alt = ''; box.insertBefore(im, box.firstChild); imgs.push(im); }
    let idx = 0, auto = 0, idle = 0, drag = false;
    function set(i) {
      idx = (i + 24) % 24; imgs.forEach((im, j) => im.classList.toggle('cur', j === idx));
      const t = idx * 2.5; $('#phasetc').textContent = `00:${String(Math.floor(t)).padStart(2, '0')}`;
      $('#phasebar').style.width = ((idx + 1) / 24 * 100) + '%';
      $('#moonpath').setAttribute('d', moonPath(Math.max(.02, lit(t)), t < 34));
    }
    const at = e => { const r = box.getBoundingClientRect(); return Math.floor(Math.min(.999, Math.max(0, (e.clientX - r.left) / r.width)) * 24); };
    box.addEventListener('pointerdown', e => { drag = true; box.setPointerCapture(e.pointerId); set(at(e)); pause(); });
    box.addEventListener('pointermove', e => { if (drag) set(at(e)); });
    box.addEventListener('pointerup', () => { drag = false; idle = setTimeout(play, 2500); });
    function play() { clearInterval(auto); auto = setInterval(() => set(idx + 1), 417); }
    function pause() { clearInterval(auto); clearTimeout(idle); }
    set(0);
    return { start: () => { set(0); play(); }, stop: pause };
  })();

  // ---- SEED digits + edition gallery ----
  const seed = (() => {
    const d = $('#digits'), ed = $('#edition'); if (!d) return null;
    const cols = [];
    for (let i = 0; i < 5; i++) { const c = document.createElement('span'); c.className = 'digit'; const s = document.createElement('span'); s.innerHTML = [...'01234567890123456789'].join('<br>'); c.appendChild(s); d.appendChild(c); cols.push(s); }
    const imgs = [];
    for (let i = 1; i <= 10; i++) { const im = new Image(); im.src = `media/ow_ed${String(i).padStart(2, '0')}.jpg`; im.alt = ''; ed.insertBefore(im, ed.firstChild); imgs.push(im); }
    let e = 0, timer = 0;
    function setNum(n, spin) { String(n).padStart(5, '0').split('').forEach((ch, i) => { cols[i].style.transform = `translateY(${-(+ch + (spin ? 10 : 0)) * 1.2}em)`; }); }
    function edition(i) {
      e = i % 10; imgs.forEach((im, j) => im.classList.toggle('cur', j === e));
      $('#edtag').textContent = `EDITION ${String(e + 1).padStart(2, '0')}`;
      $('#edlabel').textContent = `EDITION ${String(e + 1).padStart(2, '0')} · Seed마다 다르게 끝난 한 판`;
      setNum(e + 1, e % 2 === 1);
    }
    return {
      start() { cols.forEach(c => { c.style.transition = 'none'; c.style.transform = 'translateY(0)'; }); requestAnimationFrame(() => { cols.forEach(c => c.style.transition = ''); setNum(4721, true); }); imgs.forEach((im, j) => im.classList.toggle('cur', j === 0)); $('#edtag').textContent = 'SEED No. 04721'; $('#edlabel').textContent = '작품마다 고유 번호가 붙는다'; clearInterval(timer); let i = 0; timer = setInterval(() => edition(i++), 3200); },
      stop() { clearInterval(timer); }
    };
  })();

  // ---- count-up numbers ----
  function countUp(s) {
    $$('[data-count]', s).forEach(b => {
      const target = b.dataset.count, parts = target.split(/(\d+)/), t0 = performance.now();
      const step = now => { const p = Math.min(1, (now - t0) / 1200), e = 1 - Math.pow(1 - p, 3);
        b.textContent = parts.map(x => /^\d+$/.test(x) ? Math.round(+x * e) : x).join(''); if (p < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }

  // ---- navigation ----
  const prog = $('#prog'), pg = $('#pg');
  function go(n, push = true) {
    n = Math.max(0, Math.min(N - 1, n)); if (n === cur) return;
    const old = slides[cur];
    if (old) { old.classList.remove('on'); stopVideos(old); boards.forEach(b => old.contains(b.el) && b.stop()); if (phase && old.contains($('#phase'))) phase.stop(); if (seed && old.contains($('#digits'))) seed.stop(); }
    cur = n; const s = slides[n];
    void s.offsetWidth; s.classList.add('on');
    startVideos(s);
    boards.forEach(b => s.contains(b.el) && b.start());
    if (phase && s.contains($('#phase'))) phase.start();
    if (seed && s.contains($('#digits'))) seed.start();
    countUp(s);
    const acc = s.dataset.theme === 'b' ? 'var(--b)' : 'var(--a)';
    prog.style.width = ((n + 1) / N * 100) + '%'; prog.style.background = acc;
    pg.textContent = `${String(n + 1).padStart(2, '0')} / ${N}`;
    if (push) history.replaceState(null, '', '#' + (n + 1));
    // warm the next slide's films
    const nx = slides[n + 1]; if (nx) loopVideos(nx).forEach(v => { if (!v.src) { v.src = v.dataset.src; v.preload = 'metadata'; } });
  }
  const next = () => go(cur + 1), prev = () => go(cur - 1);

  const lb = $('#lb'), lbv = $('video', lb);
  function openLB(src, sound) { stopVideos(slides[cur]); lbv.src = src; lbv.muted = !sound; lb.classList.add('open'); lbv.currentTime = 0; lbv.play().catch(() => {}); }
  function closeLB() { lbv.pause(); lb.classList.remove('open'); startVideos(slides[cur]); }
  $$('[data-lightbox]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openLB(b.dataset.lightbox, b.dataset.sound === '1'); }));
  $('#lbx').addEventListener('click', closeLB);
  lb.addEventListener('click', e => { if (e.target === lb) closeLB(); });

  addEventListener('keydown', e => {
    if (lb.classList.contains('open')) { if (e.key === 'Escape') closeLB(); return; }
    if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); next(); }
    else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); prev(); }
    else if (e.key === 'Home') go(0); else if (e.key === 'End') go(N - 1);
    else if (e.key === 'f' || e.key === 'F') toggleFS();
  });
  function toggleFS() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
  $('#next').addEventListener('click', next); $('#prev').addEventListener('click', prev); $('#fs').addEventListener('click', toggleFS);
  let mt = 0; addEventListener('mousemove', () => { document.body.classList.add('mouse'); clearTimeout(mt); mt = setTimeout(() => document.body.classList.remove('mouse'), 2200); });
  let tx = null; addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
  addEventListener('touchend', e => { if (tx === null) return; const dx = e.changedTouches[0].clientX - tx; if (Math.abs(dx) > 60 && !e.target.closest('#phase')) (dx < 0 ? next : prev)(); tx = null; });
  addEventListener('hashchange', () => { const n = parseInt(location.hash.slice(1), 10); if (n) go(n - 1, false); });

  go((parseInt(location.hash.slice(1), 10) || 1) - 1);
})();
