// travel/js/shared.js
(() => {
  const TOKEN_KEY  = "lolaelo_session";
  const API_ORIGIN = "https://lolaelo-api.onrender.com";

  function setToken(t){ if (t) localStorage.setItem(TOKEN_KEY, t); }
  function getToken(){ return localStorage.getItem(TOKEN_KEY) || ""; }
  function clearToken(){ localStorage.removeItem(TOKEN_KEY); }

  // Capture token returned from API origin via #token=… (and clean URL)
  function normalizeFromHash(){
    if (location.hash && location.hash.startsWith("#token=")) {
      const t = decodeURIComponent(location.hash.slice(7));
      if (t) setToken(t);
      history.replaceState(null, "", location.pathname + location.search); // strip hash
    }
  }

  // Legacy support: also accept ?token=… once, then clean URL
  function normalizeFromQuery(){
    const url = new URL(location.href);
    const q = url.searchParams.get("token");
    if (q) {
      setToken(q);
      url.searchParams.delete("token");
      history.replaceState(null, "", url.pathname + (url.search || "")); // strip ?token
    }
  }

  // Called after /login/verify-code success
  function onVerifySuccess(resp){
    setToken(resp.token);
    location.href = "/partners_app.html"; // stays on travel origin
  }

  // Handoff from Hub → API Rooms using URL hash (not query)
  function openRooms(){
    const t = getToken();
    if (!t) { location.href = "/partners_login.html"; return; }
    location.href = `${API_ORIGIN}/partners_rooms.html#token=${encodeURIComponent(t)}`;
  }

  // Auto-normalize any incoming token on page load (hub, login, etc.)
  document.addEventListener("DOMContentLoaded", () => {
    normalizeFromHash();
    normalizeFromQuery();
  });

  window.TravelAuth = {
    onVerifySuccess,
    openRooms,
    getToken,
    setToken,
    clearToken,
  };
})();
