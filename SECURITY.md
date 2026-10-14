# Security

Please report vulnerabilities privately, through **Security → Report a vulnerability** on this repository, not in a public issue.

Only the latest release is supported.

Worth knowing when you deploy hue-web:

- The relay's `authorize` hook is your only gate. An open relay lets anyone use your Hue app's credentials.
- Cloud tokens and application keys control the lights. Store them like passwords: `localStorage` is fine for a personal app on your own devices, not for a shared machine.
