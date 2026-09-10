# Tailor Studio — Setup Guide (for testers)

Hey! Thanks for helping test this. Tailor Studio turns a folder of clothing
photos into ready-to-post Grailed listings and types them into Grailed's sell
form for you — but **you always review and click Publish yourself.** It never
logs in for you, never submits, and never touches your account when you're away.

This guide gets it running on your **Mac** in about 15–20 minutes. You'll use the
Terminal app a little — just copy/paste the commands. You don't need to
understand them.

> Before you start, the person who shared this with you (the owner) will send you
> **one thing separately**: an **API key** (a long secret string) for Step 4.
> Everything else — including the code link — is already in this guide. Keep the
> key private; treat it like a password.

---

## Step 1 — Install the things you need (one-time)

You need three things: **Node.js**, **Git**, and **Google Chrome**. Pick
**Option A** (one script — fastest) or **Option B** (download each yourself).

### Option A — install everything with one script (recommended)

Open **Terminal** (press `Cmd + Space`, type "Terminal", press Enter), then copy
and paste this whole block and press Enter. It installs **Homebrew** (a tool that
installs other tools), then Node, Git, and Chrome. Follow any on-screen prompts —
it may ask for your Mac password (you won't see it as you type; that's normal).

```bash
# 1) Install Homebrew (skips if you already have it)
if ! command -v brew >/dev/null 2>&1; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# 2) Make sure Homebrew is available in this Terminal (Apple Silicon + Intel)
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi

# 3) Install Node, Git, and Google Chrome
brew install node git
brew install --cask google-chrome

# 4) Show the versions so you can confirm it worked
echo "node: $(node -v)"; echo "git:  $(git --version)"
```

When it finishes you should see a `node:` version and a `git:` version printed at
the bottom. If Homebrew prints a line telling you to run an `eval "$(... brew
shellenv)"` command, copy/paste and run that line, then re-run the block.

### Option B — download each one yourself

1. **Node.js (version 20 or newer)** — download the **LTS** installer:
   https://nodejs.org/en/download and click through with the defaults.
2. **Google Chrome** — https://www.google.com/chrome/ (make sure it lands in your
   Applications folder).
3. **Git / Command Line Tools** — in Terminal run `xcode-select --install`, click
   **Install** in the dialog, and wait. ("already installed" is fine.)

**Quick check (either option)** — in Terminal, run these; each should print a
version, not an error:
```
node -v
git -v
```

---

## Step 2 — Download the code

In Terminal, run these one at a time (this puts the app in a folder on your
Desktop):
```
cd ~/Desktop
git clone https://github.com/Aidanz06/tailor-studio.git
cd tailor-studio
```

> If GitHub asks you to sign in, make a free account at https://github.com and
> tell the owner your GitHub username so they can add you to the repo. Prefer
> clicking over typing? You can use **GitHub Desktop** instead
> (https://desktop.github.com): paste `https://github.com/Aidanz06/tailor-studio.git`
> as the repo to clone, then come back to Terminal and run
> `cd ~/Desktop/tailor-studio`.

---

## Step 3 — Install the app's parts

Still in the `tailor-studio` folder, run:
```
npm install
```
This downloads everything the app needs. It takes a few minutes and prints a lot
of text — that's normal. As long as it finishes without a red **error**, you're
good.

---

## Step 4 — Add your key (this is the important part)

The app needs the key the owner sent you to write listings and look up prices.
You'll put it in a small settings file called `.env.local` inside the
`tailor-studio` folder.

**Do this in Terminal** (make sure you're still in the `tailor-studio`
folder — your prompt should show it):

1. Open a blank file in a simple editor:
   ```
   nano .env.local
   ```
   The Terminal turns into a basic text editor.

2. Type or paste these **two lines**, replacing the `<...>` parts with the exact
   values the owner sent you (keep the word `export` and the `=`, no spaces
   around the `=`, no quotes):
   ```
   export ANTHROPIC_API_KEY=<THE_KEY_THE_OWNER_SENDS_YOU>
   export GRAILED_ALGOLIA_KEY=<THE_SECOND_VALUE_THE_OWNER_SENDS_YOU>
   ```

3. Save and close: press **Ctrl + O**, then **Enter** (saves), then **Ctrl + X**
   (exits).

4. Check it worked — this should print your two lines back:
   ```
   cat .env.local
   ```

> The file name is exactly `.env.local` — the leading dot matters, and there's no
> `.txt` on the end. It lives only on your computer; the key never leaves your
> machine.

---

## Step 5 — Build and start the app

Run these two commands (the first one prepares the app, the second opens it):
```
npm run ui:build
npm run ui
```
The Tailor Studio window should open. **Leave the Terminal window open** while
you use the app — closing it closes the app.

Next time you want to open the app, you only need:
```
cd ~/Desktop/tailor-studio
npm run ui
```

---

## Step 6 — Your first listing

Inside the app:

1. On the Home screen you'll see a **Chrome status** row. Click **Launch Chrome**
   — a fresh Chrome window opens. **Sign in to Grailed there yourself** (you
   always do this part).
2. In that Chrome, go to **grailed.com/sell/new** (or click **Open Sell form** in
   the app). The status should turn to **"Chrome ready."**
3. Back in the app, click **New batch** and pick a folder of item photos. The app
   groups them and drafts titles, descriptions, and prices.
4. Open a draft, check it over, and confirm the suggested Grailed category.
   (Measurements go in Grailed's own form fields after the fill, if you want them.)
5. Click **Fill listing in Chrome**. The app types the listing into the sell
   form. **Review it in Chrome and click Publish yourself** — the app never
   submits.
6. Click **"I published — fill next draft"** to move to the next one.

That's the whole loop. Import a batch, review, fill, publish, repeat.

---

## Getting updates (when the owner ships changes)

The owner will keep improving the app. To pull the latest version, **quit the app
first**, then in Terminal run:
```
cd ~/Desktop/tailor-studio
git pull
npm install
npm run ui:build
npm run ui
```
- `git pull` downloads the newest code.
- `npm install` updates any changed parts (safe to run every time).
- `npm run ui:build` then `npm run ui` rebuilds and opens the updated app.

Your key file (`.env.local`), your saved listings, and your Grailed sign-in are
**kept** — updating never touches them. If `git pull` says you have local changes
blocking it, run `git stash` and then `git pull` again (or just ask the owner).

---

## If something goes wrong

- **"command not found: node" (or npm/git)** — the install in Step 1 didn't
  finish or the Terminal was open before installing. Quit and reopen Terminal,
  then try again.
- **The app opens but says a key is missing / import fails immediately** —
  re-check Step 4: the file must be named exactly `.env.local`, both lines start
  with `export`, and the key values are exactly what the owner sent (no quotes, no
  extra spaces). Run `cat .env.local` to confirm.
- **"Chrome not connected" won't go away** — click **Launch Chrome** in the app
  (don't use your everyday Chrome window), make sure it's the window the app
  opened, and that you've opened a **grailed.com/sell/new** tab in it.
- **A field didn't fill** — just fill that one field in Chrome yourself; the app
  shows which field and why in the fill checklist.
- **Anything else** — screenshot it and send it to the owner.

---

## What the app does and doesn't do (so you can relax)

- **Does:** organize your photos, draft listings, look up sold prices, and type a
  draft into the Grailed sell form when you click.
- **Does NOT:** log in for you, click Publish/submit, bump/offer/message on its
  own, or do anything on Grailed when you're not there. Every listing goes live
  only when **you** review it and hit Publish.

Thanks again for testing — your feedback on what's confusing or slow is the whole
point, so don't be shy about it.
