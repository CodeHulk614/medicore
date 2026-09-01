# MediCore — START HERE (absolute beginner guide)

This gets your apps live on the internet, installable on phones, with a real database.
No prior experience assumed. Follow it top to bottom. It takes about 30–40 minutes the
first time. You will create 3 free accounts: GitHub, MongoDB Atlas, and Netlify.

Everything is free. You do NOT need to type any code. Where you see a box like this:

    like this

it's either something to click/paste, or a value to copy. Take your time.

---

## What you're about to build (plain English)

- Your project has two parts: the **apps** (what people see) and the **API + database**
  (where the data lives). We'll put the apps on **Netlify**, and the data in **MongoDB Atlas**.
- **GitHub** is just online storage for your project files. Netlify reads your project from
  GitHub and puts it online automatically. When you change the project, you "push" to GitHub
  and Netlify updates itself.

Order we'll do it: Database (Atlas) → Code storage (GitHub) → Hosting (Netlify) → connect them.

---

## PART 1 — Create the database (MongoDB Atlas)

1. Go to **https://www.mongodb.com/atlas** and click **Try Free**. Sign up (Google login is fine).
2. When it asks what to build, pick any option / "I'm learning". Continue.
3. **Create a cluster:** choose the **M0 FREE** tier. Pick any cloud/region near you.
   Click **Create**. Wait 1–3 minutes while it sets up.
4. A "Security Quickstart" or "Connect" popup appears. Do these two things:
   - **Create a database user:** enter a **username** and click **Autogenerate Secure Password**
     (or type one). **Copy both the username and password somewhere safe now** — you'll need them.
     Avoid special characters like `@ : / ?` in the password to keep the next step simple.
   - **Network access:** choose **Add My Current IP Address**, then also click
     **Allow Access from Anywhere** (it fills in `0.0.0.0/0`). This second one is REQUIRED,
     without it the live site can't reach the database. Confirm.
5. Now get the connection link. Click **Connect** (on your cluster) → **Drivers**.
   Under "Driver" leave Node.js. You'll see a link like:

       mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority

   Copy it. Then **replace `<username>` and `<password>`** with the real ones from step 4
   (remove the `< >` too). Keep this final link, you'll paste it into Netlify later. Example
   of the finished link:

       mongodb+srv://victor:MyPass123@cluster0.ab12c.mongodb.net/?retryWrites=true&w=majority

   Keep this private. It's like a key to your database.

---

## PART 2 — Put the project on GitHub

You already did this once, so if `CodeHulk614/medicore` already has the latest files, **skip to
Part 3.** Otherwise, the simplest no-terminal way:

1. Go to **https://github.com** and sign in.
2. Top-right **+** → **New repository**. Name it (e.g. `medicore`). Leave it empty (no README).
   Click **Create repository**.
3. On the next page click **uploading an existing file**.
4. Open the extracted **`medicore-netlify`** folder on your computer, select ALL the files and
   folders inside it, and drag them into the browser upload area. (If your computer made a folder
   inside a folder, go in until you see files like `netlify.toml`, `server.js`, `public`.)
   Do NOT upload the `node_modules` folder if you see one; you don't need it.
5. Wait for the uploads to finish, then click **Commit changes**. Your code is now on GitHub.

(If you prefer VS Code: open the folder, click the Source Control icon on the left, Commit,
then "Publish/Sync". Either way is fine.)

---

## PART 3 — Host the apps on Netlify

1. Go to **https://www.netlify.com** and **Sign up** — choose **Sign up with GitHub** (easiest).
2. Click **Add new site** → **Import an existing project** → **Deploy with GitHub**.
3. Authorize Netlify if asked, then pick your **medicore** repository from the list.
4. It shows build settings. **Don't change anything** — the project already tells Netlify what to
   do (it reads a file called `netlify.toml`). Click **Deploy site** (or "Deploy medicore").
5. Wait for it to build (1–3 min). When it says **Published**, you have a live address like
   `https://sparkly-name-123.netlify.app`. (You can rename it later: Site configuration →
   Change site name.)

At this point the site is up but the database isn't connected yet, so it won't save data.
That's Part 4.

---

## PART 4 — Connect the database to Netlify (the important step)

1. In your Netlify site, click **Site configuration** (left menu) → **Environment variables**.
2. Click **Add a variable** → **Add a single variable**.
   - **Key:**   

         MONGODB_URI

   - **Value:** paste your finished MongoDB link from Part 1, step 5.
   - Scope: leave as "All". Click **Create variable**.
3. Now make Netlify use it: go to **Deploys** (left menu) → **Trigger deploy** → **Deploy site**.
   (Environment variables only take effect on a fresh deploy — this step is easy to forget.)
4. Wait for **Published** again.

---

## PART 5 — Check it works

1. In your browser go to your site address **+ `/api/health`**, for example:

       https://your-site.netlify.app/api/health

   You should see something like `{"ok":true,"patients":21,...}`. That means the API + database
   are working.
2. Go to your site address **`/doctor.html`** (or just `/` for the patient app). Log in with:

       email:    tunde@demo.ng
       password: demo1234

   (All demo accounts use the password `demo1234`.)
3. The real test: log into a staff app, **clock in**, then **refresh the page**. If you stay
   clocked in, the database is saving correctly. 🎉
4. In MongoDB Atlas → **Browse Collections**, you'll now see a database called `medicore` with a
   collection `store`. That's your data.

---

## PART 6 — Install an app on your phone

Open your site address on the phone's browser, then:
- **Android (Chrome):** tap the **⋮** menu → **Install app** (or the "Add to Home screen" banner).
- **iPhone (Safari):** tap **Share** → **Add to Home Screen**.

Each app installs separately with its own icon. The app URLs:

    Patient        /                     Dispatch       /dispatch.html
    Doctor         /doctor.html          Crew           /crew.html
    Front office   /frontdesk.html       Rider          /rider.html
    Pharmacy       /pharmacy.html        Payer (HMO)    /payer.html
    Lab            /lab.html             Community      /chw.html
    Admin          /admin.html

---

## If something goes wrong (common fixes)

- **`/api/health` shows an error, or the app won't save / keeps logging out:**
  Almost always the database isn't connected. Recheck:
  1. Atlas → Network Access includes **0.0.0.0/0** (allow from anywhere).
  2. Your `MONGODB_URI` in Netlify has the **real username and password** (no `< >` left in it).
  3. You clicked **Trigger deploy** AFTER adding the variable.
- **See the exact error:** Netlify → **Logs** → **Functions** → click **api**, then reload your
  site and do the action that fails. The red error line tells you what's wrong (usually
  "authentication failed" = wrong password, or a timeout = the 0.0.0.0/0 rule is missing).
- **Password has special characters** (`@ : / ? #`): they break the link. Easiest fix — in Atlas,
  Database Access → Edit the user → set a password with only letters and numbers, update the link.
- **Netlify build failed:** open the failed deploy → read the log's last lines. If it mentions a
  missing package, make sure `package.json` was included in your GitHub upload.

---

## Updating later

When you (or I) change the project:
1. Upload/replace the changed files on GitHub (or push from VS Code).
2. Netlify redeploys automatically. If you changed an environment variable, also do
   **Deploys → Trigger deploy**.

That's it. If you get stuck on any single step, tell me the step number and what you see on
screen, and I'll walk you through that exact spot.
