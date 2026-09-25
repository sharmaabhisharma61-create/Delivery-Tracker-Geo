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
