'''
Starlink Satellite Tracker
    CS50 Final Project — Mike Tomasulo

A real-time web application that shows which Starlink satellites are currently
connectable from a given location on Earth. Orbital element data (TLE) is
fetched from Celestrak and cached for 6 hours; every 10 seconds the app
re-propagates those elements using the SGP4 algorithm to compute live satellite
positions, filters for operational orbital shells and minimum link elevation,
and returns results colored by signal quality.

Developed with the assistance from Claude Code (Anthropic).
'''

import time
import logging
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template, request
from waitress import serve

import satellite as sat_mod

logging.basicConfig(level=logging.INFO)

app = Flask(__name__)


def _parse_time(time_str):
    """
    Parse an ISO-8601 string (e.g. "2024-01-15T14:30:00Z" or
    "2024-01-15T14:30:00+00:00") to a UTC-aware datetime.
    Returns None if time_str is falsy.
    Raises ValueError on bad input.
    """
    if not time_str:
        return None
    try:
        dt = datetime.fromisoformat(time_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        raise ValueError(f"Invalid time format: {time_str!r}. Use ISO 8601.")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/satellites")
def api_satellites():
    try:
        lat = float(request.args.get("lat", 0))
        lon = float(request.args.get("lon", 0))
        alt = float(request.args.get("alt", 0))
    except ValueError:
        return jsonify({"error": "lat/lon/alt must be numeric"}), 400

    try:
        dt = _parse_time(request.args.get("time"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        sats, _ = sat_mod.get_satellites_for_observer(lat, lon, alt, dt=dt)
        return jsonify(sats)
    except Exception as exc:
        app.logger.exception("Error computing satellites")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/tle/status")
def api_tle_status():
    with sat_mod._cache["lock"]:
        fetched_at = sat_mod._cache["fetched_at"]
        count = len(sat_mod._cache["satellites"])

    now = time.time()
    age = round(now - fetched_at, 1) if fetched_at > 0 else None

    return jsonify({
        "satellite_count": count,
        "fetched_at": fetched_at,
        "cache_age_seconds": age,
        "cache_ttl_seconds": sat_mod.TLE_CACHE_TTL,
    })


if __name__ == "__main__":
    app.logger.info("Pre-fetching TLE data…")
    try:
        sat_mod.get_satellites()
    except Exception as exc:
        app.logger.warning("Could not pre-fetch TLEs: %s", exc)

    serve(app, host="0.0.0.0", port=80, threads=4)
