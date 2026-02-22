"""
Satellite TLE fetching, SGP4 propagation, and visibility math.

Coordinate frames used:
  TEME  - True Equator Mean Equinox (SGP4 output frame)
  ECEF  - Earth-Centered, Earth-Fixed (rotated from TEME via GMST)
  ENU   - East, North, Up (topocentric, for look angles)
"""

import math
import time
import threading
import logging

import numpy as np
import requests
from sgp4.api import Satrec, SatrecArray, jday

logger = logging.getLogger(__name__)

# WGS-84 constants
_A_KM = 6378.137          # Earth equatorial radius (km)
_E2 = 0.00669437999014    # First eccentricity squared

TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle"
TLE_CACHE_TTL = 6 * 3600  # seconds

_cache = {
    "satellites": [],   # list of {"name", "norad_id", "satrec"}
    "fetched_at": 0.0,
    "lock": threading.Lock(),
}


# ---------------------------------------------------------------------------
# TLE fetching & caching
# ---------------------------------------------------------------------------

def _fetch_tles():
    """Download and parse TLE data from Celestrak. Returns list of satellite dicts."""
    resp = requests.get(TLE_URL, timeout=30)
    resp.raise_for_status()

    lines = resp.text.strip().splitlines()
    satellites = []
    i = 0
    while i + 2 < len(lines):
        name = lines[i].strip()
        line1 = lines[i + 1].strip()
        line2 = lines[i + 2].strip()
        if line1.startswith("1 ") and line2.startswith("2 "):
            try:
                satrec = Satrec.twoline2rv(line1, line2)
                satellites.append({
                    "name": name,
                    "norad_id": satrec.satnum,
                    "satrec": satrec,
                })
            except Exception as exc:
                logger.warning("Skipping bad TLE for %s: %s", name, exc)
            i += 3
        else:
            i += 1

    logger.info("Loaded %d Starlink satellites", len(satellites))
    return satellites


def get_satellites():
    """Return (satellites, fetched_at), refreshing cache if stale."""
    with _cache["lock"]:
        if time.time() - _cache["fetched_at"] > TLE_CACHE_TTL or not _cache["satellites"]:
            sats = _fetch_tles()
            _cache["satellites"] = sats
            _cache["fetched_at"] = time.time()
        return _cache["satellites"], _cache["fetched_at"]


# ---------------------------------------------------------------------------
# Coordinate transforms
# ---------------------------------------------------------------------------

def _gmst(jd, fr):
    """Greenwich Mean Sidereal Time in radians for Julian date (jd + fr)."""
    jd_full = jd + fr
    T = (jd_full - 2451545.0) / 36525.0
    # IAU 1982 formula, degrees
    theta = (
        280.46061837
        + 360.98564736629 * (jd_full - 2451545.0)
        + 0.000387933 * T ** 2
        - T ** 3 / 38710000.0
    )
    return math.radians(theta % 360.0)


def _teme_to_ecef_batch(positions_teme: np.ndarray, theta: float) -> np.ndarray:
    """
    Rotate an (N, 3) array of TEME positions to ECEF using GMST angle theta.

    ECEF = R_z(-theta) * TEME  =>
        x_ecef =  cos(theta)*x + sin(theta)*y
        y_ecef = -sin(theta)*x + cos(theta)*y
        z_ecef =  z
    """
    c, s = math.cos(theta), math.sin(theta)
    ecef = positions_teme.copy()
    ecef[:, 0] = c * positions_teme[:, 0] + s * positions_teme[:, 1]
    ecef[:, 1] = -s * positions_teme[:, 0] + c * positions_teme[:, 1]
    # z unchanged
    return ecef


def _observer_ecef(lat_deg: float, lon_deg: float, alt_m: float):
    """Geodetic (deg, deg, m) → ECEF position vector (km)."""
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    alt_km = alt_m / 1000.0
    N = _A_KM / math.sqrt(1.0 - _E2 * math.sin(lat) ** 2)
    x = (N + alt_km) * math.cos(lat) * math.cos(lon)
    y = (N + alt_km) * math.cos(lat) * math.sin(lon)
    z = (N * (1.0 - _E2) + alt_km) * math.sin(lat)
    return np.array([x, y, z])


def _ecef_to_enu_matrix(lat_deg: float, lon_deg: float) -> np.ndarray:
    """
    3×3 rotation matrix from ECEF difference vector to ENU (East, North, Up).
    """
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    sl, cl = math.sin(lat), math.cos(lat)
    so, co = math.sin(lon), math.cos(lon)
    # Rows: E, N, U
    return np.array([
        [-so,       co,      0.0],
        [-sl * co, -sl * so, cl],
        [ cl * co,  cl * so, sl],
    ])


def _ecef_to_geodetic(x: float, y: float, z: float):
    """ECEF (km) → (lat_deg, lon_deg, alt_km) via Bowring iteration."""
    lon = math.degrees(math.atan2(y, x))
    p = math.sqrt(x ** 2 + y ** 2)
    lat = math.atan2(z, p * (1.0 - _E2))
    for _ in range(5):
        N = _A_KM / math.sqrt(1.0 - _E2 * math.sin(lat) ** 2)
        lat = math.atan2(z + _E2 * N * math.sin(lat), p)
    N = _A_KM / math.sqrt(1.0 - _E2 * math.sin(lat) ** 2)
    if abs(math.cos(lat)) > 1e-10:
        alt_km = p / math.cos(lat) - N
    else:
        alt_km = abs(z) / math.sin(lat) - N * (1.0 - _E2)
    return math.degrees(lat), lon, alt_km


