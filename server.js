const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

async function init() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data JSONB NOT NULL)"
  );
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM accounts");
  if (rows[0].n === 0) {
    const seedPath = path.join(__dirname, "accounts-seed.json");
    if (fs.existsSync(seedPath)) {
      const seed = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
      for (const a of seed) {
        const { id, ...data } = a;
        await pool.query(
          "INSERT INTO accounts (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
          [id, data]
        );
      }
      console.log("Seeded", seed.length, "accounts");
    }
  }
  await migrateToProjects();
}

// Each account doc is a client holding a list of projects. Older docs stored
// everything flat, so wrap them into a single default project (idempotent).
async function migrateToProjects() {
  const { rows } = await pool.query("SELECT id, data FROM accounts");
  for (const r of rows) {
    if (Array.isArray(r.data.projects)) continue;
    const { name, order, logoSvg, logoImg, ...rest } = r.data;
    const data = {
      name,
      order,
      logoSvg: logoSvg || "",
      logoImg: logoImg || "",
      projects: [Object.assign({ id: r.id + "-1", name: "GEO Engagement" }, rest)]
    };
    await pool.query("UPDATE accounts SET data = $2 WHERE id = $1", [r.id, data]);
    console.log("Migrated", r.id, "to client/project model");
  }
}

// Read-modify-write one client doc under a row lock so two people editing
// different projects of the same client never overwrite each other.
async function withClientDoc(clientId, fn) {
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const { rows } = await conn.query("SELECT data FROM accounts WHERE id = $1 FOR UPDATE", [clientId]);
    if (!rows.length) {
      await conn.query("ROLLBACK");
      return { status: 404, body: { error: "Client not found" } };
    }
    const data = rows[0].data;
    if (!Array.isArray(data.projects)) data.projects = [];
    const out = fn(data);
    if (out.status === 200) await conn.query("UPDATE accounts SET data = $2 WHERE id = $1", [clientId, data]);
    await conn.query(out.status === 200 ? "COMMIT" : "ROLLBACK");
    return out;
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/accounts", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, data FROM accounts");
    res.json(rows.map((r) => Object.assign({ id: r.id }, r.data)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/accounts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body || {};
    await pool.query(
      "INSERT INTO accounts (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2",
      [id, data]
    );
    res.json({ id, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/accounts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const patch = req.body || {};
    const { rows } = await pool.query("SELECT data FROM accounts WHERE id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const merged = Object.assign({}, rows[0].data, patch);
    await pool.query("UPDATE accounts SET data = $2 WHERE id = $1", [id, merged]);
    res.json({ id, ...merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/accounts/:cid/projects", async (req, res) => {
  try {
    const project = Object.assign({}, req.body || {});
    project.id = req.params.cid + "-" + Date.now().toString(36);
    const out = await withClientDoc(req.params.cid, (data) => {
      data.projects.push(project);
      return { status: 200, body: project };
    });
    res.status(out.status).json(out.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/accounts/:cid/projects/:pid", async (req, res) => {
  try {
    const patch = req.body || {};
    const out = await withClientDoc(req.params.cid, (data) => {
      const p = data.projects.find((x) => x.id === req.params.pid);
      if (!p) return { status: 404, body: { error: "Project not found" } };
      Object.assign(p, patch, { id: p.id });
      return { status: 200, body: p };
    });
    res.status(out.status).json(out.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/accounts/:cid/projects/:pid", async (req, res) => {
  try {
    const out = await withClientDoc(req.params.cid, (data) => {
      const before = data.projects.length;
      data.projects = data.projects.filter((x) => x.id !== req.params.pid);
      if (data.projects.length === before) return { status: 404, body: { error: "Project not found" } };
      return { status: 200, body: { ok: true, remaining: data.projects.length } };
    });
    res.status(out.status).json(out.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/accounts/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM accounts WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

init()
  .then(() => {
    app.listen(port, () => console.log("GEO Delivery Tracker listening on port " + port));
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
