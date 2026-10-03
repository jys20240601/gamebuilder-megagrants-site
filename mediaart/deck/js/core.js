/* core.js — renderer, HDR post (bloom + ACES), camera shots and flights, pointer, projected labels, loop.
   Every station adds THREE.Scenes to D3.layers; they share one camera and one depth buffer, so each work keeps
   its own lights while the camera flies continuously between them. */
(function () {
  'use strict';
  const T = THREE, D3 = (window.D3 = window.D3 || {});
  const V3 = T.Vector3;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || /[?&]still\b/.test(location.search);
  D3.reduced = reduced;
  D3.dev = /[?&]dev\b/.test(location.search);

  // ---------- math helpers
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x)), lerp = (a, b, t) => a + (b - a) * t;
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
  Object.assign(D3, { clamp, lerp, ease, smooth, damp, V3 });
  D3.rng = seed => { let a = seed | 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  // ---------- tiny event bus (3D -> page UI)
  const bus = {};
  D3.on = (k, f) => { (bus[k] = bus[k] || []).push(f); };
  D3.emit = (k, ...a) => { (bus[k] || []).forEach(f => f(...a)); };

  // ---------- colour: the composite applies Narkowicz ACES; D3.ui(hex) returns the HDR value that comes out as exactly hex
  function invACES(y) {
    y = Math.min(y, 0.985);
    const A = y * 2.43 - 2.51, B = y * 0.59 - 0.03, C = y * 0.14;
    return y <= 0 ? 0 : (-B - Math.sqrt(B * B - 4 * A * C)) / (2 * A);
  }
  D3.ui = hex => { const c = new T.Color(hex); return new T.Color(invACES(c.r), invACES(c.g), invACES(c.b)); };
  D3.glslInvACES = 'vec3 invACES(vec3 y){y=min(y,vec3(.985));vec3 A=y*2.43-2.51,B=y*.59-.03,C=y*.14;return max((-B-sqrt(B*B-4.*A*C))/(2.*A),0.);}';

  // ---------- renderer
  const canvas = document.getElementById('gl');
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false });
  } catch (e) { D3.fail && D3.fail(e); throw e; }
  renderer.autoClear = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = T.NoToneMapping;
  renderer.outputColorSpace = T.LinearSRGBColorSpace; // the composite pass writes display-referred sRGB itself
  D3.renderer = renderer;
  renderer.info.autoReset = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); D3.fail && D3.fail(new Error('context lost')); });
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // ---------- textures from data URIs (js/textures.js) — waits for decode before the first frame
  const pending = [];
  D3.tex = (name, o = {}) => {
    const img = new Image(), t = new T.Texture(img);
    t.colorSpace = o.srgb === false ? T.NoColorSpace : T.SRGBColorSpace;
    if (o.repeat) t.wrapS = t.wrapT = T.RepeatWrapping;
    else t.wrapS = t.wrapT = T.ClampToEdgeWrapping;
    if (o.repeatS) t.wrapS = T.RepeatWrapping;
    t.anisotropy = Math.min(o.aniso || 8, maxAniso);
    pending.push(new Promise(res => { img.onload = () => { t.needsUpdate = true; res(); }; img.onerror = () => res(); }));
    img.src = (window.TEX || {})[name] || '';
    return t;
  };
  D3.canvasTex = (w, h, draw, o = {}) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
    const t = new T.CanvasTexture(c); t.colorSpace = o.srgb === false ? T.NoColorSpace : T.SRGBColorSpace;
    if (o.repeat) t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = Math.min(8, maxAniso); return t;
  };
  D3.texturesReady = () => Promise.all(pending);

  // ---------- post: MSAA HDR target -> bloom mip chain -> ACES composite
  const FS = new T.BufferGeometry();
  FS.setAttribute('position', new T.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  FS.setAttribute('uv', new T.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const fsCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1), fsScene = new T.Scene(), fsMesh = new T.Mesh(FS);
  fsMesh.frustumCulled = false; fsScene.add(fsMesh);
  const VS = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
  const mat = (fs, uniforms) => new T.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
  const downMat = mat(`uniform sampler2D tSrc;uniform vec2 uTexel;uniform float uThr,uKnee;uniform int uPre;varying vec2 vUv;
    vec3 s(vec2 o){return texture2D(tSrc,vUv+o*uTexel).rgb;}
    void main(){vec3 a=s(vec2(-2,2)),b=s(vec2(0,2)),c=s(vec2(2,2)),d=s(vec2(-2,0)),e=s(vec2(0)),f=s(vec2(2,0)),g=s(vec2(-2,-2)),h=s(vec2(0,-2)),i=s(vec2(2,-2)),j=s(vec2(-1,1)),k=s(vec2(1,1)),l=s(vec2(-1,-1)),m=s(vec2(1,-1));
    vec3 col=e*.125+(a+c+g+i)*.03125+(b+d+f+h)*.0625+(j+k+l+m)*.125;
    if(uPre==1){col=min(col,vec3(30.));float br=max(col.r,max(col.g,col.b));float sf=clamp(br-uThr+uKnee,0.,2.*uKnee);sf=sf*sf/(4.*uKnee+1e-4);col*=max(sf,br-uThr)/max(br,1e-4);}
    gl_FragColor=vec4(col,1.);}`, { tSrc: { value: null }, uTexel: { value: new T.Vector2() }, uThr: { value: 1.1 }, uKnee: { value: 0.6 }, uPre: { value: 0 } });
  const upMat = mat(`uniform sampler2D tLow,tHigh;uniform vec2 uTexel;varying vec2 vUv;
    vec3 s(vec2 o){return texture2D(tLow,vUv+o*uTexel).rgb;}
    void main(){vec3 c=s(vec2(0))*4.+(s(vec2(-1,0))+s(vec2(1,0))+s(vec2(0,-1))+s(vec2(0,1)))*2.+s(vec2(-1,-1))+s(vec2(1,-1))+s(vec2(-1,1))+s(vec2(1,1));
    gl_FragColor=vec4(c/16.+texture2D(tHigh,vUv).rgb,1.);}`, { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new T.Vector2() } });
  const compMat = mat(`uniform sampler2D tScene,tBloom;uniform float uBloom,uTime,uVig,uFade;uniform vec2 uAsp;varying vec2 vUv;
    vec3 aces(vec3 x){return clamp(x*(2.51*x+.03)/(x*(2.43*x+.59)+.14),0.,1.);}
    vec3 toSRGB(vec3 c){return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(.0031308,c));}
    float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
    void main(){vec3 c=texture2D(tScene,vUv).rgb+texture2D(tBloom,vUv).rgb*uBloom;
    c=toSRGB(aces(c));vec2 q=(vUv-.5)*uAsp;c*=mix(1.,smoothstep(1.15,.25,length(q)),uVig);
    c*=uFade;c+=(h(gl_FragCoord.xy+fract(uTime)*91.)-.5)/255.;gl_FragColor=vec4(c,1.);}`,
  { tScene: { value: null }, tBloom: { value: null }, uBloom: { value: 0 }, uTime: { value: 0 }, uVig: { value: 0.55 }, uFade: { value: 1 }, uAsp: { value: new T.Vector2(1, 1) } });

  const post = { rt: null, down: [], up: [], w: 0, h: 0 };
  const rtOpts = { type: T.HalfFloatType, depthBuffer: false, minFilter: T.LinearFilter, magFilter: T.LinearFilter };
  function sizePost(w, h) {
    if (post.rt) { post.rt.dispose(); post.down.forEach(r => r.dispose()); post.up.forEach(r => r.dispose()); }
    post.w = w; post.h = h;
    post.rt = new T.WebGLRenderTarget(w, h, { type: T.HalfFloatType, samples: 4, depthBuffer: true });
    post.down = []; post.up = [];
    let bw = w, bh = h;
    for (let i = 0; i < 6; i++) {
      bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1);
      post.down.push(new T.WebGLRenderTarget(bw, bh, rtOpts));
      if (i < 5) post.up.push(new T.WebGLRenderTarget(bw, bh, rtOpts));
    }
  }
  function pass(m, target) { fsMesh.material = m; renderer.setRenderTarget(target); renderer.render(fsScene, fsCam); }
  function bloom() {
    let src = post.rt;
    for (let i = 0; i < post.down.length; i++) {
      downMat.uniforms.tSrc.value = src.texture; downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      downMat.uniforms.uPre.value = i === 0 ? 1 : 0; pass(downMat, post.down[i]); src = post.down[i];
    }
    let low = post.down[post.down.length - 1];
    for (let i = post.up.length - 1; i >= 0; i--) {
      upMat.uniforms.tLow.value = low.texture; upMat.uniforms.uTexel.value.set(1 / low.width, 1 / low.height);
      upMat.uniforms.tHigh.value = post.down[i].texture; pass(upMat, post.up[i]); low = post.up[i];
    }
    return post.up[0].texture;
  }
  const blackTex = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blackTex.needsUpdate = true;

  // ---------- camera, shots, flights
  const cam = new T.PerspectiveCamera(32, 16 / 9, 0.05, 600);
  D3.cam = cam;
  const shot = () => ({ pos: new V3(), tgt: new V3(), fov: 32, sx: 0, sy: 0, par: 1 });
  const cur = shot();
  let goal = null, fly = null, goalFn = null;
  const setShot = (o, s) => { o.pos.copy(s.pos); o.tgt.copy(s.tgt); o.fov = s.fov ?? 32; o.sx = s.sx ?? 0; o.sy = s.sy ?? 0; o.par = s.par ?? 1; return o; };
  const toShot = s => ({ pos: s.pos.isVector3 ? s.pos.clone() : new V3(...s.pos), tgt: s.tgt.isVector3 ? s.tgt.clone() : new V3(...s.tgt), fov: s.fov ?? 32, sx: s.sx ?? 0, sy: s.sy ?? 0, par: s.par ?? 1 });
  D3.shots = {};
  /* fly the camera to a shot (object or name). A shot may be a function (t)=>shot that is re-evaluated every frame. */
  D3.flyTo = (s, o = {}) => {
    if (typeof s === 'string') s = D3.shots[s];
    goalFn = typeof s === 'function' ? s : null;
    goal = toShot(goalFn ? goalFn(0) : s);
    const dur = reduced || o.cut ? 0 : o.dur ?? 1.6;
    const from = setShot(shot(), cur);
    const dist = from.pos.distanceTo(goal.pos);
    fly = { from, t: 0, dur: Math.max(0.0001, dur), arc: o.arc ?? Math.min(9, dist * 0.22) * (dist > 8 ? 1 : 0) };
    if (dur === 0) { setShot(cur, goal); fly = null; fadeIn(); }
  };
  D3.isFlying = () => !!fly;
  let fade = 1; const fadeIn = () => { if (reduced) fade = 0.0; };
  const ctrl = new V3(), dir = new V3();
  function updateCamera(dt, time) {
    if (!goal) return;
    if (goalFn) { const g = goalFn(time); goal = toShot(g); }
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / fly.dur);
      const k = ease(fly.t), f = fly.from;
      if (fly.arc > 0) {
        ctrl.copy(f.pos).add(goal.pos).multiplyScalar(0.5);
        dir.copy(f.tgt).add(goal.tgt).multiplyScalar(0.5).sub(ctrl).normalize();
        ctrl.addScaledVector(dir, -fly.arc * 0.9); ctrl.y += fly.arc * 0.55;
        const u = 1 - k; cur.pos.copy(f.pos).multiplyScalar(u * u).addScaledVector(ctrl, 2 * u * k).addScaledVector(goal.pos, k * k);
      } else cur.pos.lerpVectors(f.pos, goal.pos, k);
      cur.tgt.lerpVectors(f.tgt, goal.tgt, k);
      cur.fov = lerp(f.fov, goal.fov, k); cur.sx = lerp(f.sx, goal.sx, k); cur.sy = lerp(f.sy, goal.sy, k); cur.par = lerp(f.par, goal.par, k);
      if (fly.t >= 1) fly = null;
    } else {
      const kk = goalFn ? 7 : 12;
      cur.pos.x = damp(cur.pos.x, goal.pos.x, kk, dt); cur.pos.y = damp(cur.pos.y, goal.pos.y, kk, dt); cur.pos.z = damp(cur.pos.z, goal.pos.z, kk, dt);
      cur.tgt.x = damp(cur.tgt.x, goal.tgt.x, kk, dt); cur.tgt.y = damp(cur.tgt.y, goal.tgt.y, kk, dt); cur.tgt.z = damp(cur.tgt.z, goal.tgt.z, kk, dt);
      cur.fov = damp(cur.fov, goal.fov, kk, dt); cur.sx = damp(cur.sx, goal.sx, kk, dt); cur.sy = damp(cur.sy, goal.sy, kk, dt); cur.par = damp(cur.par, goal.par, kk, dt);
    }
    // pointer parallax: small orbit around the target
    const d = cur.pos.distanceTo(cur.tgt), amp = reduced || D3.dragging ? 0 : 0.035 * d * cur.par;
    cam.position.copy(cur.pos); cam.up.set(0, 1, 0); cam.lookAt(cur.tgt);
    const r = new V3().setFromMatrixColumn(cam.matrix, 0), up = new V3().setFromMatrixColumn(cam.matrix, 1);
    cam.position.addScaledVector(r, ptr.sx * amp).addScaledVector(up, -ptr.sy * amp * 0.55);
    cam.lookAt(cur.tgt);
    projection();
  }
  // lens shift keeps subjects where the 1600x900 layout expects them on any window shape
  function projection() {
    const a = view.w / view.h, A = 16 / 9;
    let fov = cur.fov, kx = 1, ky = 1;
    if (a < A) { fov = (2 * Math.atan(Math.tan((cur.fov * Math.PI) / 360) * (A / a)) * 180) / Math.PI; ky = a / A; } else kx = A / a;
    cam.fov = fov; cam.aspect = a; cam.updateProjectionMatrix();
    const P = cam.projectionMatrix.elements; P[8] = -cur.sx * kx; P[9] = -cur.sy * ky;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }
  D3.camState = () => ({ pos: cur.pos.toArray().map(v => +v.toFixed(3)), tgt: cur.tgt.toArray().map(v => +v.toFixed(3)), fov: +cur.fov.toFixed(2), sx: +cur.sx.toFixed(3), sy: +cur.sy.toFixed(3) });

  // ---------- pointer
  const ptr = { x: 0, y: 0, sx: 0, sy: 0, ndc: new T.Vector2(), px: 0, py: 0 };
  D3.ptr = ptr;
  addEventListener('pointermove', e => { ptr.px = e.clientX; ptr.py = e.clientY; ptr.x = (e.clientX / innerWidth) * 2 - 1; ptr.y = (e.clientY / innerHeight) * 2 - 1; }, { passive: true });
  const ray = new T.Raycaster();
  D3.ray = (e, objs, recursive = true) => {
    ptr.ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    cam.updateMatrixWorld(); ray.setFromCamera(ptr.ndc, cam);
    return objs ? ray.intersectObjects(objs, recursive) : ray.ray;
  };

  // ---------- projected labels
  const labels = [];
  const tmp = new V3();
  D3.label = (el, pos, show) => { const L = { el, pos, show: show || (() => true), on: false }; labels.push(L); document.getElementById('labels').append(el); return L; };
  function updateLabels() {
    for (const L of labels) {
      const p = typeof L.pos === 'function' ? L.pos() : L.pos;
      let on = !!p && L.show();
      if (on) { tmp.copy(p).project(cam); on = tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2; }
      if (on) L.el.style.transform = `translate(${((tmp.x + 1) / 2 * view.w).toFixed(1)}px,${((1 - tmp.y) / 2 * view.h).toFixed(1)}px)`;
      if (on !== L.on) { L.el.classList.toggle('on', on); L.on = on; }
    }
  }
  D3.toScreen = p => { tmp.copy(p).project(cam); return { x: (tmp.x + 1) / 2 * view.w, y: (1 - tmp.y) / 2 * view.h, z: tmp.z }; };

  // ---------- layers (scenes) and stations
  D3.layers = [];   // {scene, sphere?: THREE.Sphere, order, hud?}
  D3.stations = [];
  D3.addLayer = (scene, o = {}) => { const L = Object.assign({ scene, order: 0 }, o); D3.layers.push(L); D3.layers.sort((a, b) => a.order - b.order); return L; };
  D3.bloomGoal = 0.25; let bloomNow = 0.25;
  D3.bg = D3.ui('#101116');

  // ---------- size / adaptive resolution
  const view = { w: 1, h: 1, dpr: 1, maxDpr: Math.min(devicePixelRatio || 1, 1.5) };
  D3.view = view;
  function resize() {
    view.w = innerWidth; view.h = innerHeight;
    renderer.setPixelRatio(view.dpr); renderer.setSize(view.w, view.h, false);
    sizePost(Math.round(view.w * view.dpr), Math.round(view.h * view.dpr));
    const a = view.w / view.h; compMat.uniforms.uAsp.value.set(a > 1 ? a / 1.6 : 1 / 1.6, a > 1 ? 1 / 1.6 : 1 / (1.6 * a));
  }
  view.dpr = view.maxDpr;
  addEventListener('resize', resize);
  resize();
  let ftAcc = 0, ftN = 0, ftT = 0;
  function adapt(dt) {
    ftAcc += dt; ftN++; ftT += dt;
    if (ftT < 2) return;
    const avg = ftAcc / ftN; ftAcc = ftN = ftT = 0;
    let nd = view.dpr;
    if (avg > 0.024 && view.dpr > 0.75) nd = Math.max(0.75, view.dpr - 0.25);
    else if (avg < 0.0125 && view.dpr < view.maxDpr) nd = Math.min(view.maxDpr, view.dpr + 0.25);
    if (nd !== view.dpr) { view.dpr = nd; resize(); }
    D3.fps = Math.round(1 / avg);
  }

  // ---------- loop
  const frustum = new T.Frustum(), pm = new T.Matrix4();
  let last = performance.now(), time = 0, running = false;
  D3.time = () => time;
  function frame(now) {
    renderer.info.reset();
    const elapsed = Math.max(0.0001, (now - last) / 1000);
    const dt = Math.min(0.05, elapsed); last = now; time += dt;
    for (const s of D3.stations) s.update && s.update(dt, time);
    ptr.sx = damp(ptr.sx, ptr.x, 2.2, dt); ptr.sy = damp(ptr.sy, ptr.y, 2.2, dt);
    updateCamera(dt, time);
    cam.updateMatrixWorld();
    pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
    for (const s of D3.stations) s.visible = !s.sphere || frustum.intersectsSphere(s.sphere);
    for (const s of D3.stations) s.late && s.late(dt, time);
    updateLabels();
    renderer.setRenderTarget(post.rt); renderer.setClearColor(D3.bg, 1); renderer.clear(true, true, false);
    let hudCleared = false;
    for (const L of D3.layers) {
      if (L.station && !L.station.visible) continue;
      if (L.visible && !L.visible()) continue;
      if (L.hud && !hudCleared) { renderer.clearDepth(); hudCleared = true; }
      renderer.render(L.scene, cam);
    }
    bloomNow = damp(bloomNow, D3.bloomGoal, 4, dt);
    const bt = bloomNow > 0.01 ? bloom() : blackTex;
    fade = damp(fade, 1, 6, dt);
    compMat.uniforms.tScene.value = post.rt.texture; compMat.uniforms.tBloom.value = bt;
    compMat.uniforms.uBloom.value = bloomNow; compMat.uniforms.uTime.value = time; compMat.uniforms.uFade.value = fade;
    pass(compMat, null);
    D3.drawCalls = renderer.info.render.calls;
    adapt(elapsed);
    D3.frames = (D3.frames || 0) + 1;
    requestAnimationFrame(frame);
  }
  D3.start = () => { if (running) return; running = true; last = performance.now(); requestAnimationFrame(frame); };
  D3.renderOnce = () => frame(performance.now());
})();
