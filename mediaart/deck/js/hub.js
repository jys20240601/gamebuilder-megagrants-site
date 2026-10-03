/* hub.js — the dark gallery the three works stand in: floor with light pools, drifting dust. */
(function () {
  'use strict';
  const T = THREE, D3 = window.D3;
  D3.POS = { ow: new T.Vector3(-12, 0, 0), pt: new T.Vector3(0, 0, 0), mj: new T.Vector3(12.5, 0, 0) };
  const scene = new T.Scene();
  D3.hub = { scene };

  const pools = [
    [D3.POS.ow.x, 1.2, 4.2, '#7a4a30', 0.55],
    [D3.POS.pt.x, 2.5, 8.0, '#8a6430', 0.35],
    [D3.POS.mj.x, 0.9, 6.5, '#2c3c78', 0.6],
  ];
  const floorMat = new T.ShaderMaterial({
    uniforms: {
      uBase: { value: D3.ui('#141519') }, uBg: { value: D3.bg }, uLine: { value: D3.ui('#24252d') },
      uP: { value: pools.map(p => new T.Vector4(p[0], p[1], p[2], p[4])) },
      uC: { value: pools.map(p => D3.ui(p[3])) },
    },
    vertexShader: 'varying vec3 vW;void main(){vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}',
    fragmentShader: `uniform vec3 uBase,uBg,uLine;uniform vec4 uP[3];uniform vec3 uC[3];varying vec3 vW;
      void main(){vec3 c=uBase;
        for(int i=0;i<3;i++){vec2 d=(vW.xz-vec2(uP[i].x,uP[i].y))/uP[i].z;c+=uC[i]*uP[i].w*exp(-dot(d,d)*1.6);}
        vec2 g=abs(fract(vW.xz/2.-.5)-.5)/fwidth(vW.xz/2.);float l=1.-min(min(g.x,g.y),1.);
        float near=exp(-pow(length(vW.xz-vec2(0.,1.))/26.,2.));c=mix(c,uLine,l*.55*near);
        float f=smoothstep(18.,70.,length(vW-cameraPosition));c=mix(c,uBg,f);
        gl_FragColor=vec4(c,1.);}`,
  });
  const floor = new T.Mesh(new T.PlaneGeometry(300, 300), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.002;
  scene.add(floor);

  // dust motes
  const N = D3.reduced ? 300 : 900, pos = new Float32Array(N * 3), seed = new Float32Array(N);
  const r = D3.rng(4);
  for (let i = 0; i < N; i++) { pos[i * 3] = (r() - 0.5) * 64; pos[i * 3 + 1] = 0.2 + r() * 13; pos[i * 3 + 2] = (r() - 0.5) * 40; seed[i] = r(); }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('seed', new T.BufferAttribute(seed, 1));
  const dustMat = new T.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uPx: { value: 1 } },
    vertexShader: `attribute float seed;uniform float uT,uPx;varying float vA;
      void main(){vec3 p=position;float t=uT*(.05+.08*seed);p.x+=sin(t+seed*40.)*1.2;p.y+=sin(t*.7+seed*17.)*.8;p.z+=cos(t*.9+seed*9.)*1.;
      vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=uPx*(1.2+2.2*seed)*(18./-mv.z);
      vA=(.25+.75*fract(seed*7.3))*smoothstep(60.,8.,-mv.z)*smoothstep(.3,3.,-mv.z)*(.55+.45*sin(uT*(.6+seed)+seed*30.));}`,
    fragmentShader: 'varying float vA;void main(){vec2 d=gl_PointCoord-.5;float a=smoothstep(.5,0.,length(d));gl_FragColor=vec4(vec3(1.,.86,.66)*.9,a*vA*.55);}',
    transparent: true, depthWrite: false, blending: T.AdditiveBlending,
  });
  const dust = new T.Points(g, dustMat); dust.frustumCulled = false; scene.add(dust);

  D3.addLayer(scene, { order: 0 });
  D3.stations.push({
    name: 'hub',
    update(dt, t) { dustMat.uniforms.uT.value = D3.reduced ? 0 : t; dustMat.uniforms.uPx.value = D3.view.dpr * D3.view.h / 900; },
  });
})();
