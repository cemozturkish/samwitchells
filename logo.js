/* Silver logo: a small WebGL renderer that treats the flat logo artwork as a
   piece of polished metal and moves a light across it.

   Desktop: the light is the mouse.
   Phone:   the light moves as the phone tilts (touch works too).

   Textures come from _tools/build_logo_maps.py:
     assets/logo.webp         the artwork on black
     assets/logo-relief.webp  R,G = surface normal, B = where the metal is

   If WebGL is missing the plain <img> simply stays on screen. */
(function () {
  'use strict';

  var logo = document.getElementById('logo');
  if (!logo) return;
  var canvas = logo.querySelector('canvas');
  var hint = document.getElementById('tilt-hint');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isHandheld = window.matchMedia('(hover: none) and (pointer: coarse)').matches;   // phones, tablets

  /* ------------------------------------------------------------------ */
  /* Shaders                                                             */
  /* ------------------------------------------------------------------ */

  var VERT = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);', // y runs down, like the image
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Lights the metal. uGlint = 0 draws the picture, uGlint = 1 draws only the
  // energy of the brightest highlights, which is then blurred into the glow.
  var SCENE = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uLogo;',
    'uniform sampler2D uRelief;',
    'uniform vec3 uLight;',   // x 0..2, y 0..1 (image space), z = height above the metal
    'uniform float uGain;',   // 0..1 fade-in
    'uniform float uGlint;',
    '',
    'void main() {',
    '  vec3 base = texture2D(uLogo, vUv).rgb;',
    '  vec4 rel = texture2D(uRelief, vUv);',
    '  vec2 g = rel.rg * 2.0 - 1.0;',
    '  vec3 N = normalize(vec3(g * 1.35, sqrt(max(1.0 - dot(g, g), 0.0))));',
    '  float lum = dot(base, vec3(0.299, 0.587, 0.114));',
    '  float metal = rel.b * smoothstep(0.015, 0.16, lum);',
    '',
    '  vec3 P = vec3(vUv.x * 2.0, vUv.y, 0.0);',
    '  vec3 toL = uLight - P;',
    '  float d2 = dot(toL, toL);',
    '  vec3 L = toL * inversesqrt(d2);',
    '  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));',
    '  float ndl = dot(N, L);',
    '  float ndh = max(dot(N, H), 0.0);',
    '  float near = 1.0 / (1.0 + d2 * 1.3);',   // tight pool around the light
    '  float far = 1.0 / (1.0 + d2 * 0.45);',   // reach of the glints
    '',
    // The painted chrome: moody where the light does not reach, punchy where it does.
    '  float wrap = clamp(ndl * 0.7 + 0.3, 0.0, 1.0);',
    '  float pool = clamp(near * wrap * 1.15, 0.0, 1.0);',
    '  vec3 col = mix(pow(base, vec3(1.2)) * 0.74, pow(base, vec3(1.45)) * 1.0, pool);',
    '',
    // Mirror reflection of the lamp itself, worked out in "how far is this
    // facet from facing the lamp" space. Hard-edged shapes are what make it
    // read as polished metal rather than plastic: a softbox, a thin strip
    // light under it, and a needle-sharp sparkle.
    '  vec2 dv = N.xy - H.xy;',
    '  float box = (1.0 - smoothstep(0.10, 0.16, abs(dv.x))) * (1.0 - smoothstep(0.035, 0.07, abs(dv.y)));',
    '  float strip = (1.0 - smoothstep(0.30, 0.42, abs(dv.x))) * (1.0 - smoothstep(0.012, 0.028, abs(dv.y - 0.27)));',
    '  float sheen = pow(ndh, 30.0);',
    '  float spark = pow(ndh, 600.0);',
    '  vec3 tint = vec3(0.93, 0.96, 1.0);',
    '  float energy = metal * far * (0.85 * box + 0.4 * strip + 0.06 * sheen + 1.4 * spark);',
    // Liquid banding: alternating bright and dark reflections that slide over
    // the curves as the lamp moves.
    '  float r = length(dv);',
    '  float band = 0.5 + 0.5 * cos(r * 17.0);',
    '  col *= mix(1.0, 0.5 + 0.8 * band, metal * (0.34 + 0.26 * far));',
    '  col += tint * energy * (0.3 + 0.7 * lum);',
    '',
    '  if (uGlint > 0.5) {',
    '    float hot = metal * far * (0.3 * box * lum + 0.15 * strip + 1.6 * spark);',
    // Stars only fire off steep facets (edges, the beaded wire), where a
    // mirror-perfect alignment is a pin-point rather than a patch.
    '    float steep = smoothstep(0.3, 0.55, length(N.xy));',
    '    float star = metal * far * steep * pow(ndh, 2600.0) * (0.4 + 0.6 * lum);',
    '    gl_FragColor = vec4(tint * clamp(hot - 0.12, 0.0, 1.0), clamp(star * 2.0 - 0.25, 0.0, 1.0)) * uGain;',
    '    return;',
    '  }',
    // Soft shoulder so the brightest metal rolls off to white instead of clipping.
    '  col = mix(col, 0.86 + 0.14 * (1.0 - exp(-(col - 0.86) * 4.0)), step(0.86, col));',
    '  gl_FragColor = vec4(col * uGain, 1.0);',
    '}'
  ].join('\n');

  // Separable 9-tap gaussian (5 bilinear fetches). RGB carries the glow, alpha
  // carries the pin-point sparkles that get stretched into star flares.
  var BLUR = [
    'precision mediump float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uStep;',
    'void main() {',
    '  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);',
    '  vec4 c = texture2D(uTex, uv) * 0.2270270270;',
    '  c += (texture2D(uTex, uv + uStep * 1.3846153846) + texture2D(uTex, uv - uStep * 1.3846153846)) * 0.3162162162;',
    '  c += (texture2D(uTex, uv + uStep * 3.2307692308) + texture2D(uTex, uv - uStep * 3.2307692308)) * 0.0702702703;',
    '  gl_FragColor = c;',
    '}'
  ].join('\n');

  // Adds the glow on top of the picture, dithered so it never bands on black.
  var GLOW = [
    'precision mediump float;',
    'varying vec2 vUv;',
    'uniform sampler2D uSoft;',
    'uniform sampler2D uWide;',
    'uniform sampler2D uStarH;',
    'uniform sampler2D uStarV;',
    'void main() {',
    '  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);',
    '  vec3 c = texture2D(uSoft, uv).rgb * 0.7 + texture2D(uWide, uv).rgb * 0.6;',
    '  c += vec3(0.9, 0.95, 1.0) * (texture2D(uStarH, uv).a + texture2D(uStarV, uv).a) * 4.5;',
    '  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
    '  gl_FragColor = vec4(c + (n - 0.5) / 255.0, 1.0);',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------------ */
  /* WebGL plumbing                                                      */
  /* ------------------------------------------------------------------ */

  var gl = null;
  var prog = {};
  var tex = {};
  var targets = null;
  var ready = false;

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    }
    return s;
  }

  function program(fragSrc, uniforms) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
    }
    var out = { id: p };
    uniforms.forEach(function (name) { out[name] = gl.getUniformLocation(p, name); });
    return out;
  }

  function imageTexture(img) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    return t;
  }

  function makeTarget(w, h) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { fbo: f, tex: t, w: w, h: h };
  }

  function freeTargets() {
    if (!targets) return;
    Object.keys(targets).forEach(function (k) {
      gl.deleteFramebuffer(targets[k].fbo);
      gl.deleteTexture(targets[k].tex);
    });
    targets = null;
  }

  function buildTargets() {
    freeTargets();
    var w = canvas.width, h = canvas.height;
    function sz(div) { return [Math.max(2, Math.round(w / div)), Math.max(2, Math.round(h / div))]; }
    var s2 = sz(2), s4 = sz(4), s8 = sz(8);
    targets = {
      glint: makeTarget(s2[0], s2[1]),
      softA: makeTarget(s4[0], s4[1]),
      softB: makeTarget(s4[0], s4[1]),
      wideA: makeTarget(s8[0], s8[1]),
      wideB: makeTarget(s8[0], s8[1]),
      starA: makeTarget(s4[0], s4[1]),
      starB: makeTarget(s4[0], s4[1]),
      starH: makeTarget(s4[0], s4[1]),
      starV: makeTarget(s4[0], s4[1])
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function setupGL() {
    gl = canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance'
    });
    if (!gl) return false;

    prog.scene = program(SCENE, ['uLogo', 'uRelief', 'uLight', 'uGain', 'uGlint']);
    prog.blur = program(BLUR, ['uTex', 'uStep']);
    prog.glow = program(GLOW, ['uSoft', 'uWide', 'uStarH', 'uStarV']);

    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);
    return true;
  }

  function bind(unit, texture) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  function blurPass(src, dst, dx, dy) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    bind(0, src.tex);
    gl.uniform2f(prog.blur.uStep, dx / dst.w, dy / dst.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function draw(lx, ly, lz, gain) {
    var t = targets;

    // 1. the metal
    gl.useProgram(prog.scene.id);
    bind(0, tex.logo);
    bind(1, tex.relief);
    gl.uniform1i(prog.scene.uLogo, 0);
    gl.uniform1i(prog.scene.uRelief, 1);
    gl.uniform3f(prog.scene.uLight, lx, ly, lz);
    gl.uniform1f(prog.scene.uGain, gain);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.uniform1f(prog.scene.uGlint, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2. just the hottest highlights, at half size
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.glint.fbo);
    gl.viewport(0, 0, t.glint.w, t.glint.h);
    gl.uniform1f(prog.scene.uGlint, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3. blur them into a tight glow and a wide one
    gl.useProgram(prog.blur.id);
    gl.uniform1i(prog.blur.uTex, 0);
    blurPass(t.glint, t.softA, 1, 0);
    blurPass(t.softA, t.softB, 0, 1);
    blurPass(t.softB, t.wideA, 1, 0);
    blurPass(t.wideA, t.wideB, 0, 1);
    // ...and stretch the sparkles sideways and upright into four-point stars
    // (each pass doubles its reach, so the streak stays smooth instead of dotted)
    blurPass(t.glint, t.starA, 1, 0);
    blurPass(t.starA, t.starB, 2, 0);
    blurPass(t.starB, t.starH, 4, 0);
    blurPass(t.glint, t.starA, 0, 1);
    blurPass(t.starA, t.starB, 0, 2);
    blurPass(t.starB, t.starV, 0, 4);

    // 4. add the glow over the picture
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog.glow.id);
    bind(0, t.softB.tex);
    bind(1, t.wideB.tex);
    gl.uniform1i(prog.glow.uSoft, 0);
    bind(2, t.starH.tex);
    bind(3, t.starV.tex);
    gl.uniform1i(prog.glow.uWide, 1);
    gl.uniform1i(prog.glow.uStarH, 2);
    gl.uniform1i(prog.glow.uStarV, 3);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
  }

  /* ------------------------------------------------------------------ */
  /* Sizing                                                              */
  /* ------------------------------------------------------------------ */

  var box = { cx: 0, cy: 0, w: 1, h: 1 };
  var needsDraw = true;

  function measure() {
    // Layout size, ignoring the 3D tilt, centred on the viewport like the stage.
    box.w = logo.offsetWidth || 1;
    box.h = logo.offsetHeight || 1;
    box.cx = window.innerWidth / 2;
    box.cy = window.innerHeight / 2;

    if (!gl) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var w = Math.round(box.w * dpr);
    if (w > 2560) w = 2560;           // plenty for a 2048px source
    var h = Math.round(w / 2);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      buildTargets();
    }
    needsDraw = true;
  }

  /* ------------------------------------------------------------------ */
  /* The light                                                           */
  /* ------------------------------------------------------------------ */

  // Logo space: x 0..2 left to right, y 0..1 top to bottom.
  var REST = { x: 1.0, y: 0.46 };
  var light = { x: -0.4, y: 0.3 };       // where it is now (starts off to the left)
  var pointer = { x: 1, y: 0.5, active: false, down: false };
  var tilt = { x: 0, y: 0, active: false, upX: 0, upY: 0, baseX: 0, baseY: 0, hasBase: false };
  var start = 0, last = 0, drawn = { x: NaN, y: NaN, gain: NaN };

  function toLogoSpace(clientX, clientY) {
    pointer.x = ((clientX - box.cx) / box.w + 0.5) * 2;
    pointer.y = (clientY - box.cy) / box.h + 0.5;
  }

  // A mouse steers the light just by hovering. A finger (or anything on a
  // handheld) only steers it while pressed, then hands back to tilt.
  function hovers(e) { return e.pointerType === 'mouse' && !isHandheld; }

  window.addEventListener('pointermove', function (e) {
    if (!hovers(e) && !pointer.down) return;
    pointer.active = true;
    toLogoSpace(e.clientX, e.clientY);
  }, { passive: true });

  window.addEventListener('pointerdown', function (e) {
    pointer.down = true;
    pointer.active = true;
    toLogoSpace(e.clientX, e.clientY);
  }, { passive: true });

  function release(e) {
    pointer.down = false;
    if (!hovers(e)) pointer.active = false;   // finger lifted: light drifts home
  }
  window.addEventListener('pointerup', release, { passive: true });
  window.addEventListener('pointercancel', release, { passive: true });
  document.documentElement.addEventListener('mouseleave', function () { pointer.active = false; });
  window.addEventListener('blur', function () { pointer.active = false; });

  /* ---- phone tilt ---- */

  function onOrientation(e) {
    if (e.beta === null || e.gamma === null) return;
    var b = e.beta * Math.PI / 180, g = e.gamma * Math.PI / 180;
    // Direction of "up" (against gravity) in the phone's own axes. Unlike raw
    // beta/gamma this stays smooth however the phone is held.
    var dx = -Math.cos(b) * Math.sin(g);
    var dy = Math.sin(b);
    // Rotate into screen axes so it also works in landscape.
    var a = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * Math.PI / 180;
    tilt.upX = dx * Math.cos(a) - dy * Math.sin(a);
    tilt.upY = dx * Math.sin(a) + dy * Math.cos(a);
    if (!tilt.hasBase) {
      tilt.baseX = tilt.upX;
      tilt.baseY = tilt.upY;
      tilt.hasBase = true;
    }
    if (!tilt.active) {
      tilt.active = true;
      hideHint();
    }
  }

  function listenForTilt() {
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
    window.addEventListener('orientationchange', function () { tilt.hasBase = false; });
  }

  function hideHint() {
    if (!hint) return;
    hint.classList.remove('is-visible');
    window.setTimeout(function () { hint.hidden = true; }, 1000);
  }

  function setupTilt() {
    var DOE = window.DeviceOrientationEvent;
    if (!DOE) return;
    if (!isHandheld) return;
    if (typeof DOE.requestPermission !== 'function') {
      listenForTilt();                 // Android and friends: no permission step
      return;
    }
    // iOS only hands out motion data after a tap, so ask on the first one.
    if (hint) {
      hint.hidden = false;
      window.setTimeout(function () { hint.classList.add('is-visible'); }, 1400);
    }
    function ask() {
      window.removeEventListener('click', ask);
      DOE.requestPermission().then(function (state) {
        if (state === 'granted') listenForTilt();
      }).catch(function () {}).then(hideHint);
    }
    window.addEventListener('click', ask);
  }

  /* ---- animation ---- */

  function ease(current, target, rate, dt) {
    return current + (target - current) * (1 - Math.exp(-rate * dt));
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!ready || document.hidden) { last = now; return; }
    if (!start) { start = now; last = now; }
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    var t = (now - start) / 1000;

    // Where the light wants to be.
    var tx, ty, rate;
    if (pointer.active) {
      // On the pointer, with the faint unsteadiness of a hand-held lamp.
      tx = pointer.x + (reduceMotion ? 0 : 0.012 * Math.sin(t * 1.3));
      ty = pointer.y + (reduceMotion ? 0 : 0.010 * Math.sin(t * 1.7 + 1.0));
      rate = 11;
    } else if (tilt.active) {
      // The resting pose slowly re-centres on however the phone is being held.
      tilt.baseX = ease(tilt.baseX, tilt.upX, 0.12, dt);
      tilt.baseY = ease(tilt.baseY, tilt.upY, 0.12, dt);
      tilt.x = Math.tanh((tilt.upX - tilt.baseX) / 0.3);
      tilt.y = Math.tanh((tilt.upY - tilt.baseY) / 0.3);
      tx = REST.x + tilt.x * 1.05;
      ty = REST.y - tilt.y * 0.6;
      rate = 9;
    } else if (reduceMotion) {
      tx = REST.x; ty = REST.y; rate = 3;
    } else {
      // Nobody is steering: wander slowly across the lettering.
      tx = 1.0 + 0.78 * Math.sin(t * 0.42 - 1.2);
      ty = 0.46 + 0.2 * Math.sin(t * 0.63 + 0.4);
      rate = 2.2;
    }

    light.x = ease(light.x, tx, rate, dt);
    light.y = ease(light.y, ty, rate, dt);
    var gain = reduceMotion ? 1 : Math.min(1, t / 1.1);
    gain = gain * gain * (3 - 2 * gain);

    if (!needsDraw &&
        Math.abs(light.x - drawn.x) < 2e-4 && Math.abs(light.y - drawn.y) < 2e-4 && gain === drawn.gain) {
      return;                          // nothing moved: leave the last frame up
    }
    needsDraw = false;
    drawn.x = light.x; drawn.y = light.y; drawn.gain = gain;

    draw(light.x, light.y, 0.34, gain);

    // Lean the whole piece a few degrees toward the light.
    var lean = reduceMotion ? 0 : 1;
    var rx = Math.max(-1, Math.min(1, (light.y - 0.5) * 1.4));
    var ry = Math.max(-1, Math.min(1, (light.x - 1.0) * 0.9));
    logo.style.setProperty('--tilt-x', (-rx * 5 * lean).toFixed(3) + 'deg');
    logo.style.setProperty('--tilt-y', (ry * 6 * lean).toFixed(3) + 'deg');

    if (!logo.classList.contains('is-live')) logo.classList.add('is-live');
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('could not load ' + src)); };
      img.src = src;
    });
  }

  var images = null;

  function upload() {
    tex.logo = imageTexture(images[0]);
    tex.relief = imageTexture(images[1]);
    measure();
    ready = true;
    needsDraw = true;
  }

  function boot() {
    try {
      if (!setupGL()) return;
    } catch (err) {
      gl = null;
      return;                          // the still image stays
    }

    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      ready = false;
      targets = null;
      logo.classList.remove('is-live');
    });
    canvas.addEventListener('webglcontextrestored', function () {
      try { setupGL(); upload(); } catch (err) { ready = false; }
    });

    Promise.all([loadImage('assets/logo.webp'), loadImage('assets/logo-relief.webp')])
      .then(function (loaded) {
        images = loaded;
        upload();
      })
      .catch(function () { /* the still image stays */ });

    if (window.ResizeObserver) new ResizeObserver(measure).observe(logo);
    window.addEventListener('resize', measure);
    measure();
    setupTilt();
    requestAnimationFrame(frame);
  }

  boot();
})();
