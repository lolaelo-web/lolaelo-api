// lolaelo-api/public/js/shared.js
(() => {
  const TOKEN_KEY = "lolaelo_session";

  function setToken(t){ if(t) localStorage.setItem(TOKEN_KEY, t); }
  function getToken(){ return localStorage.getItem(TOKEN_KEY) || ""; }
  function clearToken(){ localStorage.removeItem(TOKEN_KEY); }

  // Accept token via #token= (and legacy ?token=) once, then clean URL
  function normalizeTokenFromUrl(){
    const url = new URL(location.href);
    let t = url.searchParams.get("token") || "";
    if(!t && location.hash.startsWith("#token=")) t = location.hash.slice(7);
    if(t){
      setToken(t);
      url.searchParams.delete("token");
      history.replaceState(null, "", url.pathname + (url.search || ""));
      if(location.hash.startsWith("#token=")){
        history.replaceState(null, "", url.pathname + (url.search || ""));
      }
    }
  }

  function requireToken(){
    let t = getToken();
    if(!t){
      normalizeTokenFromUrl();
      t = getToken();
    }
    if(!t){
      // send back to travel login
      location.href = "https://your-travel-origin.example/partners_login.html";
      return "";
    }
    return t;
  }

  async function authFetch(url, opts = {}){
    const t = requireToken();
    const h = new Headers(opts.headers || {});
    h.set("Authorization", "Bearer " + t);
    return fetch(url, { ...opts, headers: h, credentials: "omit" });
  }
// lolaelo-api/public/js/shared.js
const TRAVEL_ORIGIN = "https://lolaelo-web.github.io/travel"; // <- set to your live travel domain

  window.LolaAuth = { requireToken, authFetch, getToken, setToken, clearToken, normalizeTokenFromUrl };
  document.addEventListener("DOMContentLoaded", normalizeTokenFromUrl);
})();
