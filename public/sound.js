// Tiny synthesised blips. No audio files to download, nothing to preload,
// and quiet enough to sit under a FaceTime call.
let ctx = null;
let enabled = false;

export function setSoundEnabled(on) {
  enabled = Boolean(on);
  if (enabled && !ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; }
  }
}

// iOS only lets audio start from inside a user gesture.
export function unlockAudio() {
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function blip({ freq = 440, dur = 0.08, type = 'sine', gain = 0.05, slideTo = null }) {
  if (!enabled || !ctx) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + dur);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(gain, now + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(amp).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  } catch { /* audio is a nicety, never a failure */ }
}

export const sfx = {
  play: () => blip({ freq: 320, dur: 0.06, type: 'triangle', gain: 0.04 }),
  yourTurn: () => blip({ freq: 660, dur: 0.12, type: 'sine', gain: 0.05, slideTo: 880 }),
  trickWon: () => { blip({ freq: 523, dur: 0.1, gain: 0.05 }); setTimeout(() => blip({ freq: 784, dur: 0.14, gain: 0.05 }), 90); },
  handEnd: () => { blip({ freq: 392, dur: 0.14, gain: 0.05 }); setTimeout(() => blip({ freq: 587, dur: 0.22, gain: 0.05 }), 130); },
  error: () => blip({ freq: 180, dur: 0.14, type: 'square', gain: 0.035 }),
};
