const { Pool } = require("pg");

const HOLD_MINUTES = 15;

let pool;
let initialized = false;
let initPromise;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
      max: 3
    });
  }
  return pool;
}

async function initDb() {
  if (initialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      const db = getPool();
      await db.query(`
        CREATE TABLE IF NOT EXISTS bookings (
          id SERIAL PRIMARY KEY,
          nama TEXT NOT NULL,
          nohp TEXT NOT NULL,
          alamat TEXT NOT NULL,
          seats INTEGER[] NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending','paid','cancelled','expired')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          hold_until TIMESTAMPTZ
        );
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
      `);
      initialized = true;
    })().catch(err => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function releaseExpired(db) {
  await db.query(`
    UPDATE bookings
    SET status='expired'
    WHERE status='pending' AND hold_until IS NOT NULL AND hold_until <= NOW()
  `);
}

function cleanSeats(seats) {
  if (!Array.isArray(seats)) return [];
  return [...new Set(seats.map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 59)
    .sort((a, b) => a - b);
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return {};
  }
}

exports.handler = async (event) => {
  try {
    if (!process.env.DATABASE_URL) {
      return json(500, { error: "DATABASE_URL belum diatur di Netlify." });
    }

    await initDb();
    const db = getPool();
    const path = event.path || "";
    const method = event.httpMethod || "GET";

    if (path.endsWith("/health") && method === "GET") {
      return json(200, { ok: true });
    }

    if (path.endsWith("/seats") && method === "GET") {
      await releaseExpired(db);
      const { rows } = await db.query(`
        SELECT id, seats, status, hold_until
        FROM bookings
        WHERE status IN ('pending','paid')
      `);
      const result = {};
      for (const r of rows) {
        for (const seat of r.seats) {
          result[seat] = {
            status: r.status,
            booking_id: r.id,
            hold_until: r.hold_until
          };
        }
      }
      return json(200, { seats: result, total: 59, hold_minutes: HOLD_MINUTES });
    }

    if (path.endsWith("/bookings") && method === "POST") {
      const body = parseBody(event);
      const nama = String(body.nama || "").trim();
      const nohp = String(body.nohp || "").trim();
      const alamat = String(body.alamat || "").trim();
      const seats = cleanSeats(body.seats);

      if (!nama || !nohp || !alamat || seats.length === 0) {
        return json(400, { error: "Data pemesan dan kursi wajib diisi" });
      }
      if (seats.length > 59) {
        return json(400, { error: "Jumlah kursi tidak valid" });
      }

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
          UPDATE bookings
          SET status='expired'
          WHERE status='pending' AND hold_until IS NOT NULL AND hold_until <= NOW()
        `);

        const { rows: conflicts } = await client.query(`
          SELECT id, seats, status, hold_until
          FROM bookings
          WHERE status IN ('pending','paid')
            AND seats && $1::integer[]
          FOR UPDATE
        `, [seats]);

        if (conflicts.length) {
          const blocked = new Set();
          conflicts.forEach(r => r.seats.forEach(s => blocked.add(s)));
          const taken = seats.filter(s => blocked.has(s));
          await client.query("ROLLBACK");
          return json(409, {
            error: "Ada kursi yang baru saja dipilih orang lain.",
            taken
          });
        }

        const { rows } = await client.query(`
          INSERT INTO bookings (nama,nohp,alamat,seats,status,hold_until)
          VALUES ($1,$2,$3,$4,'pending',NOW() + ($5 || ' minutes')::interval)
          RETURNING id, hold_until
        `, [nama, nohp, alamat, seats, HOLD_MINUTES]);

        await client.query("COMMIT");
        return json(200, {
          ok: true,
          booking_id: rows[0].id,
          hold_until: rows[0].hold_until,
          hold_minutes: HOLD_MINUTES
        });
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch {}
        console.error(e);
        return json(500, { error: "Booking gagal dibuat" });
      } finally {
        client.release();
      }
    }

    if (path.endsWith("/bookings") && method === "GET") {
      await releaseExpired(db);
      const { rows } = await db.query(`
        SELECT id,nama,nohp,alamat,seats,status,created_at,hold_until
        FROM bookings ORDER BY id DESC
      `);
      return json(200, rows);
    }

    const match = path.match(/\/bookings\/(\d+)\/(pay|cancel)$/);
    if (match && method === "POST") {
      const id = Number(match[1]);
      const action = match[2];
      const status = action === "pay" ? "paid" : "cancelled";
      const { rows } = await db.query(`
        UPDATE bookings
        SET status=$2, hold_until=CASE WHEN $2='paid' THEN NULL ELSE hold_until END
        WHERE id=$1 AND status IN ('pending','paid')
        RETURNING *
      `, [id, status]);

      if (!rows.length) {
        return json(404, { error: "Booking tidak ditemukan / sudah berubah" });
      }
      return json(200, { ok: true, booking: rows[0] });
    }

    return json(404, { error: "Endpoint tidak ditemukan" });
  } catch (e) {
    console.error(e);
    return json(500, { error: "Server bermasalah" });
  }
};
