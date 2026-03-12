/**
 * health-check.ts
 *
 * Checks that all 11 KULT platform microservices are reachable and healthy
 * by sending HTTP GET requests to each service's /health endpoint.
 *
 * Prints a formatted status table and exits with code 1 if any service
 * is unhealthy or unreachable.
 *
 * Usage:
 *   npx ts-node scripts/health-check.ts
 *
 * Override default host/ports via environment variables (see SERVICE_MAP).
 */

import * as http from "http";
import * as https from "https";
import { URL } from "url";

// ─────────────────────────────────────────────────────────────────────────────
//  Service definitions
// ─────────────────────────────────────────────────────────────────────────────

interface ServiceDef {
  name: string;
  /** Environment variable that overrides the default URL */
  envVar: string;
  defaultUrl: string;
}

const SERVICES: ServiceDef[] = [
  {
    name: "API Gateway",
    envVar: "HEALTH_API_GATEWAY",
    defaultUrl: "http://localhost:3000/health",
  },
  {
    name: "Agent Service",
    envVar: "HEALTH_AGENT_SERVICE",
    defaultUrl: "http://localhost:3001/health",
  },
  {
    name: "Tournament Service",
    envVar: "HEALTH_TOURNAMENT_SERVICE",
    defaultUrl: "http://localhost:3002/health",
  },
  {
    name: "Economy Service",
    envVar: "HEALTH_ECONOMY_SERVICE",
    defaultUrl: "http://localhost:3003/health",
  },
  {
    name: "Settlement Service",
    envVar: "HEALTH_SETTLEMENT_SERVICE",
    defaultUrl: "http://localhost:3004/health",
  },
  {
    name: "Auth Service",
    envVar: "HEALTH_AUTH_SERVICE",
    defaultUrl: "http://localhost:3005/health",
  },
  {
    name: "Leaderboard Service",
    envVar: "HEALTH_LEADERBOARD_SERVICE",
    defaultUrl: "http://localhost:3006/health",
  },
  {
    name: "Blockchain Worker",
    envVar: "HEALTH_BLOCKCHAIN_WORKER",
    defaultUrl: "http://localhost:3007/health",
  },
  {
    name: "AI Inference Service",
    envVar: "HEALTH_AI_INFERENCE",
    defaultUrl: "http://localhost:3008/health",
  },
  {
    name: "Matchmaking Service",
    envVar: "HEALTH_MATCHMAKING",
    defaultUrl: "http://localhost:3009/health",
  },
  {
    name: "Notification Service",
    envVar: "HEALTH_NOTIFICATION",
    defaultUrl: "http://localhost:3010/health",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────────────────

type HealthStatus = "OK" | "DEGRADED" | "DOWN" | "TIMEOUT" | "ERROR";

interface HealthResult {
  service: ServiceDef;
  url: string;
  status: HealthStatus;
  httpStatus: number | null;
  responseTimeMs: number;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 5000;

function httpGet(rawUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const lib = parsed.protocol === "https:" ? https : http;

    const req = lib.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { "Accept": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("TIMEOUT"));
    });

    req.on("error", (err) => reject(err));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Check a single service
// ─────────────────────────────────────────────────────────────────────────────

async function checkService(service: ServiceDef): Promise<HealthResult> {
  const url = process.env[service.envVar] ?? service.defaultUrl;
  const start = Date.now();

  let httpStatus: number | null = null;
  let healthStatus: HealthStatus;
  let detail = "";

  try {
    const { status, body } = await httpGet(url);
    const elapsed = Date.now() - start;
    httpStatus = status;

    if (status === 200) {
      // Optionally parse a JSON body for a "status" field
      try {
        const json = JSON.parse(body) as Record<string, unknown>;
        if (typeof json.status === "string" && json.status !== "ok" && json.status !== "OK") {
          healthStatus = "DEGRADED";
          detail = `reported status: ${json.status}`;
        } else {
          healthStatus = "OK";
          detail = `${elapsed}ms`;
        }
      } catch {
        // Body wasn't JSON — 200 is good enough
        healthStatus = "OK";
        detail = `${elapsed}ms`;
      }
    } else if (status >= 500) {
      healthStatus = "DOWN";
      detail = `HTTP ${status}`;
    } else if (status >= 400) {
      healthStatus = "DEGRADED";
      detail = `HTTP ${status}`;
    } else {
      healthStatus = "DEGRADED";
      detail = `Unexpected HTTP ${status}`;
    }
  } catch (err: unknown) {
    const elapsed = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);

    if (msg === "TIMEOUT") {
      healthStatus = "TIMEOUT";
      detail = `No response within ${REQUEST_TIMEOUT_MS}ms`;
    } else {
      healthStatus = "ERROR";
      detail = msg.split("\n")[0].slice(0, 60);
    }
  }

  return {
    service,
    url,
    status: healthStatus,
    httpStatus,
    responseTimeMs: Date.now() - start,
    detail,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Formatting
// ─────────────────────────────────────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

function colorStatus(s: HealthStatus): string {
  switch (s) {
    case "OK":      return `${ANSI.green}${ANSI.bold}OK     ${ANSI.reset}`;
    case "DEGRADED":return `${ANSI.yellow}${ANSI.bold}DEGRADED${ANSI.reset}`;
    case "DOWN":    return `${ANSI.red}${ANSI.bold}DOWN   ${ANSI.reset}`;
    case "TIMEOUT": return `${ANSI.red}${ANSI.bold}TIMEOUT${ANSI.reset}`;
    case "ERROR":   return `${ANSI.red}${ANSI.bold}ERROR  ${ANSI.reset}`;
  }
}

function padEnd(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - s.length));
}

function printTable(results: HealthResult[]) {
  const COL_NAME   = 26;
  const COL_STATUS = 10;
  const COL_HTTP   = 7;
  const COL_URL    = 38;

  const hr = "─".repeat(COL_NAME + COL_STATUS + COL_HTTP + COL_URL + 6);

  console.log(`\n${ANSI.bold}KULT Platform — Service Health Report${ANSI.reset}`);
  console.log(hr);
  console.log(
    `${ANSI.bold}${padEnd("SERVICE", COL_NAME)}  ${padEnd("STATUS", COL_STATUS)}  ${padEnd("HTTP", COL_HTTP)}  ENDPOINT${ANSI.reset}`
  );
  console.log(hr);

  for (const r of results) {
    const name   = padEnd(r.service.name, COL_NAME);
    const status = colorStatus(r.status);
    const http   = padEnd(r.httpStatus !== null ? String(r.httpStatus) : "—", COL_HTTP);
    const url    = `${ANSI.dim}${r.url}${ANSI.reset}`;
    const detail = r.detail ? ` ${ANSI.dim}(${r.detail})${ANSI.reset}` : "";

    console.log(`${name}  ${status}  ${http}  ${url}${detail}`);
  }

  console.log(hr);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${ANSI.cyan}[health-check]${ANSI.reset} Checking ${SERVICES.length} services...`);

  // Fire all checks concurrently
  const results = await Promise.all(SERVICES.map(checkService));

  printTable(results);

  // Summary
  const ok       = results.filter((r) => r.status === "OK").length;
  const degraded = results.filter((r) => r.status === "DEGRADED").length;
  const down     = results.filter((r) => r.status === "DOWN" || r.status === "TIMEOUT" || r.status === "ERROR").length;

  console.log(
    `\nSummary: ${ANSI.green}${ok} healthy${ANSI.reset}` +
    (degraded > 0 ? `, ${ANSI.yellow}${degraded} degraded${ANSI.reset}` : "") +
    (down > 0 ? `, ${ANSI.red}${down} down${ANSI.reset}` : "") +
    "\n"
  );

  if (down > 0) {
    console.error(
      `${ANSI.red}[health-check] FAILED — ${down} service(s) are unreachable.${ANSI.reset}`
    );
    process.exit(1);
  }

  if (degraded > 0) {
    console.warn(
      `${ANSI.yellow}[health-check] WARNING — ${degraded} service(s) are degraded.${ANSI.reset}`
    );
    // Exit 0 but warn — degraded is not fatal
    process.exit(0);
  }

  console.log(`${ANSI.green}[health-check] All services healthy.${ANSI.reset}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[health-check] Unexpected error:", err);
  process.exit(1);
});
