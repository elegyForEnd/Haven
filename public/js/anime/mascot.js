const MODEL = '/live2d/ciacord-cat/';
let corePromise;

function loadCore() {
  if (!corePromise) {
    corePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/js/vendor/live2dcubismcore.min.js';
      script.onload = async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            if (window.Live2DCubismCore?.Version.csmGetVersion()) {
              resolve(window.Live2DCubismCore);
              return;
            }
          } catch { /* WASM initialization is asynchronous. */ }
          await new Promise(done => setTimeout(done, 50));
        }
        reject(new Error('Cubism Core initialization timed out'));
      };
      script.onerror = () => reject(new Error('Cubism Core could not load'));
      document.head.append(script);
    });
  }
  return corePromise;
}

async function getAsset(file, binary = false) {
  const response = await fetch(MODEL + file);
  if (!response.ok) throw new Error('Mascot asset could not load');
  return binary ? response.arrayBuffer() : response.json();
}

// These exported clips use restricted Beziers with uniformly spaced time handles.
function applyMotion(model, motion, time) {
  for (const curve of motion.Curves) {
    const index = model.parameters.ids.indexOf(curve.Id);
    if (index < 0) continue;
    const segments = curve.Segments;
    let previousTime = segments[0];
    let value = segments[1];
    for (let i = 2; i < segments.length; i += 7) {
      const nextTime = segments[i + 5];
      const nextValue = segments[i + 6];
      if (time <= nextTime) {
        const progress = Math.max(0, Math.min(1, (time - previousTime) / (nextTime - previousTime)));
        const inverse = 1 - progress;
        value = inverse ** 3 * value
          + 3 * inverse ** 2 * progress * segments[i + 2]
          + 3 * inverse * progress ** 2 * segments[i + 4]
          + progress ** 3 * nextValue;
        break;
      }
      previousTime = nextTime;
      value = nextValue;
    }
    model.parameters.values[index] = value;
  }
}

function createRenderer(canvas, model, image) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) throw new Error('WebGL is unavailable');
  const shaders = [];
  const buffers = [];
  const program = gl.createProgram();
  const texture = gl.createTexture();
  const dispose = () => {
    for (const buffer of buffers) gl.deleteBuffer(buffer);
    for (const shader of shaders) gl.deleteShader(shader);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
  };
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, `
        attribute vec2 position;
        attribute vec2 uv;
        uniform vec2 scale;
        varying vec2 textureUV;
        void main() {
          gl_Position = vec4(position * scale, 0.0, 1.0);
          textureUV = uv;
        }`],
      [gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform sampler2D image;
        uniform float opacity;
        varying vec2 textureUV;
        void main() { gl_FragColor = texture2D(image, textureUV) * opacity; }`]
    ]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Mascot shader failed');
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Mascot shader link failed');
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, 'position');
    const uv = gl.getAttribLocation(program, 'uv');
    const opacity = gl.getUniformLocation(program, 'opacity');
    const info = model.canvasinfo;
    const modelWidth = info.CanvasWidth / info.PixelsPerUnit;
    const modelHeight = info.CanvasHeight / info.PixelsPerUnit;
    const fit = Math.min(canvas.width / modelWidth, canvas.height / modelHeight);
    gl.uniform2f(gl.getUniformLocation(program, 'scale'), 2 * fit / canvas.width, 2 * fit / canvas.height);
    gl.uniform1i(gl.getUniformLocation(program, 'image'), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enableVertexAttribArray(position);
    gl.enableVertexAttribArray(uv);
    const drawables = model.drawables;
    const meshBuffers = Array.from(drawables.ids, (_, i) => {
      const vertices = gl.createBuffer();
      const uvs = gl.createBuffer();
      const indices = gl.createBuffer();
      buffers.push(vertices, uvs, indices);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
      gl.bufferData(gl.ARRAY_BUFFER, drawables.vertexPositions[i], gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, uvs);
      gl.bufferData(gl.ARRAY_BUFFER, drawables.vertexUvs[i], gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, drawables.indices[i], gl.STATIC_DRAW);
      return { vertices, uvs, indices };
    });
    return {
      dispose,
      draw() {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const order = Array.from(drawables.ids.keys()).sort((a, b) => drawables.renderOrders[a] - drawables.renderOrders[b]);
        for (const i of order) {
          if (drawables.opacities[i] <= 0) continue;
          const mesh = meshBuffers[i];
          gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertices);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, drawables.vertexPositions[i]);
          gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvs);
          gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
          gl.uniform1f(opacity, drawables.opacities[i]);
          gl.drawElements(gl.TRIANGLES, drawables.indexCounts[i], gl.UNSIGNED_SHORT, 0);
        }
      }
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export async function createMascot(host) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ac-mascot-live2d';
  canvas.width = 290;
  canvas.height = 320;
  canvas.setAttribute('aria-hidden', 'true');
  const core = await loadCore();
  const settings = await getAsset('ciacord-cat.model3.json');
  const [bytes, idle, tap] = await Promise.all([
    getAsset(settings.FileReferences.Moc, true),
    getAsset(settings.FileReferences.Motions.Idle[0].File),
    getAsset(settings.FileReferences.Motions.Tap[0].File)
  ]);
  const image = new Image();
  image.src = MODEL + settings.FileReferences.Textures[0];
  await image.decode();
  const moc = core.Moc.fromArrayBuffer(bytes);
  if (!moc) throw new Error('Mascot model could not load');
  let model;
  let renderer;
  let frame;
  let disposed = false;
  let visible = false;
  const motion = matchMedia('(prefers-reduced-motion: no-preference) and (min-width: 761px)');
  const observer = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    sync();
  });
  const started = performance.now();
  let waveStarted = -Infinity;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    motion.removeEventListener('change', sync);
    document.removeEventListener('visibilitychange', sync);
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.remove();
    host.classList.remove('has-live2d');
    renderer?.dispose();
    model?.release();
    moc._release();
  };
  const lost = event => {
    event.preventDefault();
    dispose();
  };
  function tick(now) {
    if (disposed) return;
    model.parameters.values.set(model.parameters.defaultValues);
    applyMotion(model, idle, ((now - started) / 1000) % idle.Meta.Duration);
    const waveTime = (now - waveStarted) / 1000;
    if (waveTime >= 0 && waveTime < tap.Meta.Duration) applyMotion(model, tap, waveTime);
    model.update();
    renderer.draw();
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(frame);
    host.classList.toggle('has-live2d', !disposed && motion.matches);
    if (!disposed && visible && motion.matches && !document.hidden) frame = requestAnimationFrame(tick);
  }
  try {
    model = core.Model.fromMoc(moc);
    if (!model) throw new Error('Mascot model could not initialize');
    renderer = createRenderer(canvas, model, image);
    model.update();
    renderer.draw();
    host.append(canvas);
    canvas.addEventListener('webglcontextlost', lost);
    motion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    observer.observe(host);
    sync();
    return { dispose, wave() { waveStarted = performance.now(); } };
  } catch (error) {
    dispose();
    throw error;
  }
}
