/**
 * Ready-check / your-turn alerts: vibration (Android) and a short chime (all phones).
 *
 * iOS only lets a page play audio after a user gesture, so the AudioContext is
 * unlocked on the first touch. Same trick as Mimic's ready-check component
 * (https://github.com/molenzwiebel/Mimic, MIT, see NOTICE), but with a generated
 * tone instead of an audio file.
 */

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export function installAudioUnlock(): void {
  const unlock = () => {
    const c = context();
    if (!c) return;
    void c.resume();
    // A silent buffer counts as "played" for iOS.
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, 22050);
    src.connect(c.destination);
    src.start(0);
  };
  document.addEventListener("pointerdown", unlock, { once: true, capture: true });
}

function chime(notes: number[], gap = 0.14): void {
  const c = context();
  if (!c || c.state !== "running") return;
  const t0 = c.currentTime + 0.02;
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const t = t0 + i * gap;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  });
}

function vibrate(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // unsupported (iOS)
  }
}

export function readyCheckAlert(): void {
  vibrate([500, 250, 500, 250, 500, 250, 500]);
  chime([660, 880, 1320, 880, 1320]);
}

export function myTurnAlert(): void {
  vibrate([200, 100, 200]);
  chime([880, 1175]);
}

export function swapRequestAlert(): void {
  vibrate([150, 80, 150, 80, 150]);
  chime([988, 784, 988]);
}

export function stopVibration(): void {
  vibrate([0]);
}
