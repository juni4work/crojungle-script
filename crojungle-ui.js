import * as THREE from 'three';

(() => {
  // ===== CONFIG =====
  const NAV_ID = 'navBar';
  const LINK_SELECTOR = '.glass-target';
  const ACTIVE_SELECTOR = '.w--current';

  const PADX = 12, PADY = 6;
  const SLIDE_MS = 320, RETURN_MS = 140;
  const ease = t => 1 - Math.pow(1 - t, 3);

  // Lens (you can change these defaults; panel will update them too)
  const LENS = {
    corner: 22.0,    // px (clamped to height/2)
    falloff: 36.0,   // px
    refract: 24.0,   // px (18–32 good range)
    dispersion: 0.05,
    edgeSoft: 1.5,
    rim: 0.8,
    rimWidth: 2.0,   // px
    vignette: 0.12,
    exposure: 1.05
  };

  // ===== DOM =====
  const nav = document.getElementById(NAV_ID);
  const pill = document.getElementById('glass-pill');
  const canvas = document.getElementById('glass-canvas');
  if (!nav || !pill || !canvas) { console.warn('[pill] missing #navBar/#glass-pill/#glass-canvas'); return; }
  if (getComputedStyle(nav).position === 'static') nav.style.position = 'relative';
  pill.style.pointerEvents = 'none';
  pill.style.overflow = 'hidden';
  pill.style.willChange = 'transform,width,height';
  pill.style.opacity = '1';

  // ===== THREE =====
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = LENS.exposure;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const uniforms = {
    uBG:        { value: new THREE.Texture() },
    uHasBG:     { value: 0.0 }, // 0=fallback, 1=use snapshot
    uRes:       { value: new THREE.Vector2(200, 80) },
    uCorner:    { value: LENS.corner },
    uFalloff:   { value: LENS.falloff },
    uRefract:   { value: LENS.refract },
    uDisp:      { value: LENS.dispersion },
    uEdgeSoft:  { value: LENS.edgeSoft },
    uRim:       { value: LENS.rim },
    uRimW:      { value: LENS.rimWidth },
    uVig:       { value: LENS.vignette }
  };

  const vert = /* glsl */`
    varying vec2 vUv;
    void main(){ vUv=uv; gl_Position=vec4(position,1.0); }
  `;

  const frag = /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uBG;
    uniform float uHasBG;
    uniform vec2  uRes;
    uniform float uCorner, uFalloff, uRefract, uDisp, uEdgeSoft, uRim, uRimW, uVig;

    float sdRoundRect(vec2 p, vec2 b, float r){
      vec2 q = abs(p) - (b - vec2(r));
      return length(max(q,0.0)) - r;
    }
    float sdAt(vec2 p, vec2 b, float r){
      vec2 q = abs(p) - (b - vec2(r));
      return length(max(q,0.0)) - r;
    }
    vec2 grad(vec2 p, vec2 b, float r){
      float e=1.0;
      float dx=sdAt(p+vec2(e,0.0),b,r)-sdAt(p-vec2(e,0.0),b,r);
      float dy=sdAt(p+vec2(0.0,e),b,r)-sdAt(p-vec2(0.0,e),b,r);
      return normalize(vec2(dx,dy));
    }
    // CLAMPED sampling so we never read outside the texture
    vec3 refractRGB(vec2 baseUV, vec2 dirPx, vec2 res){
      vec2 px = dirPx / res;
      float d = uDisp;
      vec2 uvR = clamp(baseUV + px*(1.0 + d), vec2(0.001), vec2(0.999));
      vec2 uvG = clamp(baseUV + px*(1.0     ), vec2(0.001), vec2(0.999));
      vec2 uvB = clamp(baseUV + px*(1.0 - d ), vec2(0.001), vec2(0.999));
      float R = texture2D(uBG, uvR).r;
      float G = texture2D(uBG, uvG).g;
      float B = texture2D(uBG, uvB).b;
      return vec3(R,G,B);
    }
    void main(){
      vec2 halfRes = uRes * 0.5;
      vec2 p = (vUv - 0.5) * uRes;

      float sd = sdRoundRect(p, halfRes, uCorner);
      float mask = 1.0 - smoothstep(0.0, uEdgeSoft, sd);
      if(mask <= 0.001) discard;

      float edge = clamp(1.0 - (-sd / uFalloff), 0.0, 1.0);
      edge = pow(edge, 1.1);
      vec2 dir = -grad(p, halfRes, uCorner) * (edge * uRefract);

      vec3 col;
      if (uHasBG > 0.5) {
        col = refractRGB(vUv, dir, uRes);
      } else {
        vec3 top = vec3(0.96,0.98,1.00), bot = vec3(0.86,0.90,0.95);
        col = mix(bot, top, smoothstep(-halfRes.y, halfRes.y, -p.y));
        col *= 1.0 - 0.12 * smoothstep(0.5, 1.0, length(p / halfRes));
      }
      float rim = smoothstep(uRimW*1.5, 0.0, abs(sd)) * uRim;
      col += vec3(1.05,1.08,1.12) * rim;

      float vig = 1.0 - uVig * smoothstep(0.6, 1.0, length(p / halfRes));
      col *= vig;

      gl_FragColor = vec4(col, mask);
    }
  `;

  scene.add(new THREE.Mesh(
    new THREE.PlaneGeometry(2,2),
    new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, transparent: true })
  ));
  (function loop(){ renderer.render(scene, camera); requestAnimationFrame(loop); })();

  // ===== SNAPSHOT (no feedback; concurrency guard) =====
let snapping = false;
let lastSnapAt = 0;
function navBgColor() {
  // Use the computed background (fallback to your dark nav color)
  const c = getComputedStyle(nav).backgroundColor;
  return c && c !== 'rgba(0, 0, 0, 0)' ? c : '#0b1221';
}

async function snapshot(rect) {
  const h2c = window.html2canvas;
  uniforms.uCorner.value = Math.min(LENS.corner, rect.h * 0.5 - 1);

  // throttle snapshots (avoid flicker)
  const now = performance.now();
  if (!h2c || snapping || (now - lastSnapAt) < 180) { uniforms.uHasBG.value = 0.0; return; }
  snapping = true;

  const prevOpacity = pill.style.opacity;
  try {
    // hide visually but keep layout stable
    pill.style.opacity = '0';

    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const full = await h2c(nav, {
      backgroundColor: null,         // we’ll fill the crop manually
      useCORS: true,
      scale,
      logging: false,
      ignoreElements: el => el === pill || pill.contains(el)
    });

    const nr = nav.getBoundingClientRect();
    const sx = Math.max(0, Math.round(rect.x * (full.width  / nr.width)));
    const sy = Math.max(0, Math.round(rect.y * (full.height / nr.height)));
    const sw = Math.max(2, Math.round(rect.w * (full.width  / nr.width)));
    const sh = Math.max(2, Math.round(rect.h * (full.height / nr.height)));

    // Prefill crop with the nav background color to avoid “transparent black”
    const crop = document.createElement('canvas');
    crop.width = sw; crop.height = sh;
    const ctx = crop.getContext('2d');
    ctx.fillStyle = navBgColor();
    ctx.fillRect(0, 0, sw, sh);
    // Draw the snapshot on top (expanded by 1px to avoid edge seams)
    ctx.drawImage(full, sx - 1, sy - 1, sw + 2, sh + 2, -1, -1, sw + 2, sh + 2);

    const tex = new THREE.CanvasTexture(crop);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;

    uniforms.uBG.value?.dispose?.();
    uniforms.uBG.value = tex;
    uniforms.uRes.value.set(rect.w, rect.h);
    uniforms.uHasBG.value = 1.0;

    lastSnapAt = performance.now();
  } catch (e) {
    console.warn('[pill] snapshot failed; using fallback only:', e);
    uniforms.uHasBG.value = 0.0;
  } finally {
    pill.style.opacity = prevOpacity || '1';
    snapping = false;
  }
}
  // ===== MOVEMENT =====
  let last = { x:0, y:0, w:140, h:56 };
  let anim = 0, t0 = 0, from = { ...last }, to = { ...last }, backTimer = null;

  const rectFor = el => {
    const nr = nav.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x:r.left-nr.left-PADX, y:r.top-nr.top-PADY, w:r.width+2*PADX, h:r.height+2*PADY };
  };

  const apply = r => {
    pill.style.transform = `translate3d(${r.x}px,${r.y}px,0)`;
    pill.style.width  = r.w + 'px';
    pill.style.height = r.h + 'px';
    renderer.setSize(r.w, r.h, false);
    last = r;
  };

  function moveTo(el, immediate=false){
    if (!el) return;
    const target = rectFor(el);
    if (immediate){ to={...target}; from={...target}; apply(target); snapshot(target); return; }
    cancelAnimationFrame(anim); t0 = performance.now(); from={...last}; to={...target}; step(t0);
  }
  function step(ts){
    const t = Math.min(1, (ts - t0) / SLIDE_MS), k = ease(t);
    const r = { x:from.x+(to.x-from.x)*k, y:from.y+(to.y-from.y)*k,
                w:from.w+(to.w-from.w)*k, h:from.h+(to.h-from.h)*k };
    apply(r);
   if (t < 1) {
  anim = requestAnimationFrame(step);
} else {
  // slight delay so we don't reshoot if the user immediately moves again
  setTimeout(() => snapshot(r), 60);
}
  }

  // Wire up
  let links = Array.from(nav.querySelectorAll(LINK_SELECTOR));
  if (links.length === 0) links = Array.from(nav.querySelectorAll('a'));

  links.forEach(a => {
    a.addEventListener('mouseenter', () => { if (backTimer){ clearTimeout(backTimer); backTimer=null; } moveTo(a); });
    a.addEventListener('focus',      () => { if (backTimer){ clearTimeout(backTimer); backTimer=null; } moveTo(a); });
  });

  const initial = nav.querySelector(`${LINK_SELECTOR}${ACTIVE_SELECTOR}, ${ACTIVE_SELECTOR}`) || links[0];
  apply(last); uniforms.uHasBG.value = 0.0; // visible fallback immediately
  if (initial) moveTo(initial, true);

  nav.addEventListener('pointerleave', e => {
    if (nav.contains(e.relatedTarget)) return;
    const active = nav.querySelector(`${LINK_SELECTOR}${ACTIVE_SELECTOR}, ${ACTIVE_SELECTOR}`) || links[0];
    backTimer = setTimeout(() => { if (active) moveTo(active); }, RETURN_MS);
  });

  new ResizeObserver(() => { apply(last); snapshot(last); }).observe(nav);
  window.addEventListener('resize', () => { apply(last); snapshot(last); }, { passive: true });

  // ====== LIVE CONTROLS (press "g") – integrated, no globals needed ======
  (function devControls(){
    const css = `
      #glass-panel{position:fixed;top:16px;right:16px;z-index:99999;
        font:12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
        background:rgba(18,18,24,.92); color:#e6ecff; border:1px solid #2a2f3f;
        border-radius:10px; padding:10px 12px; width:260px; backdrop-filter:saturate(1.1) blur(6px);
        box-shadow:0 8px 24px rgba(0,0,0,.35); display:none }
      #glass-panel.show{display:block}
      #glass-panel h4{margin:0 0 8px; font-size:12px; letter-spacing:.04em; text-transform:uppercase; opacity:.8}
      .gp-row{display:grid; grid-template-columns:1fr 58px; gap:8px; margin:8px 0}
      .gp-row label{opacity:.8}
      .gp-row input[type=range]{width:100%}
      .gp-row input[type=number]{width:58px; background:#0f1322; border:1px solid #2a2f3f; color:#cfe0ff; border-radius:6px; padding:4px 6px}
      #gp-buttons{display:flex; gap:8px; margin-top:8px}
      #gp-buttons button{flex:1; background:#1b2339; border:1px solid #2a2f3f; color:#dfe8ff; padding:6px 8px; border-radius:8px; cursor:pointer}
      #gp-buttons button:hover{background:#232c45}
    `;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

    const wrap = document.createElement('div'); wrap.id = 'glass-panel';
    wrap.innerHTML = `
      <h4>Glass Pill Controls (press "g")</h4>
      <div class="gp-row"><label>Refraction</label><input id="gp-refract" type="range" min="6" max="60" step="0.5"><input id="gp-refract-n" type="number" step="0.5"></div>
      <div class="gp-row"><label>Dispersion</label><input id="gp-disp" type="range" min="0" max="0.15" step="0.005"><input id="gp-disp-n" type="number" step="0.005"></div>
      <div class="gp-row"><label>Corner (px)</label><input id="gp-corner" type="range" min="4" max="80" step="1"><input id="gp-corner-n" type="number" step="1"></div>
      <div class="gp-row"><label>Falloff (px)</label><input id="gp-falloff" type="range" min="8" max="80" step="1"><input id="gp-falloff-n" type="number" step="1"></div>
      <div class="gp-row"><label>Rim</label><input id="gp-rim" type="range" min="0" max="1.2" step="0.02"><input id="gp-rim-n" type="number" step="0.02"></div>
      <div class="gp-row"><label>Rim Width</label><input id="gp-rimw" type="range" min="0" max="6" step="0.1"><input id="gp-rimw-n" type="number" step="0.1"></div>
      <div class="gp-row"><label>Vignette</label><input id="gp-vig" type="range" min="0" max="0.5" step="0.01"><input id="gp-vig-n" type="number" step="0.01"></div>
      <div class="gp-row"><label>Exposure</label><input id="gp-exp" type="range" min="0.6" max="1.6" step="0.02"><input id="gp-exp-n" type="number" step="0.02"></div>
      <div id="gp-buttons">
        <button id="gp-resnap">Resnap</button>
        <button id="gp-copy">Copy JSON</button>
        <button id="gp-reset">Reset</button>
      </div>
    `;
    document.body.appendChild(wrap);

    // helper
    function bind(id, getVal, setVal, initial){
      const r = wrap.querySelector(`#${id}`), n = wrap.querySelector(`#${id}-n`);
      const apply = v => { r.value = v; n.value = v; setVal(+v); save(); };
      r.addEventListener('input', e => apply(e.target.value));
      n.addEventListener('input', e => apply(e.target.value));
      apply(initial);
      return v => apply(v);
    }
    let saveTimer;
    function save(){
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        localStorage.setItem('glassTweaks', JSON.stringify({
          corner: LENS.corner, falloff: LENS.falloff, refract: LENS.refract,
          dispersion: LENS.dispersion, rim: LENS.rim, rimWidth: LENS.rimWidth,
          vignette: LENS.vignette, exposure: renderer.toneMappingExposure
        }));
      }, 120);
    }
    // load saved
    try { const s = JSON.parse(localStorage.getItem('glassTweaks')||'null'); if (s) Object.assign(LENS, s); } catch {}

    const setRefract = bind('gp-refract', ()=>LENS.refract, v => { LENS.refract=v; uniforms.uRefract.value=v; }, LENS.refract);
    const setDisp    = bind('gp-disp',    ()=>LENS.dispersion, v => { LENS.dispersion=v; uniforms.uDisp.value=v; }, LENS.dispersion);
    const setCorner  = bind('gp-corner',  ()=>LENS.corner, v => { LENS.corner=v; uniforms.uCorner.value=Math.min(v, (last?.h||56)*0.5-1); }, LENS.corner);
    const setFalloff = bind('gp-falloff', ()=>LENS.falloff, v => { LENS.falloff=v; uniforms.uFalloff.value=v; }, LENS.falloff);
    const setRim     = bind('gp-rim',     ()=>LENS.rim, v => { LENS.rim=v; uniforms.uRim.value=v; }, LENS.rim);
    const setRimW    = bind('gp-rimw',    ()=>LENS.rimWidth, v => { LENS.rimWidth=v; uniforms.uRimW.value=v; }, LENS.rimWidth);
    const setVig     = bind('gp-vig',     ()=>LENS.vignette, v => { LENS.vignette=v; uniforms.uVig.value=v; }, LENS.vignette);
    const setExp     = bind('gp-exp',     ()=>renderer.toneMappingExposure, v => { renderer.toneMappingExposure=v; }, LENS.exposure);

    wrap.querySelector('#gp-resnap').addEventListener('click', () => { snapshot(last); });
    wrap.querySelector('#gp-copy').addEventListener('click', () => {
      const cfg = {
        corner: LENS.corner, falloff: LENS.falloff, refract: LENS.refract,
        dispersion: LENS.dispersion, rim: LENS.rim, rimWidth: LENS.rimWidth,
        vignette: LENS.vignette, exposure: renderer.toneMappingExposure
      };
      navigator.clipboard?.writeText(JSON.stringify(cfg, null, 2));
    });
    wrap.querySelector('#gp-reset').addEventListener('click', () => {
      localStorage.removeItem('glassTweaks');
      setRefract(24); setDisp(0.05); setCorner(22); setFalloff(36);
      setRim(0.8); setRimW(2.0); setVig(0.12); setExp(1.05);
      snapshot(last);
    });

    document.addEventListener('keydown', e => { if ((e.key||'').toLowerCase()==='g') wrap.classList.toggle('show'); });
  })();
})();
