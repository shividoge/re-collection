# Publishing the site on GitHub Pages (free, no card, no server)

The public front page and the 3D walk-in viewer work as plain files. Everything a visitor reads is exported from the captures you marked public into `data/`, and the website is built in "static mode" so it reads those files instead of calling a server. It stays up when your laptop is closed, and the URL is stable.

**What it can't do:** it is read-only. There are no live Claude calls, no uploads, and no family tools. Run those on your Mac as usual.

**What goes public:** exactly what the live `/public` routes show. Only captures you marked public, only facts the family approved (never "don't bring this up", pending or rejected ones), only finished sessions, with no internal files. The export is tested to leave a private capture out entirely. Whatever you publish here is on the open internet, and GitHub keeps history, so decide before you push. Get the OK of everyone filmed.

## Before publishing: build and look at it on your Mac

1. Mark what to show (see `npm --prefix guide run publish`):
   ```bash
   npm --prefix guide run publish -- <capture id>
   ```
2. Build the static site into `.static-site/` (nothing is uploaded):
   ```bash
   ./deploy/static/build.sh
   ```
   It stops with a warning if any file is over GitHub's 100 MB limit.
3. Look at it, with range requests like GitHub has:
   ```bash
   node deploy/static/serve.mjs .static-site
   ```
   Open http://127.0.0.1:8790 and click through the front page and "Walk into a moment".
4. See what would go public, still without sending anything:
   ```bash
   ./deploy/static/publish.sh shividoge/braindance-site
   ```

## One-time setup (when you're ready; this is the part that makes it public)

Create a new **public** repo (GitHub Pages on a private repo needs a paid plan). Use a different repo from `braindance`, so your code and private history stay private:

```bash
gh repo create shividoge/braindance-site --public --description "Braindance public demo site"
```

Then publish:

```bash
./deploy/static/publish.sh shividoge/braindance-site --publish
```

Turn on Pages for that repo:

```bash
gh api -X POST repos/shividoge/braindance-site/pages -f 'source[branch]=main' -f 'source[path]=/'
```

After a minute or two the site is at **https://shividoge.github.io/braindance-site/** (use that link in the Devpost).

## Updating or taking it down

- **Update:** mark or unmark captures, run `build.sh`, then `publish.sh ... --publish` again.
- **Take it down:** unmark the captures and publish again to empty it, or make the repo private or delete it:
  ```bash
  gh repo delete shividoge/braindance-site
  ```
  Old versions stay in the repo's git history until the repo is deleted, so delete it if something shouldn't have been public.

## Limits

GitHub rejects any file over 100 MB, and asks sites to stay under about 1 GB. One 20-second capture is about 100 MB (the video and `depth.bin` are the big files). Two or three captures fit; ten won't.
