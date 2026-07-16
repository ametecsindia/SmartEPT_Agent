'use strict';
/* Local presence worker — brightness-based detector (dependency-free MVP).
   Reports PRESENT / CAMERA_BLOCKED / CAMERA_UNAVAILABLE with numeric metadata only. */

const SAMPLE_MS = 5000;
const DARK_THRESHOLD = 12;   // average luminance below this => lens covered/dark

const video = document.getElementById('v');
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

let ready = false;

navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false })
  .then((stream) => {
    video.srcObject = stream;
    ready = true;
  })
  .catch(() => {
    window.presenceBridge.report({ status: 'CAMERA_UNAVAILABLE', brightness: 0, face_count: 0, mode: 'brightness' });
  });

function avgLuminance() {
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    // Rec. 601 luma
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return Math.round(sum / n);
}

setInterval(() => {
  if (!ready || video.readyState < 2) return;
  let brightness = 0;
  try { brightness = avgLuminance(); } catch { return; }

  const status = brightness < DARK_THRESHOLD ? 'CAMERA_BLOCKED' : 'PRESENT';
  // Brightness mode cannot count faces; face_count is reported as unknown (1 when present).
  window.presenceBridge.report({
    status,
    brightness,
    face_count: status === 'PRESENT' ? 1 : 0,
    mode: 'brightness',
  });
}, SAMPLE_MS);
