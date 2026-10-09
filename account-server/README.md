# Headroom Account Server

Optional accounts for Headroom: sign in once on a device and every computer in the account is listed and
connects without pairing. One file, no dependencies, Node.js 20 or later. It's a directory and key issuer only:
sessions go directly between devices and computers.

```bash
node server.mjs                       # http://0.0.0.0:8780, data in ./data
node server.mjs add-user <name>       # create an account (asks for the password)
node server.mjs list-users | reset-password <name> | reset-2fa <name> | delete-user <name>
node test.mjs                         # tests (in-process, temporary data dir)
```

Docker (build from the repository root, so the web app is included):

```bash
docker build -f account-server/Dockerfile -t headroom-accounts .
docker run -d --name headroom-accounts -p 8780:8780 -v headroom-accounts:/data headroom-accounts
```

Settings are environment variables: `PORT`, `BIND`, `DATA_DIR`, `TLS_CERT`/`TLS_KEY`, `TRUST_PROXY`,
`SIGNUP` (`first` | `open` | `closed`), `NAME`, `WEB_ROOT`. Back up `DATA_DIR`: `secret.key` derives every
device's per-computer keys, and losing it means signing everything in again.

See [docs/ACCOUNTS.md](../docs/ACCOUNTS.md) for setup, the trust model and the API.
