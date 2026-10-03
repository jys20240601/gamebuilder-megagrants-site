/* moonjar.js — 달을 품은 항아리: the v2 full-moon frame as a two-layer backdrop plate (room / window view),
   a lathe moon jar on the shelf with a porcelain shader, lit through the pine gobo (MoonJar assets) so moving the
   gobo turns crescent -> half -> full -> waning. The phase follows the brightness curve measured on the film. */
(function () {
  'use strict';
  const T = THREE, D3 = window.D3, { clamp, lerp, smooth, damp } = D3;
  const O = D3.POS.mj, INFO = (window.TEX_INFO || {}).jar || { cx: 0.7008, foot: 0.4884, h: 0.3162, w: 0.1086 };
  const PW = 9, PH = 3, Y0 = 0.5, DZ = 1.5, DREF = 9.4;
  const scene = new T.Scene();
  const station = { name: 'mj', sphere: new T.Sphere(O.clone().add(new T.Vector3(0, Y0 + PH / 2, -0.5)), 5.6) };
  const G = new T.Group(); G.position.copy(O); scene.add(G);
  const uT = { value: 0 };
  const VS = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';

  // ---------- plate layers
  const landTex = D3.tex('mj_land'), roomTex = D3.tex('mj_room'), roomA = D3.tex('mj_room_a', { srgb: false });
  const k0 = (DREF + DZ) / DREF, M = 1.32;
  const landMat = new T.ShaderMaterial({
    uniforms: { tC: { value: landTex }, uT, uM: { value: M } },
    vertexShader: VS,
    fragmentShader: `${D3.glslInvACES}uniform sampler2D tC;uniform float uT,uM;varying vec2 vUv;
      void main(){vec2 uv=(vUv-.5)*uM+.5;vec3 c=texture2D(tC,clamp(uv,.001,.999)).rgb;
      float out_=max(max(-uv.x,uv.x-1.),max(-uv.y,uv.y-1.));c*=1.-smoothstep(0.,.12,out_)*.6;gl_FragColor=vec4(invACES(c),1.);}`,
  });
  const land = new T.Mesh(new T.PlaneGeometry(PW * k0 * M, PH * k0 * M), landMat);
  land.position.set(0, Y0 + PH / 2, -DZ); G.add(land);
  const roomMat = new T.ShaderMaterial({
    uniforms: { tC: { value: roomTex }, tA: { value: roomA }, uT, uWarm: { value: 1 } }, transparent: true,
    vertexShader: VS,
    fragmentShader: `${D3.glslInvACES}uniform sampler2D tC,tA;uniform float uT,uWarm;varying vec2 vUv;
      void main(){float a=texture2D(tA,vUv).r;if(a<.004)discard;vec3 c=texture2D(tC,vUv).rgb;
      float w=clamp((c.r-c.b)*4.,0.,1.);c*=1.+uWarm*w*(.05*sin(uT*.55)+.025*sin(uT*1.7+1.));gl_FragColor=vec4(invACES(c),a);}`,
  });
  const room = new T.Mesh(new T.PlaneGeometry(PW, PH), roomMat); room.position.set(0, Y0 + PH / 2, 0); room.renderOrder = 10; G.add(room);
  // shadow box between the layers + outer frame and plinth (so the work reads as an object in the gallery)
  const boxMat = new T.MeshBasicMaterial({ color: D3.ui('#0b0c10'), side: T.DoubleSide });
  const bw = PW * 1.12, bh = PH * 1.12;
  [[bw, DZ, 0, Y0 + PH / 2 + bh / 2, -DZ / 2, Math.PI / 2, 0], [bw, DZ, 0, Y0 + PH / 2 - bh / 2, -DZ / 2, Math.PI / 2, 0], [DZ, bh, -bw / 2, Y0 + PH / 2, -DZ / 2, 0, Math.PI / 2], [DZ, bh, bw / 2, Y0 + PH / 2, -DZ / 2, 0, Math.PI / 2]].forEach(([w, h, x, y, z, rx, ry]) => { const m = new T.Mesh(new T.PlaneGeometry(w, h), boxMat); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); G.add(m); });
  const wood = new T.MeshStandardMaterial({ color: new T.Color('#2b1d16'), roughness: 0.7 });
  const frame = new T.Shape(); frame.moveTo(-PW / 2 - 0.14, Y0 - 0.14); frame.lineTo(PW / 2 + 0.14, Y0 - 0.14); frame.lineTo(PW / 2 + 0.14, Y0 + PH + 0.14); frame.lineTo(-PW / 2 - 0.14, Y0 + PH + 0.14);
  const hole = new T.Path(); hole.moveTo(-PW / 2, Y0); hole.lineTo(-PW / 2, Y0 + PH); hole.lineTo(PW / 2, Y0 + PH); hole.lineTo(PW / 2, Y0); frame.holes.push(hole);
  const fm = new T.Mesh(new T.ExtrudeGeometry(frame, { depth: DZ + 0.2, bevelEnabled: false }), wood); fm.position.z = -DZ - 0.1; G.add(fm);
  const plinth = new T.Mesh(new T.BoxGeometry(PW + 0.6, Y0 - 0.14, DZ + 0.8), new T.MeshStandardMaterial({ color: new T.Color('#1b1715'), roughness: 0.8 })); plinth.position.set(0, (Y0 - 0.14) / 2, -DZ / 2 + 0.1); G.add(plinth);
  scene.add(new T.HemisphereLight(new T.Color('#6a7cb8'), new T.Color('#2a1c14'), 0.6));
  const fl = new T.DirectionalLight(new T.Color('#9fb2ff'), 0.6); fl.position.set(O.x - 4, 6, 8); fl.target.position.copy(O); scene.add(fl, fl.target);

  // ---------- the jar (profile from MoonJar/blender/build_jar.py, cm)
  const PROFILE = [[0, 7.6], [0.25, 7.95], [0.8, 8.15], [1.6, 8.25], [1.9, 8.6], [3, 10.6], [5, 13.3], [7.5, 15.9], [10, 17.9], [13, 19.7], [16, 20.9], [19, 21.6], [21.6, 21.9], [22.6, 21.95], [23.4, 22.05], [25, 22.1], [27.5, 21.8], [30, 21], [32.5, 19.6], [35, 17.6], [37.2, 15.3], [39, 13.1], [40.3, 11.6], [41.1, 10.75], [41.6, 10.35], [42.4, 10.15], [43.6, 10.15], [44.5, 10.35], [44.95, 10.55]];
  const INNER = [[45, 10.2], [44.6, 9.65], [43.5, 9.45], [42, 9.45], [40.5, 10.5], [38.5, 12.6]];
  function resample(pts, n) {
    const P = pts.map(([z, r]) => new T.Vector2(r, z)), dense = [];
    for (let i = 0; i < P.length - 1; i++) { const p0 = P[Math.max(i - 1, 0)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(i + 2, P.length - 1)]; for (let k = 0; k < 16; k++) { const t = k / 16, t2 = t * t, t3 = t2 * t; dense.push(new T.Vector2(0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3), 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3))); } }
    dense.push(P[P.length - 1]);
    const L = [0]; for (let i = 1; i < dense.length; i++) L.push(L[i - 1] + dense[i].distanceTo(dense[i - 1]));
    const out = []; let j = 0; for (let i = 0; i < n; i++) { const s = (L[L.length - 1] * i) / (n - 1); while (j < L.length - 2 && L[j + 1] < s) j++; const f = (s - L[j]) / Math.max(L[j + 1] - L[j], 1e-9); const q = dense[j].clone().lerp(dense[j + 1], f); out.push([q.y, q.x, s / L[L.length - 1]]); }
    return out;
  }
  const rj = D3.rng(7), harm = [[2, rj() * 6.28, 0.0045], [3, rj() * 6.28, 0.0028], [4, rj() * 6.28, 0.0014], [5, rj() * 6.28, 0.0008]];
  function deform(th, z, r) {
    const up = 1 / (1 + Math.exp(-(z - 22.8) / 0.9)), body = Math.sin(Math.PI * clamp((z - 1.9) / 40, 0, 1));
    let rr = r; for (const [k, ph, a] of harm) rr += r * a * body * Math.cos(k * th + ph + 0.7 * up);
    rr *= 1 + 0.012 * up * body; rr += 0.05 * Math.exp(-(((z - 22.8) / 0.9) ** 2)) * (1 + 0.5 * Math.cos(th * 3 + 1.1));
    return [rr, -0.55 * up * body * (0.5 + 0.5 * Math.cos(th - 2.2)), 0.45 * up + 0.25 * body, -0.2 * up];
  }
  const prof = resample(PROFILE, 120).concat(resample(INNER, 12).slice(1).map(([z, r], i) => [Math.min(z, 44.9), r, 1 + (i + 1) * 0.004]));
  const NU = 112, pos = [], uv = [], idx = [];
  prof.forEach(([z, r, v]) => { for (let i = 0; i <= NU; i++) { const th = (2 * Math.PI * i) / NU, [rr, dz, dx, dy] = deform(th, z, r); pos.push(rr * Math.cos(th) + dx, z + dz, -(rr * Math.sin(th) + dy)); uv.push(i / NU, v); } });
  for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < NU; i++) { const a = j * (NU + 1) + i, b = a + NU + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
  const jg = new T.BufferGeometry(); jg.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); jg.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); jg.setIndex(idx); jg.computeVertexNormals();
  const KCM = (INFO.h * PH) / 45; // world units per cm
  const JX = (INFO.cx - 0.5) * PW, JY = Y0 + (1 - INFO.foot) * PH, JZ = 0.06;
  const jarC = new T.Vector3(O.x + JX, O.y + JY + 22 * KCM, O.z + JZ);
  const gobo = D3.tex('gobo', { srgb: false, repeatS: true });
  const L = new T.Vector3(-0.42, 0.3, 0.86).normalize();
  const jarMat = new T.ShaderMaterial({
    uniforms: {
      tBC: { value: D3.tex('jar_bc') }, tG: { value: gobo }, uL: { value: L }, uC: { value: jarC }, uSpan: { value: 126 * KCM },
      uOff: { value: 0 }, uVOff: { value: 0 }, uGob: { value: 0.985 }, uKey: { value: new T.Color(1.7, 1.62, 1.5) },
      uSky: { value: new T.Color(0.025, 0.035, 0.075) }, uGround: { value: new T.Color(0.014, 0.01, 0.008) }, uRim: { value: new T.Color(0.04, 0.055, 0.11) },
    },
    vertexShader: 'varying vec3 vN,vW;varying vec2 vUv;void main(){vUv=uv;vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;vN=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*viewMatrix*w;}',
    fragmentShader: `uniform sampler2D tBC,tG;uniform vec3 uL,uC,uKey,uSky,uGround,uRim;uniform float uSpan,uOff,uVOff,uGob;varying vec3 vN,vW;varying vec2 vUv;
      void main(){vec3 N=normalize(vN);if(!gl_FrontFacing)N=-N;vec3 V=normalize(cameraPosition-vW);vec3 base=texture2D(tBC,vUv).rgb*1.05;
      vec3 Lr=normalize(cross(vec3(0.,1.,0.),uL)),Lu=cross(uL,Lr);vec2 g=vec2(dot(vW-uC,Lr),dot(vW-uC,Lu))/uSpan;
      float occ=texture2D(tG,vec2(.5+g.x+uOff,.5+g.y+uVOff),1.2).r;float lit=1.-occ*uGob;
      float ndl=dot(N,uL),wrap=max(0.,(ndl+.3)/1.3);
      vec3 H=normalize(uL+V);float nh=max(dot(N,H),0.);float spec=(pow(nh,260.)*2.4+pow(nh,30.)*.08)*step(0.,ndl);
      vec3 col=base*uKey*wrap*lit*.62;
      col+=base*uKey*.05*lit*smoothstep(-.35,.15,ndl)*(1.-smoothstep(.15,.6,ndl));
      col+=base*mix(uGround,uSky,N.y*.5+.5)*1.15;
      col+=uKey*spec*lit;float F=pow(1.-max(dot(N,V),0.),4.);col+=uRim*F;
      gl_FragColor=vec4(col,1.);}`,
  });
  const jar = new T.Mesh(jg, jarMat); jar.scale.setScalar(KCM); jar.position.set(JX, JY, JZ); G.add(jar);
  const contact = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: D3.canvasTex(64, 64, (c, w, h) => { const g = c.createRadialGradient(32, 32, 1, 32, 32, 32); g.addColorStop(0, 'rgba(0,0,0,.7)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(0, 0, w, h); }), transparent: true, depthWrite: false }));
  contact.scale.set(40 * KCM, 12 * KCM, 1); contact.rotation.x = -Math.PI / 2; contact.position.set(JX, JY + 0.004, JZ); contact.renderOrder = 11; G.add(contact);

  // ---------- phase calibration: lit fraction of the jar disc versus gobo offset (sampled from the gobo itself)
  const PHASE = [[0, 0.042], [6, 0.088], [12, 0.181], [18, 0.344], [24, 0.692], [28, 0.909], [31, 0.917], [34, 1], [37, 0.911], [40, 0.803], [43, 0.455], [45, 0.249], [47, 0.11], [49, 0.033], [51, 0.005], [53, 0.003], [55, 0.003], [57, 0], [58.5, 0.006], [59.9, 0.04], [60, 0.042]];
  const curve = t => { t = ((t % 60) + 60) % 60; for (let i = 0; i < PHASE.length - 1; i++) { const [a, va] = PHASE[i], [b, vb] = PHASE[i + 1]; if (t <= b) return lerp(va, vb, (t - a) / (b - a)); } return PHASE[0][1]; };
  const mj = (D3.mj = { t: 34, mode: 'auto', speed: 1, frac: null, offFull: 0.4, emph: { shadow: 0, mist: 0, wind: 0 }, curve, PHASE });
  let offTable = null;
  function calibrate() {
    const img = gobo.image; if (!img || !img.width) return;
    const c = document.createElement('canvas'); c.width = 256; c.height = 256; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 256, 256);
    const d = x.getImageData(0, 0, 256, 256).data, rad = 22.1 / 126, frac = new Float32Array(256);
    // Match the shader projection on the visible hemisphere, including its depth.
    // Sampling a flat disc shifts the crescent/half phases toward a much fuller moon.
    const lr = new T.Vector3().crossVectors(new T.Vector3(0,1,0),L).normalize(), lu = new T.Vector3().crossVectors(L,lr);
    for (let k = 0; k < 256; k++) { let s = 0, n = 0; for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) { const u = i / 20, v = j / 20; if (u * u + v * v > 1) continue; const z=Math.sqrt(Math.max(0,1-u*u-v*v)), gx=rad*(u*lr.x+v*lr.y+z*lr.z), gy=rad*(u*lu.x+v*lu.y+z*lu.z); const px = Math.floor(((0.5 + gx + k / 256) % 1) * 256), py = Math.max(0,Math.min(255,Math.floor((0.5 - gy) * 256))); s += d[(py * 256 + px) * 4] / 255; n++; } frac[k] = 1 - s / n; }
    // full = widest lit plateau centre; new = darkest; waxing = from new to full
    let kMax = 0, kMin = 0; for (let k = 0; k < 256; k++) { if (frac[k] > frac[kMax] + 1e-4) kMax = k; if (frac[k] < frac[kMin] - 1e-4) kMin = k; }
    let a = kMax, b = kMax; while (frac[(a + 255) % 256] > frac[kMax] - 0.01 && a - kMax > -128) a--; while (frac[(b + 1) % 256] > frac[kMax] - 0.01 && b - kMax < 128) b++;
    const full = ((a + b) / 2 + 256) % 256; let n0 = kMin;
    offTable = { frac, full, n0 };
    mj.offFull = full / 256; mj.frac = frac;
  }
  // brightness wanted at time t -> gobo offset on the waxing (t<34) or waning branch
  function offsetFor(t) {
    if (!offTable) return mj.offFull;
    const { frac, full } = offTable, want = curve(t) * (frac[Math.round(full) % 256]), wax = ((t % 60) + 60) % 60 < 34;
    let best = full, bestD = 9; for (let s = 0; s <= 128; s++) { const k = wax ? full - s : full + s, f = frac[((Math.round(k) % 256) + 256) % 256], dd = Math.abs(f - want); if (dd < bestD - 1e-4) { bestD = dd; best = k; } if (f < want - 0.02 && s > 4) break; }
    return best / 256;
  }
  mj.offsetFor = offsetFor;
  mj.label = t => { t = ((t % 60) + 60) % 60; return t < 10 ? '초승' : t < 27 ? '반달' : t < 41 ? '보름' : t < 50 ? '기우는 반달' : '그믐'; };

  // ---------- mist and water glints
  const mistTex = D3.canvasTex(256, 128, (c, w, h) => { const r = D3.rng(9); for (let i = 0; i < 90; i++) { const x = r() * w, y = h * (0.3 + r() * 0.4), rad = 14 + r() * 40, g = c.createRadialGradient(x, y, 0, x, y, rad); g.addColorStop(0, 'rgba(255,255,255,.18)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, w, h); } c.globalCompositeOperation='destination-in'; for (const axis of [0,1]) { const edge=c.createLinearGradient(0,0,axis?0:w,axis?h:0); edge.addColorStop(0,'transparent'); edge.addColorStop(.24,'white'); edge.addColorStop(.76,'white'); edge.addColorStop(1,'transparent'); c.fillStyle=edge; c.fillRect(0,0,w,h); } });
  const mists = [];
  for (let i = 0; i < 4; i++) {
    const m = new T.Mesh(new T.PlaneGeometry(PW * 0.75, PH * 0.42), new T.MeshBasicMaterial({ map: mistTex, transparent: true, depthWrite: false, color: new T.Color(0.55, 0.62, 0.8), opacity: 0.0 }));
    m.position.set(-PW * 0.3 + i * PW * 0.22, Y0 + PH * (0.36 + (i % 2) * 0.08), -DZ * (0.25 + i * 0.17)); m.userData = { ph: i * 1.9, x0: m.position.x }; G.add(m); mists.push(m);
  }
  const NS = 150, sp = new Float32Array(NS * 3), ss = new Float32Array(NS), rs = D3.rng(13);
  for (let i = 0; i < NS; i++) { const u = 0.27 + rs() * 0.6, v = 0.6 + rs() * 0.2; sp[i * 3] = (u - 0.5) * PW * k0; sp[i * 3 + 1] = Y0 + PH / 2 + (0.5 - v) * PH * k0; sp[i * 3 + 2] = -DZ + 0.03; ss[i] = rs(); }
  const sg = new T.BufferGeometry(); sg.setAttribute('position', new T.BufferAttribute(sp, 3)); sg.setAttribute('seed', new T.BufferAttribute(ss, 1));
  const glintMat = new T.ShaderMaterial({
    uniforms: { uT, uI: { value: 1 }, uPx: { value: 1 } }, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    vertexShader: 'attribute float seed;uniform float uT,uPx;varying float vA;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;float s=sin(uT*(1.5+seed*2.)+seed*60.);vA=pow(max(s,0.),18.);gl_PointSize=uPx*(1.5+seed*2.)*(9./-mv.z);}',
    fragmentShader: 'uniform float uI;varying float vA;void main(){float a=smoothstep(.5,0.,length(gl_PointCoord-.5));gl_FragColor=vec4(vec3(.8,.88,1.)*a*vA*uI*1.6,1.);}',
  });
  const glints = new T.Points(sg, glintMat); glints.frustumCulled = false; G.add(glints);

  // ---------- update
  mj.setT = t => { mj.t = ((t % 60) + 60) % 60; };
  mj.cycle = 30;
  let calibrated = false, sway = 0;
  station.update = (dt, time) => {
    if (D3.reduced) time = 0;
    uT.value = time;
    if (!calibrated && gobo.image && gobo.image.complete && gobo.image.width) { calibrate(); calibrated = true; }
    if (station.visible === false) return;
    const e = mj.emph; ['shadow', 'mist', 'wind'].forEach(k => (e[k] = damp(e[k], mj.want && mj.want[k] ? 1 : 0, 3, dt)));
    if (mj.mode === 'auto' && !D3.reduced) mj.t = (mj.t + dt * (60 / mj.cycle) * (1 + e.shadow * 2)) % 60;
    sway = damp(sway, 1 + e.wind * 3, 2, dt);
    const w = D3.reduced ? 0 : sway;
    jarMat.uniforms.uOff.value = offsetFor(mj.t) + Math.sin(time * 0.7) * 0.0025 * w + Math.sin(time * 1.9 + 1) * 0.0012 * w;
    jarMat.uniforms.uVOff.value = Math.sin(time * 0.5 + 2) * 0.002 * w;
    const mistI = 0.35 + e.mist * 0.9;
    mists.forEach((m, i) => { const u = m.userData; if (!D3.reduced) m.position.x = u.x0 + Math.sin(time * 0.03 * (1 + e.wind) + u.ph) * 1.2 + ((time * 0.04 * (1 + e.wind)) % 2) * 0; m.material.opacity = mistI * (0.6 + 0.4 * Math.sin(time * 0.2 + u.ph)) * 0.75; });
    glintMat.uniforms.uPx.value = D3.view.dpr * D3.view.h / 900; glintMat.uniforms.uI.value = D3.reduced ? 0.4 : 1;
    D3.emit('mj:t', mj.t);
  };
  D3.stations.push(station);
  D3.addLayer(scene, { order: 30, station });

  // ---------- shots
  const P = (x, y, z) => [O.x + x, O.y + y, O.z + z];
  const cy = Y0 + PH / 2;
  D3.shots['mj.hero'] = { pos: P(0, cy + 0.25, DREF), tgt: P(0, cy, 0), fov: 32, sx: 0, sy: 0.17, par: 0.8 };
  D3.shots['mj.dial'] = { pos: P(JX + 0.35, JY + 0.62, 3.35), tgt: P(JX, JY + 0.48, 0), fov: 30, sx: -0.3, sy: 0.04, par: 0.8 };
  D3.shots['mj.quiet'] = { pos: P(-0.9, cy + 0.15, 7.6), tgt: P(0.25, cy - 0.05, 0), fov: 32, sx: 0, sy: 0.2, par: 1.2 };
  mj.anchor = { jarTop: new T.Vector3(O.x + JX, O.y + JY + 48 * KCM, O.z + JZ), top: new T.Vector3(O.x, O.y + Y0 + PH + 0.5, O.z) };
  mj.pickables = [jar, room, land];
})();
