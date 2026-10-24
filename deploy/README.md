# Putting Braindance on Vultr

This gives the public front page a stable URL that stays up when your laptop sleeps. It's the MLH **Best Use of Vultr** track, and the server is a plain Vultr cloud server.

**What goes up:** the website, the guide's code, and only the captures you marked public (plus their finished sessions). **What stays on your Mac:** every private capture, `guide/.env`, your Anthropic key, and the team password. The server has no Anthropic key, so visitors can't start Claude sessions or spend credits. Its team key is random and never shared, so nobody can upload or approve anything.

## One-time setup (about 15 minutes)

You do these yourself; they involve your accounts and payment.

1. **Vultr account and credits.** Sign up at vultr.com. For the MLH prize, use the credit link from the MLH/Cal Hacks Vultr page. Don't enter card details anywhere except Vultr's own site.
2. **An SSH key** (skip if you have one):
   ```bash
   ssh-keygen -t ed25519 -C "braindance-vultr"
   cat ~/.ssh/id_ed25519.pub
   ```
   In Vultr: *Account → SSH Keys → Add*, and paste the line that starts `ssh-ed25519`. That's the public key; never share the private one.
3. **Create the server** (*Products → Deploy*):
   - Type: **Cloud Compute**, shared CPU (the regular one is fine)
   - Location: **Silicon Valley** (closest to the judges)
   - Image: **Ubuntu 24.04 LTS**
   - Plan: 2 GB RAM is comfortable; 1 GB works. About $5–12 a month, which your credits cover
   - SSH key: tick the one you added. Leave IPv6 and auto-backups off.
4. **Wait about a minute**, then copy the server's IPv4 address from the Vultr page. Below it's `203.0.113.7`; use yours.
5. **Set the server up** (run on your Mac, from the repo folder). It installs Node and Caddy, makes a locked-down service, and prints your site's address:
   ```bash
   ssh root@203.0.113.7 'bash -s' < deploy/setup-server.sh
   ```
   Your URL will be `https://203-0-113-7.sslip.io`. That works with no domain, and the HTTPS certificate is free and automatic. To use your own domain instead, point its A record at the IP first and run `ssh root@203.0.113.7 'DOMAIN=braindance.example.com bash -s' < deploy/setup-server.sh`.

## Every deploy

1. Mark what you want visitors to see (only after everyone filmed has agreed):
   ```bash
   npm --prefix guide run publish -- <capture id>
   npm --prefix guide run publish -- --list
   ```
2. Check what would go up without sending anything:
   ```bash
   ./deploy/deploy.sh root@203.0.113.7 --dry-run
   ```
3. Deploy:
   ```bash
   ./deploy/deploy.sh root@203.0.113.7
   ```
   It builds the site, copies the public captures (the table capture is about 100 MB), restarts the service, and prints the live URL after checking it answers.

To **take something down**, run `publish -- <id> --off` and deploy again; the capture is deleted from the server. To take **everything** down, `ssh root@203.0.113.7 systemctl stop braindance`, or destroy the server in Vultr.

## Before you share the link

- Open the URL in a private window. The front page must load with no password.
- Open `https://<your-url>/api/captures`. It must say `Missing or wrong X-Braindance-Key`.
- Look at what's public with `npm --prefix guide run publish -- --list`. Anything with a real person's face or name in it needs their OK.

## Troubleshooting

- **`deploy.sh` says nothing is public:** mark a capture first (step 1 above).
- **The URL doesn't load right after setup:** Caddy gets the certificate on the first request and can take up to a minute. `ssh root@203.0.113.7 journalctl -u caddy -n 30`
- **The site loads but is empty or broken:** `ssh root@203.0.113.7 journalctl -u braindance -n 30`
- **Run the dry run first** if you aren't sure; it needs the server reachable but changes nothing.

## For the Devpost

Say that the demo site runs on Vultr: a cloud server serving a read-only mirror of the public captures, with the Claude calls kept off the public server.
