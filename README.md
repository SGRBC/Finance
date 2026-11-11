# SGRBC Finance Tracker

An installable web app (PWA) for tracking incoming credits and outgoing debits. One codebase runs on desktop browsers, Android and iPhone.

Starting data comes from `SGRBC Finance Cash Flow.xlsx` (468 transactions, categories from the *Category* sheet).

## Features
- Add / edit / delete credits and debits (amount, category, date-time, description)
- Filter by month, category, type, text search; running Credits / Debits / Balance totals
- Summary tab: totals per category and per month
- Export CSV, JSON backup / restore, reset to original spreadsheet data
- **Shared data file in Google Drive** that every device reads (auto-refreshes every minute)
- **Google sign-in for editing; everyone else is view-only**
- Light/dark mode, touch friendly, works offline (shows last downloaded copy)

## Two modes
| Mode | When | Behaviour |
|------|------|-----------|
| Local-only | `GOOGLE_CLIENT_ID` is empty in `app/config.js` (default) | Data stays in this browser; no sign-in; anyone using the device can edit |
| Google Drive | `GOOGLE_CLIENT_ID` is set | One JSON file in Google Drive is the single source of truth for all devices |

## How access control works (Google Drive mode)
The data file lives in the **owner's** Google Drive and is shared with Google's own sharing system:

| Person | Drive permission | In the app |
|--------|------------------|-----------|
| Owner | Owner | Edits, and can manage who has access (⋮ → *Share & access*) |
| Editor | Editor | Signs in with Google, can add / change / delete |
| Viewer | Viewer | Signs in, can only look |
| Anyone else | none | Sees nothing: no data is loaded until a listed account signs in |

Enforcement is done by **Google Drive**, not by the page: every save is an authenticated write to the Drive file, and Google rejects it unless that account has Editor rights. Editing the page's code in a browser cannot grant write access. The app also hides the add/edit buttons for viewers. The app only requests the narrow `drive.file` permission, so it can never see the rest of anyone's Drive.

## One-time setup (about 10 minutes, done by the file owner)
1. Go to <https://console.cloud.google.com/>, create a project (e.g. "SGRBC Finance").
2. **APIs & Services → Library**: enable **Google Drive API** and **Google Picker API**.
3. **APIs & Services → OAuth consent screen**: choose *External* (or *Internal* for a Google Workspace org), add the scope `.../auth/drive.file`, and add your editors/viewers as **Test users** while the app is in "Testing" (or publish the app).
4. **Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorized JavaScript origins** add *only* the https address where you host the app (e.g. `https://yourname.github.io`). Under **Authorized redirect URIs** add the full address of the app page (e.g. `https://yourname.github.io/SGRBC/index.html`); the installed home-screen app signs in by redirect and needs it. Copy the **Client ID**.
5. **Credentials → Create credentials → API key**. Restrict it: *Application restrictions → Websites* = your https address, *API restrictions* = Google Drive API + Google Picker API. Copy the key.
6. Note your **project number** (Cloud Console → Dashboard). It is also the digits before the `-` in the client ID.
7. Edit `app/config.js` and fill in `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY`, `GOOGLE_APP_ID`.
8. Host the `app/` folder on any **HTTPS** static host (GitHub Pages, Netlify, Cloudflare Pages, internal server).
9. Open the app, ⋮ → *Sign in with Google*, then click **Paste shared file link** and paste the Drive link of the existing shared data file (`SGRBC Finance Data.json`). The app no longer creates data files; all changes go only to that shared file.
10. ⋮ → **Share & access…** → add people by Google email as **Viewer** or **Editor**. Do not turn on "anyone with the link": the app never loads data without a sign-in, and removes that option from the sharing list.
11. ⋮ → **Copy link for other devices** and send it. Optional: put the file ID in `DRIVE_FILE_ID` in `config.js` so every device uses the file automatically.

The client ID, API key and project number are *public by design* (they identify the app, they are not passwords), which is why the restrictions in steps 4–5 matter. Never put a client **secret** in this app; none is needed.

### First time on another device / for another person
- Open the shared link and sign in with Google. Nothing is shown until you sign in, and only accounts listed on the file as Viewer or Editor can see the data.
- Use the account you were made Viewer or Editor for. Because the app only has `drive.file` access, Google asks you to **confirm the file once** (a Google file-picker opens: choose *SGRBC Finance Data.json*). After that it works on every device you sign in on.

## Try it on your computer
```
node tools/serve.mjs            # serves ./app at http://127.0.0.1:8080/
```
Local-only mode works as-is. Google sign-in needs `http://127.0.0.1:8080` (or your real address) listed under Authorized JavaScript origins.

## Install on a phone
Host over HTTPS, open the URL, then:
- **Android (Chrome):** menu (⋮) → *Install app* / *Add to Home Screen*
- **iPhone (Safari):** Share → *Add to Home Screen*

## Good to know
- Concurrent edits: each save re-downloads the latest file, applies just your change, then uploads, so two editors adding different entries do not overwrite each other (only edits made within the same second or so can still collide, last write wins).
- Drive keeps version history for the file (right-click the file in Drive → *Manage versions*), which is your safety net against mistakes.
- The attachment image paths from the spreadsheet are not included.
- Tokens are held in memory only (never saved to disk); signing out revokes them.
- When you change any app file, bump `CACHE` in `app/sw.js`.

## Developer tools
`tools/build-seed.mjs` converts a text dump of the workbook into `app/seed.json`; `tools/make-icons.mjs` regenerates icons; `tools/serve.mjs` is a local test server that refuses to bind to all interfaces.
