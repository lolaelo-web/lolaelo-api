// lolaelo-api/public/js/shared.js
(() => {
  const TOKEN_KEY = "lolaelo_session";
  // 👇 set to your live travel domain (login/hub)
  const TRAVEL_ORIGIN = "https://lolaelo-web.github.io/travel";

  // Safe localStorage helpers
  const store = {
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    get(k)    { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    rm(k)     { try { localStorage.removeItem(k); } catch {} },
  };

  function setToken(t){ if (t) store.set(TOKEN_KEY, t); }
  function getToken(){ return store.get(TOKEN_KEY); }
  function clearToken(){ store.rm(TOKEN_KEY); }

  // Accept token via #token=... or ?token=... then strip it from the URL
  function normalizeTokenFromUrl(){
    const url = new URL(location.href);
    let t = url.searchParams.get("token");
    if (!t && location.hash.startsWith("#token=")) {
      t = decodeURIComponent(location.hash.slice(7));
    }
    if (t) {
      setToken(t);
      url.searchParams.delete("token");
      // drop both query + hash
      history.replaceState(null, "", url.pathname + (url.search || ""));
    }
  }

  function requireToken(){
    let t = getToken();
    if (!t) { normalizeTokenFromUrl(); t = getToken(); }
    if (!t) {
      location.href = `${TRAVEL_ORIGIN}/partners_login.html`;
      return "";
    }
    return t;
  }

  async function authFetch(url, opts = {}){
    const t = requireToken();
    const headers = new Headers(opts.headers || {});
    if (t) headers.set("Authorization", `Bearer ${t}`);
    return fetch(url, { ...opts, headers, credentials: "omit" });
  }

  function logoutToLogin(){
    clearToken();
    location.href = `${TRAVEL_ORIGIN}/partners_login.html`;
  }

  window.LolaAuth = {
    requireToken,
    authFetch,
    getToken,
    setToken,
    clearToken,
    normalizeTokenFromUrl,
    logoutToLogin,
  };

  document.addEventListener("DOMContentLoaded", normalizeTokenFromUrl);
})();
