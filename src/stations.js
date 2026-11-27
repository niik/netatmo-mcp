// Normalizes Netatmo station data and formats it for the tools.

import { formatTime, isValidTimeZone } from "./time.js";

export const MODULE_KINDS = {
  NAMain: { label: "Indoor (base station)", aliases: ["indoor", "main", "base", "base station", "inside"] },
  NAModule1: { label: "Outdoor", aliases: ["outdoor", "outside", "outdoors"] },
  NAModule2: { label: "Wind gauge", aliases: ["wind", "anemometer", "wind gauge"] },
  NAModule3: { label: "Rain gauge", aliases: ["rain", "rain gauge", "precipitation"] },
  NAModule4: { label: "Additional indoor", aliases: ["indoor", "additional indoor", "inside"] },
};

const UNITS = {
  temperature: "°C",
  min_temp: "°C",
  max_temp: "°C",
  humidity: "%",
  min_hum: "%",
  max_hum: "%",
  co2: "ppm",
  min_co2: "ppm",
  max_co2: "ppm",
  pressure: "mbar",
  min_pressure: "mbar",
  max_pressure: "mbar",
  noise: "dB",
  min_noise: "dB",
  max_noise: "dB",
  rain: "mm",
  sum_rain: "mm",
  windstrength: "km/h",
  guststrength: "km/h",
  max_wind_str: "km/h",
  windangle: "°",
  gustangle: "°",
};
export const unitFor = (type) => UNITS[String(type).toLowerCase()] ?? "";

/** Flatten getstationsdata into stations, each with its base station as the first module. */
export function normalizeStations(body) {
  const devices = Array.isArray(body?.devices) ? body.devices : [];
  return devices.map((d) => {
    const tz = isValidTimeZone(d.place?.timezone) ? d.place.timezone : "UTC";
    const main = {
      id: d._id,
      name: cleanName(d.module_name) || "Indoor",
      type: d.type || "NAMain",
      dataTypes: d.data_type || [],
      dashboard: d.dashboard_data || null,
      reachable: d.reachable !== false,
      lastSeen: d.last_status_store ?? d.dashboard_data?.time_utc,
      wifi: d.wifi_status,
      firmware: d.firmware,
      isMain: true,
    };
    const modules = (d.modules || []).map((m) => ({
      id: m._id,
      name: cleanName(m.module_name) || MODULE_KINDS[m.type]?.label || cleanName(m.type),
      type: m.type,
      dataTypes: m.data_type || [],
      dashboard: m.dashboard_data || null,
      reachable: m.reachable !== false,
      lastSeen: m.last_seen ?? m.last_message ?? m.dashboard_data?.time_utc,
      battery: m.battery_percent,
      rf: m.rf_status,
      firmware: m.firmware,
      isMain: false,
    }));
    return {
      id: d._id,
      name: cleanName(d.home_name || d.station_name || d.module_name) || d._id,
      tz,
      place: d.place || {},
      readOnly: d.read_only === true,
      modules: [main, ...modules],
    };
  });
}

/**
 * Names come from Netatmo users (including owners of stations shared with this
 * user) and end up in the model's context: strip control and markdown
 * characters and cap the length.
 */
