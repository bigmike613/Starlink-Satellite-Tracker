# Starlink Satellite Tracker

**CS50 Final Project — Mike Tomasulo**
### Video: https://youtu.be/s7ww4aEMGcQ
### Description:
A real-time web application that shows which Starlink satellites are currently connectable from any location on Earth. Built with Python/Flask on the backend and vanilla JavaScript + Leaflet.js on the frontend.


---

## What It Does

The app answers a practical question: *if you set up a Starlink dish at a given location right now, which satellites could it actually connect to?*

Orbital element data (TLEs) is fetched from Celestrak once and cached for 6 hours. Every 10 seconds the app re-propagates those cached elements to compute current satellite positions using the SGP4 algorithm, then filters the results down to only the satellites that are both overhead and physically linkable from your location. Satellites that are rising toward or setting below the connection window are shown separately so you can see what's coming next.

### The Map

- **Green → yellow → orange dots** — satellites your terminal could connect to right now, colored by signal quality (green = excellent, orange = marginal)
- **Red dots** — satellites in the right orbital shell that are currently below the minimum connectable elevation; they were recently connectable or will be soon
- **White circle** — your location
- **Dashed ring** — approximate visibility horizon (~2,200 km radius)
- Click any satellite dot for name, NORAD ID, azimuth, elevation, slant range, altitude, and a signal quality bar

### The Sky View

A polar plot in the bottom-right corner shows the same satellites projected onto the sky above you. The center is directly overhead (zenith), the outer ring is the horizon. A dashed red ring marks the 25° minimum elevation threshold. North is up.

### Controls

| Control | What it does |
|---|---|
| Address search | Type any street address or place name and press Enter — the address is geocoded to coordinates via OpenStreetMap, the map flies to that location, and satellites are recalculated for that observer position |
| ⏸ Pause / ▶ Resume | Stops or restarts the 10-second auto-refresh |
| Time Shift | Pick any date and time to see where satellites were or will be at that moment |
| ↺ Now | Returns from Time Shift mode to live tracking |
| Enter Coordinates | Manually enter a latitude/longitude if geolocation is unavailable |
| Click the map | Sets your observer location to wherever you click |

---

## The Science

### Why not all overhead satellites are connectable

A satellite being above the horizon is not enough. Three things cut down the real connectable count:

1. **Elevation floor (25°)** — The Starlink phased-array dish steers its beam electronically. Below ~25° elevation, two compounding effects make the link unreliable: *scan loss* (antenna gain falls roughly as the cosine of the steering angle from boresight) and *atmospheric path loss* (signal passes through ~4× more troposphere at 15° than at 90°).

2. **Orbital shell filter (450–650 km)** — The TLE catalog includes Starlink satellites in transit orbits, parking orbits, and decommissioning trajectories. Only satellites in active operational shells at 450–650 km altitude can serve a ground terminal.

3. **Free-space path loss** — A satellite at 10° elevation from a 550 km shell has a slant range of ~2,600 km, versus ~550 km at zenith. That's a 13.5 dB penalty in received signal strength.

### How positions are computed

1. TLE (Two-Line Element) data is fetched from [Celestrak](https://celestrak.org) and cached for 6 hours
2. All ~9,500 Starlink TLEs are batch-propagated using the **SGP4** algorithm via the `sgp4` Python library — this gives position vectors in the TEME (True Equator Mean Equinox) frame
3. Positions are rotated from TEME to ECEF (Earth-Centered, Earth-Fixed) using the Greenwich Mean Sidereal Time angle
4. The observer's geodetic coordinates are converted to ECEF, then a difference vector is computed and rotated into the local ENU (East-North-Up) frame
5. Azimuth and elevation are derived from the ENU components; geodetic lat/lon/altitude is recovered from ECEF via Bowring's iterative method
6. The altitude band and elevation filters are applied; a signal quality score (0–100) is computed as `(elevation − 25) / 65 × 100`

The entire pipeline for ~9,500 satellites runs in under 50 ms using NumPy vectorisation.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, Flask |
| Orbit math | `sgp4` library (Brandon Rhodes), NumPy |
| TLE data | Celestrak GP endpoint (live, cached 6 h) |
| Geocoding | Nominatim / OpenStreetMap — converts street addresses to coordinates (no API key required) |
| Map | Leaflet.js, CartoDB Dark Matter tiles |
| Sky view | HTML5 Canvas |
| Frontend | Vanilla JavaScript, HTML5 Geolocation API |

---

## Installation & Running

```bash
# 1. Clone or download the project
cd FinalProject

# 2. Create and activate a virtual environment (recommended)
python3 -m venv venv
source venv/bin/activate      # macOS/Linux
# venv\Scripts\activate       # Windows

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run the app
python app.py
```

Open **http://localhost:5000** in your browser.

On first launch the app pre-fetches TLE data (~1–2 seconds). Subsequent requests use the in-memory cache.

### Requirements

```
flask
sgp4
requests
numpy
```

---

## Project Structure

```
FinalProject/
├── app.py          — Flask app and API routes
├── satellite.py    — TLE fetching, SGP4 propagation, coordinate math
├── static/
│   ├── app.js      — Map rendering, geolocation, UI logic
│   └── style.css
├── templates/
│   └── index.html
└── requirements.txt
```

### API Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Serves the web app |
| `GET /api/satellites?lat=&lon=&alt=&time=` | Returns connectable + approaching satellites for the given observer. `time` is optional ISO-8601 UTC for Time Shift mode. |
| `GET /api/tle/status` | Cache age, satellite count, TTL |

---

## Acknowledgements

This project was written by **Mike Tomasulo** as the final project for [CS50x](https://cs50.harvard.edu/x/) (Harvard's Introduction to Computer Science). Development was completed with the assistance of **Claude Code** (Anthropic), an AI coding assistant, which helped implement the coordinate transform math, the vectorised NumPy propagation pipeline, and the frontend map rendering.

The SGP4 implementation is by Brandon Rhodes (`python-sgp4`). Satellite TLE data is provided by [Celestrak](https://celestrak.org). Geocoding is provided by [Nominatim](https://nominatim.openstreetmap.org) / OpenStreetMap contributors.
