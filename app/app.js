"use strict";
(() => {
  const CFG = window.SGRBC_CONFIG || {};
  const driveMode = Boolean(CFG.GOOGLE_CLIENT_ID);
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const DRIVE = "https://www.googleapis.com/drive/v3";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const LOCAL_KEY = "sgrbc-finance-v1";          // local-only mode data
  const CACHE_KEY = "sgrbc-finance-cache-v1";    // last copy downloaded from Google Drive (for fast/offline viewing)
  const FILE_KEY = "sgrbc-finance-file-id";
  const PAGE = 50;
  const DEBIT_CATEGORIES = ["Pastoral Colabor", "Benevolence", "Utilities", "Recurring", "Special"];
  // Retired categories: old entries keep them (and still count in the totals), but they are not offered in the Category filter or the chart options.
  const HIDDEN_CATEGORIES = new Set(["Custodian", "Honorarium", "Representation"]);
  const listedCategory = (c) => !HIDDEN_CATEGORIES.has(c);
  const MAX_BYTES = 20 * 1024 * 1024;
  const MAX_ATTACH = 150000;                      // max length of one stored attachment (data URL characters, ~110 KB)
  const MAX_PHOTO_FILE = 25 * 1024 * 1024;        // largest original image we will try to read
  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const validFileId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{10,100}$/.test(s);
  const validEmail = (s) => typeof s === "string" && s.length <= 254 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s);

  let state = { categories: { Credit: [], Debit: [] }, transactions: [] };
  const currentMonth = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  let filters = { year: currentMonth().slice(0, 4), month: currentMonth().slice(5, 7), category: "", search: "", type: "" };   // current year + month is the default view ("" = all)
  let shown = PAGE;
  let editingId = null;
  let formType = "Credit";
  let formAttachment = "";

  // Drive mode state
  const session = { token: "", expires: 0, email: "", name: "" };
  const drive = { fileId: "", status: "init", owner: false, metaDenied: false };
  let role = driveMode ? "viewer" : "editor";
  const canEdit = () => role === "editor";
  const hasToken = () => Boolean(session.token) && Date.now() < session.expires - 30000;

  // ---------- helpers ----------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const monthLabel = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  const nowLocal = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const toast = (msg) => {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(() => (t.hidden = true), 3500);
  };
  const scripts = {};
  const loadScript = (src) => (scripts[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = resolve;
    s.onerror = () => { delete scripts[src]; reject(new Error("script")); };
    document.head.append(s);
  }));

  // ---------- validation (also applied to imported / downloaded data) ----------
  const validAttachment = (s) =>
    typeof s === "string" && s.length <= MAX_ATTACH && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(s);

  const isValidTx = (t) =>
    t && typeof t === "object" &&
    (t.attachment === undefined || validAttachment(t.attachment)) &&
    (t.type === "Credit" || t.type === "Debit") &&
    typeof t.category === "string" && t.category.length > 0 && t.category.length <= 60 &&
    typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t.date) &&
    typeof t.amount === "number" && Number.isFinite(t.amount) && t.amount > 0 && t.amount <= 1e9 &&
    typeof t.description === "string" && t.description.length <= 200 &&
    typeof t.id === "string" && t.id.length > 0 && t.id.length <= 64;

  const sanitize = (data) => {
    if (!data || typeof data !== "object" || !Array.isArray(data.transactions)) throw new Error("bad format");
    const cats = { Credit: [], Debit: DEBIT_CATEGORIES.slice() };
    {
      const src = data.categories && Array.isArray(data.categories.Credit) ? data.categories.Credit : [];
      for (const c of src) if (typeof c === "string" && c && c.length <= 60 && !cats.Credit.includes(c)) cats.Credit.push(c);
    }
    const seen = new Set();
    const txs = [];
    for (const t of data.transactions) {
      if (!isValidTx(t) || seen.has(t.id)) continue;
      seen.add(t.id);
      if (!cats[t.type].includes(t.category)) cats[t.type].push(t.category);
      const clean = { id: t.id, date: t.date, type: t.type, category: t.category, amount: t.amount, description: t.description };
      if (t.attachment) clean.attachment = t.attachment;
      txs.push(clean);
    }
    if (!txs.length && data.transactions.length) throw new Error("no valid rows");
    return { categories: cats, transactions: txs };
  };

  // ---------- local storage ----------
  const saveLocal = () => {
    if (driveMode) return;   // Drive mode never stores the shared data on the device
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); }
    catch { toast("Could not save on this device: browser storage is full or blocked."); }
  };
  const readLocal = (key) => {
    try { const raw = localStorage.getItem(key); return raw ? sanitize(JSON.parse(raw)) : null; }
    catch { return null; }
  };
  const loadSeed = async () => {
    const res = await fetch("seed.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("seed unavailable");
    return sanitize(await res.json());
  };

  // ---------- Google auth ----------
  let tokenClient = null;
  let waiter = null;
  const initAuth = async () => {
    await loadScript("https://accounts.google.com/gsi/client");
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        const w = waiter; waiter = null;
        if (!w) return;
        if (r.error || !r.access_token || !google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) { w.reject(new Error("auth")); return; }
        session.token = r.access_token;
        session.expires = Date.now() + Number(r.expires_in || 3600) * 1000;
        w.resolve(session.token);
      },
      error_callback: () => { const w = waiter; waiter = null; if (w) w.reject(new Error("auth")); },
    });
  };
  const authReady = (async () => { if (driveMode) { try { await initAuth(); } catch { /* shown on sign-in */ } } })();

  // Installed app (home-screen PWA): the Google popup cannot report back from the Custom Tab Android opens, so sign-in
  // uses a full-page redirect instead (see signInRedirect / takeRedirectToken). Silent re-auth is not possible there.
  const STATE_KEY = "sgrbc-oauth-state";
  const redirectUri = () => new URL("index.html", location.href).href;
  const signInRedirect = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const st = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem(STATE_KEY, st); } catch { toast("Sign-in needs browser storage, which is blocked."); return; }
    const p = new URLSearchParams({
      client_id: CFG.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: "token", scope: SCOPE,
      state: st, include_granted_scopes: "true", prompt: "select_account",
    });
    if (session.email) p.set("login_hint", session.email);
    location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
  };
  // Reads the token Google put in the URL fragment after the redirect. Returns true when a token was accepted.
  const takeRedirectToken = () => {
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.has("access_token") && !h.has("error")) return false;
    history.replaceState(null, "", location.pathname + location.search);
    let expected = "";
    try { expected = localStorage.getItem(STATE_KEY) || ""; localStorage.removeItem(STATE_KEY); } catch { /* ignore */ }
    const token = h.get("access_token");
    const scopes = (h.get("scope") || "").split(" ");
    if (!token || !expected || h.get("state") !== expected || !scopes.includes(SCOPE)) { toast("Sign-in was cancelled or failed."); return false; }
    session.token = token;
    session.expires = Date.now() + (Number(h.get("expires_in")) || 3600) * 1000;
    return true;
  };

  const getToken = async () => {
    if (hasToken()) return session.token;
    if (isInstalled()) throw new Error("auth");
    await authReady;
    if (!tokenClient) throw new Error("auth");
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject };
      tokenClient.requestAccessToken({ prompt: session.email ? "" : "select_account", login_hint: session.email || undefined });
    });
  };

  // Drive REST call with a 20 s timeout. Always uses the signed-in user's token (no anonymous access).
  const api = async (url, opts = {}) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    const headers = { ...(opts.headers || {}) };
    if (hasToken()) headers.Authorization = `Bearer ${session.token}`;
    try { return await fetch(url, { ...opts, headers, signal: ctl.signal, cache: "no-store" }); }
    finally { clearTimeout(timer); }
  };
  const readJson = async (res) => {
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("too large");
    return JSON.parse(text);
  };

  const fetchUser = async () => {
    const res = await api(`${DRIVE}/about?fields=user(emailAddress,displayName)`);
    if (!res.ok) throw new Error("user");
    const u = (await readJson(res)).user || {};
    session.email = typeof u.emailAddress === "string" ? u.emailAddress : "";
    session.name = typeof u.displayName === "string" ? u.displayName : "";
  };

  // ---------- Drive data file ----------
  const setFileId = (id) => {
    drive.fileId = id;
    try { localStorage.setItem(FILE_KEY, id); } catch { /* ignore */ }
  };

  // Downloads the data file with the signed-in token. Returns { status, data }; nothing is put on screen here.
  const loadRemote = async () => {
    let res;
    try { res = await api(`${DRIVE}/files/${drive.fileId}?alt=media`); }
    catch { return { status: "offline" }; }
    if (res.status === 401) { session.token = ""; return { status: "needsignin" }; }
    if (res.status === 403 || res.status === 404) return { status: "noaccess" };
    if (!res.ok) return { status: "error" };
    try { return { status: "ok", data: sanitize(await readJson(res)) }; } catch { return { status: "invalid" }; }
  };

  const loadRole = async () => {
    role = "viewer"; drive.owner = false; drive.metaDenied = false; drive.notListed = false;
    if (!hasToken()) return;
    try {
      const res = await api(`${DRIVE}/files/${drive.fileId}?fields=ownedByMe,capabilities(canEdit,canShare),permissions(type,role,emailAddress)`);
      if (!res.ok) { drive.metaDenied = true; return; }
      const m = await readJson(res);
      drive.owner = m.ownedByMe === true;
      role = m.capabilities && m.capabilities.canEdit === true ? "editor" : "viewer";
      // Google only returns the complete access list to people who can manage sharing (viewers get a partial list),
      // so only then must the account be named in it. For everyone else, Drive itself already allowed the download.
      const fullList = m.ownedByMe === true || (m.capabilities && m.capabilities.canShare === true);
      if (fullList && Array.isArray(m.permissions) && m.permissions.length && session.email) {
        const me = session.email.toLowerCase();
        drive.notListed = !m.permissions.some((p) => p.type === "user" && typeof p.emailAddress === "string" && p.emailAddress.toLowerCase() === me);
      }
    } catch { drive.metaDenied = true; }
  };

  const clearData = () => { state = { categories: { Credit: [], Debit: [] }, transactions: [] }; };

  // Data is only fetched and shown when the user is signed in and Google confirms access to the shared file.
  const refresh = async (manual) => {
    if (!driveMode) return;
    role = "viewer";
    if (!drive.fileId) { drive.status = "nofile"; clearData(); fullRender(); updateUi(); return; }
    if (!hasToken()) { drive.status = "needsignin"; clearData(); fullRender(); updateUi(); return; }
    const r = await loadRemote();
    drive.status = r.status;
    if (r.status === "ok") {
      await loadRole();
      if (drive.notListed) { drive.status = "notlisted"; role = "viewer"; clearData(); } else state = r.data;
    } else clearData();
    fullRender();
    updateUi();
    if (manual) toast(drive.status === "ok" ? "Up to date" : "Could not refresh");
  };

  // Every change: download latest -> apply change -> upload. Google Drive rejects the upload unless the signed-in
  // account really has edit rights, so this cannot be bypassed by editing the page.
  const mutate = async (fn) => {
    if (!driveMode) { state = sanitize(fn(state)); saveLocal(); return true; }
    if (!canEdit()) { toast("View only: you do not have edit access."); return false; }
    try {
      await getToken();
      const cur = await api(`${DRIVE}/files/${drive.fileId}?alt=media`);
      if (!cur.ok) throw new Error("read");
      const next = sanitize(fn(sanitize(await readJson(cur))));
      const put = await api(`${UPLOAD}/files/${drive.fileId}?uploadType=media`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
      });
      if (!put.ok) throw new Error(put.status === 403 ? "denied" : "write");
      state = next;
      return true;
    } catch (e) {
      toast(e.message === "denied" ? "Google Drive refused the change: you do not have edit access." : "Could not save to Google Drive. Nothing was changed.");
      await refresh();
      return false;
    }
  };


  // Accepts a Drive link (…/d/ID/…, …?id=ID) or a bare file ID.
  const parseDriveId = (input) => {
    const s = String(input || "").trim();
    if (validFileId(s)) return s;
    let u;
    try { u = new URL(s); } catch { return ""; }
    if (u.protocol !== "https:" || !/^(drive|docs)\.google\.com$/.test(u.hostname)) return "";
    const m = u.pathname.match(/\/d\/([A-Za-z0-9_-]{10,100})/);
    const id = m ? m[1] : u.searchParams.get("id");
    return validFileId(id) ? id : "";
  };
  const linkError = (msg) => { const e = $("linkError"); e.textContent = msg || ""; e.hidden = !msg; };
  const openLinkDialog = () => {
    $("linkInput").value = "";
    linkError("");
    $("linkDlg").showModal();
    $("linkInput").focus();
  };
  const submitLink = async (ev) => {
    ev.preventDefault();
    const raw = $("linkInput").value.trim();
    if (/docs\.google\.com\/spreadsheets/.test(raw)) {
      linkError("That is a Google Sheet. This app stores its data in a file named “SGRBC Finance Data.json” in Google Drive — paste that file's link.");
      return;
    }
    const id = parseDriveId(raw);
    if (!id) { linkError("That does not look like a Google Drive file link."); return; }
    $("linkDlg").close();
    setFileId(id);
    await refresh(true);
  };

  const pickFile = async () => {
    try {
      const token = await getToken();
      await loadScript("https://apis.google.com/js/api.js");
      await new Promise((resolve) => gapi.load("picker", { callback: resolve }));
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(false).setMimeTypes("application/json");
      if (drive.fileId) view.setFileIds(drive.fileId);
      const builder = new google.picker.PickerBuilder()
        .addView(view)
        .setOrigin(`${location.protocol}//${location.host}`)
        .setOAuthToken(token)
        .setSize(Math.max(566, Math.min(1000, window.innerWidth - 24)), Math.max(350, Math.min(620, window.innerHeight - 24)))
        .setCallback((d) => {
          if (d.action !== google.picker.Action.PICKED || !d.docs || !d.docs[0]) return;
          const id = d.docs[0].id;
          if (!validFileId(id)) { toast("That file cannot be used."); return; }
          setFileId(id);
          refresh(true);
        });
      if (CFG.GOOGLE_APP_ID) builder.setAppId(CFG.GOOGLE_APP_ID);
      builder.build().setVisible(true);
    } catch { toast("Could not open the Google file picker."); }
  };

  const signIn = async () => {
    if (isInstalled()) { signInRedirect(); return; }
    try {
      await getToken();
      await fetchUser();
      await refresh();
    } catch { toast("Sign-in was cancelled or failed."); }
    updateUi();
  };
  const signOut = async () => {
    const t = session.token;
    session.token = ""; session.expires = 0; session.email = ""; session.name = "";
    try { if (t && window.google) google.accounts.oauth2.revoke(t, () => {}); } catch { /* ignore */ }
    await refresh();
    toast("Signed out");
  };

  // ---------- sharing (Drive permissions) ----------
  const permUrl = (suffix = "") => `${DRIVE}/files/${drive.fileId}/permissions${suffix}`;
  const shareError = (msg) => { const e = $("shareError"); e.textContent = msg || ""; e.hidden = !msg; };
  let linkPermId = "";

  const renderPerms = async () => {
    const box = $("permList");
    box.replaceChildren(el("p", "hint", "Loading…"));
    try {
      await getToken();
      const res = await api(permUrl("?pageSize=100&fields=permissions(id,type,role,emailAddress,displayName)"));
      if (!res.ok) throw new Error("perm");
      const perms = (await readJson(res)).permissions || [];
      box.replaceChildren();
      linkPermId = "";
      for (const p of perms) {
        if (typeof p.id !== "string") continue;
        const row = el("div", "perm");
        if (p.type === "anyone") {
          linkPermId = p.id;
          row.append(el("span", "perm-name", "Anyone with the link (not allowed in this app)"), el("span", "perm-role", "Viewer"));
        } else if (p.role === "owner") {
          row.append(el("span", "perm-name", p.emailAddress || p.displayName || "Owner"), el("span", "perm-role", "Owner"));
        } else {
          const sel = el("select");
          sel.append(new Option("Viewer", "reader"), new Option("Editor", "writer"));
          sel.value = p.role === "writer" ? "writer" : "reader";
          sel.setAttribute("aria-label", `Access for ${p.emailAddress || "user"}`);
          sel.addEventListener("change", async () => {
            const r = await api(permUrl(`/${p.id}`), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: sel.value }) });
            toast(r.ok ? "Access updated" : "Could not update access");
            renderPerms();
          });
          const rm = el("button", "danger small", "Remove");
          rm.type = "button";
          rm.addEventListener("click", async () => {
            if (!confirm(`Remove ${p.emailAddress || "this person"}?`)) return;
            const r = await api(permUrl(`/${p.id}`), { method: "DELETE" });
            toast(r.ok || r.status === 204 ? "Access removed" : "Could not remove access");
            renderPerms();
          });
          row.append(el("span", "perm-name", p.emailAddress || p.displayName || "User"), sel, rm);
        }
        box.append(row);
      }
      // Public link access is never offered; the button only appears to remove one that already exists.
      $("shareLinkBtn").hidden = !linkPermId;
      $("shareLinkBtn").textContent = "Remove “anyone with the link” access";
    } catch { box.replaceChildren(el("p", "error", "Could not load the access list.")); }
  };

  const addPerson = async (ev) => {
    ev.preventDefault();
    const email = $("shareEmail").value.trim();
    const roleVal = $("shareRole").value === "writer" ? "writer" : "reader";
    if (!validEmail(email)) { shareError("Enter a valid email address."); return; }
    shareError("");
    try {
      await getToken();
      const res = await api(permUrl("?sendNotificationEmail=true"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "user", role: roleVal, emailAddress: email }),
      });
      if (!res.ok) throw new Error("add");
      $("shareEmail").value = "";
      toast("Person added");
      renderPerms();
    } catch { shareError("Could not add that person. Check the address and that it is a Google account."); }
  };

  const toggleLinkSharing = async () => {
    try {
      await getToken();
      if (!linkPermId) return;
      const res = await api(permUrl(`/${linkPermId}`), { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error("link");
      renderPerms();
    } catch { shareError("Could not change link sharing."); }
  };

  const copyLink = async () => {
    const url = `${location.origin}${location.pathname}#f=${drive.fileId}`;
    try { await navigator.clipboard.writeText(url); toast("Link copied. Open it on any device."); }
    catch { prompt("Copy this link:", url); }
  };

  // ---------- filtering & totals ----------
  const filtered = () => {
    const q = filters.search.trim().toLowerCase();
    return state.transactions
      .filter((t) =>
        (!filters.year || t.date.startsWith(filters.year)) &&
        (!filters.month || t.date.slice(5, 7) === filters.month) &&
        (!filters.category || t.category === filters.category) &&
        (!filters.type || t.type === filters.type) &&
        (!q || t.description.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date));
  };
  const totals = (list) => {
    let c = 0, d = 0;
    for (const t of list) (t.type === "Credit" ? (c += t.amount) : (d += t.amount));
    return { c, d, net: c - d };
  };

  // ---------- rendering ----------
  // A month only makes sense within a year: with "All years" the month is reset to "All months" and the dropdown is greyed out.
  const syncMonthSelect = () => {
    if (!filters.year) filters.month = "";
    const mSel = $("fMonth");
    mSel.value = filters.month;
    mSel.disabled = !filters.year;
  };
  const renderFilterOptions = () => {
    // The current year is always offered (even before it has entries) so it can be the default.
    const years = [...new Set([currentMonth().slice(0, 4), ...state.transactions.map((t) => t.date.slice(0, 4))])].sort().reverse();
    const ySel = $("fYear");
    ySel.replaceChildren(new Option("All years", ""), ...years.map((y) => new Option(y, y)));
    ySel.value = years.includes(filters.year) ? filters.year : "";
    filters.year = ySel.value;

    const mSel = $("fMonth");
    mSel.replaceChildren(new Option("All months", ""), ...MONTHS.map((m, i) => new Option(m, String(i + 1).padStart(2, "0"))));
    syncMonthSelect();

    const cats = [...new Set([...state.categories.Credit, ...state.categories.Debit])].filter(listedCategory).sort();
    const cSel = $("fCategory");
    cSel.replaceChildren(new Option("All categories", ""), ...cats.map((c) => new Option(c, c)));
    cSel.value = cats.includes(filters.category) ? filters.category : "";
    filters.category = cSel.value;
  };

  const renderCards = (list) => {
    const { c, d, net } = totals(list);
    $("sumCredit").textContent = fmt.format(c);
    $("sumDebit").textContent = fmt.format(d);
    const b = $("sumBalance");
    b.textContent = fmt.format(net);
    b.className = net >= 0 ? "pos" : "neg";
  };

  const renderList = (list) => {
    const root = $("list");
    root.replaceChildren();
    $("empty").hidden = list.length > 0;
    for (const t of list.slice(0, shown)) {
      const day = t.date.slice(0, 10);
      const dt = new Date(`${day}T00:00:00`);
      const row = el("button", `tx ${t.type}`);
      row.type = "button";
      row.dataset.id = t.id;
      row.classList.toggle("ro", !canEdit());
      row.title = dt.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      const when = el("span", "when");
      when.append(
        el("span", "d", dt.toLocaleDateString(undefined, { month: "short", day: "numeric" })),
        el("span", "y", `${dt.toLocaleDateString(undefined, { weekday: "short" })} ${dt.getFullYear()}`));
      row.append(when);
      const main = el("span", "main");
      main.append(el("span", "desc", t.description || t.category), el("span", "meta", `${t.category} · ${t.date.slice(11)}`));
      if (t.attachment) {
        const thumb = el("img", "thumb");
        thumb.src = t.attachment;
        thumb.alt = "Attachment preview (tap to enlarge)";
        row.append(thumb);
      }
      row.append(main, el("span", "amt", `${t.type === "Credit" ? "+" : "−"}${fmt.format(t.amount)}`));
      root.append(row);
    }
    $("moreBtn").hidden = list.length <= shown;
  };

  const renderSummary = (list) => {
    const byCat = $("byCategory");
    byCat.replaceChildren();
    const map = new Map();
    for (const t of list) {
      const k = `${t.type}|${t.category}`;
      map.set(k, (map.get(k) || 0) + t.amount);
    }
    const rows = [...map].map(([k, v]) => ({ type: k.split("|")[0], cat: k.split("|")[1], v })).sort((a, b) => b.v - a.v);
    const max = rows.length ? rows[0].v : 1;
    for (const r of rows) {
      const box = el("div", "bar-row");
      const line = el("div", "line");
      line.append(el("span", "", `${r.cat} (${r.type})`), el("strong", r.type === "Credit" ? "pos" : "neg", fmt.format(r.v)));
      const track = el("div", "bar-track");
      const fill = el("div", `bar-fill ${r.type}`);
      fill.style.width = `${Math.max(2, (r.v / max) * 100)}%`;
      track.append(fill);
      box.append(line, track);
      byCat.append(box);
    }
    if (!rows.length) byCat.append(el("p", "empty", "No data."));

    const months = new Map();
    for (const t of list) {
      const m = t.date.slice(0, 7);
      const e = months.get(m) || { c: 0, d: 0 };
      if (t.type === "Credit") e.c += t.amount; else e.d += t.amount;
      months.set(m, e);
    }
    const body = $("byMonth");
    body.replaceChildren();
    // Running net accumulates from the oldest month in the chosen range; rows are shown newest first.
    let running = 0;
    const rowsAsc = [...months].sort((a, b) => a[0].localeCompare(b[0])).map(([m, e]) => {
      const net = e.c - e.d;
      running += net;
      return { m, e, net, running };
    });
    for (const r of rowsAsc.reverse()) {
      const tr = el("tr");
      tr.append(
        el("td", "", monthLabel(r.m)), el("td", "pos", fmt.format(r.e.c)), el("td", "neg", fmt.format(r.e.d)),
        el("td", r.net >= 0 ? "pos" : "neg", fmt.format(r.net)),
        el("td", r.running >= 0 ? "pos" : "neg", fmt.format(r.running)));
      body.append(tr);
    }
  };

  // ---------- chart (hand-drawn SVG: the page's security policy does not allow chart libraries) ----------
  const SVGNS = "http://www.w3.org/2000/svg";
  const CHART_COLORS = ["#2563eb", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#475569", "#ea580c"];
  const amountFmt = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 2 });
  const chartOff = new Set();    // categories the user switched off; every other category counts towards the chart
  const svgEl = (tag, attrs = {}, cls) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (cls) n.setAttribute("class", cls);
    return n;
  };
  const shortNum = (x) => {
    const n = Math.abs(x), sign = x < 0 ? "-" : "";
    if (n >= 1e6) return `${sign}${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (n >= 1e3) return `${sign}${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
    return sign + String(Math.round(n));
  };
  const niceStep = (x) => {
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  };
  // One point per day (when the filtered data is within a single month) or per month, and only for days/months that
  // actually have transactions. `x` is the real position in time, so gaps between points stay honest.
  // `v` is the running net balance up to and including that day/month; `day` is that day's own net.
  const chartPoints = (list, selected) => {
    const daily = new Set(list.map((t) => t.date.slice(0, 7))).size <= 1;
    const len = daily ? 10 : 7;
    const sums = new Map();
    for (const t of selected) {
      const k = t.date.slice(0, len);
      sums.set(k, (sums.get(k) || 0) + (t.type === "Credit" ? t.amount : -t.amount));
    }
    let running = 0;
    return [...sums].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => {
      const [y, m, d] = k.split("-").map(Number);
      running += v;
      return {
        v: running, day: v,
        x: daily ? Date.UTC(y, m - 1, d) / 86400000 : y * 12 + m - 1,
        label: daily ? `${MONTHS[m - 1]} ${d}` : `${MONTHS[m - 1]} ${String(y).slice(2)}`,
      };
    });
  };

  // Width (in chart units) needed so that a label `labelW` wide can sit at every point without touching its neighbour.
  // Points are placed by real time, so the closest pair of points decides. Wider than the screen => the box scrolls sideways.
  const chartWidth = (xs, labelW, sides) => {
    const u = [...new Set(xs)].sort((a, b) => a - b);
    if (u.length < 2) return 600;
    let minD = Infinity;
    for (let i = 1; i < u.length; i++) minD = Math.min(minD, u[i] - u[i - 1]);
    return Math.max(600, Math.ceil((labelW * (u[u.length - 1] - u[0])) / minD + labelW + 8 + sides));
  };

  const renderChart = (list) => {
    const allCats = [...new Set([...state.categories.Credit, ...state.categories.Debit])].filter(listedCategory).sort();
    for (const c of [...chartOff]) if (!allCats.includes(c)) chartOff.delete(c);
    const chips = $("chartCats");
    chips.replaceChildren();
    for (const c of allCats) {
      const b = el("button", "chip", c);
      b.type = "button";
      b.setAttribute("aria-pressed", chartOff.has(c) ? "false" : "true");
      b.addEventListener("click", () => { if (chartOff.has(c)) chartOff.delete(c); else chartOff.add(c); renderChart(list); renderCategoryChart(list); });
      chips.append(b);
    }
    $("chartAll").onclick = () => { chartOff.clear(); renderChart(list); renderCategoryChart(list); };
    $("chartNone").onclick = () => { allCats.forEach((c) => chartOff.add(c)); renderChart(list); renderCategoryChart(list); };

    const box = $("chart");
    const legend = $("chartLegend");
    box.replaceChildren();
    legend.replaceChildren();
    if (!list.length) { box.append(el("p", "empty", "No data for this selection.")); return; }

    const pts = chartPoints(list, list.filter((t) => !chartOff.has(t.category)));
    const on = allCats.length - chartOff.size;
    const item = el("span", "legend-item");
    item.append(el("i", "sw ln-net"), document.createTextNode(`Running net balance (credits − debits) · ${on} of ${allCats.length} categories`));
    legend.append(item);
    if (!pts.length) { box.append(el("p", "empty", "No categories selected.")); return; }

    const vals = pts.map((p) => p.v);
    const labelW = Math.max(56, ...vals.map((v) => amountFmt.format(v).length * 5.6 + 8));
    const H = 300, L = 50, R = 16, T = 12, B = 30;
    const W = chartWidth(pts.map((p) => p.x), labelW, L + R);   // wide enough for every amount to be written without overlap
    const pw = W - L - R, ph = H - T - B;
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const step = niceStep((hi - lo || 1) / 4);
    const yMin = step * Math.floor(lo / step), yMax = Math.max(step * Math.ceil(hi / step), yMin + step);
    const n = pts.length;
    const x0 = pts[0].x, span = pts[n - 1].x - x0;
    const inset = n > 1 ? labelW / 2 + 4 : 0;   // keeps the first and last dots and labels inside the frame
    const X = (p) => (span === 0 ? L + pw / 2 : L + inset + ((p.x - x0) / span) * (pw - 2 * inset));
    const Y = (v) => T + ph - ((v - yMin) / (yMax - yMin)) * ph;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Line chart of running net balance (credits minus debits)" }, "chart-svg");
    if (W > 600) svg.style.width = `${W}px`;
    for (let v = yMin; v <= yMax + step / 1000; v += step) {
      svg.append(svgEl("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v) }, Math.abs(v) < step / 1000 ? "grid zero" : "grid"));
      const t = svgEl("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end" });
      t.textContent = shortNum(v);
      svg.append(t);
    }
    // Date labels sit under every point.
    for (const p of pts) {
      const t = svgEl("text", { x: X(p), y: H - 10, "text-anchor": "middle" });
      t.textContent = p.label;
      svg.append(t);
    }
    svg.append(svgEl("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${X(p).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(" ") }, "ln ln-net"));
    for (const p of pts) {
      const dot = svgEl("circle", { cx: X(p), cy: Y(p.v), r: n > 60 ? 2.5 : 4 }, `dot ${p.v >= 0 ? "ln-credit" : "ln-debit"}`);
      const tip = svgEl("title");
      tip.textContent = `${p.label}: balance ${fmt.format(p.v)} (day net ${fmt.format(p.day)})`;
      dot.append(tip);
      svg.append(dot);
    }
    // The balance written next to every dot (above it, or below when there is no room above).
    for (const p of pts) {
      const above = Y(p.v) - 10 >= T + 6;
      const t = svgEl("text", { x: X(p), y: above ? Y(p.v) - 9 : Y(p.v) + 17, "text-anchor": "middle" }, `val ${p.v >= 0 ? "pos" : "neg"}`);
      t.textContent = amountFmt.format(p.v);
      svg.append(t);
    }
    box.append(svg);
  };

  // Second chart: not a net. One line per category showing the amount of that category in each day/month, so a rising or
  // falling trend is visible per category. Days/months where a selected category has no entries plot as 0.
  const renderCategoryChart = (list) => {
    const allCats = [...new Set([...state.categories.Credit, ...state.categories.Debit])].filter(listedCategory).sort();
    const box = $("chartByCat");
    const legend = $("chartByCatLegend");
    box.replaceChildren();
    legend.replaceChildren();
    if (!list.length) { box.append(el("p", "empty", "No data for this selection.")); return; }

    const daily = new Set(list.map((t) => t.date.slice(0, 7))).size <= 1;
    const len = daily ? 10 : 7;
    const selected = list.filter((t) => !chartOff.has(t.category));
    const byCat = new Map();   // category -> Map(period -> amount)
    const periods = new Set();
    for (const t of selected) {
      const k = t.date.slice(0, len);
      periods.add(k);
      if (!byCat.has(t.category)) byCat.set(t.category, new Map());
      const m = byCat.get(t.category);
      m.set(k, (m.get(k) || 0) + t.amount);
    }
    if (!periods.size) { box.append(el("p", "empty", "No categories selected.")); return; }

    const keys = [...periods].sort();
    const pos = (k) => {
      const [y, m, d] = k.split("-").map(Number);
      return daily ? Date.UTC(y, m - 1, d) / 86400000 : y * 12 + m - 1;
    };
    const labelOf = (k) => {
      const [y, m, d] = k.split("-").map(Number);
      return daily ? `${MONTHS[m - 1]} ${d}` : `${MONTHS[m - 1]} ${String(y).slice(2)}`;
    };
    const cats = allCats.filter((c) => byCat.has(c));
    const colorOf = (c) => CHART_COLORS[allCats.indexOf(c) % CHART_COLORS.length];
    const dashOf = (c) => (allCats.indexOf(c) >= CHART_COLORS.length ? "6 4" : null);
    for (const c of cats) {
      const item = el("span", "legend-item");
      const sw = el("i", "sw");
      sw.style.borderTopColor = colorOf(c);
      item.append(sw, document.createTextNode(c));
      legend.append(item);
    }

    let hi = 0, maxLen = 0;
    for (const m of byCat.values()) for (const v of m.values()) { hi = Math.max(hi, v); maxLen = Math.max(maxLen, amountFmt.format(v).length); }
    const labelW = Math.max(56, maxLen * 5.6 + 8);
    const H = 300, L = 50, R = 16, T = 12, B = 30;
    const W = chartWidth(keys.map(pos), labelW, L + R);   // wide enough for every amount to be written without overlap
    const pw = W - L - R, ph = H - T - B;
    const step = niceStep((hi || 1) / 4);
    const yMax = Math.max(step * Math.ceil(hi / step), step);
    const n = keys.length;
    const x0 = pos(keys[0]), span = pos(keys[n - 1]) - x0;
    const inset = n > 1 ? labelW / 2 + 4 : 0;
    const X = (k) => (span === 0 ? L + pw / 2 : L + inset + ((pos(k) - x0) / span) * (pw - 2 * inset));
    const Y = (v) => T + ph - (v / yMax) * ph;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Line chart of the amount per category over time" }, "chart-svg");
    if (W > 600) svg.style.width = `${W}px`;
    for (let v = 0; v <= yMax + step / 1000; v += step) {
      svg.append(svgEl("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v) }, v === 0 ? "grid zero" : "grid"));
      const t = svgEl("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end" });
      t.textContent = shortNum(v);
      svg.append(t);
    }
    for (const k of keys) {
      const t = svgEl("text", { x: X(k), y: H - 10, "text-anchor": "middle" });
      t.textContent = labelOf(k);
      svg.append(t);
    }
    for (const c of cats) {
      const m = byCat.get(c);
      const line = svgEl("path", {
        d: keys.map((k, i) => `${i ? "L" : "M"}${X(k).toFixed(1)} ${Y(m.get(k) || 0).toFixed(1)}`).join(" "),
        stroke: colorOf(c),
      }, "ln");
      if (dashOf(c)) line.setAttribute("stroke-dasharray", dashOf(c));
      svg.append(line);
      for (const k of keys) {
        const v = m.get(k) || 0;
        const dot = svgEl("circle", { cx: X(k), cy: Y(v), r: n > 60 ? 2.5 : 4, fill: colorOf(c) }, "dot");
        const tip = svgEl("title");
        tip.textContent = `${c} · ${labelOf(k)}: ${fmt.format(v)}`;
        dot.append(tip);
        svg.append(dot);
      }
    }
    // The amount written next to every real entry, in its category colour. Labels of different categories in the same
    // period that would land on top of each other are moved apart vertically.
    for (const k of keys) {
      const items = cats.filter((c) => byCat.get(c).has(k)).map((c) => ({ c, v: byCat.get(c).get(k), y: Y(byCat.get(c).get(k)) - 9 }));
      items.sort((a, b) => a.y - b.y);
      items.forEach((it, i) => {
        it.y = Math.max(it.y, T + 8, i ? items[i - 1].y + 11 : 0);
        const t = svgEl("text", { x: X(k), y: it.y, "text-anchor": "middle" }, "val");
        t.style.fill = colorOf(it.c);
        t.textContent = amountFmt.format(it.v);
        svg.append(t);
      });
    }
    box.append(svg);
  };
  const render = () => {
    const list = filtered();
    renderCards(list);
    renderList(list);
    renderSummary(list);
    renderChart(list);
    renderCategoryChart(list);
  };
  const fullRender = () => { renderFilterOptions(); render(); };

  // ---------- banner / menu / role-dependent UI ----------
  const setBanner = (text, actions = []) => {
    const b = $("banner");
    b.hidden = !text;
    $("bannerText").textContent = text || "";
    const box = $("bannerActions");
    box.replaceChildren();
    for (const [label, fn] of actions) {
      const btn = el("button", "", label);
      btn.type = "button";
      btn.addEventListener("click", fn);
      box.append(btn);
    }
  };

  const updateUi = () => {
    const signed = Boolean(session.email) && hasToken();
    document.body.classList.toggle("locked", driveMode && drive.status !== "ok");   // hide all data until access is confirmed
    $("addBtn").hidden = !canEdit();
    $("importJson").hidden = !canEdit();
    $("resetSeed").hidden = !canEdit();
    $("menuSignIn").hidden = !driveMode || signed;
    $("menuSignOut").hidden = !driveMode || !signed;
    $("menuRefresh").hidden = !driveMode || !drive.fileId;
    $("menuShare").hidden = !driveMode || !signed || !drive.owner || !drive.fileId;
    $("menuLink").hidden = !driveMode || !drive.fileId || !signed;
    $("exportCsv").hidden = driveMode && drive.status !== "ok";
    $("exportJson").hidden = driveMode && drive.status !== "ok";
    const who = $("who");
    who.hidden = !driveMode;
    who.textContent = !driveMode ? "" : `${signed ? session.email : "Not signed in"} · ${canEdit() ? "Editor" : "View only"}`;

    if (!driveMode) { setBanner(""); return; }
    if (!drive.fileId) {
      setBanner("No shared data file is linked yet.",
        signed ? [["Paste shared file link", openLinkDialog]] : [["Sign in with Google", signIn], ["Paste shared file link", openLinkDialog]]);
      return;
    }
    switch (drive.status) {
      case "needsignin": setBanner("Sign in with a Google account that has been given access to view this data.", [["Sign in with Google", signIn]]); break;
      case "notlisted": setBanner(`${session.email} has not been given access to this data. Ask the owner to add this email as a viewer or editor.`, [["Sign in with another account", signIn]]); break;
      case "noaccess": setBanner("Access denied. If the owner has added your email, confirm the shared file once on this device so Google lets this app open it.", [["Choose file", pickFile], ["Sign in with another account", signIn]]); break;
      case "offline": case "error": setBanner("Could not reach Google Drive.", [["Retry", () => refresh(true)]]); break;
      case "invalid": setBanner("The Drive file is not a valid SGRBC Finance data file.", [["Retry", () => refresh(true)]]); break;
      case "ok":
        if (canEdit()) setBanner("");
        else if (!signed) setBanner("Sign in to continue.", [["Sign in with Google", signIn]]);
        else if (drive.metaDenied) setBanner("View only. If you were given edit access, confirm the file once to unlock editing.", [["Choose file", pickFile]]);
        else setBanner("Your account has view-only access to this data.");
        break;
      default: setBanner("Loading…");
    }
  };

  // ---------- add / edit dialog ----------
  // Debit entries may only use DEBIT_CATEGORIES. An older entry with a retired category must be re-categorised before saving.
  const formCategories = (type) => (type === "Debit" ? DEBIT_CATEGORIES : state.categories[type]);
  const fillCategoryOptions = (selected) => {
    const sel = $("fCat");
    const list = formCategories(formType);
    const options = list.map((c) => new Option(c, c));
    if (selected && !list.includes(selected)) options.unshift(new Option(`Choose a category (was: ${selected})`, ""));
    sel.replaceChildren(...options);
    if (selected && list.includes(selected)) sel.value = selected;
  };
  const setFormType = (type, selected) => {
    formType = type;
    document.querySelectorAll("[data-ftype]").forEach((b) => b.classList.toggle("active", b.dataset.ftype === type));
    fillCategoryOptions(selected);
  };
  const openDialog = (tx) => {
    if (!canEdit()) return;
    editingId = tx ? tx.id : null;
    $("dlgTitle").textContent = tx ? "Edit transaction" : "Add transaction";
    $("delBtn").hidden = !tx;
    $("formError").hidden = true;
    setFormType(tx ? tx.type : "Credit", tx && tx.category);
    $("fAmount").value = tx ? tx.amount : "";
    $("fDate").value = tx ? tx.date : nowLocal();
    $("fDesc").value = tx ? tx.description : "";
    setAttachment(tx && tx.attachment ? tx.attachment : "");
    $("dlg").showModal();
    if (!tx) $("fAmount").focus();
  };
  const showFormError = (msg) => { const e = $("formError"); e.textContent = msg; e.hidden = false; };

  // ---------- attachments (photo / image upload) ----------
  const setAttachment = (dataUrl) => {
    formAttachment = dataUrl;
    const p = $("attPreview");
    p.hidden = !dataUrl;
    if (dataUrl) p.src = dataUrl; else p.removeAttribute("src");
    $("attRemove").hidden = !dataUrl;
  };
  const showImage = (src) => { $("imgFull").src = src; $("imgDlg").showModal(); };

  const loadBitmap = async (file) => {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* fall back below */ }
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("read"));
      r.readAsDataURL(file);
    });
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("decode"));
      img.src = dataUrl;
    });
  };

  // Shrinks the picked/captured image and re-encodes it as JPEG so it stays small enough to store with the data.
  const compressImage = async (file) => {
    const bmp = await loadBitmap(file);
    const w0 = bmp.width, h0 = bmp.height;
    if (!w0 || !h0) throw new Error("decode");
    for (const [maxDim, q] of [[1000, 0.75], [900, 0.65], [800, 0.55], [700, 0.5], [600, 0.45], [500, 0.4]]) {
      const scale = Math.min(1, maxDim / Math.max(w0, h0));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w0 * scale));
      c.height = Math.max(1, Math.round(h0 * scale));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", q);
      if (validAttachment(url)) { if (bmp.close) bmp.close(); return url; }
    }
    if (bmp.close) bmp.close();
    throw new Error("size");
  };

  const onPickImage = async (input) => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > MAX_PHOTO_FILE) { toast("Please choose an image smaller than 25 MB."); return; }
    try { setAttachment(await compressImage(file)); }
    catch { toast("Could not use that image. Try a different photo."); }
  };

  const submitForm = async (ev) => {
    ev.preventDefault();
    const tx = {
      id: editingId || newId(),
      type: formType,
      category: $("fCat").value,
      amount: Math.round(parseFloat($("fAmount").value) * 100) / 100,
      date: $("fDate").value.slice(0, 16),
      description: $("fDesc").value.trim(),
    };
    if (formAttachment) tx.attachment = formAttachment;
    if (!isValidTx(tx) || !formCategories(tx.type).includes(tx.category)) {
      showFormError("Please enter a valid amount (above 0), category and date.");
      return;
    }
    const isEdit = state.transactions.some((t) => t.id === tx.id);
    $("saveBtn").disabled = true;
    const ok = await mutate((s) => {
      const i = s.transactions.findIndex((t) => t.id === tx.id);
      const list = s.transactions.slice();
      if (i >= 0) list[i] = tx; else list.push(tx);
      return { ...s, transactions: list };
    });
    $("saveBtn").disabled = false;
    if (!ok) return;
    $("dlg").close();
    fullRender();
    toast(isEdit ? "Transaction updated" : "Transaction added");
  };

  const deleteCurrent = async () => {
    if (!editingId || !confirm("Delete this transaction?")) return;
    const id = editingId;
    if (!(await mutate((s) => ({ ...s, transactions: s.transactions.filter((t) => t.id !== id) })))) return;
    $("dlg").close();
    fullRender();
    toast("Transaction deleted");
  };

  // ---------- export / import ----------
  const download = (name, mime, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const csvCell = (v) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  // Minimal ZIP writer (stored, no compression: the attachments are already JPEG).
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const makeZip = (files) => {   // files: [{ name, data: Uint8Array }]
    const enc = new TextEncoder();
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    const header = (size, fill) => { const b = new DataView(new ArrayBuffer(size)); fill(b); return new Uint8Array(b.buffer); };
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const local = header(30, (v) => {
        v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
        v.setUint16(10, dosTime, true); v.setUint16(12, dosDate, true); v.setUint32(14, crc, true);
        v.setUint32(18, f.data.length, true); v.setUint32(22, f.data.length, true); v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
      });
      central.push(header(46, (v) => {
        v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x0800, true); v.setUint16(10, 0, true);
        v.setUint16(12, dosTime, true); v.setUint16(14, dosDate, true); v.setUint32(16, crc, true);
        v.setUint32(20, f.data.length, true); v.setUint32(24, f.data.length, true); v.setUint16(28, name.length, true);
        v.setUint32(42, offset, true);
      }), name);
      parts.push(local, name, f.data);
      offset += local.length + name.length + f.data.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = header(22, (v) => {
      v.setUint32(0, 0x06054b50, true); v.setUint16(8, files.length, true); v.setUint16(10, files.length, true);
      v.setUint32(12, cdSize, true); v.setUint32(16, offset, true);
    });
    return [...parts, ...central, end];
  };
  const dataUrlBytes = (url) => Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (ch) => ch.charCodeAt(0));

  // Plain CSV when no row has a photo. Otherwise a ZIP: the CSV plus an images/ folder, linked by the Attachment column.
  const exportCsv = () => {
    const rows = [["Date", "Type", "Category", "Amount", "Description", "Attachment"]];
    const images = [];
    for (const t of filtered()) {
      let file = "";
      if (t.attachment) {
        file = `images/${String(images.length + 1).padStart(3, "0")}_${t.date.replace(/[T:]/g, "-")}.jpg`;
        images.push({ name: file, data: dataUrlBytes(t.attachment) });
      }
      rows.push([t.date.replace("T", " "), t.type, t.category, t.amount, t.description, file]);
    }
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    if (!images.length) { download("sgrbc-finance.csv", "text/csv;charset=utf-8", csv); return; }
    const files = [{ name: "sgrbc-finance.csv", data: new TextEncoder().encode(csv) }, ...images];
    download("sgrbc-finance.zip", "application/zip", new Blob(makeZip(files)));
    toast(`Exported ${images.length} image${images.length === 1 ? "" : "s"} with the CSV (zip file)`);
  };
  const exportJson = () => download("sgrbc-finance-backup.json", "application/json", JSON.stringify(state));
  const importJson = async (file) => {
    if (!canEdit()) return;
    if (!file || file.size > 10 * 1024 * 1024) { toast("File missing or too large."); return; }
    let data;
    try { data = sanitize(JSON.parse(await file.text())); } catch { toast("That file is not a valid backup."); return; }
    if (!confirm(`Replace current data with ${data.transactions.length} transactions from this backup?`)) return;
    if (await mutate(() => data)) { fullRender(); toast("Backup restored"); }
  };
  const resetSeed = async () => {
    if (!canEdit() || !confirm("Replace ALL data with the original spreadsheet data? Entries added since then will be lost.")) return;
    let seed;
    try { seed = await loadSeed(); } catch { toast("Could not load original data."); return; }
    if (await mutate(() => seed)) { fullRender(); toast("Original data restored"); }
  };

  // ---------- install as an app (PWA) ----------
  // Chrome/Edge (PC + Android) give us a native install prompt; Safari/iPhone and Firefox need manual steps.
  let installEvent = null;
  const isInstalled = () =>
    window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: window-controls-overlay)").matches || navigator.standalone === true;
  const platform = () => {
    const ua = navigator.userAgent || "";
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const android = /Android/.test(ua);
    const firefox = /Firefox|FxiOS/.test(ua);
    const edge = /Edg|EdgA|EdgiOS/.test(ua);
    const safari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|Edg|EdgA|EdgiOS|OPR/.test(ua);
    return { ios, android, firefox, edge, safari };
  };
  const updateInstallUi = () => { $("menuInstall").hidden = isInstalled(); };

  const installHelp = () => {
    const p = platform();
    let intro = "";
    let steps = [];
    if (p.ios) {
      intro = p.safari ? "On iPhone and iPad, installing is done from the Share menu." : "On iPhone and iPad, installing is done from the Share menu. If you do not see the option below, open this page in Safari.";
      steps = ["Tap the Share button (a square with an arrow pointing up) in the browser toolbar.", "Scroll down and tap “Add to Home Screen”.", "Tap “Add”. The SGRBC Finance icon now appears on your home screen."];
    } else if (p.android && p.firefox) {
      intro = "Firefox on Android can install this app from its menu.";
      steps = ["Tap the menu (⋮) in Firefox.", "Tap “... More”.", "Tap “Add app to Home screen”.", "Confirm with “Add”. The icon appears on your home screen."];
    } else if (p.android) {
      intro = "Your browser did not offer the install prompt automatically, but you can still install from its menu.";
      steps = ["Tap the menu (⋮) in the top-right corner.", "Tap “Install app” (or “Add to Home screen”).", "Confirm with “Install”. The icon appears on your home screen."];
    } else if (p.firefox) {
      intro = "Firefox on a computer cannot install web apps.";
      steps = ["Open this same address in Google Chrome or Microsoft Edge.", "Click the install icon at the right end of the address bar, or open the menu and choose “Install SGRBC Finance”.", "Or keep using it in Firefox and bookmark the page (Ctrl+D)."];
    } else if (p.edge) {
      intro = "Microsoft Edge can install this site as an app.";
      steps = ["Click the menu (…) at the top right of Edge.", "Choose “Apps”, then “Install this site as an app”.", "Click “Install”. You can pin it to the taskbar or Start."];
    } else if (p.safari) {
      intro = "Safari on a Mac can add this site to the Dock.";
      steps = ["In the menu bar choose File, then “Add to Dock…”.", "Click “Add”."];
    } else {
      intro = "Google Chrome can install this site as an app.";
      steps = ["Click the install icon at the right end of the address bar.", "If you do not see it, open the menu (⋮) and choose “Cast, save and share”, then “Install page as app”.", "Click “Install”."];
    }
    $("installIntro").textContent = intro;
    $("installSteps").replaceChildren(...steps.map((s) => el("li", "", s)));
    $("installDlg").showModal();
  };

  const installApp = async () => {
    if (installEvent) {
      const ev = installEvent;
      installEvent = null;
      try {
        await ev.prompt();
        const choice = await ev.userChoice;
        if (choice && choice.outcome === "accepted") toast("Installing…");
      } catch { installHelp(); }
      return;
    }
    installHelp();
  };

  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; updateInstallUi(); });
  window.addEventListener("appinstalled", () => { installEvent = null; updateInstallUi(); toast("App installed"); });

  // ---------- wiring ----------
  const wire = () => {
    $("fYear").addEventListener("change", (e) => { filters.year = e.target.value; syncMonthSelect(); shown = PAGE; render(); });
    $("fMonth").addEventListener("change", (e) => { filters.month = e.target.value; shown = PAGE; render(); });
    $("fCategory").addEventListener("change", (e) => { filters.category = e.target.value; shown = PAGE; render(); });
    $("fSearch").addEventListener("input", (e) => {
      filters.search = e.target.value; shown = PAGE;
      $("fSearchClear").hidden = !e.target.value;
      render();
    });
    $("fSearchClear").addEventListener("click", () => {
      $("fSearch").value = ""; filters.search = ""; shown = PAGE;
      $("fSearchClear").hidden = true;
      render();
      $("fSearch").focus();
    });
    document.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => {
      filters.type = b.dataset.type; shown = PAGE;
      document.querySelectorAll("[data-type]").forEach((x) => x.classList.toggle("active", x === b));
      render();
    }));
    document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
      $("tabList").hidden = b.dataset.tab !== "list";
      $("tabSummary").hidden = b.dataset.tab !== "summary";
      $("tabChart").hidden = b.dataset.tab !== "chart";
    }));
    $("moreBtn").addEventListener("click", () => { shown += PAGE; render(); });
    $("list").addEventListener("click", (e) => {
      const row = e.target.closest(".tx");
      const tx = row && state.transactions.find((t) => t.id === row.dataset.id);
      if (!tx) return;
      if (e.target.classList.contains("thumb") && tx.attachment) { showImage(tx.attachment); return; }
      openDialog(tx);
    });
    // Camera button only on touch devices (phones/tablets); desktops just get "Upload image".
    $("attCamera").hidden = !window.matchMedia("(pointer: coarse)").matches;
    $("attCamera").addEventListener("click", () => $("attFileCam").click());
    $("attUpload").addEventListener("click", () => $("attFile").click());
    $("attFileCam").addEventListener("change", (e) => onPickImage(e.target));
    $("attFile").addEventListener("change", (e) => onPickImage(e.target));
    $("attRemove").addEventListener("click", () => setAttachment(""));
    $("attPreview").addEventListener("click", () => { if (formAttachment) showImage(formAttachment); });
    $("imgClose").addEventListener("click", () => $("imgDlg").close());
    $("addBtn").addEventListener("click", () => openDialog(null));
    document.querySelectorAll("[data-ftype]").forEach((b) => b.addEventListener("click", () => setFormType(b.dataset.ftype)));
    $("form").addEventListener("submit", submitForm);
    $("cancelBtn").addEventListener("click", () => $("dlg").close());
    $("delBtn").addEventListener("click", deleteCurrent);

    const menu = $("menu");
    $("menuBtn").addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener("click", () => (menu.hidden = true));
    $("menuInstall").addEventListener("click", installApp);
    $("installClose").addEventListener("click", () => $("installDlg").close());
    updateInstallUi();
    $("exportCsv").addEventListener("click", exportCsv);
    $("exportJson").addEventListener("click", exportJson);
    $("importJson").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", (e) => { importJson(e.target.files[0]); e.target.value = ""; });
    $("resetSeed").addEventListener("click", resetSeed);

    $("menuSignIn").addEventListener("click", signIn);
    $("menuSignOut").addEventListener("click", signOut);
    $("menuRefresh").addEventListener("click", () => refresh(true));
    $("menuLink").addEventListener("click", copyLink);
    $("menuShare").addEventListener("click", () => { shareError(""); $("shareDlg").showModal(); renderPerms(); });
    $("shareForm").addEventListener("submit", addPerson);
    $("shareLinkBtn").addEventListener("click", toggleLinkSharing);
    $("shareClose").addEventListener("click", () => $("shareDlg").close());
    $("linkForm").addEventListener("submit", submitLink);
    $("linkCancel").addEventListener("click", () => $("linkDlg").close());
    $("linkPicker").addEventListener("click", () => { $("linkDlg").close(); pickFile(); });
  };

  // ---------- start ----------
  const start = async () => {
    wire();
    if (!driveMode) {
      state = readLocal(LOCAL_KEY) || state;
      if (!state.transactions.length) {
        try { state = await loadSeed(); saveLocal(); } catch { toast("Could not load starting data."); }
      }
      fullRender(); updateUi();
      return;
    }
    // Returning from the Google sign-in redirect (installed app): the token arrives in the URL fragment
    const signedInByRedirect = takeRedirectToken();
    // Drive mode: pick up the shared file id from a link (#f=ID), earlier use, or config.js
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("f");
    if (validFileId(fromHash)) { setFileId(fromHash); history.replaceState(null, "", location.pathname + location.search); }
    else {
      let stored = "";
      try { stored = localStorage.getItem(FILE_KEY) || ""; } catch { /* ignore */ }
      drive.fileId = validFileId(stored) ? stored : (validFileId(CFG.DRIVE_FILE_ID) ? CFG.DRIVE_FILE_ID : "");
    }
    // Nothing is loaded or shown until the user signs in and Google confirms access. Remove any copy cached by older versions.
    try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
    fullRender(); updateUi();
    if (signedInByRedirect) { try { await fetchUser(); } catch { /* refresh() shows the state */ } }

    await refresh();
    const autoRefresh = () => { if (hasToken() && document.visibilityState === "visible" && !$("dlg").open && !$("shareDlg").open) refresh(); };
    setInterval(autoRefresh, 60000);
    document.addEventListener("visibilitychange", autoRefresh);
  };
  start();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
