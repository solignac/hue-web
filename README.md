# hue-web

**A web wrapper for Philips Hue.** Drive your lights from any web page: over the LAN when you're home, through the cloud when you're not, with effects that stop the moment you say stop.

[![CI](https://github.com/solignac/hue-web/actions/workflows/ci.yml/badge.svg)](https://github.com/solignac/hue-web/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hue-web)](https://www.npmjs.com/package/hue-web)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```ts
import { createHueStore, createLocalTransport, pairBridge } from 'hue-web';

const bridge = await pairBridge({ onLinkButton: () => alert('Press the button on your bridge') });
if (bridge.status !== 'paired') throw new Error(`Bridge ${bridge.status}`);

const store = createHueStore({ transport: createLocalTransport(bridge) });
await store.refresh();
await store.setGroup('0', { on: true, bri: 180 }); // every light; the snapshot shows it at once
```

No IP address to type. No backend for local use. Zero dependencies, about 15 kB minified and gzipped for the whole library, tree-shakable.

## Why

The Hue API was designed for native apps. A web page runs into walls the official docs never mention. hue-web is the result of hitting each of them on a real setup:

| On the web… | hue-web |
| --- | --- |
| There is no mDNS or SSDP, and Philips' discovery service refuses other origins. | Finds the bridge through the cloud's view of it, the addresses you remember, and `philips-hue.local`. When the cloud can tell which bridge is yours, it pairs with that one only. |
| Pairing means walking to the bridge. | Tries the keys you already have, the cloud's own key, and a link-button press **through the cloud**, before asking for a physical press. |
| CLIP v2 (native effects, gradients) is blocked by CORS on the LAN. The remote API has no CORS at all. | Two transports, one interface: **local** for speed, **cloud** (via a 2 kB relay you deploy anywhere) for v2 and for when you're away. `localFirst` picks the fastest that works. |
| v1 answers HTTP 200 when it fails, and applies commands partially. | Errors are typed (`HueError.reason`), and a white light ignoring a colour is not a failure. |
| A naive effect loop keeps sending after "stop", floods the bridge, or dies silently. | An effect engine with a **stop barrier**, per-transport pacing, auto-stop on repeated failure, a maximum duration, and coordination across tabs. |
| A slider fires 60 events a second; a poll overwrites what you just set. | A store with coalesced commands (the last value always lands), a write mask, ordered reads and rollback on failure. |

## Install

```sh
npm install hue-web
```

ESM with TypeScript types. Web standards only (`fetch`, `AbortController`, `BroadcastChannel`), for browsers, Node 22+, Bun and Deno; the relay runs in any Fetch API runtime. CI tests Node 22 and 24. React is optional.

## Guide

### Pair once, without an IP

```ts
import { pairBridge } from 'hue-web';

const result = await pairBridge({
  knownKeys: [saved?.appKey], // tried first: a saved key survives address changes
  hints: [saved?.host],
  onLinkButton: () => showDialog('Press the round button on your Hue bridge'),
});

switch (result.status) {
  case 'paired': // { host, appKey, via }
    save({ host: result.host, appKey: result.appKey });
    break;
  case 'unreachable': // first visit: the bridge's certificate must be accepted once
    showLink(`https://${result.candidate ?? 'philips-hue.local'}`);
    break;
  case 'timeout': // nobody pressed the button
    break;
}
```

### Control lights

```ts
import { createHueStore, createLocalTransport, hexToXy } from 'hue-web';

const store = createHueStore({ transport: createLocalTransport(saved) });
const unsubscribe = store.subscribe(() => render(store.getSnapshot())); // { lights, groups, error, … }, read in the background

store.setLight('3', { on: true, xy: hexToXy('#ff8a00') });
store.setGroup('1', { bri: 120, transitiontime: 10 }); // a room, faded over 1 s
store.recallScene('1', sceneId);
store.allOff(); // everything off (with `effects`, every effect is stopped first)
```

Commands show in the snapshot at once, go out in the order you issued them (never two at a time on one light), and resolve `true` once the bridge applied them, or `false`: the snapshot is rolled back and `onCommandError` tells why. Rapid changes merge, so a slider's last value always lands. Reads run in the background while someone is subscribed: every 4 s locally, 30 s through the cloud.

### Effects

```ts
import { createEffectManager, createHueStore, drift, palettes, wave } from 'hue-web';

const effects = createEffectManager();
const store = createHueStore({ transport, effects }); // commands now stop the effect driving their lights
await store.refresh();

await effects.start(wave({ palette: palettes.sunset }), { lights: store.getSnapshot().lights, transport });
store.setLight('1', { bri: 80 }); // brightness is adopted by the running effect, not a reason to stop it
await effects.stop(); // { clean: true } once the bridge acknowledged the last frame: nothing can land after
```

Built in: `wave` (a palette scrolling across the room), `drift` (each light gliding between colours, optionally with a native `candle` or `fire` on top), `audioSync` (follows the microphone). Writing your own takes a loop: see [docs/effects.md](docs/effects.md).

### Local and cloud together

```ts
import { createCloudTransport, createRelayClient, localFirst } from 'hue-web';

const cloud = createCloudTransport({ relay: createRelayClient({ url: '/api/hue' }), tokens });
const store = createHueStore({ transport: cloud, effects }); // full v2 state, from anywhere

const fastest = localFirst({ fallback: cloud, local: () => loadBridge(), onMoved: saveBridge });
await effects.start(wave(), { lights, transport: fastest }); // the LAN when home, checked against the cloud's bridge id
```

The cloud needs a small relay that keeps your Hue app's secret off the browser. It is one function for Supabase, Cloudflare, Vercel, Deno or Node: [docs/cloud.md](docs/cloud.md).

### React

```tsx
import { useHue } from 'hue-web/react';

function Lights() {
  const { lights, error } = useHue(store);
  const running = useHue(effects, (s) => s.active?.name);
  // …
}
```

## API

| Import | |
| --- | --- |
| `createLocalTransport`, `createCloudTransport`, `createRelayClient`, `localFirst` | Reach a bridge. |
| `pairBridge`, `findBridge`, `probeBridge`, `checkKey`, `requestKey` | Find a bridge and get a key. |
| `createHueStore`, `readLights` | Shared, reactive state and commands. |
| `createEffectManager`, `runEffect`, `wave`, `drift`, `audioSync` | Effects. |
| `capabilities`, `isControllable`, `isPlug`, `isLit`, `nativeAnimation` | What a light can do and is doing. |
| `hexToXy`, `xyToHex`, `hexToHueSat`, `hueSatToHex`, `mirekToHex`, `samplePalette`, `palettes` | Colour. |
| `HueError`, `isHueError` | Typed failures: `unreachable`, `unauthorized` (pair or reconnect), `forbidden` (your relay refused you), `link-button`, `rate-limited`, `unavailable`, `unsupported`, `rejected`, `aborted`. |
| `hue-web/react` | `useHue`. |
| `hue-web/relay` | `createRelayHandler`, the server half of the cloud transport. |

Every export is documented in its type definitions.

## Limits

- **First visit:** each browser must accept the bridge's self-signed certificate once, and Chrome asks for local network access. No code can skip that.
- **CLIP v2 in a browser needs the cloud.** Local is v1 only (lights, groups, scenes, colorloop), which covers everything but native effects and gradients.
- **The cloud has a quota** of 50,000 calls a day per Hue app. Pair the local bridge for effects.
- **Effects are coordinated across tabs, not across devices.**
- **Hidden tabs are slow.** Browsers throttle timers in background tabs (Chrome, after about 5 minutes hidden: about one wake-up a minute), so an effect keeps running there, but barely moves.
- **Not the Entertainment API.** Effects use REST with bridge-side fades: smooth, but not frame-accurate for music.

More in [docs/field-notes.md](docs/field-notes.md): everything the Hue API does that its documentation doesn't make obvious.

## Contributing

Issues and pull requests are welcome, especially with behaviour observed on real hardware. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Thomas Solignac

hue-web is an independent project for Philips Hue, not affiliated with or endorsed by Signify or Philips. Hue is a trademark of Signify Holding B.V.; Philips is a registered trademark of Koninklijke Philips N.V., used under license by Signify.
