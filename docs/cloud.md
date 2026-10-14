# Cloud setup

The cloud transport reaches the bridge from anywhere, and is the only way a web page gets CLIP v2 (native effects such as `candle` or `fire`, gradients). It goes: browser → **your relay** → Philips remote API → bridge.

Why a relay: the remote API answers browsers without CORS headers, and its OAuth flow needs a client secret that must never ship to a browser. The relay is one stateless function; tokens stay with the client.

## 1. Create a Hue app

On [developers.meethue.com/my-apps](https://developers.meethue.com/my-apps/), add a Remote API app. Set its **callback URL** to the page of your app that will receive `?code=…&state=…`. Note the client id and client secret.

## 2. Deploy the relay

Anywhere `Request` and `Response` exist. `authorize` is required and is your only gate: return `true` only for a positively identified user, and `false` whenever identification fails or your own configuration is missing. A caller it refuses gets reason `forbidden`.

**Supabase Edge Function** (Deno). `verify_jwt` alone is not a gate: the public anon key is a valid JWT.

```ts
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createRelayHandler } from 'npm:hue-web@0.1/relay';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
// Fail closed: an unset secret must not compare equal to an unidentified caller.
const owner = Deno.env.get('OWNER_EMAIL')?.trim().toLowerCase();
if (!owner) throw new Error('OWNER_EMAIL is not set');

Deno.serve(
  createRelayHandler({
    clientId: Deno.env.get('HUE_CLIENT_ID')!,
    clientSecret: Deno.env.get('HUE_CLIENT_SECRET')!,
    authorize: async (request) => {
      const jwt = request.headers.get('authorization')?.replace(/^Bearer /, '');
      if (!jwt) return false;
      const { data, error } = await supabase.auth.getUser(jwt);
      return !error && data.user?.email?.toLowerCase() === owner;
    },
  }),
);
```

**Next.js route handler**

```ts
// app/api/hue/route.ts
import { createRelayHandler } from 'hue-web/relay';
import { auth } from '@/auth';

// Built at the first request: `next build` imports this module without the secrets.
let relay: ((request: Request) => Promise<Response>) | undefined;
const handle = (request: Request) =>
  (relay ??= createRelayHandler({
    clientId: process.env.HUE_CLIENT_ID!,
    clientSecret: process.env.HUE_CLIENT_SECRET!,
    authorize: async () => !!(await auth()),
  }))(request);

export { handle as POST, handle as OPTIONS };
```

**Cloudflare Worker**

```ts
import { createRelayHandler } from 'hue-web/relay';

let relay: ((request: Request) => Promise<Response>) | undefined;

export default {
  // Built once per isolate: secrets are only known at the first request.
  fetch: (request: Request, env: Env) =>
    (relay ??= createRelayHandler({
      clientId: env.HUE_CLIENT_ID,
      clientSecret: env.HUE_CLIENT_SECRET,
      authorize: (r) => verifySession(r, env), // yours
    }))(request),
};
```

## 3. Connect from the page

```ts
import { createCloudTransport, createRelayClient, type TokenStore } from 'hue-web';

const relay = createRelayClient({
  url: '/api/hue',
  headers: async () => ({ authorization: `Bearer ${await sessionToken()}` }), // what `authorize` checks
});

// Tokens rotate on every refresh: the transport writes them back here.
const tokens: TokenStore = {
  get: () => JSON.parse(localStorage.getItem('hue.tokens') ?? 'null'),
  set: (t) => localStorage.setItem('hue.tokens', JSON.stringify(t)),
};

// 1. Send the user to Philips. `state` protects the callback against forgery.
const state = crypto.randomUUID();
sessionStorage.setItem('hue.state', state);
location.assign(await relay.authorizeUrl(state));

// 2. On the callback page. `exchange` also presses the bridge's link button
//    remotely and creates the application key: no trip to the bridge.
const params = new URLSearchParams(location.search);
const expected = sessionStorage.getItem('hue.state');
sessionStorage.removeItem('hue.state');
if (!expected || params.get('state') !== expected) throw new Error('OAuth state mismatch');
tokens.set(await relay.exchange(params.get('code') ?? ''));

// 3. Use it like any transport.
const cloud = createCloudTransport({ relay, tokens });
```

## What to expect

- **Latency**: hundreds of milliseconds per call. Fine for switches and sliders; for effects, pair the local bridge too and let [`localFirst`](../README.md#local-and-cloud-together) pick it.
- **Quota**: Philips allows 50,000 calls per 24 h per Remote API app. A continuous effect through the cloud sends several calls per second: hours of it can exhaust the day. The store polls every 30 s through the cloud for this reason.
- **Refresh**: access tokens last about a week and are refreshed transparently, one refresh at a time per token store. A store shared between tabs (like `localStorage`) lets a tab adopt tokens another tab already rotated.
