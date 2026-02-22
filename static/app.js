"use strict";

// ── Config ───────────────────────────────────────────────────────────────────
const REFRESH_MS     = 10_000;
const HORIZON_RADIUS = 2_200_000; // metres

// ── State ────────────────────────────────────────────────────────────────────
let userLat      = null;
let userLon      = null;
let isPaused     = false;
let frozenTime   = null;
let refreshTimer = null;
let openNoradId  = null;
const satMarkers = new Map(); // norad_id → L.marker

// ── Leaflet ───────────────────────────────────────────────────────────────────
const satLayer = L.layerGroup();
let userMarker    = null;
let horizonCircle = null;

const map = L.map("map", { center: [20, 0], zoom: 2, zoomControl: true });

L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: "© OpenStreetMap contributors © CARTO",
  subdomains: "abcd",
  maxZoom: 19,
}).addTo(map);

satLayer.addTo(map);
map.on("click", (e) => setLocation(e.latlng.lat, e.latlng.lng));

// ── Location ─────────────────────────────────────────────────────────────────
function setLocation(lat, lon) {
  userLat = lat;
  userLon = lon;

  if (userMarker)    map.removeLayer(userMarker);
  if (horizonCircle) map.removeLayer(horizonCircle);

  userMarker = L.circleMarker([lat, lon], {
    radius: 7, fillColor: "#ffffff", color: "#ffffff",
    weight: 2, opacity: 1, fillOpacity: 0.9,
  }).addTo(map).bindPopup(
    `<b>Your Location</b><br>Lat: ${lat.toFixed(4)}<br>Lon: ${lon.toFixed(4)}`
  );

  horizonCircle = L.circle([lat, lon], {
    radius: HORIZON_RADIUS,
    color: "#00ff88", weight: 1, opacity: 0.2,
    fillOpacity: 0, dashArray: "6 10",
  }).addTo(map);

  hideError();
  fetchAndUpdate();
  scheduleRefresh();
}

// ── Scheduling ────────────────────────────────────────────────────────────────
function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (!frozenTime && !isPaused) {
    refreshTimer = setInterval(fetchAndUpdate, REFRESH_MS);
  }
}

