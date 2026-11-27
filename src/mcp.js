// MCP server and tools. A new server is built per request, bound to the
// caller's Netatmo access token.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NetatmoClient, NetatmoError } from "./netatmo.js";
import {
  autoScale,
  defaultTypes,
  findModule,
  findStation,
  formatModuleStatus,
  formatPlace,
  formatReadings,
  MODULE_KINDS,
  normalizeStations,
  SCALES,
  unitFor,
} from "./stations.js";
import { formatTime, parseDate } from "./time.js";

const VERSION = "0.1.0";

const INSTRUCTIONS =
  "Data from the user's own Netatmo Smart Weather Station(s): current readings and history for the indoor base station " +
  "(temperature, humidity, CO₂, noise, pressure), the outdoor module (temperature, humidity), and optional rain gauge, " +
  "wind gauge and additional indoor modules. Values are metric (°C, mm, km/h, mbar); convert if the user prefers other units. " +
  "Times are shown in the station's local time zone. Start with get_current_weather for 'now' questions; use " +
  "get_measurements for history, trends, records and totals (e.g. rain per day with scale=1day). " +
  "Call list_stations if you need module names or the station's location.";

const MAX_POINTS_CAP = 5000;

export function createServer(netatmoAccessToken) {
  const server = new McpServer(
    { name: "netatmo", title: "Netatmo Weather", version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  const api = new NetatmoClient(netatmoAccessToken);

  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const run = (fn) => async (args) => {
    try {
      return text(await fn(args));
    } catch (e) {
      const msg =
        e instanceof NetatmoError && e.isAuthError
          ? "Netatmo rejected the sign-in (token expired or revoked). Reconnect the Netatmo connector and try again."
          : e.message;
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  };
  const loadStations = async () => normalizeStations(await api.getStationsData());

  server.registerTool(
    "list_stations",
    {
      title: "List Netatmo stations and modules",
      description:
        "List the user's Netatmo weather stations with location and time zone, and every module (indoor base station, " +
        "outdoor, rain gauge, wind gauge, additional indoor) with its name, id, measured data types, battery, signal and last-seen time.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(async () => {
      const stations = await loadStations();
      if (!stations.length) return "No weather stations found on this Netatmo account.";
      return stations
        .map((s) =>
          [
            `# ${s.name}${s.readOnly ? " (shared with you, read-only)" : ""}`,
            `Station id: ${s.id}`,
            `Location: ${formatPlace(s)}`,
            "",
            ...s.modules.map(
              (m) =>
                `- **${m.name}**: ${MODULE_KINDS[m.type]?.label || m.type} · id ${m.id} · measures ${m.dataTypes.join(", ") || "–"}` +
                (formatModuleStatus(m, s.tz) ? ` · ${formatModuleStatus(m, s.tz)}` : ""),
            ),
          ].join("\n"),
        )
        .join("\n\n");
    }),
  );

  server.registerTool(
    "get_current_weather",
    {
      title: "Current Netatmo readings",
      description:
        "Latest readings from every module of the user's Netatmo weather station: indoor and outdoor temperature (with today's " +
        "high/low and trend), humidity, CO₂, noise, pressure, rain (latest, last hour, today) and wind/gusts. Readings update about every 10 minutes.",
      inputSchema: {
        station: z.string().optional().describe("Station name or id. Defaults to the first station."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(async ({ station }) => {
      const stations = await loadStations();
      const chosen = station ? [findStation(stations, station)] : stations;
      if (!chosen.length) return "No weather stations found on this Netatmo account.";
      return chosen
        .map((s) =>
          [
            `# ${s.name}`,
            `${formatPlace(s)}`,
            ...s.modules.flatMap((m) => {
              const status = formatModuleStatus(m, s.tz);
              return [
                `\n## ${m.name} (${MODULE_KINDS[m.type]?.label || m.type})`,
                ...formatReadings(m, s.tz),
                ...(status ? [`- Status: ${status}`] : []),
              ];
            }),
          ].join("\n"),
        )
        .join("\n\n");
    }),
  );

  server.registerTool(
    "get_measurements",
    {
      title: "Netatmo measurement history",
      description:
        "Historical measurements from one Netatmo module, with summary statistics (min/max with time, mean, and totals for rain). " +
        "Examples: outdoor temperature over the last week; daily min/max temperature for a month (scale=1day); rain per day or " +
        "month (module=rain, scale=1day or 1month); indoor CO₂ today. Without scale, one is chosen to suit the time range. " +
        "At aggregated scales, Temperature/Humidity/etc. are averages over each interval, min_temp/max_temp are the extremes, " +
        "and sum_rain is the rain total per interval.",
      inputSchema: {
        module: z
          .string()
          .optional()
          .describe("Module name, id, or kind: 'outdoor', 'indoor', 'rain', 'wind'. Defaults to the outdoor module."),
        station: z.string().optional().describe("Station name or id, if the user has several."),
        start: z
          .string()
          .optional()
          .describe("Start: YYYY-MM-DD (start of that day, station time) or ISO 8601 date-time. Defaults to 24 hours before end."),
        end: z
          .string()
          .optional()
          .describe("End: YYYY-MM-DD (end of that day, station time) or ISO 8601 date-time. Defaults to now."),
        scale: z
          .enum(SCALES)
          .optional()
          .describe("Interval per data point: max (every ~5–10 min), 30min, 1hour, 3hours, 1day, 1week, 1month."),
        types: z
          .array(z.string())
          .optional()
          .describe(
            "Netatmo measurement types, e.g. Temperature, min_temp, max_temp, date_min_temp, date_max_temp, Humidity, CO2, " +
              "Pressure, Noise, Rain, sum_rain, WindStrength, WindAngle, GustStrength, GustAngle. Defaults suit the module and scale.",
          ),
        max_points: z
          .number()
          .int()
          .min(1)
          .max(MAX_POINTS_CAP)
          .default(1000)
          .describe("Maximum data points to return (the series is cut at this many)."),
        include_series: z
          .boolean()
          .default(true)
          .describe("Include the data table. Set false to get only the summary for long ranges."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(async ({ module, station, start, end, scale, types, max_points, include_series }) => {
      const stations = await loadStations();
      const { station: s, module: m } = findModule(stations, { station, module });
      const tz = s.tz;
      const now = Math.floor(Date.now() / 1000);
      const dateEnd = Math.min(end ? parseDate(end, tz, { endOfDay: true }) : now, now);
      const dateBegin = start ? parseDate(start, tz) : dateEnd - 86400;
      if (dateBegin >= dateEnd) throw new Error("start must be before end.");
      const sc = scale || autoScale(dateEnd - dateBegin);
      const ty = types?.length ? types : defaultTypes(m.type, sc);

      // Netatmo returns at most 1024 points per call; page forward until done.
      const points = [];
      let cursor = dateBegin;
      let truncated = false;
      while (cursor <= dateEnd) {
        const limit = Math.min(1024, max_points - points.length);
        const page = await api.getMeasure({
          deviceId: s.id,
          moduleId: m.id,
          scale: sc,
          types: ty,
          dateBegin: cursor,
          dateEnd,
          limit,
        });
        const fresh = page.filter((p) => p.time >= cursor && p.time <= dateEnd);
        points.push(...fresh);
        if (points.length >= max_points) {
          truncated = true;
          break;
        }
        if (page.length < limit || !fresh.length) break;
        cursor = fresh[fresh.length - 1].time + 1;
      }

      const dateOnly = ["1day", "1week", "1month"].includes(sc);
      const when = (t) => formatTime(t, tz, { dateOnly });
      const isDateType = (t) => /^date_/i.test(t);
      const header = [
        `# ${s.name} – ${m.name} (${MODULE_KINDS[m.type]?.label || m.type})`,
        `Range: ${formatTime(dateBegin, tz)} → ${formatTime(dateEnd, tz)} (${tz}) · scale ${sc} · ${points.length} points`,
        `Units: ${ty.map((t) => `${t}${unitFor(t) ? ` ${unitFor(t)}` : isDateType(t) ? " (local time)" : ""}`).join(", ")}`,
      ];
      if (!points.length) return [...header, "", "No data for this range (the module may not have existed yet, or was offline)."].join("\n");

      // Summary per type.
      const summary = ["", "## Summary"];
      ty.forEach((t, i) => {
        if (isDateType(t)) return;
        const vals = points.map((p) => ({ v: p.values?.[i], t: p.time })).filter((x) => typeof x.v === "number");
        if (!vals.length) return summary.push(`- ${t}: no values`);
        const unit = unitFor(t) ? ` ${unitFor(t)}` : "";
        const min = vals.reduce((a, b) => (b.v < a.v ? b : a));
        const max = vals.reduce((a, b) => (b.v > a.v ? b : a));
        const parts = [`min ${min.v}${unit} (${when(min.t)})`, `max ${max.v}${unit} (${when(max.t)})`];
        if (!/angle/i.test(t)) {
          const mean = vals.reduce((a, b) => a + b.v, 0) / vals.length;
          parts.push(`mean ${Math.round(mean * 10) / 10}${unit}`);
        }
        if (/rain/i.test(t)) parts.push(`total ${Math.round(vals.reduce((a, b) => a + b.v, 0) * 10) / 10}${unit}`);
        summary.push(`- ${t}: ${parts.join(", ")}`);
      });
      // For daily extremes, report the exact time of the record from date_min_temp/date_max_temp when present.
      const di = (name) => ty.findIndex((t) => t.toLowerCase() === name);
      for (const [vName, dName, label] of [
        ["min_temp", "date_min_temp", "Lowest"],
        ["max_temp", "date_max_temp", "Highest"],
      ]) {
        const vi = di(vName);
        const dIdx = di(dName);
        if (vi < 0 || dIdx < 0) continue;
        const rows = points.filter((p) => typeof p.values?.[vi] === "number");
        if (!rows.length) continue;
        const best = rows.reduce((a, b) => ((label === "Lowest" ? b.values[vi] < a.values[vi] : b.values[vi] > a.values[vi]) ? b : a));
        summary.push(`- ${label} temperature: ${best.values[vi]} °C at ${formatTime(best.values[dIdx], tz)}`);
      }

      const out = [...header, ...summary];
      if (truncated) out.push("", `⚠️ Cut at ${max_points} points; narrow the range or use a coarser scale for the rest.`);
      if (include_series) {
        out.push(
          "",
          "## Data",
          `| Time | ${ty.join(" | ")} |`,
          `|---|${ty.map(() => "---").join("|")}|`,
          ...points.map(
            (p) =>
              `| ${when(p.time)} | ${ty
                .map((t, i) => {
                  const v = p.values?.[i];
                  return v == null ? "–" : isDateType(t) ? formatTime(v, tz) : v;
                })
                .join(" | ")} |`,
          ),
        );
      }
      return out.join("\n");
    }),
  );

  return server;
}
