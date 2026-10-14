import { hexToXy, hsvToHex } from '../color.js';
import type { Effect } from './engine.js';

/** Options of {@link audioSync}. */
export interface AudioSyncOptions {
  /** Peak brightness. Default 254. */
  brightness?: number;
}

/**
 * The room follows the sound picked up by the microphone (browser only). Overall
 * energy drives brightness (instant attack, slow release: a "pump"), the bass /
 * treble balance drives hue (bass warm red, treble cold violet). It follows the
 * mood and sections of the music, not each beat: that would need the
 * Entertainment streaming API.
 */
export function audioSync(options: AudioSyncOptions = {}): Effect {
  return {
    name: 'audio sync',
    brightness: options.brightness ?? 254,
    async run(ctx) {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('audioSync needs a browser with microphone access.');
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (cause) {
        throw new Error('Microphone access was denied or is unavailable.', { cause });
      }
      let audio: AudioContext | null = null;
      // Registered before the AudioContext exists: when creating it throws, the
      // microphone must still be released.
      ctx.onCleanup(async () => {
        for (const track of stream.getTracks()) track.stop();
        await audio?.close().catch(() => {});
      });
      audio = new AudioContext();
      // Stopped while the permission prompt was open: leave, cleanup releases the mic.
      if (!ctx.live()) return;
      await audio.resume().catch(() => {}); // iOS Safari starts it suspended
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      audio.createMediaStreamSource(stream).connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const n = bins.length;
      const bassEnd = Math.max(1, Math.floor(n * 0.15));
      const midEnd = Math.max(bassEnd + 1, Math.floor(n * 0.5));
      let envelope = 0;

      while (ctx.live()) {
        analyser.getByteFrequencyData(bins);
        let total = 0;
        let bass = 0;
        let treble = 0;
        for (let i = 0; i < n; i++) {
          const v = bins[i] ?? 0;
          total += v;
          if (i < bassEnd) bass += v;
          else if (i >= midEnd) treble += v;
        }
        envelope = Math.max(total / (n * 255), envelope * 0.82);
        const bassN = bass / (bassEnd * 255);
        const trebleN = treble / ((n - midEnd) * 255);
        const hue = (15 + Math.min(1, trebleN * 1.6) * 255 - Math.min(1, bassN * 1.3) * 15 + 360) % 360;
        const peak = ctx.brightness();
        const floor = Math.min(20, peak);
        const bri = Math.max(1, Math.round(floor + envelope * (peak - floor)));
        const xy = hexToXy(hsvToHex(hue, 0.9, 1));
        for (const light of ctx.lights) {
          if (!ctx.live()) break;
          await ctx.setLight(light.id, { on: true, bri, xy, transitiontime: 2 });
        }
        await ctx.sleep(50);
      }
    },
  };
}