// ── Time param ────────────────────────────────────────────────────────────────
function timeParam() {
  return frozenTime ? `&time=${encodeURIComponent(frozenTime.toISOString())}` : "";
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
function fetchAndUpdate() {
  if (userLat === null) return;

  fetch(`/api/satellites?lat=${userLat}&lon=${userLon}&alt=0${timeParam()}`)
    .then((r) => r.json())
    .then((data) => {
      if (data.error) throw new Error(data.error);
      renderSatellites(data);
      updateSkyView(data);
      updateTimestamp();
    })
    .catch((err) => showError("Satellite fetch failed: " + err.message));
}

// ── HTML escaping ─────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Signal quality colour ─────────────────────────────────────────────────────
/**
 * Returns a CSS colour for a connectable satellite based on quality 0–100.
 * quality 0  (el 25°) → red-orange
 * quality 50 (el 57°) → yellow
 * quality 100 (el 90°) → green
 */
function qualityColor(quality) {
  const hue = (quality / 100) * 120; // 0 = red, 60 = yellow, 120 = green
  return `hsl(${hue}, 100%, 52%)`;
}

// ── Markers ───────────────────────────────────────────────────────────────────
function satIcon(sat) {
  let color, size, glow;
  if (sat.connectable) {
    color = qualityColor(sat.quality);
    size  = 9;
    glow  = `0 0 7px ${color}`;
  } else {
    // Approaching / departing — right orbit, outside connectable window
    color = "#ff3333";
    size  = 6;
    glow  = "0 0 4px #ff333388";
  }
  return L.divIcon({
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;
             background:${color};border:1px solid ${color};
             box-shadow:${glow}"></div>`,
    className: "",
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function popupHtml(s) {
  const name = escHtml(s.name);
  if (s.connectable) {
    const bar = "█".repeat(Math.round(s.quality / 10)) +
                "░".repeat(10 - Math.round(s.quality / 10));
    return `<b>${name}</b><br>
      NORAD: ${s.norad_id}<br>
      Az / El: ${s.azimuth}° / ${s.elevation}°<br>
      Range: ${s.range_km} km &nbsp; Alt: ${s.altitude_km} km<br>
      Signal: <span style="color:${qualityColor(s.quality)}">${bar}</span> ${s.quality}%`;
  }
  return `<b>${name}</b><br>
    NORAD: ${s.norad_id}<br>
    Az / El: ${s.azimuth}° / ${s.elevation}°<br>
    Range: ${s.range_km} km &nbsp; Alt: ${s.altitude_km} km<br>
    <span style="color:#ff5555">Not connectable yet (el &lt; 25°)</span>`;
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderSatellites(sats) {
  // Capture which popup (if any) is currently open before clearing.
  openNoradId = null;
  satMarkers.forEach((marker, noradId) => {
    if (marker.isPopupOpen()) openNoradId = noradId;
  });

  satLayer.clearLayers();
  satMarkers.clear();

  const connectable = sats.filter((s) => s.connectable);
  const approaching = sats.filter((s) => !s.connectable);

  // Draw approaching first (below connectable in z-order)
  approaching.forEach((s) => {
    const marker = L.marker([s.lat, s.lon], { icon: satIcon(s), title: s.name })
      .bindPopup(popupHtml(s))
      .addTo(satLayer);
    satMarkers.set(s.norad_id, marker);
  });
  connectable.forEach((s) => {
    const marker = L.marker([s.lat, s.lon], { icon: satIcon(s), title: s.name })
      .bindPopup(popupHtml(s))
      .addTo(satLayer);
    satMarkers.set(s.norad_id, marker);
  });

  // Re-open the popup if the satellite is still visible.
  if (openNoradId !== null && satMarkers.has(openNoradId)) {
    satMarkers.get(openNoradId).openPopup();
  }

  document.getElementById("sat-count").textContent =
    `${connectable.length} connectable`;
  document.getElementById("sat-approaching").textContent =
    approaching.length ? `${approaching.length} approaching` : "";
}

// ── Sky view ──────────────────────────────────────────────────────────────────
function updateSkyView(sats) {
  const canvas = document.getElementById("sky-canvas");
  const ctx    = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2, R = W / 2 - 14;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#080810";
  ctx.fillRect(0, 0, W, H);

  // Rings
  [0, 30, 60].forEach((el) => {
    const r = R * (1 - el / 90);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = el === 0 ? "#00ff8855" : "#00ff8822";
    ctx.lineWidth = 1;
    ctx.stroke();
    if (el > 0) {
      ctx.fillStyle = "#00ff8844";
      ctx.font = "9px Courier New";
      ctx.textAlign = "left";
      ctx.fillText(el + "°", cx + 3, cy - r + 10);
    }
  });

  // Connectable threshold ring (25°)
  const rConn = R * (1 - 25 / 90);
  ctx.beginPath();
  ctx.arc(cx, cy, rConn, 0, Math.PI * 2);
  ctx.strokeStyle = "#ff333355";
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  // Cardinals
  ctx.fillStyle = "#00ff8877";
  ctx.font = "10px Courier New";
  [["N", cx, cy - R + 13, "center"], ["S", cx, cy + R - 3, "center"],
   ["E", cx + R - 2, cy + 4, "right"], ["W", cx - R + 2, cy + 4, "left"]]
    .forEach(([t, x, y, a]) => { ctx.textAlign = a; ctx.fillText(t, x, y); });

  // Zenith dot
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fillStyle = "#00ff8844";
  ctx.fill();

  // Satellites
  sats.forEach((s) => {
    const az   = (s.azimuth * Math.PI) / 180;
    const dist = R * (1 - s.elevation / 90);
    const x    = cx + dist * Math.sin(az);
    const y    = cy - dist * Math.cos(az);
    const col  = s.connectable ? qualityColor(s.quality) : "#ff3333";

    ctx.beginPath();
    ctx.arc(x, y, s.connectable ? 3 : 2, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.shadowBlur  = s.connectable ? 6 : 3;
    ctx.shadowColor = col;
    ctx.fill();
    ctx.shadowBlur = 0;

    if (s.connectable && s.elevation > 40) {
      ctx.fillStyle = col + "bb";
      ctx.font = "8px Courier New";
      ctx.textAlign = "left";
      ctx.fillText(s.name.replace("STARLINK-", ""), x + 5, y + 3);
    }
  });
}

// ── Timestamp ─────────────────────────────────────────────────────────────────
function updateTimestamp() {
  const el = document.getElementById("last-updated");
  if (frozenTime) {
    el.textContent = "Showing: " + frozenTime.toUTCString().replace(" GMT", " UTC");
  } else {
    el.textContent = "Live · updated " + new Date().toLocaleTimeString();
  }
}

function showError(msg) {
  const el = document.getElementById("error-msg");
  el.textContent = msg;
  el.style.display = "block";
}
function hideError() {
  const el = document.getElementById("error-msg");
  el.style.display = "none";
  el.textContent = "";
}

// ── Pause UI sync ─────────────────────────────────────────────────────────────
function syncPauseUI() {
  const btn   = document.getElementById("btn-pause");
  const badge = document.getElementById("frozen-badge");
  const inp   = document.getElementById("inp-datetime");

  if (frozenTime) {
    btn.textContent = "⏹ Time Shift";
    btn.className   = "frozen";
    badge.style.display = "block";
    inp.classList.add("frozen");
  } else if (isPaused) {
    btn.textContent = "▶ Resume";
    btn.className   = "paused";
    badge.style.display = "none";
    inp.classList.remove("frozen");
  } else {
    btn.textContent = "⏸ Pause";
    btn.className   = "live";
    badge.style.display = "none";
    inp.classList.remove("frozen");
  }
}

// ── Pause button ──────────────────────────────────────────────────────────────
document.getElementById("btn-pause").addEventListener("click", function () {
  if (frozenTime) {
    goLive();
  } else {
    isPaused = !isPaused;
    syncPauseUI();
    scheduleRefresh();
    if (!isPaused) fetchAndUpdate();
  }
});

// ── Date/time ─────────────────────────────────────────────────────────────────
function prefillDatetime() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  document.getElementById("inp-datetime").value =
    `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function applyCustomTime() {
  const val = document.getElementById("inp-datetime").value;
  if (!val) { goLive(); return; }
  const d = new Date(val);
  if (isNaN(d)) { showError("Invalid date/time."); return; }
  frozenTime = d;
  isPaused   = false;
  hideError();
  syncPauseUI();
  scheduleRefresh();
  fetchAndUpdate();
}

function goLive() {
  frozenTime = null;
  isPaused   = false;
  prefillDatetime();
  syncPauseUI();
  scheduleRefresh();
  fetchAndUpdate();
}

document.getElementById("btn-go").addEventListener("click", applyCustomTime);
document.getElementById("btn-now").addEventListener("click", goLive);
document.getElementById("inp-datetime").addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyCustomTime();
});

// ── Address geocoding (Nominatim / OpenStreetMap) ─────────────────────────────
function geocodeAddress() {
  const query = document.getElementById("inp-address").value.trim();
  if (!query) return;

  const resultEl = document.getElementById("address-result");
  resultEl.className = "";
  resultEl.textContent = "Searching…";

  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
              encodeURIComponent(query);

  fetch(url, { headers: { "Accept-Language": "en" } })
    .then((r) => r.json())
    .then((data) => {
      if (!data.length) {
        resultEl.className = "error";
        resultEl.textContent = "Address not found.";
        return;
      }
      const { lat, lon, display_name } = data[0];
      resultEl.className = "";
      resultEl.textContent = display_name;
      resultEl.title = display_name;

      const llat = parseFloat(lat), llon = parseFloat(lon);
      map.setView([llat, llon], 8);
      setLocation(llat, llon);
    })
    .catch(() => {
      resultEl.className = "error";
      resultEl.textContent = "Geocoding request failed.";
    });
}

document.getElementById("btn-address").addEventListener("click", geocodeAddress);
document.getElementById("inp-address").addEventListener("keydown", (e) => {
  if (e.key === "Enter") geocodeAddress();
});

// ── Manual coordinates ────────────────────────────────────────────────────────
document.getElementById("btn-manual-toggle").addEventListener("click", function () {
  const form = document.getElementById("manual-coords");
  const open = form.style.display === "block";
  form.style.display = open ? "none" : "block";
  this.classList.toggle("active", !open);
});

document.getElementById("btn-set-location").addEventListener("click", () => {
  const lat = parseFloat(document.getElementById("inp-lat").value);
  const lon = parseFloat(document.getElementById("inp-lon").value);
  if (isNaN(lat) || isNaN(lon)) { showError("Enter valid latitude and longitude."); return; }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    showError("Latitude −90…90, longitude −180…180."); return;
  }
  map.setView([lat, lon], 6);
  setLocation(lat, lon);
});

// ── Geolocation ───────────────────────────────────────────────────────────────
prefillDatetime();
syncPauseUI();

if ("geolocation" in navigator) {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.setView([pos.coords.latitude, pos.coords.longitude], 7);
      setLocation(pos.coords.latitude, pos.coords.longitude);
    },
    () => {
      showError("Geolocation denied. Click the map or enter coordinates.");
      document.getElementById("btn-manual-toggle").click();
    },
    { timeout: 10_000 }
  );
} else {
  showError("Geolocation not supported. Click the map or enter coordinates.");
  document.getElementById("btn-manual-toggle").click();
}