def _ecef_to_geodetic_batch(ecef: np.ndarray):
    """Vectorised ECEF (N×3, km) → (lats_deg, lons_deg, alts_km)."""
    x, y, z = ecef[:, 0], ecef[:, 1], ecef[:, 2]
    lons = np.degrees(np.arctan2(y, x))
    p = np.sqrt(x ** 2 + y ** 2)
    lats = np.arctan2(z, p * (1.0 - _E2))
    for _ in range(5):
        N = _A_KM / np.sqrt(1.0 - _E2 * np.sin(lats) ** 2)
        lats = np.arctan2(z + _E2 * N * np.sin(lats), p)
    N = _A_KM / np.sqrt(1.0 - _E2 * np.sin(lats) ** 2)
    cos_lat = np.cos(lats)
    sin_lat = np.sin(lats)
    alts = np.where(
        np.abs(cos_lat) > 1e-10,
        p / cos_lat - N,
        np.abs(z) / sin_lat - N * (1.0 - _E2),
    )
    return np.degrees(lats), lons, alts


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

import datetime as _dt

# Operational Starlink altitude band (km) — excludes test/transit/decommissioned sats
_ALT_MIN_KM      = 450.0
_ALT_MAX_KM      = 650.0

# Elevation thresholds
_EL_CONNECTABLE  = 25.0   # minimum for reliable link (scan loss + atmosphere)
_EL_VISIBLE      = 10.0   # show "approaching" sats above this


def _to_jd(dt: "_dt.datetime"):
    """Convert a timezone-aware UTC datetime to (jd, fr)."""
    return jday(dt.year, dt.month, dt.day,
                dt.hour, dt.minute, dt.second + dt.microsecond / 1e6)


def _quality(elevation: float) -> int:
    """
    Signal quality score 0–100 for a connectable satellite.
    Based on elevation angle (primary driver of scan loss + atmospheric path).
    """
    return round(max(0.0, min(1.0, (elevation - _EL_CONNECTABLE) / (90.0 - _EL_CONNECTABLE))) * 100)


def get_satellites_for_observer(lat: float, lon: float, alt_m: float = 0.0,
                                dt: "_dt.datetime | None" = None):
    """
    Return (list_of_dicts, fetched_at_timestamp).

    Returns every operational-altitude Starlink satellite above the visible
    horizon (≥ 10°).  Each dict includes:
      connectable  – True when elevation ≥ 25° (usable link)
      quality      – 0–100 signal quality score (0 when not connectable)
      name, norad_id, azimuth, elevation, range_km, lat, lon, altitude_km
    """
    satellites, fetched_at = get_satellites()
    if not satellites:
        return [], fetched_at

    if dt is None:
        dt = _dt.datetime.now(_dt.timezone.utc)
    jd, fr = _to_jd(dt)

    theta = _gmst(jd, fr)
    obs   = _observer_ecef(lat, lon, alt_m)
    R_enu = _ecef_to_enu_matrix(lat, lon)

    # Batch propagate — output shape (M_sats, 1, 3); squeeze the time axis.
    sat_array = SatrecArray([s["satrec"] for s in satellites])
    _e, _r, _ = sat_array.sgp4(np.array([jd]), np.array([fr]))
    errors = _e[:, 0]       # (N,)
    r_teme = _r[:, 0, :]   # (N, 3)

    valid  = errors == 0
    r_ecef = _teme_to_ecef_batch(r_teme, theta)

    # Pre-filter 1: operational altitude band using ECEF magnitude
    ecef_mag   = np.linalg.norm(r_ecef, axis=1)
    alt_mask   = (ecef_mag >= (_A_KM + _ALT_MIN_KM)) & (ecef_mag <= (_A_KM + _ALT_MAX_KM))

    # Pre-filter 2: rough slant range (catches all sats above ~10° from 650 km)
    diff       = r_ecef - obs
    rough_dist = np.linalg.norm(diff, axis=1)
    range_mask = rough_dist < 3000.0

    candidates = np.where(valid & alt_mask & range_mask)[0]
    if candidates.size == 0:
        return [], fetched_at

    # Exact ENU look angles for candidates
    diff_c = diff[candidates]
    enu    = diff_c @ R_enu.T
    ranges = np.linalg.norm(diff_c, axis=1)
    elevs  = np.degrees(np.arctan2(enu[:, 2], np.sqrt(enu[:, 0]**2 + enu[:, 1]**2)))
    azims  = np.degrees(np.arctan2(enu[:, 0], enu[:, 1])) % 360.0

    # Keep only satellites above the visible floor
    above = elevs >= _EL_VISIBLE
    idxs  = candidates[above]
    elevs = elevs[above]
    azims = azims[above]
    rngs  = ranges[above]

    if idxs.size == 0:
        return [], fetched_at

    sat_lats, sat_lons, sat_alts = _ecef_to_geodetic_batch(r_ecef[idxs])

    result = []
    for k, i in enumerate(idxs):
        el   = float(elevs[k])
        conn = el >= _EL_CONNECTABLE
        result.append({
            "name":        satellites[i]["name"],
            "norad_id":    satellites[i]["norad_id"],
            "azimuth":     round(float(azims[k]), 2),
            "elevation":   round(el, 2),
            "range_km":    round(float(rngs[k]), 2),
            "lat":         round(float(sat_lats[k]), 4),
            "lon":         round(float(sat_lons[k]), 4),
            "altitude_km": round(float(sat_alts[k]), 2),
            "connectable": conn,
            "quality":     _quality(el) if conn else 0,
        })

    return result, fetched_at
