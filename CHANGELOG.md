# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/) (0.x: minor versions may break the API).

## [0.1.0] - 2026-10-14

First public release.

- Local (browser → bridge) and cloud (browser → relay → remote API) transports behind one interface.
- IP-free discovery and pairing: cloud-reported address, remembered hints, mDNS; known keys, the cloud's key, a remote link-button press, then the physical button.
- Effect engine with a stop barrier, per-transport pacing, auto-stop on repeated failure and a maximum duration; an effect manager coordinating tabs; built-in `wave`, `drift` and `audioSync` effects.
- Reactive store with ordered reads, a write mask, coalesced commands and rollback on failure.
- `hue-web/react`: `useHue`. `hue-web/relay`: a stateless Fetch API relay.

[0.1.0]: https://github.com/solignac/hue-web/releases/tag/v0.1.0
