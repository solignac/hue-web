# Field notes

What the Hue API does that its documentation doesn't make obvious, and that hue-web handles for you. Each item cost real debugging time.

## Talking to the bridge from a web page

- **There is no discovery.** Browsers have neither mDNS nor SSDP, and `discovery.meethue.com` answers with `Access-Control-Allow-Origin: https://discovery.meethue.com`, so a page cannot read it. Relaying it through a server doesn't work either: it locates bridges by the caller's public IP, which would be the server's. What works: the bridge config read through the cloud (it includes `ipaddress`), and the `philips-hue.local` mDNS name, which the operating system resolves.
- **HTTPS and its certificate.** An HTTPS page can only call the bridge over HTTPS, and the bridge's certificate is self-signed: each browser must open `https://<bridge>` once and accept it. Until then, every call fails like a network error.
- **Chrome asks for local network access** (version 142 and later) the first time a public site calls a private address.
- **CLIP v2 is out of reach.** It requires a `hue-application-key` header, which triggers a CORS preflight the bridge does not satisfy. v1 works if requests carry no extra header, so v1 bodies go without `Content-Type`.

## CLIP v1

- **HTTP 200 for failures.** Errors come back as `[{ "error": { "type": 1, … } }]` with status 200. Type 1 is an unauthorised key, 101 the link button not pressed.
- **Partial success.** Each attribute is applied separately: `{ on, bri, hue }` sent to a white-only light turns it on, sets brightness, and returns an error for `hue`. Treating that as a failure kills effects on mixed rooms.
- **`on: true` on an unpowered light.** A light switched off at the wall keeps `on: true`; only `reachable: false` tells.
- **`mindimlevel` is in thousandths of a percent** (200 means 0.2 %), unlike v2's `min_dim_level`, in percent.
- **Colour priority is xy > ct > hs**, not the order you sent them. Merging two commands must drop the older colour entirely.
- **Rates.** About 10 commands per second to lights for the whole bridge (they share one Zigbee network), and one group command per second: a group command is broadcast to every light of the room. The store spaces its commands accordingly.
- **Plugs.** A group action turns plugs on with the lights. Effects should address lights one by one and skip plugs.

## Remote API

- **No CORS.** A preflight to `api.meethue.com/route/…` gets a 401 without any `Access-Control-*` header. Hence the relay.
- **`Content-Type: application/json` is mandatory** for the calls that press the link button and create a key; without it the remote answers 415.
- **The link button can be pressed remotely** (`PUT /route/api/0/config {"linkbutton": true}`), which is how a key is created without walking to the bridge.
- **Refresh tokens rotate.** A refresh token works once. Two tabs refreshing at the same time leave one of them with a dead token, unless they share storage and re-read it first.
- **Quota.** 50,000 calls per 24 h per app. A 429 burst during an effect is better retried with backoff than dropped, except once the effect is stopped.
