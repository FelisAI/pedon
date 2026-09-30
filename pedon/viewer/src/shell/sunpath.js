// Dragging the sun across the day.
//
// The user wants to see the garden under the sun at different times of day.
//
// tools/sun.py is real astronomy, `/api/sun` puts it on the scene, lighting.js
// samples a physical sky into both the background and the environment. This is
// the way to MOVE it. You cannot see how a garden works at five in the afternoon
// by typing 17:00 into an `<input type="time">`; you see it by dragging the
// handle and watching the shadows swing, because what you are judging is the
// change.
//
// The cost is the constraint: every change round-trips to a python subprocess,
// and a slider would fire a hundred of them. So the viewer fetches the whole
// day's track ONCE (`sun.py day`) and interpolates between samples while the
// handle moves. The astronomy stays in the one file that owns it — a second
// solar model written in JS is a second copy that drifts.
//
// Pure. No DOM, no fetch.

const MIN = 60 * 1000;

/** "2026-09-12T13:49:15+00:00" -> minutes since UTC midnight of that day. */
export function utcMinutes(iso, dayISO) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const base = Date.parse(`${dayISO}T00:00:00+00:00`);
  return (t - base) / MIN;
}

/**
 * Where the sun is at a given local minute, interpolated from the day's track.
 *
 * LINEAR, between samples ten minutes apart. The sun moves about 2.5° of azimuth
 * in ten minutes and its path is smooth, so the interpolation error is under a
 * twentieth of a degree — far below what a shadow on a garden slope shows. Anything
 * cleverer would be a second solar model.
 *
 * Azimuth is unwrapped across 0/360 before interpolating: at the moment the sun
 * passes due north a naive mean of 359 and 1 is 180, which would swing every
 * shadow in the garden to the opposite side for one sample.
 */
export function sunAt(day, localMinutes, utcOffsetH = 0) {
  const track = day?.track ?? [];
  if (track.length === 0) return null;
  const want = localMinutes - utcOffsetH * 60;   // back to UTC minutes
  const at = i => utcMinutes(track[i].utc, day.date);
  if (track.length === 1 || want <= at(0)) return sample(track[0]);
  if (want >= at(track.length - 1)) return sample(track[track.length - 1]);
  let i = 0;
  while (i < track.length - 2 && at(i + 1) < want) i++;
  const a = track[i], b = track[i + 1];
  const ta = at(i), tb = at(i + 1);
  const f = tb === ta ? 0 : (want - ta) / (tb - ta);
  // unwrap: take the shorter way round the compass
  let da = b.azimuth_deg - a.azimuth_deg;
  if (da > 180) da -= 360; else if (da < -180) da += 360;
  return {
    altitude_deg: +(a.altitude_deg + (b.altitude_deg - a.altitude_deg) * f).toFixed(3),
    azimuth_deg: +(((a.azimuth_deg + da * f) % 360 + 360) % 360).toFixed(3),
  };
}
const sample = s => ({ altitude_deg: s.altitude_deg, azimuth_deg: s.azimuth_deg });

/**
 * The slider's range, in LOCAL minutes: first light to last light.
 *
 * Padded half an hour each side of sunrise and sunset, because the half hour
 * after the sun goes down is a real thing to look at a garden in and a slider
 * that stops dead at sunset cannot show it.
 */
export function dayRange(day, utcOffsetH = 0, padMin = 30) {
  if (!day?.sunrise_utc || !day?.sunset_utc) return { start: 6 * 60, end: 20 * 60 };
  const rise = utcMinutes(day.sunrise_utc, day.date) + utcOffsetH * 60;
  const set = utcMinutes(day.sunset_utc, day.date) + utcOffsetH * 60;
  return { start: Math.round(rise - padMin), end: Math.round(set + padMin) };
}

/** minutes -> "17:20", for the label and for the time input. */
export function hhmm(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "17:20" -> 1040. */
export function minutesOf(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ""));
  return m ? +m[1] * 60 + +m[2] : null;
}

/**
 * TWO SUNS IN ONE FRAME — the one lighting error you cannot art-direct around.
 *
 * The scan is a PHOTOGRAPH. Its shadows were taken at the hour on the capture's
 * own filename and they are painted into the texture; nothing can relight them.
 * So the moment the lit hour moves away from the capture hour, the frame carries
 * the design's shadows falling one way and the ground's falling another, and it
 * reads as a rendering fault rather than as a time of day.
 *
 * The honest answer is not to forbid it — "what does the patio look like at
 * six?" is a real question — but to SAY it, and to offer the one thing that
 * fixes it: hide the plate and look at the design on bare measured ground.
 *
 * 45 minutes, because that is roughly where a shadow's direction has moved
 * enough to read as wrong rather than as the same afternoon.
 */
export function twoSunsWarning({ litMinutes, captureMinutes, scanShown } = {}) {
  if (!scanShown) return null;                       // no plate, no contradiction
  if (!Number.isFinite(litMinutes) || !Number.isFinite(captureMinutes)) return null;
  const off = Math.abs(litMinutes - captureMinutes);
  if (off < 45) return null;
  const h = Math.round(off / 6) / 10;
  return `The scan was photographed at ${hhmm(captureMinutes)} and its shadows are `
       + `part of the picture — ${h} h away, the ground's shadows and the design's `
       + "point different ways. Hide the scan to judge the light on its own.";
}

/** The dates worth comparing, for "what is this bed doing in February?" */
export function seasonDates(season, year) {
  const y = year ?? new Date().getFullYear();
  return {
    march_equinox: `${y}-03-20`,
    june_solstice: `${y}-06-21`,
    september_equinox: `${y}-09-22`,
    december_solstice: `${y}-12-21`,
    ...(season ?? {}),
  };
}
