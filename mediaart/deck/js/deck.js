/* Artwork introduction player. All indices in the public deck API are zero based. */
(async function () {
  'use strict';
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const D = window.D3, ow = D.ow, pt = D.pt, mj = D.mj;
  const slides = $$('.slide'); let index = -1, lastFocus = null, idleTimer, arrivalTimer, ready = false;
  D.shots.cover = { pos: [18, 12, 39], tgt: [1, 1.7, -1], fov: 43, sx: .42, sy: -.03, par: .65 };
  D.shots.overview = { pos: [.5, 10, 39], tgt: [.5, 1.5, -1.5], fov: 43, sx: 0, sy: .14, par: .45 };
  D.shots.closing = { pos: [1.5, 8.5, 39], tgt: [.5, 1.5, -1.5], fov: 43, sx: 0, sy: .14, par: .45 };
  const overview = () => { ow.setMode('attract'); pt.overview(); mj.mode = 'auto'; mj.cycle = 24; };
  const scenes = [
    { shot: 'cover', scrim: 'left', enter: overview },
    { shot: 'overview', scrim: 'bottom', enter: overview },
    { shot: 'ow.hero', scrim: 'left', enter() { ow.setMode('manual'); if (!D.reduced) arrivalTimer = setTimeout(() => { if(index===2) ow.press(); }, 3000); } },
    { shot: 'ow.tlDyn', scrim: 'left', enter() { ow.setMode('timeline'); ow.showRibbon(true); if (!D.reduced) ow.play(); } },
    { shot: 'ow.run', scrim: 'left', enter() { ow.setMode('manual'); } },
    { shot: 'pt.hero', scrim: 'right', enter() { pt.waiting(); } },
    { shot: 'pt.align', scrim: 'right', enter() { pt.sequence(); } },
    { shot: 'pt.walk', scrim: 'right', enter() { pt.walkIn(); } },
    { shot: 'mj.hero', scrim: 'bottom', enter() { mj.mode = 'auto'; mj.cycle = 24; mj.setT(34); } },
    { shot: 'mj.dial', scrim: 'right', enter() { mj.mode = 'dial'; mj.setT(0); updateMoon(0); } },
    { shot: 'mj.quiet', scrim: 'bottom', enter() { mj.mode = 'auto'; mj.cycle = 40; mj.setT(21); } },
    { shot: 'closing', scrim: 'bottom', enter: overview }
  ];
  function fit() { if (innerWidth < 800) { location.replace(artworkSiteURL(index < 0 ? undefined : index)); return; } document.documentElement.style.setProperty('--scale', Math.min(innerWidth / 1600, innerHeight / 900)); }
  addEventListener('resize', fit); fit();
  slides.forEach((s, i) => {
    s.setAttribute('aria-label', `${i + 1}. ${s.dataset.title}`);
    if (!s.querySelector('.foot')) { const f = document.createElement('footer'); f.className = 'foot'; f.innerHTML = `<span>MEDIA ART · THREE WORKS</span><span>${String(i + 1).padStart(2, '0')} / 12</span>`; s.append(f); }
    const b = document.createElement('button'); b.className = 'overview-item';
    const num = document.createElement('span'); num.textContent = String(i + 1).padStart(2, '0');
    const title = document.createElement('strong'); title.textContent = s.dataset.title; b.append(num, title);
    b.onclick = () => { closeOverlays(); show(i); }; $('#overview-grid').append(b);
  });
  function updateNote() {
    if (index < 0) return;
    $('#note-number').textContent = `PRESENTER NOTES · ${String(index + 1).padStart(2, '0')} / 12`;
    $('#note-title').textContent = slides[index].dataset.title; $('#note-body').textContent = slides[index].dataset.note;
    let hint = $('#note-hint'); if (!hint) { hint = document.createElement('p'); hint.id = 'note-hint'; $('#note-body').after(hint); }
    hint.textContent = slides[index].dataset.hint || '';
    $('#note-prev').disabled = index === 0; $('#note-next').disabled = index === 11;
  }
  function show(n, options = {}) {
    n = Math.max(0, Math.min(11, Math.trunc(Number(n)) || 0));
    const first = index < 0;
    clearTimeout(arrivalTimer); ow.pause(); ow.showRibbon(false); pt.auto = null; pt.walk = null;
    D.dragging = false; index = n;
    slides.forEach((s, i) => { s.classList.toggle('active', i === n); s.setAttribute('aria-hidden', i !== n); s.inert = i !== n; });
    const cfg = scenes[n]; $('#scrim').className = cfg.scrim;
    document.body.dataset.slide = n + 1;
    document.body.dataset.artwork = [2,5,8].includes(n) ? 'true' : 'false';
    cfg.enter(); D.flyTo(cfg.shot, { dur: 1.8, cut: first || options.cut });
    $('#counter').value = `${String(n + 1).padStart(2, '0')} / 12`; $('#progress').style.width = `${(n + 1) / 12 * 100}%`;
    $('#prev').disabled = n === 0; $('#next').disabled = n === 11;
    $$('.overview-item').forEach((b, i) => b.classList.toggle('current', i === n));
    $('#fallback-button').href = artworkSiteURL(n);
    try { history.replaceState(null, '', '#' + (n + 1)); } catch (_) { /* file:// history may be restricted */ }
    updateNote(); activeUI();
  }
  function closeOverlays() {
    const v = $('#video-player-slot video'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
    $$('.overlay').forEach(e => { e.classList.remove('open'); e.inert = true; });
    $('#stage').inert = false;
    if (lastFocus?.isConnected && !lastFocus.closest('[inert]')) lastFocus.focus(); lastFocus = null;
  }
  function toggleOverlay(id) {
    const el = $(id), wasOpen = el.classList.contains('open'), focus = document.activeElement;
    closeOverlays();
    if (!wasOpen) { lastFocus = focus; el.inert = false; el.classList.add('open'); $('#stage').inert = true; el.querySelector('button').focus(); }
    updateNote();
  }
  $$('.overlay').forEach(e => { e.inert = true; });
  $('#prev').onclick = () => show(index - 1); $('#next').onclick = () => show(index + 1);
  $('#note-prev').onclick = () => show(index - 1); $('#note-next').onclick = () => show(index + 1);
  $('#overview-button').onclick = () => toggleOverlay('#overview'); $('#notes-button').onclick = () => toggleOverlay('#notes');
  $$('[data-close]').forEach(b => b.onclick = closeOverlays);
  $$('[data-jump]').forEach(b => b.onclick = () => show(+b.dataset.jump - 1));
  $$('[data-src]').forEach(b => b.onclick = () => {
    ow.pause(); toggleOverlay('#video-modal'); $('#video-heading').textContent = b.dataset.videoTitle;
    const v = document.createElement('video'); v.src = b.dataset.src; v.poster = b.dataset.poster || ''; v.controls = v.autoplay = v.playsInline = true; v.loop = !!b.dataset.loop;
    v.setAttribute('aria-label', b.dataset.videoTitle); $('#video-player-slot').replaceChildren(v);
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  });
  async function fullscreen() { try { if(document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch (_) { $('#fullscreen').textContent = '브라우저 F11 사용'; } }
  $('#fullscreen').onclick = fullscreen;
  function togglePlay() { ow.playing ? ow.pause() : ow.play(); }
  function replay() { if (index===4) ow.run(); else if (index===2) { ow.reset(); ow.setMode('manual'); ow.press(); } else if(index===3) { ow.seek(0); ow.play(); } else if(index===6) pt.sequence(); else if(index===7) pt.walkIn(); else if(index>=8&&index<=10) mj.setT(0); }
  document.addEventListener('keydown', e => {
    const open = $('.overlay.open');
    if(e.key==='Escape') { closeOverlays(); $('#blank').classList.remove('open'); return; }
    if(e.key==='Tab' && open) { const list = [...open.querySelectorAll('button:not(:disabled),a[href],video')]; if(e.shiftKey&&document.activeElement===list[0]) { e.preventDefault(); list.at(-1).focus(); } else if(!e.shiftKey&&document.activeElement===list.at(-1)) { e.preventDefault(); list[0].focus(); } return; }
    if(/INPUT|TEXTAREA|SELECT|VIDEO/.test(e.target.tagName)||e.ctrlKey||e.metaKey||e.altKey) return;
    const k = e.key.toLowerCase();
    if(k==='b') { $('#blank').classList.toggle('open'); return; }
    if($('#blank').classList.contains('open')) return;
    if(k==='o') { toggleOverlay('#overview'); return; } if(k==='n') { toggleOverlay('#notes'); return; }
    if(open) return;
    if(k==='f') fullscreen(); if(k==='r') replay();
    if(e.key===' ' && !['BUTTON','A'].includes(e.target.tagName)) { e.preventDefault(); if(index===4) ow.press(); else if(index===3) togglePlay(); else show(index+1); }
    if(['ArrowRight','PageDown'].includes(e.key)) { e.preventDefault(); show(index+1); }
    if(['ArrowLeft','PageUp'].includes(e.key)) { e.preventDefault(); show(index-1); }
    if(e.key==='Home') { e.preventDefault(); show(0); } if(e.key==='End') { e.preventDefault(); show(11); }
  });
  function activeUI() { document.body.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => document.body.classList.add('idle'), 3500); }
  addEventListener('pointermove', activeUI, { passive: true }); addEventListener('keydown', activeUI); addEventListener('focusin',activeUI);
  addEventListener('hashchange', () => { const n = parseInt(location.hash.slice(1),10); if(Number.isFinite(n)) show(n-1); });
  $('#ow-press').onclick = () => ow.press(); $('#ow-play').onclick = togglePlay;
  const seek = t => { ow.pause(); ow.seek(+t); };
  $('#ow-seek').oninput = e => seek(e.target.value); $$('[data-seek]').forEach(b => b.onclick = () => seek(b.dataset.seek));
  $('#ow-run').onclick = () => ow.run();
  D.on('ow:count', n => { $('#ow-count').textContent = String(n).padStart(2,'0'); });
  D.on('ow:time', t => { $('#ow-time').textContent = `${Math.min(60,t).toFixed(1)} / 60초`; $('#ow-seek').value = t; });
  D.on('ow:play', on => { $('#ow-play').textContent = on ? 'Ⅱ 정지' : '▶ 재생'; $('#ow-play').setAttribute('aria-pressed', String(on)); });
  D.on('ow:runstart', seed => { $('#ow-run-log').textContent = `장면 ${seed} · 링이 머무는 자리를 기다립니다.`; });
  D.on('ow:runend', () => { $('#ow-run-log').textContent = ow.runs.slice(-3).map(r => `장면 ${r.seed} · 걸린 링 ${r.n}`).join(' / '); });
  $('#pt-alt').min = 3; $('#pt-alt').max = 40; $('#pt-alt').oninput = e => pt.setAlt(+e.target.value);
  $('#pt-walk').onclick = () => pt.walkIn();
  $$('[data-pt-step]').forEach(b => b.onclick = () => { pt.sequence(); pt.auto=null; pt.setAlt(+b.dataset.ptStep===0 ? 25 : pt.ALIGN); if(+b.dataset.ptStep===2) pt.ign=1; });
  const label = (text, pos, show, action) => { const e=document.createElement(action?'button':'div'); e.className='world-label'; e.textContent=text; if(action) { e.type='button'; e.onclick=action; } D.label(e,pos,()=> !D.isFlying() && !$('.overlay.open') && show()); return e; };
  const isHub = () => [0,1,11].includes(index);
  label('ONE WAVE',ow.anchor.top,isHub,()=>show(2)); label('포털 진입',pt.anchor.top,isHub,()=>show(5)); label('달을 품은 항아리',mj.anchor.top,isHub,()=>show(8));
  label('판정선 +6 m',pt.anchor.line,()=>index===6);
  const lengthLabel=label('그림자',pt.anchor.len,()=>index===6), angleLabel=label('7.33°',pt.anchor.angle,()=>index===6);
  label('1.8 m',pt.anchor.height,()=>index===6);
  D.on('pt:state', s => {
    if(index!==6) return;
    $('#pt-alt').value=s.alt; $('#pt-alt-value').textContent=s.alt.toFixed(2)+'°'; $('#pt-len').textContent=s.len.toFixed(1)+' m'; $('#pt-gap').textContent=Math.abs(s.gap).toFixed(1)+' m'; $('#pt-state').textContent=s.open?'열림':s.aligned?'정렬':'닫힘';
    $('#sun-hand').setAttribute('transform',`rotate(${-s.alt} 120 112)`);
    lengthLabel.textContent=`그림자 ${s.len.toFixed(1)} m`; angleLabel.textContent=s.alt.toFixed(2)+'°';
    $$('[data-pt-step]').forEach(b=>b.classList.toggle('current',+b.dataset.ptStep===(s.open?2:s.aligned?1:0)));
  });
  [0,8,16,28,36,49,56,60].forEach(t=>label(t+'',()=>ow.ribbonWorld(t,-.11),()=>index===3));
  [[4,'정지'],[12,'첫 물살'],[22,'부유'],[32,'두 번째 물살'],[42,'안착'],[52,'고요'],[58,'공개']].forEach(([t,s])=>label(s,()=>ow.ribbonWorld(t,.095),()=>index===3));
  const phaseTimes=[0,21,34,45,55];
  function updateMoon(t) {
    $('#mj-time').value=t; $('#mj-time-value').textContent=t.toFixed(1)+'초'; $('#mj-phase').textContent=mj.label(t);
    $('#phase-hand').setAttribute('transform',`rotate(${t*6} 100 100)`);
    $('#mj-curve-dot').setAttribute('cx',String(12+t/60*376)); $('#mj-curve-dot').setAttribute('cy',String(88-mj.curve(t)*70));
    const near=phaseTimes.reduce((a,b)=>Math.abs(t-b)<Math.abs(t-a)?b:a);
    $$('[data-phase]').forEach(b=> { b.classList.toggle('current',+b.dataset.phase===near); b.setAttribute('aria-pressed',String(+b.dataset.phase===near)); });
  }
  const path=document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d',mj.PHASE.map(([t,y],i)=>`${i?'L':'M'}${12+t/60*376},${88-y*70}`).join(' ')); path.setAttribute('fill','none');path.setAttribute('stroke','#a698ed');path.setAttribute('stroke-width','2');$('#mj-curve').prepend(path);
  const phase = t => { mj.mode='dial'; mj.setT(t); updateMoon(mj.t); };
  $('#mj-time').oninput=e=>phase(+e.target.value); $$('[data-phase]').forEach(b=>b.onclick=()=>phase(+b.dataset.phase));
  D.on('mj:t',t=>{if(index===9)updateMoon(t);});
  mj.want={shadow:false,mist:false,wind:false};
  $$('[data-mj-want]').forEach(b=>{const k=b.dataset.mjWant;let chosen=false; b.onclick=()=>{chosen=!chosen;mj.want[k]=chosen;b.setAttribute('aria-pressed',String(chosen));}; b.onpointerenter=()=>{mj.want[k]=true;};b.onpointerleave=()=>{mj.want[k]=chosen;};});
  // Drag targets share pointer capture, preventing a release outside the canvas from leaving parallax locked.
  let drag=null;
  function down(e, kind) { if(e.button!==0||$('.overlay.open'))return;drag={kind,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,t:mj.t,el:e.currentTarget};D.dragging=true;e.currentTarget.setPointerCapture(e.pointerId);if(kind==='ribbon'){const t=ow.ribbonHit(e);if(t!==null)seek(t);} e.preventDefault(); }
  $('#gl').addEventListener('pointerdown',e=>{if(index===3&&ow.ribbonHit(e)!==null)down(e,'ribbon');else if(index===6)down(e,pt.pickFigure(e)?'figure':'sun');else if(index===9)down(e,'phase');else down(e,'click');});
  $('#sun-dial').addEventListener('pointerdown',e=>down(e,'sun')); $('#phase-dial').addEventListener('pointerdown',e=>down(e,'phase'));
  addEventListener('pointermove',e=>{if(!drag)return;const dy=e.clientY-drag.y;if(drag.kind==='sun')pt.dragSun(dy);else if(drag.kind==='figure')pt.dragFigure(e);else if(drag.kind==='phase')phase(drag.t+(e.clientX-drag.startX)*60/(innerWidth*.5));else if(drag.kind==='ribbon'){const t=ow.ribbonHit(e);if(t!==null)seek(t);}drag.x=e.clientX;drag.y=e.clientY;});
  function up(e){if(!drag)return;const click=Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)<7;
    if(drag.kind==='click'&&click){if([2,4].includes(index)&&D.ray(e,ow.pickables).length)ow.press();else if(isHub()){let best=null;for(const [key,slide] of [['ow',2],['pt',5],['mj',8]]){const ls=D.layers.filter(l=>l.station?.name===key&&!l.hud);const hits=D.ray(e,ls.map(l=>l.scene));if(hits.length&&(!best||hits[0].distance<best.d))best={d:hits[0].distance,slide};}if(best)show(best.slide);}}
    if(drag?.el.hasPointerCapture(e.pointerId))drag.el.releasePointerCapture(e.pointerId);drag=null;D.dragging=false;
  }
  addEventListener('pointerup',up);addEventListener('pointercancel',()=>{drag=null;D.dragging=false;});addEventListener('blur',()=>{drag=null;D.dragging=false;});
  const workVisible = name => D.isFlying() || isHub() || name === (index<5?'ow':index<8?'pt':'mj');
  for(const layer of D.layers) if(layer.station) { const previous=layer.visible; layer.visible=()=>workVisible(layer.station.name)&&(!previous||previous()); }
  D.stations.push({name:'player',update(){ D.bloomGoal=.1+(workVisible('pt')&&D.stations.find(s=>s.name==='pt')?.visible?D.bloomGoalPt||0:0); }});
  window.deck={show,get index(){return index;},count:12,get ready(){return ready;}};
  await Promise.all([D.texturesReady(),document.fonts.ready]);
  show((parseInt(location.hash.slice(1),10)||1)-1,{cut:true}); D.start(); ready=true;
  $('#loading').classList.add('loaded'); $('#loading').setAttribute('aria-hidden','true');
})().catch(e=>{ console.error(e); window.D3?.fail?.(e); });
