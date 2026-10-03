/* onewave.js — ONE WAVE: the toy console, its water tank, rings and pegs, PRESS jets with a simple ring physics,
   and the 60 s timeline ribbon. The physics is the website toy's 2D model (side view) extended with depth:
   rings rise in the jet plume, tumble, drift and sink; a flat ring falling onto a peg top is caught and stacks. */
(function () {
  'use strict';
  const T = THREE, D3 = window.D3, { clamp, lerp, smooth, damp } = D3;
  const O = D3.POS.ow;
  const station = { name: 'ow', sphere: new T.Sphere(O.clone().add(new T.Vector3(0, 1.9, 0)), 3.4) };
  const casing = new T.Scene(), tank = new T.Scene(), hud = new T.Scene();
  const root = new T.Group(); root.position.copy(O); casing.add(root);
  const troot = new T.Group(); troot.position.copy(O); tank.add(troot);

  // ---------- tank geometry (station coordinates)
  const TK = { x0: -1.3, x1: 1.3, yb: 1.85, yt: 2.87, zb: -0.6, zf: 0.7 };
  const Wt = TK.x1 - TK.x0, Ht = TK.yt - TK.yb, AR = Wt / Ht;
  const S = { R: 0.072, FLOOR: 0.885, PEG_TOP: 0.44, G: 0.2, KD: 1.7, DT: 1 / 120, STR: 4.2, CW: 0.6, CF: 0.55 };
  S.TH = S.R * 0.34; S.JA = Math.atan(1 / (0.36 * AR));
  const sandY = TK.yb + (1 - S.FLOOR) * Ht;
  const WX = x => (x / AR - 0.5) * Wt, WY = y => TK.yb + (1 - y) * Ht;

  // ---------- helpers
  function rr(w, h, r, x0, y0, path) {
    const s = path ? new T.Path() : new T.Shape(), [a, b, c, d] = Array.isArray(r) ? r : [r, r, r, r];
    s.moveTo(x0 + a, y0); s.lineTo(x0 + w - b, y0); s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + b);
    s.lineTo(x0 + w, y0 + h - c); s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - c, y0 + h);
    s.lineTo(x0 + d, y0 + h); s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - d); s.lineTo(x0, y0 + a); s.quadraticCurveTo(x0, y0, x0 + a, y0);
    return s;
  }
  const ext = (shape, depth, bevel = 0.03, seg = 3) => new T.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: seg, curveSegments: 18 });
  const std = (hex, o = {}) => new T.MeshStandardMaterial(Object.assign({ color: new T.Color(hex), roughness: 0.5, metalness: 0 }, o));
  const add = (parent, geo, m, x = 0, y = 0, z = 0) => { const me = new T.Mesh(geo, m); me.position.set(x, y, z); parent.add(me); return me; };

  // ---------- casing (warm room light)
  const paintRed = std('#b3201c', { roughness: 0.32, metalness: 0.08 });
  const cream = std('#efe5cf', { roughness: 0.45 });
  const chrome = std('#c9ccd2', { roughness: 0.22, metalness: 0.9 });
  const dark = std('#2a1f1c', { roughness: 0.7 });
  add(root, new T.BoxGeometry(3.12, 0.08, 1.56), dark, 0, 0.04, 0);
  const lower = add(root, ext(rr(3.0, 1.43, 0.07, -1.5, 0.1), 1.44), paintRed, 0, 0, -0.72);
  add(root, new T.BoxGeometry(3.08, 0.05, 1.54), chrome, 0, 1.555, 0);
  const hShape = rr(3.1, 1.6, [0.05, 0.05, 0.52, 0.52], -1.55, 1.6);
  hShape.holes.push(rr(Wt + 0.02, Ht + 0.02, 0.1, TK.x0 - 0.01, TK.yb - 0.01, true));
  add(root, ext(hShape, 1.44), cream, 0, 0, -0.72);
  const bez = rr(Wt + 0.16, Ht + 0.16, 0.16, TK.x0 - 0.08, TK.yb - 0.08); bez.holes.push(rr(Wt + 0.02, Ht + 0.02, 0.1, TK.x0 - 0.01, TK.yb - 0.01, true));
  add(root, ext(bez, 0.02, 0.012, 2), chrome, 0, 0, 0.735);
  add(root, new T.PlaneGeometry(3.0, 1.55), cream, 0, 2.38, -0.755).rotation.y = Math.PI;
  // marquee
  add(root, ext(rr(2.56, 0.66, 0.08, -1.28, 3.16), 0.36, 0.025, 2), cream, 0, 0, -0.18);
  const marqMat = new T.MeshStandardMaterial({ map: D3.tex('marquee'), emissiveMap: null, emissive: new T.Color('#ffffff'), roughness: 0.4 });
  marqMat.emissiveMap = marqMat.map; marqMat.emissiveIntensity = 0.85;
  add(root, new T.PlaneGeometry(2.36, 0.46), marqMat, 0, 3.49, 0.21);
  // PRESS panel + button
  add(root, ext(rr(0.8, 1.02, 0.06, -0.4, 0.3), 0.04, 0.02, 2), cream, 0, 0, 0.73);
  add(root, new T.PlaneGeometry(0.42, 0.105), new T.MeshBasicMaterial({ map: D3.tex('press'), transparent: true, color: D3.ui('#5b5146') }), 0, 1.18, 0.796);
  const btn = new T.Group(); btn.position.set(0, 0.76, 0.79); root.add(btn);
  const btnCyl = add(btn, new T.CylinderGeometry(0.2, 0.21, 0.12, 40), std('#8d9298', { roughness: 0.28, metalness: 0.75 }), 0, 0, 0.04); btnCyl.rotation.x = Math.PI / 2;
  add(btn, new T.CylinderGeometry(0.235, 0.235, 0.03, 40), std('#6b7076', { roughness: 0.35, metalness: 0.7 }), 0, 0, 0.0).rotation.x = Math.PI / 2;
  add(btn, new T.BoxGeometry(0.3, 0.035, 0.02), std('#4b5056', { roughness: 0.5, metalness: 0.5 }), 0, 0, 0.105);
  btn.userData.press = 0;
  // decals
  add(root, new T.PlaneGeometry(0.96, 0.48), new T.MeshStandardMaterial({ map: D3.tex('watergame'), transparent: true, roughness: 0.6 }), -0.98, 0.72, 0.752);
  add(root, new T.BoxGeometry(0.16, 0.1, 0.03), std('#c8a447', { roughness: 0.3, metalness: 0.85 }), 1.06, 1.12, 0.76);
  // glass
  const glassMat = new T.ShaderMaterial({
    uniforms: { uT: { value: 0 } }, transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv;void main(){float d=vUv.x*1.2+vUv.y*.55;
      float s=smoothstep(.02,.0,abs(fract(d*.9)-.18))*.5+smoothstep(.05,.0,abs(fract(d*.9)-.27))*.25;
      float e=smoothstep(.0,.08,vUv.y)*smoothstep(1.,.9,vUv.y);float edge=1.-smoothstep(0.,.03,min(min(vUv.x,1.-vUv.x),min(vUv.y,1.-vUv.y)));
      gl_FragColor=vec4(vec3(1.),.035+s*.07*e+edge*.25);}`,
  });
  add(root, new T.PlaneGeometry(Wt, Ht), glassMat, 0, (TK.yb + TK.yt) / 2, TK.zf);
  // room light and a soft contact shadow on the gallery floor
  casing.add(new T.HemisphereLight(new T.Color('#ffe6c8'), new T.Color('#2a1a14'), 0.55));
  const spot = new T.SpotLight(new T.Color('#ffd9a8'), 3.5, 0, 0.55, 0.85, 0); spot.position.copy(O).add(new T.Vector3(1.5, 7.5, 6.5));
  spot.target.position.copy(O).add(new T.Vector3(0, 1.6, 0)); casing.add(spot, spot.target);
  const rim = new T.DirectionalLight(new T.Color('#ffc59a'), 0.9); rim.position.copy(O).add(new T.Vector3(-4, 5, -6)); rim.target.position.copy(O); casing.add(rim, rim.target);
  const shadowTex = D3.canvasTex(128, 128, (c, w, h) => { const g = c.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2); g.addColorStop(0, 'rgba(0,0,0,.75)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(0, 0, w, h); });
  const sh = add(root, new T.PlaneGeometry(4.6, 2.6), new T.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }), 0, 0.004, 0.1); sh.rotation.x = -Math.PI / 2;

  // ---------- tank interior (its own underwater light)
  tank.add(new T.HemisphereLight(new T.Color('#cfeaff'), new T.Color('#c9b083'), 1.25));
  const sun = new T.DirectionalLight(new T.Color('#e8f6ff'), 2.4); sun.position.copy(O).add(new T.Vector3(0.6, 6, 3)); sun.target.position.copy(O).add(new T.Vector3(0, 2, 0)); tank.add(sun, sun.target);
  const caus = D3.tex('caustics', { srgb: false, repeat: true });
  const uT = { value: 0 }, uTurb = { value: 0 };
  const waterMat = new T.ShaderMaterial({
    uniforms: { uT, tC: { value: caus }, uDark: { value: 0 } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform float uT,uDark;uniform sampler2D tC;varying vec2 vUv;
      void main(){vec3 top=vec3(.06,.36,.78),bot=vec3(.012,.07,.2);vec3 c=mix(bot,top,pow(vUv.y,1.25));
      float x=vUv.x+(1.-vUv.y)*.18;float r=pow(max(0.,sin(x*23.+sin(uT*.25)*1.7)),10.)+pow(max(0.,sin(x*13.-uT*.17+1.3)),14.)*.8;
      c+=vec3(.35,.6,.8)*r*vUv.y*vUv.y*.55;
      float k=texture2D(tC,vUv*vec2(2.6,1.1)+vec2(uT*.012,uT*.02)).r*texture2D(tC,vUv*vec2(2.1,.9)-vec2(uT*.017,uT*.01)).r;
      c+=vec3(.2,.45,.6)*k*smoothstep(.35,1.,vUv.y)*.9;c*=1.-uDark*.45;gl_FragColor=vec4(c,1.);}`,
  });
  const back = add(troot, new T.PlaneGeometry(Wt, Ht + 0.02), waterMat, 0, (TK.yb + TK.yt) / 2, TK.zb);
  const sideMat = waterMat.clone(); sideMat.uniforms = { uT, tC: { value: caus }, uDark: { value: 1 } };
  [-1, 1].forEach(s => { const m = add(troot, new T.PlaneGeometry(TK.zf - TK.zb, Ht + 0.02), sideMat, s * (Wt / 2 - 0.004), (TK.yb + TK.yt) / 2, (TK.zf + TK.zb) / 2); m.rotation.y = -s * Math.PI / 2; });
  const sandMat = new T.ShaderMaterial({
    uniforms: { uT, tC: { value: caus } },
    vertexShader: 'varying vec2 vUv;varying vec3 vP;void main(){vUv=uv;vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform float uT;uniform sampler2D tC;varying vec2 vUv;varying vec3 vP;
      void main(){vec2 p=vUv*vec2(3.2,1.6);float k=texture2D(tC,p+vec2(uT*.03,uT*.018)).r;float k2=texture2D(tC,p*1.3-vec2(uT*.02,-uT*.012)).r;
      float n=fract(sin(dot(floor(vUv*vec2(900.,450.)),vec2(12.9,78.2)))*43758.);
      vec3 sand=vec3(.62,.48,.28)*(.92+.12*n);vec3 c=sand*(.42+1.25*pow(min(k,k2)*1.6,1.6));
      c=mix(c,vec3(.03,.16,.34),.25+.45*(1.-vUv.y));gl_FragColor=vec4(c,1.);}`,
  });
  const sand = add(troot, new T.PlaneGeometry(Wt, TK.zf - TK.zb), sandMat, 0, sandY, (TK.zf + TK.zb) / 2); sand.rotation.x = -Math.PI / 2;
  add(troot, new T.PlaneGeometry(Wt, sandY - TK.yb + 0.01), new T.MeshBasicMaterial({ color: D3.ui('#7a6544') }), 0, (sandY + TK.yb) / 2, TK.zf - 0.004);
  const surfMat = new T.ShaderMaterial({
    uniforms: { uT, tC: { value: caus } }, side: T.DoubleSide,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform float uT;uniform sampler2D tC;varying vec2 vUv;void main(){float k=texture2D(tC,vUv*vec2(3.,1.5)+uT*.03).r;
      vec3 c=vec3(.25,.62,.95)*(.7+1.6*k*k);gl_FragColor=vec4(c,1.);}`,
  });
  const surf = add(troot, new T.PlaneGeometry(Wt, TK.zf - TK.zb), surfMat, 0, TK.yt - 0.003, (TK.zf + TK.zb) / 2); surf.rotation.x = Math.PI / 2;
  // light shafts
  const shaftMat = new T.ShaderMaterial({
    uniforms: { uT }, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform float uT;varying vec2 vUv;void main(){float w=smoothstep(.5,.0,abs(vUv.x-.5));float a=w*w*pow(vUv.y,1.6)*(.65+.35*sin(uT*.6+vUv.x*5.));
      gl_FragColor=vec4(vec3(.55,.8,1.)*a*.16,1.);}`,
  });
  const shafts = [];
  for (let i = 0; i < 6; i++) {
    const m = add(troot, new T.PlaneGeometry(0.22 + 0.1 * (i % 3), Ht * 1.05), shaftMat, -1.0 + i * 0.42, (TK.yb + TK.yt) / 2 + 0.03, -0.45 + (i % 2) * 0.35);
    m.rotation.z = 0.22 + (i % 3) * 0.05; m.userData.ph = i * 1.7; shafts.push(m);
  }

  // decor: castle, rock, weeds, coral, chest, pebbles, fish
  const stone = std('#8c8f96', { roughness: 0.92, flatShading: true }), roof = std('#b8483f', { roughness: 0.6, flatShading: true });
  const castle = new T.Group(); castle.position.set(-0.98, sandY, -0.38); troot.add(castle);
  add(castle, new T.BoxGeometry(0.36, 0.26, 0.2), stone, 0, 0.13, 0);
  add(castle, new T.BoxGeometry(0.1, 0.12, 0.02), std('#1c2230'), 0, 0.06, 0.1);
  [[-0.15, 0.48, 0.065], [0.16, 0.4, 0.055], [0.0, 0.6, 0.05]].forEach(([x, h, r]) => {
    add(castle, new T.CylinderGeometry(r, r * 1.08, h, 9), stone, x, h / 2, -0.02);
    add(castle, new T.ConeGeometry(r * 1.35, r * 2.2, 9), roof, x, h + r * 1.1, -0.02);
  });
  for (let i = 0; i < 7; i++) add(castle, new T.BoxGeometry(0.035, 0.04, 0.035), stone, -0.15 + i * 0.05, 0.28, 0.08);
  const rockGeo = new T.IcosahedronGeometry(1, 2); { const p = rockGeo.attributes.position; for (let i = 0; i < p.count; i++) { const x=p.getX(i),y=p.getY(i),z=p.getZ(i),k=.96+.08*Math.sin(x*9+y*6+z*11); p.setXYZ(i,x*k,y*k,z*k); } rockGeo.computeVertexNormals(); }
  const rock = add(troot, rockGeo, std('#3a3f47', { roughness: 0.95, flatShading: true }), 1.06, sandY + 0.18, -0.4); rock.scale.set(0.3, 0.42, 0.2);
  const weedMat = new T.ShaderMaterial({
    uniforms: { uT, uTurb }, side: T.DoubleSide,
    vertexShader: `uniform float uT,uTurb;attribute float ph;varying float vH;void main(){vec3 p=position;vH=uv.y;
      float s=sin(uT*1.1+ph+p.y*6.)*(.05+.12*uTurb)*vH*vH+sin(uT*2.3+ph*2.)*.012*vH;p.x+=s;p.z+=s*.3;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
    fragmentShader: 'varying float vH;void main(){vec3 c=mix(vec3(.02,.12,.06),vec3(.12,.5,.22),vH);gl_FragColor=vec4(c,1.);}',
  });
  [[-0.72, -0.45, 0.42], [-0.62, -0.5, 0.3], [-0.3, -0.52, 0.5], [0.42, -0.5, 0.36], [0.62, -0.48, 0.46], [0.8, -0.3, 0.3], [1.22, -0.2, 0.28], [-1.2, -0.15, 0.32]].forEach(([x, z, h], i) => {
    const g = new T.PlaneGeometry(0.05, h, 1, 10); g.translate(0, h / 2, 0);
    g.setAttribute('ph', new T.Float32BufferAttribute(new Array(g.attributes.position.count).fill(i * 1.37), 1));
    add(troot, g, weedMat, x, sandY, z).rotation.y = i * 0.7;
  });
  const coral = std('#ff7a3a', { roughness: 0.6, emissive: new T.Color('#5a1a00'), emissiveIntensity: 0.4 });
  [[-0.5, -0.2], [0.82, -0.1]].forEach(([x, z], k) => {
    const cg = new T.Group(); cg.position.set(x, sandY, z); troot.add(cg); const r = D3.rng(11 + k);
    for (let i = 0; i < 7; i++) { const h = 0.06 + r() * 0.09, m = add(cg, new T.CylinderGeometry(0.008, 0.013, h, 5), coral, (r() - 0.5) * 0.08, h / 2, (r() - 0.5) * 0.05); m.rotation.z = (r() - 0.5) * 1.1; m.rotation.x = (r() - 0.5) * 0.6; }
  });
  const chest = new T.Group(); chest.position.set(-1.12, sandY, 0.18); chest.rotation.y = 0.5; troot.add(chest);
  add(chest, new T.BoxGeometry(0.2, 0.11, 0.13), std('#6b4426', { roughness: 0.8 }), 0, 0.055, 0);
  add(chest, new T.CylinderGeometry(0.065, 0.065, 0.2, 10, 1, false, 0, Math.PI), std('#7a4e2c', { roughness: 0.8 }), 0, 0.11, 0).rotation.z = Math.PI / 2;
  add(chest, new T.BoxGeometry(0.205, 0.015, 0.135), std('#c9a14a', { metalness: 0.8, roughness: 0.35 }), 0, 0.1, 0);
  const peb = new T.InstancedMesh(new T.IcosahedronGeometry(0.018, 1), std('#ffffff', { roughness: 0.6 }), 40);
  { const r = D3.rng(21), m = new T.Matrix4(), cols = ['#d9d4c6', '#8f8a84', '#b9775a', '#6f8fb4', '#e3c873']; for (let i = 0; i < 40; i++) { const s = 0.5 + r(); m.makeScale(s, s * 0.6, s); m.setPosition((r() - 0.5) * Wt * 0.95, sandY + 0.004, TK.zb + 0.05 + r() * (TK.zf - TK.zb - 0.1)); peb.setMatrixAt(i, m); peb.setColorAt(i, new T.Color(cols[i % 5])); } }
  troot.add(peb);
  const fish = [];
  const fishGeo = new T.SphereGeometry(1, 14, 10), tailGeo = new T.ConeGeometry(0.55, 0.8, 4); tailGeo.rotateZ(Math.PI / 2);
  [['#f39a3c', 0.13, -0.42, 0.35], ['#e8553f', 0.11, -0.34, 0.62], ['#4f8fe8', 0.1, -0.48, 0.48], ['#f5cc3e', 0.09, -0.28, 0.75]].forEach(([c, L, z, y], i) => {
    const g = new T.Group(); troot.add(g);
    const m = std(c, { roughness: 0.38, emissive: new T.Color(c), emissiveIntensity: 0.18 });
    const body = add(g, fishGeo, m); body.scale.set(L, L * 0.55, L * 0.3);
    const tail = new T.Group(); tail.position.x = -L * 0.95; g.add(tail);
    const tm = add(tail, tailGeo, m, -L * 0.3); tm.scale.set(L, L * 0.9, L * 0.25);
    add(g, new T.SphereGeometry(L * 0.09, 8, 6), std('#101420'), L * 0.62, L * 0.12, L * 0.2);
    fish.push({ g, tail, L, z, y: WY(1 - y), x: lerp(-0.9, 0.9, (i * 0.37) % 1), d: i % 2 ? -1 : 1, s: 0.08 + 0.03 * i, ph: i * 2.1, turn: 0 });
  });

  // pegs, nozzles
  const pegXs = [0.32, 0.5, 0.68].map(f => AR * f), pegTopY = WY(S.PEG_TOP);
  const pegMat = new T.MeshStandardMaterial({ color: new T.Color('#e6f6ff'), transparent: true, opacity: 0.38, roughness: 0.06, metalness: 0, emissive: new T.Color('#7fb8ff'), emissiveIntensity: 0.22, depthWrite: false });
  pegXs.forEach(x => {
    const h = pegTopY - sandY; add(troot, new T.CylinderGeometry(0.014, 0.016, h, 16), pegMat, WX(x), sandY + h / 2, 0);
    add(troot, new T.SphereGeometry(0.014, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), pegMat, WX(x), pegTopY, 0);
    add(troot, new T.CylinderGeometry(0.045, 0.05, 0.012, 20), std('#cfe6f5', { roughness: 0.2, transparent: true, opacity: 0.6 }), WX(x), sandY + 0.006, 0);
  });
  const nozX = [AR * 0.1, AR * 0.9];
  const jetMat = new T.ShaderMaterial({
    uniforms: { uT, uE: { value: 0 } }, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform float uT,uE;varying vec2 vUv;void main(){float n=sin(vUv.y*40.-uT*30.+sin(vUv.x*20.)*2.)*.5+.5;
      float a=uE*(1.-vUv.y)*smoothstep(0.,.25,vUv.y)*(.5+.5*n)*smoothstep(.5,.15,abs(vUv.x-.5));gl_FragColor=vec4(vec3(.7,.9,1.)*a*1.4,1.);}`,
  });
  const jets = nozX.map((x, i) => {
    add(troot, new T.CylinderGeometry(0.05, 0.06, 0.02, 20), std('#2b2f3a', { roughness: 0.4, metalness: 0.4 }), WX(x), sandY + 0.01, 0);
    const g = new T.ConeGeometry(0.16, 0.75, 20, 1, true); g.translate(0, -0.375, 0); g.rotateZ(Math.PI);
    const m = jetMat.clone(); m.uniforms = { uT, uE: { value: 0 } };
    const mesh = add(troot, g, m, WX(x), sandY + 0.01, 0); mesh.rotation.z = (i ? 1 : -1) * (Math.PI / 2 - S.JA) * 0.92;
    return mesh;
  });

  // rings and bubbles (instanced)
  const RING_COL = ['#ec4b40', '#f3c52f', '#3b7fe6', '#3cb46d', '#f0f3f7'];
  const NR = 24;
  const ringGeo = new T.TorusGeometry((S.R - S.TH / 2) * Ht, (S.TH / 2) * Ht, 12, 36);
  const ringMesh = new T.InstancedMesh(ringGeo, new T.MeshStandardMaterial({ roughness: 0.26, metalness: 0, emissive: new T.Color('#ffffff'), emissiveIntensity: 0.05 }), NR);
  ringMesh.frustumCulled = false; troot.add(ringMesh);
  for (let i = 0; i < NR; i++) ringMesh.setColorAt(i, new T.Color(RING_COL[i % 5]));
  const NB = 420;
  const bubMat = new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    vertexShader: `varying float vF;void main(){vec4 w=modelMatrix*instanceMatrix*vec4(position,1.);vec3 n=normalize(mat3(modelMatrix*instanceMatrix)*normal);
      vF=1.-abs(dot(n,normalize(cameraPosition-w.xyz)));gl_Position=projectionMatrix*viewMatrix*w;}`,
    fragmentShader: 'varying float vF;void main(){gl_FragColor=vec4(vec3(.75,.92,1.)*(.12+pow(vF,2.5)*1.3),1.);}',
  });
  const bubMesh = new T.InstancedMesh(new T.IcosahedronGeometry(1, 2), bubMat, NB); bubMesh.frustumCulled = false; bubMesh.count = 0; troot.add(bubMesh);

  // ---------- physics (deterministic per seed)
  const sim = { rings: [], pegs: pegXs.map(x => ({ x, n: 0 })), pulses: [], bubbles: [], t: 0, rng: Math.random, seed: 1, script: null };
  function reset(seed) {
    sim.seed = seed; sim.rng = D3.rng(seed * 9973 + 17); sim.t = 0; sim.pulses = []; sim.bubbles = []; sim.script = null;
    sim.pegs.forEach(p => (p.n = 0)); sim.rings = [];
    const r = sim.rng;
    for (let i = 0; i < NR; i++) {
      let x, tries = 0;
      do { x = S.R + r() * (AR - 2 * S.R); tries++; } while (tries < 30 && sim.pegs.some(p => Math.abs(p.x - x) < S.R * 1.3));
      sim.rings.push({ x, y: S.FLOOR - S.TH * 0.5 - (r() < 0.3 ? S.TH : 0), z: (r() - 0.5) * 0.56, vx: 0, vy: 0, vz: 0, p: (r() - 0.5) * 0.3, wp: 0, r: (r() - 0.5) * 0.25, wr: 0, yaw: r() * 6.28, wy: 0, st: 2, peg: -1, slot: 0, c: i % 5 });
    }
    count();
  }
  function count() { const n = sim.rings.filter(r => r.st === 1).length; if (n !== sim.lastCount) { sim.lastCount = n; D3.emit('ow:count', n); } return n; }
  function press(side, str, dur) {
    const list = side == null ? [0, 1] : [side];
    for (const i of list) sim.pulses.push({ x: nozX[i], dir: i ? -1 : 1, t0: sim.t, dur: dur || 0.5, A: (str || S.STR) * (1 + (sim.rng() - 0.5) * 0.16) });
    btn.userData.press = 1;
  }
  function step() {
    const DT = S.DT, r = sim.rng; sim.t += DT;
    let turb = 0;
    for (const pl of sim.pulses) { const age = sim.t - pl.t0; if (age < 4) turb += pl.A * 0.05 * Math.exp(-age / 1.4); }
    sim.turb = turb;
    if (sim.script) for (const ev of sim.script.ev) if (!ev.done && sim.t >= ev.t) { ev.done = true; press(null, S.STR, ev.d); }
    for (const rg of sim.rings) {
      if (rg.st === 1) { const p = sim.pegs[rg.peg], ty = S.FLOOR - S.TH * (rg.slot + 0.55); rg.x += (p.x - rg.x) * Math.min(1, DT * 12); rg.z += (0 - rg.z) * Math.min(1, DT * 12); rg.y = Math.min(ty, rg.y + DT * 0.34); rg.p *= 1 - DT * 5; rg.r *= 1 - DT * 5; continue; }
      let ax = 0, ay = S.G, az = 0, up = 0; const h = S.FLOOR - rg.y;
      for (const pl of sim.pulses) {
        const age = sim.t - pl.t0; if (age < 0 || age > pl.dur + 0.4) continue;
        const e = age < pl.dur ? Math.min(1, age / (pl.dur * 0.25)) : Math.exp(-(age - pl.dur) / 0.12);
        const ux = pl.dir * Math.cos(S.JA), uy = -Math.sin(S.JA), rx = rg.x - pl.x, ry = rg.y - S.FLOOR, a = rx * ux + ry * uy, dd = rx * -uy + ry * ux;
        if (a > -0.06) {
          const wd = 0.07 + 0.42 * Math.max(0, a), f = pl.A * e * Math.exp(-((dd / wd) ** 2) - (rg.z / (wd * 1.6 + 0.08)) ** 2 * 0.5) * Math.exp(-Math.max(0, a) / 1.5);
          ax += f * ux + Math.sign(dd) * f * 0.18 * -uy; ay += f * uy; up += -f * uy; az += -rg.z * f * 0.9 + (r() - 0.5) * f * 0.25;
          if (f > 0.5) { rg.wp += (r() - 0.5) * f * DT * 22; rg.wr += (r() - 0.5) * f * DT * 7; rg.wy += (r() - 0.5) * f * DT * 12; }
        }
        if (h < 0.14) { const f2 = pl.A * 0.34 * e * Math.exp(-(((rg.x - pl.x) / (0.42 * AR)) ** 2)); ay -= f2; ax += pl.dir * f2 * 0.25; up += f2; if (f2 > 0.4) rg.wp += (r() - 0.5) * f2 * DT * 20; }
      }
      if (turb > 0) { ax += turb * Math.sin(rg.y * 9 + sim.t * 1.7 + rg.yaw) * 2.2; ay += turb * Math.cos(rg.x * 7 + sim.t * 1.3 + rg.yaw) * 1.2; az += turb * Math.sin(rg.x * 5 + sim.t * 1.1) * 0.5; }
      ay -= up;
      if (rg.st === 2) { if (up > S.G * 1.3) rg.st = 0; else { rg.vx *= 1 - DT * 8; rg.vy = 0; rg.vz *= 1 - DT * 8; rg.p *= 1 - DT * 6; rg.r *= 1 - DT * 6; rg.x += rg.vx * DT; rg.z += rg.vz * DT; continue; } }
      rg.vx += ax * DT; rg.vy += ay * DT; rg.vz += az * DT;
      const dmp = Math.exp(-S.KD * DT); rg.vx *= dmp; rg.vy *= dmp; rg.vz *= dmp;
      const py = rg.y; rg.x += rg.vx * DT; rg.y += rg.vy * DT; rg.z += rg.vz * DT;
      rg.wp *= Math.exp(-1.1 * DT); rg.wr *= Math.exp(-1.6 * DT); rg.wy *= Math.exp(-0.8 * DT);
      rg.wp += -0.9 * Math.sin(2 * rg.p) * DT; rg.wr += -1.4 * rg.r * DT; rg.p += rg.wp * DT; rg.r += rg.wr * DT; rg.yaw += rg.wy * DT;
      if (rg.x < S.R) { rg.x = S.R; rg.vx = Math.abs(rg.vx) * 0.4; } if (rg.x > AR - S.R) { rg.x = AR - S.R; rg.vx = -Math.abs(rg.vx) * 0.4; }
      if (rg.y < S.R * 0.7) { rg.y = S.R * 0.7; rg.vy = Math.abs(rg.vy) * 0.3; }
      if (Math.abs(rg.z) > 0.3) { rg.z = Math.sign(rg.z) * 0.3; rg.vz *= -0.3; }
      for (let i = 0; i < sim.pegs.length; i++) {
        const pg = sim.pegs[i], dx = rg.x - pg.x;
        if (Math.abs(dx) >= S.R * 1.02 || rg.y <= S.PEG_TOP || Math.abs(rg.z) > S.R * Ht * 0.9) continue;
        const flat = Math.abs(Math.cos(rg.p)) > S.CF && Math.abs(rg.r) < 0.55;
        if (py <= S.PEG_TOP && rg.y > S.PEG_TOP && Math.abs(dx) < S.R * S.CW && Math.abs(rg.z) < 0.06 && flat && rg.vy > 0) { rg.st = 1; rg.peg = i; rg.slot = pg.n++; rg.vx = rg.vy = rg.vz = 0; count(); D3.emit('ow:catch', i); break; }
        const s = Math.sign(dx) || 1; rg.x = pg.x + s * S.R * 1.02; rg.vx = s * Math.max(Math.abs(rg.vx) * 0.5, 0.05); rg.wp += (r() - 0.5) * 2;
      }
      if (rg.y > S.FLOOR - S.TH * 0.5) { rg.y = S.FLOOR - S.TH * 0.5; rg.vy = 0; rg.st = 2; }
    }
    const R = sim.rings;
    for (let i = 0; i < R.length; i++) {
      const a = R[i]; if (a.st === 1) continue;
      for (let j = i + 1; j < R.length; j++) {
        const b = R[j]; if (b.st === 1) continue;
        const dx = b.x - a.x, dy = b.y - a.y, dz = (b.z - a.z) / Ht, md = S.R * 1.25, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= md * md || d2 === 0) continue;
        const d = Math.sqrt(d2), o = (md - d) * 0.25, nx = dx / d, ny = dy / d, nz = dz / d;
        a.x -= nx * o; b.x += nx * o; a.z -= nz * o * Ht; b.z += nz * o * Ht;
        if (a.st !== 2) a.y -= ny * o; if (b.st !== 2) b.y += ny * o;
      }
    }
    for (const pl of sim.pulses) {
      const age = sim.t - pl.t0;
      if (age >= 0 && age < pl.dur && sim.bubbles.length < NB - 4) for (let k = 0; k < 3; k++) sim.bubbles.push({ x: pl.x + (r() - 0.5) * 0.06, y: S.FLOOR - 0.01, z: (r() - 0.5) * 0.08, vx: pl.dir * (0.25 + r() * 0.3), vy: -(0.35 + r() * 0.4), r: 0.004 + r() * 0.008, ph: r() * 6 });
    }
    for (const b of sim.bubbles) { b.y += b.vy * DT; b.x += (b.vx + Math.sin(sim.t * 4 + b.ph) * 0.03) * DT; b.vx *= 1 - DT * 0.8; b.z += Math.sin(sim.t * 3 + b.ph) * 0.02 * DT; }
    sim.bubbles = sim.bubbles.filter(b => b.y > 0.02);
    sim.pulses = sim.pulses.filter(pl => sim.t - pl.t0 < 4.2);
  }

  // ---------- modes: attract (overview), manual (PRESS), timeline (60 s classic), run (same rule, new seed)
  const CLASSIC = [{ t: 8, d: 0.5 }, { t: 28, d: 0.32 }];
  const ow = (D3.ow = { sim, mode: 'attract', speed: 1, playing: false, tl: 0, runs: [], seed: 1 });
  ow.reset = () => { reset(ow.seed); ow.tl = 0; D3.emit('ow:time', 0); D3.emit('ow:count', 0); };
  let nextAuto = 2, acc = 0;
  ow.press = () => { if (ow.mode === 'timeline') return; if (ow.mode === 'attract' || ow.mode === 'run') ow.mode = 'manual'; press(null); D3.emit('ow:press'); };
  ow.setMode = m => {
    ow.mode = m; ow.playing = false; ow.speed = 1;
    if (m !== 'timeline') sim.script = null;
    if (m === 'timeline') ow.seek(0);
    if (m === 'attract') nextAuto = sim.t + 1.5;
  };
  ow.seek = t => {
    t = clamp(t, 0, 60);
    if (t < sim.t - 1e-6 || !sim.script || sim.script.kind !== 'tl') { reset(3); sim.script = { kind: 'tl', ev: CLASSIC.map(e => Object.assign({}, e)), end: 60 }; }
    while (sim.t < t - S.DT * 0.5) step();
    ow.tl = sim.t; D3.emit('ow:time', ow.tl);
  };
  ow.play = () => { if (ow.mode !== 'timeline') ow.setMode('timeline'); if (ow.tl >= 59.9) ow.seek(0); ow.playing = true; D3.emit('ow:play', true); };
  ow.pause = () => { ow.playing = false; D3.emit('ow:play', false); };
  ow.run = () => {
    ow.mode = 'run'; ow.seed = (ow.seed % 97) + 1 + Math.floor(Math.random() * 7);
    reset(ow.seed); sim.script = { kind: 'run', ev: [{ t: 0.4, d: 0.5 }, { t: 6.5, d: 0.32 }], end: 14, fin: false };
    ow.speed = D3.reduced ? 4 : 1.6; D3.emit('ow:runstart', ow.seed);
  };
  ow.revealK = () => (ow.mode === 'timeline' ? smooth(56, 59, ow.tl) : 0);
  reset(1);

  // ---------- timeline ribbon (HUD: rides with the camera, tilts with the pointer)
  const SEG = [[0, 8, '정지', '#3c3d4a'], [8, 16, '첫 물살', '#f16459'], [16, 28, '부유', '#4e7d8c'], [28, 36, '두 번째 물살', '#f16459'], [36, 49, '안착', '#7768a2'], [49, 56, '고요', '#3c3d4a'], [56, 60, '공개', '#c89943']];
  const RW = 2.5, RH = 0.07, RD = 3.2, RY = -0.27;
  const hudRoot = new T.Group(); hud.add(hudRoot);
  const ribbon = new T.Group(); ribbon.position.set(0, RY, -RD); hudRoot.add(ribbon);
  const bend = x => 0.18 * (x / (RW / 2)) ** 2;
  const segGeo = (t0, t1, h, z0 = 0) => { const n = Math.max(2, Math.round((t1 - t0) / 1.5)), g = new T.PlaneGeometry(1, h, n, 1), p = g.attributes.position; for (let i = 0; i < p.count; i++) { const u = (p.getX(i) + 0.5), x = lerp(t0, t1, u) / 60 * RW - RW / 2; p.setXYZ(i, x, p.getY(i), bend(x) + z0); } g.computeVertexNormals(); return g; };
  const segMeshes = SEG.map(([a, b, , c]) => { const m = new T.Mesh(segGeo(a + 0.12, b - 0.12, RH), new T.MeshBasicMaterial({ color: D3.ui(c), transparent: true, opacity: 0.95 })); ribbon.add(m); return m; });
  const prog = new T.Mesh(segGeo(0, 60, RH * 0.22, 0.001), new T.MeshBasicMaterial({ color: D3.ui('#f8f7f5'), transparent: true, opacity: 0.9 })); prog.position.y = -RH * 0.88; ribbon.add(prog);
  const track = new T.Mesh(segGeo(0, 60, RH * 0.22, 0), new T.MeshBasicMaterial({ color: D3.ui('#4a4b56') })); track.position.y = -RH * 0.88; ribbon.add(track);
  const head = new T.Mesh(new T.PlaneGeometry(0.012, RH * 2.6), new T.MeshBasicMaterial({ color: new T.Color(6, 5.2, 4.2) })); ribbon.add(head);
  const headDot = new T.Mesh(new T.CircleGeometry(0.022, 24), new T.MeshBasicMaterial({ color: new T.Color(6, 5.2, 4.2) })); ribbon.add(headDot);
  const hit = new T.Mesh(segGeo(0, 60, RH * 3.5), new T.MeshBasicMaterial({ visible: false })); ribbon.add(hit);
  [8, 28].forEach(t => { const x = t / 60 * RW - RW / 2, m = new T.Mesh(new T.CircleGeometry(0.016, 20), new T.MeshBasicMaterial({ color: new T.Color(4, 1.4, 1.1) })); m.position.set(x, RH * 0.9, bend(x) + 0.002); ribbon.add(m); });
  ribbon.children.forEach(m => { m.material.transparent = true; m.material.depthWrite = false; });
  ow.ribbonX = t => { const x = t / 60 * RW - RW / 2; return new T.Vector3(x, 0, bend(x)); };
  ow.ribbonWorld = (t, dy = 0) => { const v = ow.ribbonX(t); v.y += dy; return ribbon.localToWorld(v); };
  ow.ribbonHit = e => { const h = D3.ray(e, [hit], false)[0]; if (!h) return null; const l = ribbon.worldToLocal(h.point.clone()); return clamp((l.x + RW / 2) / RW * 60, 0, 60); };
  let hudOn = 0; ow.showRibbon = on => (ow.ribbonOn = on);
  D3.addLayer(hud, { order: 90, hud: true, visible: () => ow.ribbonOn && hudOn > 0.01 });

  // ---------- render sync
  const m4 = new T.Matrix4(), q = new T.Quaternion(), qx = new T.Quaternion(), qy = new T.Quaternion(), qz = new T.Quaternion(), qb = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), Math.PI / 2);
  const ax = new T.Vector3(1, 0, 0), ay = new T.Vector3(0, 1, 0), az = new T.Vector3(0, 0, 1), one = new T.Vector3(1, 1, 1), p3 = new T.Vector3();
  function sync(time) {
    sim.rings.forEach((rg, i) => {
      qz.setFromAxisAngle(az, rg.r); qy.setFromAxisAngle(ay, rg.yaw); qx.setFromAxisAngle(ax, rg.p);
      q.copy(qz).multiply(qy).multiply(qx).multiply(qb);
      p3.set(WX(rg.x), WY(rg.y), rg.z); m4.compose(p3, q, one); ringMesh.setMatrixAt(i, m4);
    });
    ringMesh.instanceMatrix.needsUpdate = true;
    const nb = Math.min(NB, sim.bubbles.length);
    for (let i = 0; i < nb; i++) { const b = sim.bubbles[i], s = b.r * Ht; m4.makeScale(s, s, s); m4.setPosition(WX(b.x), WY(b.y), b.z); bubMesh.setMatrixAt(i, m4); }
    bubMesh.count = nb; bubMesh.instanceMatrix.needsUpdate = true;
    jets.forEach((j, i) => { let e = 0; for (const pl of sim.pulses) { if (pl.x !== nozX[i]) continue; const age = sim.t - pl.t0; if (age >= 0) e = Math.max(e, age < pl.dur ? Math.min(1, age / 0.08) : Math.exp(-(age - pl.dur) / 0.15)); } j.material.uniforms.uE.value = e; j.visible = e > 0.01; });
    uTurb.value = clamp((sim.turb || 0) * 2, 0, 1);
    if (!D3.reduced) fish.forEach(f => {
      f.x += f.d * f.s * (1 / 60) * (1 + uTurb.value);
      if (f.x > 1.0) f.d = -1; if (f.x < -1.0) f.d = 1;
      f.turn = damp(f.turn, f.d > 0 ? 0 : Math.PI, 3, 1 / 60);
      f.g.position.set(f.x, f.y + Math.sin(time * 0.6 + f.ph) * 0.03, f.z + Math.sin(time * 0.3 + f.ph) * 0.05);
      f.g.rotation.y = f.turn; f.tail.rotation.y = Math.sin(time * 9 + f.ph) * 0.35;
    });
    shafts.forEach(s => (s.position.x += Math.sin(time * 0.2 + s.userData.ph) * 0.0004));
    btn.userData.press = damp(btn.userData.press, 0, 9, 1 / 60); btnCyl.position.z = 0.04 - btn.userData.press * 0.05;
  }

  const busyRun = () => sim.pulses.length > 0 || sim.rings.some(r => r.st === 0 && r.vy * r.vy + r.vx * r.vx > 1e-5);
  station.update = (dt, time) => {
    if (D3.reduced) time = 0;
    uT.value = time;
    const active = station.visible !== false;
    if (!active && !ow.playing) return;
    if (ow.mode === 'timeline') {
      if (ow.playing) {
        const target = Math.min(60, ow.tl + dt * ow.speed);
        while (sim.t < target - S.DT * 0.5) step();
        ow.tl = target; D3.emit('ow:time', ow.tl);
        if (ow.tl >= 60) ow.pause();
      }
    } else {
      acc += dt * ow.speed; let n = 0;
      while (acc >= S.DT && n < 24) { step(); acc -= S.DT; n++; }
      if (acc > S.DT * 4) acc = 0;
      if (ow.mode === 'attract' && !D3.reduced && sim.t > nextAuto) { const s = sim.rng(); press(s < 0.4 ? 0 : s < 0.8 ? 1 : null, S.STR * (0.75 + sim.rng() * 0.3)); nextAuto = sim.t + 3 + sim.rng() * 3.5; }
      if (ow.mode === 'run' && sim.script && !sim.script.fin && sim.t >= sim.script.end && !busyRun()) { sim.script.fin = true; const n2 = count(); ow.runs.push({ seed: ow.seed, n: n2 }); D3.emit('ow:runend', ow.seed, n2); ow.speed = 1; }
      if (ow.mode === 'run' && sim.script && !sim.script.fin && sim.t > sim.script.end + 12) { sim.script.fin = true; const n2 = count(); ow.runs.push({ seed: ow.seed, n: n2 }); D3.emit('ow:runend', ow.seed, n2); ow.speed = 1; }
    }
    sync(time);
  };
  station.late = (dt, time) => {
    hudOn = damp(hudOn, ow.ribbonOn ? 1 : 0, 6, dt);
    hudRoot.position.copy(D3.cam.position); hudRoot.quaternion.copy(D3.cam.quaternion);
    ribbon.rotation.x = -0.18 + (D3.reduced ? 0 : D3.ptr.sy * 0.08); ribbon.rotation.y = D3.reduced ? 0 : D3.ptr.sx * 0.1;
    ribbon.position.y = RY - (1 - hudOn) * 0.25;
    ribbon.position.x = D3.cam.projectionMatrix.elements[8] * RD / D3.cam.projectionMatrix.elements[0];
    ribbon.children.forEach(m => { if (m !== hit) m.material.opacity = (m.userData.op ?? 0.95) * hudOn; });
    const t = ow.tl, x = t / 60 * RW - RW / 2; head.position.set(x, 0, bend(x) + 0.003); headDot.position.set(x, RH * 1.45, bend(x) + 0.004);
    prog.visible = t > 0.01;
    const pp = prog.geometry.attributes.position; { const n = pp.count / 2; for (let i = 0; i < n; i++) { const u = i / (n - 1), xx = lerp(0, t, u) / 60 * RW - RW / 2; pp.setX(i, xx); pp.setZ(i, bend(xx) + 0.001); pp.setX(i + n, xx); pp.setZ(i + n, bend(xx) + 0.001); } pp.needsUpdate = true; }
    hudRoot.updateMatrixWorld(true);
  };
  D3.stations.push(station);
  D3.addLayer(tank, { order: 10, station });
  D3.addLayer(casing, { order: 11, station });

  // ---------- shots
  const P = (x, y, z) => [O.x + x, O.y + y, O.z + z];
  D3.shots['ow.hero'] = { pos: P(0.25, 2.55, 6.2), tgt: P(0.1, 2.3, 0), fov: 30, sx: 0.38, sy: 0.02 };
  D3.shots['ow.tl'] = { pos: P(0, 2.45, 6.5), tgt: P(0, 2.32, 0), fov: 30, sx: 0.34, sy: 0.23 };
  D3.shots['ow.reveal'] = { pos: P(0, 2.1, 10.2), tgt: P(0, 1.95, 0), fov: 30, sx: 0, sy: 0.16 };
  D3.shots['ow.run'] = { pos: P(-0.1, 2.5, 9), tgt: P(-0.1, 2.3, 0), fov: 30, sx: 0.5, sy: 0.12 };
  D3.shots['ow.tlDyn'] = () => { const k = ow.revealK(), a = D3.shots['ow.tl'], b = D3.shots['ow.reveal'], m = (u, v) => u.map((x, i) => lerp(x, v[i], k)); return { pos: m(a.pos, b.pos), tgt: m(a.tgt, b.tgt), fov: 30, sx: lerp(a.sx,.34,k), sy: lerp(a.sy, b.sy, k) }; };
  ow.anchor = { tank: new T.Vector3(O.x, O.y + 2.95, O.z + 0.7), button: new T.Vector3(O.x, O.y + 0.76, O.z + 0.9), top: new T.Vector3(O.x, O.y + 4.05, O.z) };
  ow.hitTargets = [btnCyl, back, sand, ...pegXs.map(() => null)].filter(Boolean);
  ow.pickables = [lower, btnCyl, back, sand];
})();
