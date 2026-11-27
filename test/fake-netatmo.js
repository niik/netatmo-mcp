// A tiny stand-in for api.netatmo.com used by the tests.

import { createServer } from "node:http";

export const STATION = {
  _id: "70:ee:50:00:00:01",
  type: "NAMain",
  station_name: "Home (Indoor)",
  home_name: "Home",
  module_name: "Indoor",
  data_type: ["Temperature", "CO2", "Humidity", "Noise", "Pressure"],
  wifi_status: 50,
  reachable: true,
  last_status_store: 1764230000,
  place: { timezone: "Europe/Stockholm", city: "Stockholm", country: "SE", altitude: 20, location: [18.07, 59.33] },
  dashboard_data: {
    time_utc: 1764230000, Temperature: 21.4, CO2: 612, Humidity: 41, Noise: 38, Pressure: 1012.3, AbsolutePressure: 1009.9,
    min_temp: 20.1, max_temp: 22.0, date_min_temp: 1764200000, date_max_temp: 1764220000, temp_trend: "stable", pressure_trend: "up",
  },
  modules: [
    {
      _id: "02:00:00:00:00:01", type: "NAModule1", module_name: "Outdoor", data_type: ["Temperature", "Humidity"],
      battery_percent: 77, rf_status: 70, reachable: true, last_seen: 1764230000,
      dashboard_data: { time_utc: 1764230000, Temperature: -3.2, Humidity: 88, min_temp: -6.1, max_temp: -1.0, date_min_temp: 1764190000, date_max_temp: 1764215000, temp_trend: "down" },
    },
    {
      _id: "05:00:00:00:00:01", type: "NAModule3", module_name: "Rain gauge", data_type: ["Rain"],
      battery_percent: 90, rf_status: 65, reachable: true, last_seen: 1764230000,
      dashboard_data: { time_utc: 1764230000, Rain: 0.1, sum_rain_1: 0.4, sum_rain_24: 3.2 },
    },
  ],
};

// Tests can change `opts` to make the fake misbehave.
export function startFakeNetatmo() {
  const calls = [];
  const opts = { mail: "owner@example.com", station: STATION, stationsStatus: 200, apiAuthFail: false, hang: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    for await (const c of req) body += c;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (opts.hang && url.pathname.startsWith("/api/")) return; // never answers

    if (url.pathname === "/oauth2/token") {
      const p = new URLSearchParams(body);
      if (p.get("client_id") !== "app-id" || p.get("client_secret") !== "app-secret") return send(400, { error: "invalid_client" });
      if (p.get("grant_type") === "authorization_code" && p.get("code") === "netatmo-code")
        return send(200, { access_token: "na-access-1", refresh_token: "na-refresh-1", expires_in: 10800, scope: ["read_station"] });
      const n = p.get("grant_type") === "refresh_token" && /^na-refresh-(\d+)$/.exec(p.get("refresh_token") || "")?.[1];
      if (n) return send(200, { access_token: `na-access-${+n + 1}`, refresh_token: `na-refresh-${+n + 1}`, expires_in: 10800, scope: ["read_station"] });
      return send(400, { error: "invalid_grant" });
    }

    const auth = req.headers.authorization;
    if (url.pathname.startsWith("/api/") && (opts.apiAuthFail || !/^Bearer na-access-\d+$/.test(auth || "")))
      return send(403, { error: { code: 3, message: "Access token expired" } });

    if (url.pathname === "/api/getstationsdata") {
      if (opts.stationsStatus !== 200) return send(opts.stationsStatus, { error: { code: 500, message: "Internal error" } });
      return send(200, { status: "ok", body: { devices: [opts.station], user: { mail: opts.mail, administrative: { unit: 0 } } } });
    }

    if (url.pathname === "/api/getmeasure") {
      const q = url.searchParams;
      const step = { max: 300, "30min": 1800, "1hour": 3600, "3hours": 10800, "1day": 86400 }[q.get("scale")] || 1800;
      const types = q.get("type").split(",");
      const begin = Number(q.get("date_begin"));
      const end = Number(q.get("date_end"));
      const limit = Number(q.get("limit")) || 1024;
      const out = {};
      let n = 0;
      for (let t = Math.ceil(begin / step) * step; t <= end && n < limit; t += step, n++) {
        out[t] = types.map((ty) =>
          /rain/i.test(ty) ? 0.5 : /^date_/.test(ty) ? t + 100 : Math.round((Math.sin(t / 40000) * 10 + (/hum/i.test(ty) ? 60 : 0)) * 10) / 10,
        );
      }
      return send(200, { status: "ok", body: out });
    }
    send(404, { error: { code: 404, message: "not found" } });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, opts, url: `http://127.0.0.1:${server.address().port}` })),
  );
}
