# Effects

An effect is an object with a name and an async `run` loop:

```ts
import { type Effect, hexToXy } from 'hue-web';

export const blink: Effect = {
  name: 'blink',
  brightness: 254,
  async run(ctx) {
    let on = true;
    while (ctx.live()) {
      for (const light of ctx.lights) await ctx.setLight(light.id, { on, bri: ctx.brightness(), xy: hexToXy('#ff0040') });
      on = !on;
      await ctx.sleep(500);
    }
  },
};
```

Start it through a manager (one effect at a time, coordinated across tabs) or directly with `runEffect`:

```ts
await effects.start(blink, { lights, transport });
const { clean } = await effects.stop(); // true once the loop exited, its last command was acknowledged and cleanup ran
```

## The context

| Member | |
| --- | --- |
| `lights` | Target lights, with plugs and on/off-only devices filtered out. |
| `live()` | `false` once stopping. Check it in every loop. |
| `setLight(id, state)` | Sends at the transport's pace. Use it for every command. |
| `emit(fn)` | Same pacing for any other command: `ctx.emit((o) => ctx.transport.writeV2(v2Id, body, o))`. |
| `sleep(ms)` | Wakes early on stop. |
| `brightness()` | Current brightness; the manager and store can change it live. |
| `signal` | Aborted on stop. Pass it to commands you send yourself. |
| `onCleanup(fn)` | Runs after the loop exits, before `stop()` resolves (bounded to 5 s). For native effects to turn off, a microphone to release. What it sends with `setLight` or `emit` still goes out, paced and without a signal: await it. |

## What the engine guarantees

- **Stop is a barrier.** `stop()` resolves after the loop has exited, every command in flight is answered, and cleanup ran. Anything sent afterwards (a "turn off" for instance) cannot be overwritten by a late frame. If a request hangs, `stop()` gives up waiting after 5 s: `runEffect(…).stop()` resolves `false` and the manager's `{ clean: false }`. A command may then still land; the store's `allOff()` sends "off" again a bit later for that reason.
- **No retry after stop.** The transport sends nothing more for a stopped effect, not even a retry after a rate limit.
- **Repeated failure ends the effect.** After two full rounds of lights without a single success (at least 6 failures), the effect ends with reason `failed` and the last error. Partial success, such as a white light ignoring a colour, is success.
- **Bounded duration.** 4 h by default, reason `expired`. `maxDurationMs: Infinity` removes the limit, for a wall tablet for instance.
- **Background tabs.** Effects keep running when the tab is hidden, on purpose (set a mood, switch tabs). Browsers throttle timers there, though: in Chrome, after about 5 minutes hidden, an effect wakes about once a minute.

## Pacing

| Transport | Gap between sends | In flight | Why |
| --- | --- | --- | --- |
| local | 120 ms | 3 | Waiting for each answer made rooms update in seconds; ~8 commands/s stays under the Zigbee guidance. |
| cloud | none | 1 | Each call crosses the relay and the remote API; bursts get rate-limited. Latency sets the pace. |

Smoothness comes from `transitiontime`: ask the bridge to fade to each target over about the time until that light's next update. The built-in `wave` measures that time, so it looks smooth on both transports.

## Native effects

`candle`, `fire`, `prism`… run on the light itself, through CLIP v2, so they need the cloud transport in a browser (or a local transport outside one). They outlive your loop: turn them off in `onCleanup`, as `drift({ native: 'candle' })` does.

## Across tabs and devices

The manager announces its effect on a `BroadcastChannel`. Other tabs list it in `elsewhere`. Starting an effect stops the other tabs' effects on the same lights; a store command on those lights, or `stopAll()`, also waits until they are silent (a few seconds at most).

Light ids belong to a bridge. With several bridges, give each one its own manager and channel, for instance `` createEffectManager({ channel: `hue-web:${bridgeId}` }) ``.

There is no such channel between devices: an effect started on a phone is only known to the phone.
