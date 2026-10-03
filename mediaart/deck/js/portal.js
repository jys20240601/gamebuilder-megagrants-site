/* portal.js — 포털 진입: an underpass model (metres, scaled into the gallery). The sun lowers until the walker's
   shadow (1.8 m figure, 7.33° sun -> 14 m) reaches the judgement line 6 m inside the tunnel; then the portal ignites:
   centre line, frame ribs, light flood, motes. Sun altitude and the figure can be dragged. */
(function () {
  'use strict';
  const T = THREE, D3 = window.D3, { clamp, lerp, smooth, damp, ease } = D3;
  const O = D3.POS.pt, SP = 0.4;
  const HM = 1.8, LINE = -6, TL = 28, TW = 5, TH = 3.2, APP = 14, FIG0 = 8;
  const ALIGN = (Math.atan(HM / (FIG0 - LINE)) * 180) / Math.PI; // 7.33°
  const scene = new T.Scene();
  const station = { name: 'pt', sphere: new T.Sphere(O.clone().add(new T.Vector3(0, 1.8, -2.5)), 10.5) };
  const G = new T.Group(); G.position.copy(O); G.scale.setScalar(SP); scene.add(G);
  const W = v => G.localToWorld(v.clone());
  const add = (geo, m, x = 0, y = 0, z = 0, parent = G) => { const me = new T.Mesh(geo, m); me.position.set(x, y, z); parent.add(me); return me; };

  // ---------- procedural textures
  const rnd = D3.rng(31);
  const noiseTex = (w, h, base, spots, o = {}) => D3.canvasTex(w, h, (c) => {
    c.fillStyle = base; c.fillRect(0, 0, w, h);
    for (const [col, n, r0, r1, a] of spots) { c.fillStyle = col; for (let i = 0; i < n; i++) { c.globalAlpha = a * (0.4 + rnd() * 0.6); const r = r0 + rnd() * (r1 - r0); c.beginPath(); c.arc(rnd() * w, rnd() * h, r, 0, 7); c.fill(); } }
    c.globalAlpha = 1; o.draw && o.draw(c, w, h);
  }, { repeat: true });
  const asphalt = noiseTex(512, 512, '#47433f', [['#2f2c2a', 2200, 0.6, 2.2, 0.6], ['#6a645d', 1800, 0.5, 1.6, 0.5], ['#3a3633', 40, 10, 40, 0.15]]);
  const concrete = noiseTex(512, 512, '#bdae99', [['#a59682', 900, 1, 4, 0.35], ['#cfc2ae', 700, 1, 3, 0.4], ['#8c7f6d', 30, 20, 70, 0.08]], {
    draw(c, w, h) { c.strokeStyle = 'rgba(80,68,55,.35)'; c.lineWidth = 2; for (let y = 64; y < h; y += 64) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); } c.strokeStyle = 'rgba(80,68,55,.18)'; for (let x = 0; x < w; x += 128) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); } },
  });
  const grass = noiseTex(512, 512, '#7f7136', [['#5f5a2a', 1400, 2, 7, 0.5], ['#a39150', 1200, 1, 5, 0.5], ['#4f6a2c', 300, 3, 10, 0.4], ['#b59e5c', 500, 1, 3, 0.6]]);
  [asphalt, concrete, grass].forEach(t => (t.anisotropy = 8));
  const tiled = (tex, sx, sy) => { const t = tex.clone(); t.repeat.set(sx, sy); t.needsUpdate = true; return t; };
  const concMat = new T.MeshStandardMaterial({ map: tiled(concrete, 3, 1.5), roughness: 0.92 });
  const concWall = new T.MeshStandardMaterial({ map: tiled(concrete, 4, 1), roughness: 0.92 });
  const tunMat = new T.MeshStandardMaterial({ map: tiled(concrete, 10, 1.2), roughness: 0.95, color: new T.Color('#b9b3aa') });
  const roadMat = new T.MeshStandardMaterial({ map: tiled(asphalt, 3, 6), roughness: 0.96 });
  const grassMat = new T.MeshStandardMaterial({ map: tiled(grass, 5, 5), roughness: 1 });
  const earth = new T.MeshStandardMaterial({ color: new T.Color('#3b3128'), roughness: 1 });
  const metal = new T.MeshStandardMaterial({ color: new T.Color('#8c9094'), roughness: 0.4, metalness: 0.8 });

  // ---------- ground, road, lines
  const shadowed = m => { m.receiveShadow = true; m.castShadow = true; return m; };
  const road = add(new T.PlaneGeometry(7.2, APP), roadMat, 0, 0, APP / 2); road.rotation.x = -Math.PI / 2; road.receiveShadow = true;
  const tfloor = add(new T.PlaneGeometry(TW, TL), new T.MeshStandardMaterial({ map: tiled(asphalt, 2, 10), roughness: 0.95 }), 0, 0, -TL / 2); tfloor.rotation.x = -Math.PI / 2; tfloor.receiveShadow = true;
  // centre line: lit along its length by a 1D emissive map rewritten each frame
  const LN = 256, lineData = new Uint8Array(LN * 4), lineTex = new T.DataTexture(lineData, LN, 1); lineTex.colorSpace = T.NoColorSpace; lineTex.magFilter = T.LinearFilter; lineTex.needsUpdate = true;
  const lineZ = u => lerp(APP, -TL, u); // u along the strip
  const lineGeo = new T.PlaneGeometry(0.16, APP + TL); lineGeo.rotateX(-Math.PI / 2); lineGeo.translate(0, 0.006, (APP - TL) / 2);
  { const uv = lineGeo.attributes.uv, p = lineGeo.attributes.position; for (let i = 0; i < uv.count; i++) uv.setXY(i, (APP - p.getZ(i)) / (APP + TL), 0.5); }
  const lineMat = new T.MeshStandardMaterial({ color: new T.Color('#e9e6df'), roughness: 0.7, emissive: new T.Color(1, 0.86, 0.6), emissiveMap: lineTex, emissiveIntensity: 9 });
  add(lineGeo, lineMat).receiveShadow = true;
  const judgeMat = new T.MeshStandardMaterial({ color: new T.Color('#d7d2c8'), roughness: 0.5, emissive: new T.Color(1, 0.85, 0.6), emissiveIntensity: 0 });
  const judge = add(new T.PlaneGeometry(TW - 0.1, 0.07), judgeMat, 0, 0.007, LINE); judge.rotation.x = -Math.PI / 2; judge.receiveShadow = true;

  // ---------- retaining walls with coping and handrails, facade, tunnel
  const topAt = z => lerp(4.9, 0.55, clamp(z / APP, 0, 1));
  [-1, 1].forEach(s => {
    const sh = new T.Shape(); sh.moveTo(0, 0); sh.lineTo(APP, 0); sh.lineTo(APP, topAt(APP)); sh.lineTo(0, topAt(0)); sh.lineTo(0, 0);
    const g = new T.ExtrudeGeometry(sh, { depth: 0.42, bevelEnabled: false }); g.rotateY(-Math.PI / 2);
    const m = shadowed(add(g, concWall, s > 0 ? 3.6 + 0.42 : -3.6, 0, 0)); m.position.x = s > 0 ? 3.6 + 0.42 : -3.6;
    const len = Math.hypot(APP, topAt(0) - topAt(APP)), ang = Math.atan2(topAt(0) - topAt(APP), APP);
    const cap = shadowed(add(new T.BoxGeometry(0.62, 0.14, len + 0.1), concMat, s * 3.81, (topAt(0) + topAt(APP)) / 2 + 0.07, APP / 2)); cap.rotation.x = ang;
    const rail = add(new T.CylinderGeometry(0.03, 0.03, len, 8), metal, s * 4.25, (topAt(0) + topAt(APP)) / 2 + 1.05, APP / 2); rail.rotation.x = Math.PI / 2 + ang;
    for (let z = 0.6; z < APP; z += 1.8) add(new T.CylinderGeometry(0.025, 0.025, 1.0, 6), metal, s * 4.25, topAt(z) + 0.55, z);
  });
  const fac = new T.Group(); G.add(fac);
  shadowed(add(new T.BoxGeometry(1.9, 5.0, 0.9), concMat, -3.45, 2.5, -0.45, fac));
  shadowed(add(new T.BoxGeometry(1.9, 5.0, 0.9), concMat, 3.45, 2.5, -0.45, fac));
  shadowed(add(new T.BoxGeometry(5.0, 1.8, 0.9), concMat, 0, TH + 0.9, -0.45, fac));
  shadowed(add(new T.BoxGeometry(8.9, 0.2, 1.1), concMat, 0, 5.1, -0.45, fac));
  // tunnel shell (inside faces) and roof slab (casts the interior shade)
  const twall = (x) => { const m = add(new T.PlaneGeometry(TL, TH), tunMat, x, TH / 2, -TL / 2); m.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2; m.receiveShadow = true; return m; };
  twall(-TW / 2); twall(TW / 2);
  const ceil = add(new T.PlaneGeometry(TW, TL), tunMat, 0, TH, -TL / 2); ceil.rotation.x = Math.PI / 2; ceil.receiveShadow = true;
  shadowed(add(new T.BoxGeometry(TW + 2, 1.8, TL), earth, 0, TH + 0.9, -TL / 2 - 0.45));
  for (let z = -2; z > -TL; z -= 4) add(new T.BoxGeometry(0.5, 0.04, 0.12), new T.MeshBasicMaterial({ color: new T.Color(1.4, 1.35, 1.25) }), 0, TH - 0.03, z);
  const exitMat = new T.MeshBasicMaterial({ color: new T.Color(0.9, 0.82, 0.7) });
  add(new T.PlaneGeometry(TW, TH), exitMat, 0, TH / 2, -TL - 0.01);

  // embankments: slopes beside the approach, top over the tunnel, model-cut skirts
  const slope = (s) => { const g = new T.PlaneGeometry(12.38, APP, 6, 14); const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i) + 6.19, z = APP / 2 - p.getY(i); p.setXYZ(i, s * (4.02 + x), topAt(z) + 0.2 + Math.sin(x * 0.9 + z * 0.7) * 0.06 * x * 0.2, z); } g.computeVertexNormals(); if (s < 0) g.scale(1, 1, 1); const m = add(g, grassMat); m.receiveShadow = true; m.material.side = T.DoubleSide; return m; };
  slope(-1); slope(1);
  const top = add(new T.PlaneGeometry(32.8, 32.9), grassMat, 0, 5.12, -16.45); top.rotation.x = -Math.PI / 2; top.receiveShadow = true;
  const skirt = (w, h, x, y, z, ry) => { const m = add(new T.PlaneGeometry(w, h), earth, x, y, z); m.rotation.y = ry; return m; };
  skirt(32.8, 5.12, 0, 2.56, -32.9, 0);
  [-1, 1].forEach(s => {
    skirt(32.9, 5.12, s * 16.4, 2.56, -16.45, s * Math.PI / 2);
    const sh = new T.Shape(); sh.moveTo(0, 0); sh.lineTo(APP, 0); sh.lineTo(APP, topAt(APP) + 0.2); sh.lineTo(0, topAt(0) + 0.2);
    const g = new T.ShapeGeometry(sh); g.rotateY(-Math.PI / 2); add(g, earth, s * 16.4, 0, 0).material.side = T.DoubleSide;
    const fr = new T.Shape(); fr.moveTo(0, 0); fr.lineTo(12.38, 0); fr.lineTo(12.38, topAt(APP) + 0.2); fr.lineTo(0, topAt(APP) + 0.2);
    const fg = new T.ShapeGeometry(fr); add(fg, earth, s > 0 ? 4.02 : -16.4, 0, APP).material.side = T.DoubleSide;
  });
  // fence on top, shrubs, trees
  for (let x = -15; x <= 15; x += 2.5) add(new T.CylinderGeometry(0.03, 0.03, 1.1, 6), metal, x, 5.7, -1.4);
  add(new T.CylinderGeometry(0.03, 0.03, 30, 6), metal, 0, 6.2, -1.4).rotation.z = Math.PI / 2;
  const shrubGeo = new T.IcosahedronGeometry(1, 1), shrubs = new T.InstancedMesh(shrubGeo, new T.MeshStandardMaterial({ color: new T.Color('#ffffff'), roughness: 1, flatShading: true }), 90);
  { const m4 = new T.Matrix4(), q = new T.Quaternion(), r = D3.rng(5), cols = ['#5c6b2e', '#6f7a34', '#7d6f38', '#4d5c2a']; let i = 0;
    while (i < 90) { const s = r() < 0.5 ? -1 : 1, x = s * (4.9 + r() * 10), z = -28 + r() * (APP + 28), y = z > 0 ? topAt(z) + 0.2 : 5.12; if (z < -1 && z > -2) continue; const sc = 0.35 + r() * 0.7; m4.compose(new T.Vector3(z < 0 ? (r() - 0.5) * 30 : x, y + sc * 0.3, z), q.random(), new T.Vector3(sc, sc * 0.7, sc)); shrubs.setMatrixAt(i, m4); shrubs.setColorAt(i, new T.Color(cols[i % 4])); i++; } }
  shrubs.castShadow = true; shrubs.receiveShadow = true; G.add(shrubs);
  const trunkMat = new T.MeshStandardMaterial({ color: new T.Color('#5a4a3a'), roughness: 1 }), leafMat = new T.MeshStandardMaterial({ color: new T.Color('#7c8a4a'), roughness: 1, flatShading: true });
  [[-9, 3], [8.5, 5], [-11, -6], [11.5, -9], [-6.5, -14], [6, -20]].forEach(([x, z]) => {
    const y = z > 0 ? topAt(z) + 0.2 : 5.12, t = new T.Group(); t.position.set(x, y, z); G.add(t);
    shadowed(add(new T.CylinderGeometry(0.09, 0.14, 3.2, 6), trunkMat, 0, 1.6, 0, t));
    [[0, 3.4, 0, 1.3], [0.6, 2.8, 0.3, 0.9], [-0.5, 3.0, -0.3, 1.0]].forEach(([a, b, c, r]) => shadowed(add(new T.IcosahedronGeometry(r, 1), leafMat, a, b, c, t)));
  });
  // apartments behind
  const apt = D3.canvasTex(256, 512, (c, w, h) => {
    c.fillStyle = '#ddd2bf'; c.fillRect(0, 0, w, h);
    for (let y = 10; y < h - 10; y += 22) { c.fillStyle = 'rgba(120,100,80,.35)'; c.fillRect(0, y + 15, w, 3); for (let x = 8; x < w - 10; x += 24) { c.fillStyle = rnd() < 0.15 ? '#c8a06a' : '#4a5260'; c.fillRect(x, y, 16, 12); } }
  });
  const aptMat = new T.MeshStandardMaterial({ map: apt, roughness: 0.85 });
  [[-14, -40, 11, 22], [-2, -44, 14, 26], [12, -41, 12, 20], [24, -46, 10, 24], [-26, -45, 10, 18]].forEach(([x, z, w, h]) => { const m = add(new T.BoxGeometry(w, h, 7), aptMat, x, h / 2, z); m.material.map.repeat.set(1, 1); m.receiveShadow = true; });
  // sky cyclorama (fades in near the station)
  const skyMat = new T.ShaderMaterial({
    uniforms: { uA: { value: 0 }, uLow: { value: 0 } }, transparent: true, depthWrite: false, side: T.BackSide,
    vertexShader: 'varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform float uA,uLow;varying vec3 vP;void main(){float h=clamp(vP.y/38.,0.,1.);
      vec3 hi=mix(vec3(.32,.5,.85),vec3(.28,.36,.62),uLow),mid=mix(vec3(.95,.86,.7),vec3(1.4,.78,.42),uLow);
      vec3 c=mix(mid,hi,smoothstep(0.,.55,h));gl_FragColor=vec4(c,uA*smoothstep(0.,.04,h));}`,
  });
  const sky = add(new T.CylinderGeometry(70, 70, 40, 48, 1, true, Math.PI * 0.62, Math.PI * 0.76), skyMat, 0, 20, -2); sky.renderOrder = -1;

  // ---------- frame ribs (entrance outline + every 4 m inside)
  const ribs = [];
  for (let i = 0; i <= 7; i++) {
    const z = -i * 4 - (i === 0 ? -0.02 : 0), m = new T.MeshBasicMaterial({ color: new T.Color(0, 0, 0) }), g = new T.Group(); g.position.z = z; G.add(g);
    const inset = i === 0 ? 0.0 : 0.03, w = 0.07;
    add(new T.BoxGeometry(w, TH - inset, w), m, -TW / 2 + inset + w / 2, (TH - inset) / 2, 0, g);
    add(new T.BoxGeometry(w, TH - inset, w), m, TW / 2 - inset - w / 2, (TH - inset) / 2, 0, g);
    add(new T.BoxGeometry(TW - 2 * inset, w, w), m, 0, TH - inset - w / 2, 0, g);
    if (i > 0) add(new T.BoxGeometry(TW - 2 * inset, 0.02, w), m, 0, 0.012, 0, g);
    ribs.push({ m, i });
  }
  // flood volume, inner lights, motes, contact flash
  const floodMat = new T.ShaderMaterial({
    uniforms: { uI: { value: 0 }, uT: { value: 0 } }, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
    vertexShader: 'varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform float uI,uT;varying vec3 vP;void main(){float d=clamp(-vP.z/${TL.toFixed(1)},0.,1.);
      float a=uI*(.035+.16*pow(d,1.6))*(1.-smoothstep(.4,1.,abs(vP.x)/2.5)*.4);gl_FragColor=vec4(vec3(1.,.82,.55)*a,1.);}`,
  });
  const flood = add(new T.BoxGeometry(TW - 0.12, TH - 0.08, TL - 0.4), floodMat, 0, TH / 2, -TL / 2 - 0.2);
  flood.geometry.translate(0, 0, 0); flood.renderOrder = 5;
  { const p = flood.geometry.attributes.position; for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) - (TL - 0.4) / 2 + 0.0); flood.position.z = -0.2; }
  const inner = [-5, -13, -21].map(z => { const l = new T.PointLight(new T.Color('#ffd49a'), 0, 16 * SP, 1.2); l.position.set(0, 2.4, z); G.add(l); return l; });
  const NM = 280, mp = new Float32Array(NM * 3), ms = new Float32Array(NM);
  for (let i = 0; i < NM; i++) { mp[i * 3] = (rnd() - 0.5) * 4.6; mp[i * 3 + 1] = rnd() * 3.1; mp[i * 3 + 2] = -rnd() * 30 + 3; ms[i] = rnd(); }
  const mg = new T.BufferGeometry(); mg.setAttribute('position', new T.BufferAttribute(mp, 3)); mg.setAttribute('seed', new T.BufferAttribute(ms, 1));
  const moteMat = new T.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uI: { value: 0 }, uPx: { value: 1 } }, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    vertexShader: `attribute float seed;uniform float uT,uI,uPx;varying float vA;void main(){vec3 p=position;float t=uT*(.25+.3*seed);
      p.z=mod(p.z+t*1.2+30.,33.)-30.;p.x+=sin(t+seed*20.)*.3;p.y+=sin(t*.8+seed*9.)*.25;
      vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=uPx*(2.+3.*seed)*(6./-mv.z);
      vA=uI*(.4+.6*sin(uT*2.+seed*40.)*.5+.3)*smoothstep(3.,-1.,p.z);}`,
    fragmentShader: 'varying float vA;void main(){float a=smoothstep(.5,0.,length(gl_PointCoord-.5));gl_FragColor=vec4(vec3(1.,.85,.6)*a*vA*2.2,1.);}',
  });
  const motes = new T.Points(mg, moteMat); motes.frustumCulled = false; G.add(motes);
  const flashTex = D3.canvasTex(128, 128, (c, w, h) => { const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,220,160,.6)'); g.addColorStop(1, 'rgba(255,200,120,0)'); c.fillStyle = g; c.fillRect(0, 0, w, h); });
  const flash = add(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: flashTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending, color: new T.Color(3, 2.4, 1.6) }), 0, 0.02, LINE);
  flash.rotation.x = -Math.PI / 2;

  // ---------- figure
  const fig = new T.Group(); G.add(fig);
  const cloth = new T.MeshStandardMaterial({ color: new T.Color('#3b3632'), roughness: 0.85 }), jeans = new T.MeshStandardMaterial({ color: new T.Color('#5d7088'), roughness: 0.9 });
  const skin = new T.MeshStandardMaterial({ color: new T.Color('#c49a7c'), roughness: 0.7 }), hair = new T.MeshStandardMaterial({ color: new T.Color('#1f1a17'), roughness: 0.8 }), pack = new T.MeshStandardMaterial({ color: new T.Color('#252629'), roughness: 0.7 });
  const limb = (r, l, m, x, y) => { const piv = new T.Group(); piv.position.set(x, y, 0); fig.add(piv); const me = new T.Mesh(new T.CapsuleGeometry(r, l, 4, 10), m); me.position.y = -l / 2 - r * 0.6; me.castShadow = true; piv.add(me); return piv; };
  const legL = limb(0.08, 0.72, jeans, -0.1, 0.9), legR = limb(0.08, 0.72, jeans, 0.1, 0.9);
  const torso = new T.Mesh(new T.CapsuleGeometry(0.17, 0.42, 4, 12), cloth); torso.position.y = 1.2; torso.scale.set(1.15, 1, 0.78); torso.castShadow = true; fig.add(torso);
  const armL = limb(0.055, 0.55, cloth, -0.25, 1.46), armR = limb(0.055, 0.55, cloth, 0.25, 1.46);
  const headM = new T.Mesh(new T.SphereGeometry(0.105, 16, 12), skin); headM.position.y = 1.685; headM.scale.set(0.95, 1.08, 1); headM.castShadow = true; fig.add(headM);
  const hairM = new T.Mesh(new T.SphereGeometry(0.112, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hair); hairM.position.y = 1.7; hairM.castShadow = true; fig.add(hairM);
  const neck = new T.Mesh(new T.CylinderGeometry(0.05, 0.055, 0.1, 8), skin); neck.position.y = 1.56; fig.add(neck);
  const bp = new T.Mesh(new T.BoxGeometry(0.34, 0.44, 0.17), pack); bp.position.set(0, 1.25, 0.2); bp.castShadow = true; fig.add(bp);
  fig.traverse(o => { if (o.isMesh) o.userData.fig = true; });
  const figPick = []; fig.traverse(o => o.isMesh && figPick.push(o));

  // ---------- guides: shadow dimension, sun ray, angle arc
  const guideMat = new T.MeshBasicMaterial({ color: D3.ui('#f8f7f5'), transparent: true, opacity: 0.85, depthWrite: false });
  const dimBar = add(new T.PlaneGeometry(1, 0.035), guideMat, 0.75, 0.012, 0); dimBar.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
  const dimA = add(new T.PlaneGeometry(0.3, 0.035), guideMat, 0.75, 0.012, 0), dimB = add(new T.PlaneGeometry(0.3, 0.035), guideMat, 0.75, 0.012, 0);
  dimA.rotation.x = dimB.rotation.x = -Math.PI / 2;
  const rayGeo = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]);
  const rayLine = new T.Line(rayGeo, new T.LineDashedMaterial({ color: D3.ui('#ffcf6a'), dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.9 })); G.add(rayLine);
  const arcGeo = new T.BufferGeometry(); arcGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(33 * 3), 3));
  const arcLine = new T.Line(arcGeo, new T.LineBasicMaterial({ color: D3.ui('#f16459') })); G.add(arcLine);
  const guides = [dimBar, dimA, dimB, rayLine, arcLine];

  // ---------- light
  scene.add(new T.AmbientLight(new T.Color('#ffffff'), 0.05));
  const hemi = new T.HemisphereLight(new T.Color('#b8c8e6'), new T.Color('#6b5638'), 0.9); scene.add(hemi);
  const sun = new T.DirectionalLight(new T.Color('#ffe2b8'), 3); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.015; sun.shadow.radius = 2;
  scene.add(sun, sun.target);

  // ---------- state
  const st = (D3.pt = { alt: ALIGN, pos: FIG0, ign: 1, ignGoal: 1, mode: 'idle', auto: null, walk: null, guides: 0, focus: 0 });
  st.ALIGN = ALIGN; st.LINE = LINE;
  const shadowLen = () => HM / Math.tan((st.alt * Math.PI) / 180);
  const gap = () => LINE - (st.pos - shadowLen()); // >0: falls short (tip outside the line), <0: overshoots
  st.aligned = () => Math.abs(st.pos - shadowLen() - LINE) <= 0.3;
  st.info = () => { const L = shadowLen(), tip = st.pos - L, g = tip - LINE; return { alt: st.alt, len: L, gap: g, aligned: Math.abs(g) <= 0.3, open: st.ign > 0.9 }; };
  st.set = (o) => { Object.assign(st, o); };
  st.sequence = () => { // slide 7: sun lowers from 32° to 7.33°, then the frame ignites
    st.walk = null;
    st.pos = FIG0; st.mode = 'align';
    if (D3.reduced) { st.alt = ALIGN; st.auto = null; return; }
    st.alt = 32; st.ign = 0; st.auto = { t: 0, dur: 4.2, from: 32 };
  };
  st.waiting = () => { st.mode = 'idle'; st.auto = null; st.alt = 17; st.pos = FIG0; st.ign = 0; st.walk = null; };
  st.walkIn = () => {
    st.mode = 'walk'; st.auto = null; st.alt = ALIGN; st.ign = 1;
    if (D3.reduced) { st.pos = 0.4; st.walk = null; return; }
    st.pos = FIG0; st.walk = { t: -0.9, from: FIG0, to: -5, speed: 1.35 };
  };
  st.overview = () => { st.mode = 'overview'; st.auto = null; st.walk = null; st.alt = ALIGN; st.pos = FIG0; };
  st.dragSun = (dy) => { st.auto = null; let a = clamp(st.alt - dy * 0.06, 3, 40); const want = (Math.atan(HM / (st.pos - LINE)) * 180) / Math.PI; if (Math.abs(a - want) < 0.35) a = want; st.alt = a; };
  st.setAlt = (a) => { st.auto = null; const want = (Math.atan(HM / (st.pos - LINE)) * 180) / Math.PI; st.alt = Math.abs(a - want) < 0.3 ? want : clamp(a, 3, 40); };
  st.dragFigure = (e) => {
    st.auto = null; const r = D3.ray(e); const t = -(r.origin.y - O.y) / r.direction.y; if (!(t > 0)) return;
    const p = r.origin.clone().addScaledVector(r.direction, t); let z = (p.z - O.z) / SP;
    const L = shadowLen(); if (Math.abs(z - L - LINE) < 0.45) z = LINE + L; st.pos = clamp(z, 1, APP - 0.5);
  };
  st.pickFigure = e => D3.ray(e, figPick, false).length > 0;

  let pulse = 0, lastAligned = false, lastShadowAlt = NaN, lastShadowPos = NaN;
  station.update = (dt, time) => {
    if (D3.reduced) time = 0;
    st.focus = damp(st.focus, clamp(1 - (D3.cam.position.distanceTo(station.sphere.center) - 8) / 14, 0, 1), 3, dt);
    if (st.auto) { st.auto.t += dt; const k = ease(clamp(st.auto.t / st.auto.dur, 0, 1)); st.alt = lerp(st.auto.from, ALIGN, k); if (k >= 1) st.auto = null; }
    let walking = 0;
    if (st.walk) { const w = st.walk; w.t += dt; if (w.t > 0) { const d = w.from - w.to, u = clamp((w.t * w.speed) / d, 0, 1); st.pos = lerp(w.from, w.to, u); walking = u < 1 ? 1 : 0; if (u >= 1) st.walk = null; } }
    const al = st.aligned();
    if (st.mode === 'align' || st.mode === 'overview' || st.mode === 'drag') st.ignGoal = al ? 1 : 0;
    else if (st.mode === 'walk') st.ignGoal = 1; else st.ignGoal = 0;
    if (D3.reduced) st.ign = st.ignGoal; else st.ign = st.ignGoal > st.ign ? Math.min(st.ignGoal, st.ign + dt / 1.5) : Math.max(st.ignGoal, st.ign - dt / 0.5);
    if (al && !lastAligned) pulse = 1; lastAligned = al; pulse = Math.max(0, pulse - dt * 0.9);
    st.guides = damp(st.guides, st.mode === 'align' || st.mode === 'drag' ? 1 : 0, 5, dt);
    // figure pose
    fig.position.set(0, 0, st.pos); fig.rotation.y = 0;
    const ph = time * 7.2, sw = walking * 0.5;
    legL.rotation.x = Math.sin(ph) * sw; legR.rotation.x = -Math.sin(ph) * sw; armL.rotation.x = -Math.sin(ph) * sw * 0.7; armR.rotation.x = Math.sin(ph) * sw * 0.7;
    fig.position.y = walking ? Math.abs(Math.sin(ph)) * 0.035 : Math.sin(time * 1.6) * 0.004;
    if (lastShadowAlt !== st.alt || lastShadowPos !== st.pos || walking) {
      D3.renderer.shadowMap.needsUpdate = true;
      lastShadowAlt = st.alt; lastShadowPos = st.pos;
    }
    armL.rotation.z = -0.06; armR.rotation.z = 0.06;
    // sun
    const a = (st.alt * Math.PI) / 180, low = smooth(25, 6, st.alt);
    const dir = new T.Vector3(0.0, Math.sin(a), Math.cos(a));
    const tgt = W(new T.Vector3(0, 1.5, -6));
    sun.target.position.copy(tgt); sun.position.copy(tgt).addScaledVector(dir, 40);
    const hs = Math.max(5.5, (36 * Math.sin(a) + 6 * Math.cos(a)) / 2 + 1) * SP;
    const c = sun.shadow.camera; c.left = -6 * SP; c.right = 6 * SP; c.top = hs; c.bottom = -hs; c.near = 1; c.far = 80; c.updateProjectionMatrix();
    sun.color.setRGB(lerp(1, 1, low), lerp(0.9, 0.7, low), lerp(0.76, 0.42, low)); sun.intensity = lerp(2.6, 3.4, low);
    hemi.intensity = lerp(1.0, 0.55, low); hemi.color.setRGB(lerp(0.72, 0.62, low), lerp(0.78, 0.6, low), lerp(0.9, 0.78, low));
    skyMat.uniforms.uA.value = st.focus; skyMat.uniforms.uLow.value = low; sky.visible = st.mode !== 'overview' && st.focus > 0.8;
    // ignition
    const ig = st.ign;
    const lk = clamp((ig - 0.08) / 0.32, 0, 1), tipZ = LINE;
    for (let i = 0; i < LN; i++) {
      const z = lineZ(i / (LN - 1)), d = Math.abs(z - tipZ), reach = lk * 22;
      let v = d < reach ? 1 - smooth(reach - 2, reach, d) * 0.9 : 0;
      v *= z < tipZ ? 1 : 0.55; v += Math.exp(-((z - tipZ) ** 2) / 0.4) * clamp(ig / 0.12, 0, 1) * 0.8;
      lineData[i * 4] = lineData[i * 4 + 1] = lineData[i * 4 + 2] = Math.round(clamp(v, 0, 1) * 255); lineData[i * 4 + 3] = 255;
    }
    lineTex.needsUpdate = true; lineMat.emissiveIntensity = 7.5 * Math.min(1, ig * 3);
    judgeMat.emissiveIntensity = 2.5 * clamp(ig / 0.15, 0, 1) + pulse * 2;
    ribs.forEach(r => { const k = clamp((ig - 0.32 - 0.05 * r.i) / 0.18, 0, 1); r.m.color.setRGB(0.02 + 7.5 * k, 0.018 + 6.4 * k, 0.015 + 4.6 * k); });
    const fl = clamp((ig - 0.6) / 0.32, 0, 1);
    floodMat.uniforms.uI.value = fl * 1.8; inner.forEach(l => (l.intensity = fl * 14));
    exitMat.color.setRGB(0.9 + fl * 9, 0.82 + fl * 7.5, 0.7 + fl * 5.2);
    moteMat.uniforms.uT.value = time; moteMat.uniforms.uI.value = 0.18 + fl * 1.1; moteMat.uniforms.uPx.value = D3.view.dpr * D3.view.h / 900;
    flash.scale.setScalar(0.4 + (1 - pulse) * 2.8); flash.material.opacity = pulse * clamp(ig * 4, 0, 1); flash.visible = pulse > 0.01;
    D3.bloomGoalPt = 0.025 + fl * 0.10;
    // guides
    const L = shadowLen(), tip = st.pos - L, gv = st.guides;
    guides.forEach(g => { g.visible = gv > 0.02; if (g.material) g.material.opacity = gv * 0.9; });
    const z0 = st.pos, z1 = Math.max(tip, -TL + 0.5); dimBar.position.z = (z0 + z1) / 2; dimBar.scale.x = Math.max(0.01, z0 - z1);
    dimA.position.z = z0; dimB.position.z = z1;
    rayGeo.attributes.position.setXYZ(0, 0, HM, st.pos); rayGeo.attributes.position.setXYZ(1, 0, 0, tip); rayGeo.attributes.position.needsUpdate = true; rayLine.computeLineDistances();
    const ap = arcGeo.attributes.position; for (let i = 0; i <= 32; i++) { const t = (i / 32) * a; ap.setXYZ(i, 0, Math.sin(t) * 1.6 + 0.01, tip + Math.cos(t) * 1.6); } ap.needsUpdate = true;
    D3.emit('pt:state', st.info());
  };
  D3.stations.push(station);
  D3.addLayer(scene, { order: 20, station });

  // ---------- anchors and shots (world)
  st.anchor = {
    line: () => W(new T.Vector3(-1.6, 0.05, LINE)), len: () => W(new T.Vector3(0.95, 0.02, (st.pos + Math.max(st.pos - shadowLen(), -TL)) / 2)),
    angle: () => W(new T.Vector3(0, 0.55, st.pos - shadowLen() + 2.4)), height: () => W(new T.Vector3(-0.45, 1.05, st.pos)),
    top: W(new T.Vector3(0, 6.4, -2)), figure: () => W(new T.Vector3(0, 1.95, st.pos)),
  };
  const P = (x, y, z) => W(new T.Vector3(x, y, z)).toArray();
  D3.shots['pt.hero'] = { pos: P(-5.5, 7.8, 25), tgt: P(0.6, 1.6, -3), fov: 32, sx: -0.24, sy: 0.02 };
  D3.shots['pt.align'] = { pos: P(4.2, 10.5, 22.5), tgt: P(0, 0.2, -2.5), fov: 32, sx: -0.2, sy: 0.08 };
  D3.shots['pt.walk'] = (t) => { const z = st.pos; return { pos: P(0.9, 2.3, z + 5.2), tgt: P(0, 1.4, z - 6), fov: 38, sx: -0.18, sy: 0.02, par: 0.6 }; };
})();
