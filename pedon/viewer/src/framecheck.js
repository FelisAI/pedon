// A frame that is entirely black is not a picture of anything.
//
// When the WebGL context dies mid-walkthrough, `renderer.render()` on the dead
// context returns in 0 ms with 0 draw calls and does not throw, so the
// walkthrough goes on calling toDataURL and the dev server goes on writing the
// results: byte-identical black files (3,362 bytes, brightest pixel 0) that the
// panel then shows as eye-level photographs.
//
// `renderRefusal` checks `isContextLost()` BEFORE rendering. This is the case
// that check cannot see: a context that dies during a run, a driver that returns
// a blank buffer, anything that makes the pixels wrong without making the API
// complain. The only honest test of "did anything
// get drawn" is to look at what got drawn.
//
// Pure. The reading of the framebuffer is the one impure function, and it is
// separated so the decision can be tested without a GPU.
import * as THREE from "three";

/** The brightest channel value in an RGBA buffer, 0-255. */
export function maxLuma(pixels) {
  let m = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    // max of the channels, not a weighted luma: a frame that is pure saturated
    // blue sky is not blank, and a green-weighted luma would call it nearly so
    const v = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (v > m) { m = v; if (m === 255) return 255; }   // cannot get brighter
  }
  return m;
}

/**
 * Why this frame must not be saved, or null to keep it.
 *
 * EXACTLY zero, deliberately. A garden lit at dusk is legitimately dark and a
 * threshold picked by eye would start refusing real pictures; a frame in which
 * not one of half a million pixels carries a single unit of any channel is not
 * a dark picture, it is nothing at all.
 */
export function blankFrameReason(max) {
  if (max === null || max === undefined) return null;   // nothing measured, nothing claimed
  if (max > 0) return null;
  return "the frame came back completely black — nothing was drawn. The WebGL "
       + "context is most likely dead (it can die DURING a render and the API "
       + "does not say so). Reload the viewer tab, in Fast preview, and try "
       + "again; a black frame is never saved, because one on disk is read as a "
       + "photograph of the garden.";
}

/** Read the brightest pixel out of what is currently on the canvas. */
export function readMaxLuma(renderer) {
  try {
    const gl = renderer?.getContext?.();
    if (!gl || gl.isContextLost?.()) return 0;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (!w || !h) return 0;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return maxLuma(buf);
  } catch {
    return null;            // never fail a render over the check itself
  }
}

/**
 * Which frames in a set are the SAME PICTURE as an earlier one.
 *
 * Two byte-identical frames that are not black are a different fault: two
 * stations planned in the same place looking the same way, so one viewpoint is
 * spent saying nothing new. Reported,
 * never dropped — a repeated frame is honest output from a station list that
 * needs fixing, and deleting it would hide the thing worth knowing.
 */
export function duplicateStations(frames) {
  const seen = new Map();
  const out = [];
  (frames ?? []).forEach((f, i) => {
    const k = f?.dataUrl;
    if (!k) return;
    if (seen.has(k)) out.push({ index: i, sameAs: seen.get(k), name: f.name });
    else seen.set(k, i);
  });
  return out;
}

/**
 * What an off-screen render changes on the user's own view — the camera and the drawing size —
 * held, and the function that puts it back exactly (one copy for viewport.js and walkthrough.js:
 * a field one copy forgot would be a view that comes back wrong).
 */
export function holdView(renderer, camera) {
  const pos = camera.position.clone(), quat = camera.quaternion.clone(), up = camera.up.clone();
  const { fov, aspect } = camera, size = renderer.getSize(new THREE.Vector2()), pr = renderer.getPixelRatio();
  return () => {
    renderer.setPixelRatio(pr);
    renderer.setSize(size.x, size.y, false);
    camera.position.copy(pos); camera.quaternion.copy(quat); camera.up.copy(up);
    camera.fov = fov; camera.aspect = aspect;
    camera.updateProjectionMatrix();
  };
}
