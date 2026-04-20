// =====================================================================
// OrbitViewer — gestures (MediaPipe Hands)
// Emits CustomEvents on `document`:
//   gesture:cursor   { x, y }            (normalized 0..1, mirrored)
//   gesture:pan      { dx, dy }
//   gesture:zoom     { dir: +1 | -1 }    (one step, throttled)
//   gesture:split    { dir: +1 | -1 }    (one step, throttled)
//   gesture:thumb    { holdMs, ratio }
//   gesture:lock     { x, y }            (fired when thumb held >= 5s + drift ok)
//   gesture:status   { text }
// =====================================================================

(function () {
  const CFG = {
    detectMs: 80,
    detectFistMs: 40,
    thumbWarmupMs: 300,
    thumbHoldMs: 5000,
    thumbMaxDrift: 0.18,
    zoomThrottleMs: 700,
    splitThrottleMs: 70
  };

  // ---------- finger geometry ----------

  function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.hypot(dx, dy); }

  // Mediapipe Hands landmark indices:
  //   0 wrist, 4 thumb tip, 8 index tip, 12 middle tip, 16 ring tip, 20 pinky tip
  //   (adjacent PIPs/MCPs at -2/-3)
  function isExtended(lm, tipIdx) {
    const pip = lm[tipIdx - 2];
    const mcp = lm[tipIdx - 3] || lm[0];
    // tip is "extended" when its distance from the wrist is greater than the PIP's
    return dist(lm[0], lm[tipIdx]) > dist(lm[0], pip) * 1.05 &&
           dist(lm[tipIdx], mcp) > dist(pip, mcp) * 1.05;
  }
  function thumbUp(lm) {
    const tip = lm[4], ip = lm[3], mcp = lm[2], wrist = lm[0];
    // thumb tip clearly above wrist (smaller y), and other 4 fingers folded
    const above = tip.y < wrist.y - 0.08;
    const straight = dist(tip, mcp) > dist(ip, mcp) * 1.05;
    const folded = !isExtended(lm, 8) && !isExtended(lm, 12) &&
                   !isExtended(lm, 16) && !isExtended(lm, 20);
    return above && straight && folded;
  }
  function classify(lm) {
    const i = isExtended(lm, 8);
    const m = isExtended(lm, 12);
    const r = isExtended(lm, 16);
    const p = isExtended(lm, 20);
    if (thumbUp(lm)) return 'thumb';
    if (i && m && r && p) return 'open';     // open hand
    if (i && m && !r && !p) return 'v';      // V sign
    if (i && !m && !r && !p) return 'point'; // index pointing
    if (!i && !m && !r && !p) return 'fist';
    return 'idle';
  }

  // ---------- engine ----------

  class GestureEngine {
    constructor() {
      this.video = null;
      this.canvas = null;
      this.ctx = null;
      this.hands = null;
      this.camera = null;
      this.stream = null;
      this.running = false;

      this.lastGesture = 'idle';
      this.gestureSince = 0;
      this.lastZoomAt = 0;
      this.lastSplitAt = 0;

      // pan
      this.lastFistPos = null;

      // thumb
      this.thumbStart = 0;
      this.thumbAnchor = null;
    }

    async start() {
      if (this.running) return;
      this.video = document.getElementById('webcam-video');
      this.canvas = document.getElementById('webcam-canvas');
      this.ctx = this.canvas.getContext('2d');

      if (!window.Hands) {
        this.emitStatus('MediaPipe no se cargó. Comprueba la conexión.');
        return;
      }

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 360, facingMode: 'user' },
          audio: false
        });
      } catch (e) {
        this.emitStatus('Permiso de cámara denegado.');
        throw e;
      }
      this.video.srcObject = this.stream;
      await this.video.play();

      this.canvas.width = this.video.videoWidth || 640;
      this.canvas.height = this.video.videoHeight || 360;

      this.hands = new window.Hands({
        locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
      });
      this.hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.6
      });
      this.hands.onResults((r) => this._onResults(r));

      this.camera = new window.Camera(this.video, {
        onFrame: async () => { if (this.running) await this.hands.send({ image: this.video }); },
        width: this.canvas.width,
        height: this.canvas.height
      });
      this.running = true;
      this.camera.start();
      document.getElementById('webcam-off-msg').style.display = 'none';
      this.emitStatus('Cámara activa.');
    }

    async stop() {
      this.running = false;
      try { if (this.camera) await this.camera.stop(); } catch (_) {}
      try { if (this.hands)  await this.hands.close(); }  catch (_) {}
      if (this.stream) {
        this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
      }
      if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const v = document.getElementById('webcam-video');
      if (v) v.srcObject = null;
      const off = document.getElementById('webcam-off-msg');
      if (off) off.style.display = '';
      this._setThumbBar(0);
      this.emitStatus('—');
    }

    emitStatus(text) {
      document.dispatchEvent(new CustomEvent('gesture:status', { detail: { text } }));
    }

    _setThumbBar(ratio) {
      const bar = document.getElementById('thumbs-bar');
      if (bar) bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    }

    _onResults(results) {
      // draw mirror overlay
      const c = this.ctx, cv = this.canvas;
      c.save();
      c.clearRect(0, 0, cv.width, cv.height);
      c.drawImage(results.image, 0, 0, cv.width, cv.height);
      const lms = results.multiHandLandmarks && results.multiHandLandmarks[0];
      if (lms && window.drawConnectors && window.HAND_CONNECTIONS) {
        window.drawConnectors(c, lms, window.HAND_CONNECTIONS, { color: '#3b82f6', lineWidth: 2 });
        window.drawLandmarks(c, lms, { color: '#f97316', lineWidth: 1, radius: 3 });
      }
      c.restore();

      if (!lms) {
        this.lastGesture = 'idle';
        this.gestureSince = 0;
        this.lastFistPos = null;
        this._maybeResetThumb();
        return;
      }

      const g = classify(lms);
      const now = performance.now();

      // Mirror x because video is mirrored.
      const tip = lms[8] || lms[0];
      const cursorX = 1 - tip.x;
      const cursorY = tip.y;
      document.dispatchEvent(new CustomEvent('gesture:cursor',
        { detail: { x: cursorX, y: cursorY } }));

      const requiredHold = (g === 'fist') ? CFG.detectFistMs : CFG.detectMs;
      if (g !== this.lastGesture) {
        this.lastGesture = g;
        this.gestureSince = now;
        if (g !== 'thumb') this._maybeResetThumb();
        if (g !== 'fist') this.lastFistPos = null;
      }
      const heldFor = now - this.gestureSince;
      if (heldFor < requiredHold && g !== 'thumb') {
        this.emitStatus(`detectando ${g}…`);
        return;
      }

      this.emitStatus(`gesto: ${g}`);

      // ----- gesture actions -----
      const appState = window.OrbitViewerState || window.OrbitMixerState;
      const handMode = appState ? appState.handControlMode : 'map';

      if (g === 'fist') {
        if (handMode === 'map') {
          if (this.lastFistPos) {
            const dx = (cursorX - this.lastFistPos.x);
            const dy = (cursorY - this.lastFistPos.y);
            document.dispatchEvent(new CustomEvent('gesture:pan', { detail: { dx, dy } }));
          }
          this.lastFistPos = { x: cursorX, y: cursorY };
        }
      } else {
        this.lastFistPos = null;
      }

      if (g === 'v' || g === 'open') {
        const isV = g === 'v';
        if (handMode === 'map') {
          if (now - this.lastZoomAt > CFG.zoomThrottleMs) {
            this.lastZoomAt = now;
            document.dispatchEvent(new CustomEvent('gesture:zoom',
              { detail: { dir: isV ? +1 : -1 } }));
          }
        } else if (handMode === 'compare') {
          if (now - this.lastSplitAt > CFG.splitThrottleMs) {
            this.lastSplitAt = now;
            document.dispatchEvent(new CustomEvent('gesture:split',
              { detail: { dir: isV ? +1 : -1 } }));
          }
        }
      }

      if (g === 'thumb') {
        if (!this.thumbStart) {
          this.thumbStart = now;
          this.thumbAnchor = { x: cursorX, y: cursorY };
        }
        const elapsed = now - this.thumbStart;
        if (elapsed < CFG.thumbWarmupMs) {
          this._setThumbBar(0);
          return;
        }
        const drift = Math.hypot(cursorX - this.thumbAnchor.x, cursorY - this.thumbAnchor.y);
        if (drift > CFG.thumbMaxDrift) {
          this._maybeResetThumb();
          this.emitStatus('pulgar inestable — reintenta');
          return;
        }
        const holdMs = elapsed - CFG.thumbWarmupMs;
        const ratio = Math.min(1, holdMs / CFG.thumbHoldMs);
        this._setThumbBar(ratio);
        document.dispatchEvent(new CustomEvent('gesture:thumb',
          { detail: { holdMs, ratio } }));
        if (holdMs >= CFG.thumbHoldMs) {
          this._maybeResetThumb();
          document.dispatchEvent(new CustomEvent('gesture:lock',
            { detail: { x: this.thumbAnchor.x, y: this.thumbAnchor.y } }));
        }
      }
    }

    _maybeResetThumb() {
      if (this.thumbStart) {
        this.thumbStart = 0;
        this.thumbAnchor = null;
        this._setThumbBar(0);
      }
    }
  }

  window.OrbitGestures = new GestureEngine();
})();