export const cleanName = (s) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f`*_#|<>\[\]()\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

const norm = (s) => String(s ?? "").trim().toLowerCase();

export function findStation(stations, query) {
  if (!stations.length) throw new Error("No weather stations found on this Netatmo account.");
  if (!query) return stations[0];
  const q = norm(query);
  const hit =
    stations.find((s) => norm(s.id) === q) ||
    stations.find((s) => norm(s.name) === q) ||
    stations.find((s) => norm(s.name).includes(q));
  if (!hit) throw new Error(`No station matches "${query}". Stations: ${stations.map((s) => s.name).join(", ")}.`);
  return hit;
}

/** Find a module by id, name or kind ("outdoor", "rain", ...), optionally within one station. */
export function findModule(stations, { station, module }) {
  const pool = station ? [findStation(stations, station)] : stations;
  const all = pool.flatMap((s) => s.modules.map((m) => ({ station: s, module: m })));
  if (!all.length) throw new Error("No weather stations found on this Netatmo account.");
  if (!module) {
    // Default: the outdoor module, else the base station.
    return all.find((x) => x.module.type === "NAModule1") || all[0];
  }
  const q = norm(module);
  const hit =
    all.find((x) => norm(x.module.id) === q) ||
    all.find((x) => norm(x.module.name) === q) ||
    all.find((x) => (MODULE_KINDS[x.module.type]?.aliases || []).includes(q)) ||
    all.find((x) => norm(x.module.name).includes(q));
  if (!hit) {
    const list = all.map((x) => `${x.module.name} (${MODULE_KINDS[x.module.type]?.label || x.module.type})`).join(", ");
    throw new Error(`No module matches "${module}". Modules: ${list}.`);
  }
  return hit;
}

// ── Formatting ──────────────────────────────────────────────────────────────

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg) => (deg == null || deg < 0 ? "" : ` (${COMPASS[Math.round(deg / 22.5) % 16]})`);
const num = (v, unit) => (v == null ? null : `${v}${unit ? (unit === "%" || unit === "°" || unit === "°C" ? "" : " ") + unit : ""}`);

function signalLabel(rf) {
  if (rf == null) return null;
  return rf >= 90 ? "low" : rf >= 76 ? "medium" : rf >= 60 ? "high" : "full"; // lower rf_status = stronger
}
function wifiLabel(w) {
  if (w == null) return null;
  return w >= 86 ? "bad" : w >= 71 ? "average" : "good";
}

/** Lines describing one module's latest readings. */
export function formatReadings(m, tz) {
  const d = m.dashboard;
  if (!d) return [m.reachable ? "No data yet." : "Module unreachable, no current data."];
  const t = (u) => formatTime(u, tz);
  const lines = [];
  const add = (label, value) => value != null && lines.push(`- ${label}: ${value}`);

  if (d.Temperature != null) {
    add("Temperature", `${num(d.Temperature, "°C")}${d.temp_trend ? ` (trend: ${d.temp_trend})` : ""}`);
    if (d.min_temp != null) add("Today's low", `${num(d.min_temp, "°C")} at ${t(d.date_min_temp)}`);
    if (d.max_temp != null) add("Today's high", `${num(d.max_temp, "°C")} at ${t(d.date_max_temp)}`);
  }
  add("Humidity", num(d.Humidity, "%"));
  add("CO₂", num(d.CO2, "ppm"));
  add("Noise", num(d.Noise, "dB"));
  if (d.Pressure != null)
    add("Pressure (sea level)", `${num(d.Pressure, "mbar")}${d.pressure_trend ? ` (trend: ${d.pressure_trend})` : ""}`);
  add("Absolute pressure", num(d.AbsolutePressure, "mbar"));

  add("Rain, latest reading", num(d.Rain, "mm"));
  add("Rain, last hour", num(d.sum_rain_1, "mm"));
  add("Rain, today", num(d.sum_rain_24, "mm"));

  if (d.WindStrength != null) add("Wind", `${num(d.WindStrength, "km/h")} from ${d.WindAngle}°${compass(d.WindAngle)}`);
  if (d.GustStrength != null) add("Gusts", `${num(d.GustStrength, "km/h")} from ${d.GustAngle}°${compass(d.GustAngle)}`);
  if (d.max_wind_str != null)
    add("Today's strongest wind", `${num(d.max_wind_str, "km/h")} from ${d.max_wind_angle}°${compass(d.max_wind_angle)} at ${t(d.date_max_wind_str)}`);

  add("Measured", t(d.time_utc));
  return lines;
}

export function formatModuleStatus(m, tz) {
  const bits = [];
  if (!m.reachable) bits.push("UNREACHABLE");
  if (m.battery != null) bits.push(`battery ${m.battery}%`);
  if (m.rf != null) bits.push(`radio signal ${signalLabel(m.rf)}`);
  if (m.wifi != null) bits.push(`Wi-Fi ${wifiLabel(m.wifi)}`);
  if (m.lastSeen) bits.push(`last seen ${formatTime(m.lastSeen, tz)}`);
  return bits.join(", ");
}

/** City/country, altitude and time zone. GPS coordinates are deliberately left out (they pinpoint the user's home). */
export function formatPlace(s) {
  const p = s.place;
  const loc = [p.city, p.country].filter(Boolean).map(cleanName).join(", ");
  const alt = typeof p.altitude === "number" ? `, altitude ${p.altitude} m` : "";
  return `${loc || "Unknown location"}${alt}; time zone ${s.tz}`;
}

/** Default getmeasure types for a module type and scale. */
export function defaultTypes(moduleType, scale) {
  const daily = ["1day", "1week", "1month"].includes(scale);
  switch (moduleType) {
    case "NAMain":
      return daily
        ? ["Temperature", "min_temp", "max_temp", "Humidity", "CO2", "Pressure"]
        : ["Temperature", "Humidity", "CO2", "Pressure", "Noise"];
    case "NAModule1":
      return daily ? ["Temperature", "min_temp", "max_temp", "Humidity"] : ["Temperature", "Humidity"];
    case "NAModule4":
      return daily ? ["Temperature", "min_temp", "max_temp", "Humidity", "CO2"] : ["Temperature", "Humidity", "CO2"];
    case "NAModule3":
      return scale === "max" ? ["Rain"] : ["sum_rain"];
    case "NAModule2":
      return ["WindStrength", "WindAngle", "GustStrength", "GustAngle"];
    default:
      return ["Temperature"];
  }
}

export const SCALES = ["max", "30min", "1hour", "3hours", "1day", "1week", "1month"];

/** Pick a scale that keeps the series a readable size for the time range. */
export function autoScale(seconds) {
  const day = 86400;
  if (seconds <= 1 * day) return "30min";
  if (seconds <= 3 * day) return "1hour";
  if (seconds <= 21 * day) return "3hours";
  if (seconds <= 400 * day) return "1day";
  if (seconds <= 8 * 365 * day) return "1week";
  return "1month";
}
