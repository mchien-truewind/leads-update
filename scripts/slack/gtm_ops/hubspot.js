// Minimal HubSpot CRM client: token load, rate-limit-aware fetch, owners, search, associations.
// Ported from the retired gtm-ops repo. The worker entrypoint (gtm_ops_bot.js) loads
// .env.local before requiring this module, so the token is present at require time.
const fs = require("fs");
const path = require("path");

const BASE = "https://api.hubapi.com";

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
// Local dev convenience; on Railway vars come from the environment. Check repo root + cwd.
loadEnv(path.resolve(__dirname, "../../../.env.local"));
loadEnv(path.resolve(process.cwd(), ".env.local"));

const TOKEN =
  process.env.HUBSPOT_PRIVATE_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN ||
  process.env.HUBSPOT_MERCEDES_CLAUDE ||
  process.env.HUBSPOT;

if (!TOKEN) throw new Error("Missing HubSpot token (HUBSPOT_PRIVATE_TOKEN / HUBSPOT_ACCESS_TOKEN / HUBSPOT_MERCEDES_CLAUDE)");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hub(method, urlPath, body, attempt = 0) {
  const res = await fetch(urlPath.startsWith("http") ? urlPath : BASE + urlPath, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 && attempt < 8) {
    await sleep(1200 + attempt * 400);
    return hub(method, urlPath, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

// Map of active owners: ownerId -> { name, email }. Excludes archived.
async function getOwners() {
  const map = new Map();
  let after;
  do {
    const u = new URL(BASE + "/crm/v3/owners");
    u.searchParams.set("limit", "100");
    if (after) u.searchParams.set("after", after);
    const d = await hub("GET", u.pathname + u.search);
    for (const o of d.results || []) {
      map.set(String(o.id), { name: `${o.firstName || ""} ${o.lastName || ""}`.trim(), email: (o.email || "").toLowerCase() });
    }
    after = d.paging?.next?.after;
  } while (after);
  return map;
}

async function searchAll(objectType, body) {
  const all = [];
  let after;
  do {
    const d = await hub("POST", `/crm/v3/objects/${objectType}/search`, { ...body, after });
    all.push(...(d.results || []));
    after = d.paging?.next?.after;
    await sleep(200);
  } while (after);
  return all;
}

// deal/contact -> associated object ids. Returns Map<fromId, string[] toIds>.
async function associations(fromType, ids, toType) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const d = await hub("POST", `/crm/v4/associations/${fromType}/${toType}/batch/read`, {
      inputs: ids.slice(i, i + 100).map((id) => ({ id })),
    });
    for (const r of d.results || []) out.set(String(r.from.id), (r.to || []).map((t) => String(t.toObjectId)));
    await sleep(150);
  }
  return out;
}

async function batchRead(objectType, ids, properties) {
  const out = new Map();
  const uniq = [...new Set(ids.map(String))];
  for (let i = 0; i < uniq.length; i += 100) {
    const d = await hub("POST", `/crm/v3/objects/${objectType}/batch/read`, {
      properties,
      inputs: uniq.slice(i, i + 100).map((id) => ({ id })),
    });
    for (const o of d.results || []) out.set(String(o.id), o.properties || {});
    await sleep(150);
  }
  return out;
}

module.exports = { BASE, hub, getOwners, searchAll, associations, batchRead, sleep };
