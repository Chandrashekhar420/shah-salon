const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'database.sqlite');
const MIGRATION_SRC = path.join(__dirname, 'bookings.json');

const db = new sqlite3.Database(DB_PATH);

// Helper to run query and return a Promise
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

// Helper to query single row
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Helper to query multiple rows
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Initialize tables and run migrations
async function initDb() {
  // Create tables
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      barber TEXT NOT NULL,
      service TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS payment_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      card_type TEXT NOT NULL,
      last4 TEXT NOT NULL,
      cardholder_name TEXT NOT NULL,
      expiry TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Migrate old bookings.json if sqlite DB is empty
  try {
    const bookingCount = await get(`SELECT COUNT(*) as count FROM bookings`);
    if (bookingCount.count === 0 && fs.existsSync(MIGRATION_SRC)) {
      console.log('Migrating existing bookings from bookings.json into SQLite...');
      const fileData = fs.readFileSync(MIGRATION_SRC, 'utf8');
      const oldBookings = JSON.parse(fileData || '[]');

      for (const b of oldBookings) {
        if (!b.name || !b.phone) continue;

        // Check or insert user
        let user = await get(`SELECT id FROM users WHERE phone = ?`, [b.phone]);
        let userId;
        if (!user) {
          const res = await run(`INSERT INTO users (name, phone) VALUES (?, ?)`, [b.name, b.phone]);
          userId = res.id;
        } else {
          userId = user.id;
        }

        // Insert booking
        const bookingId = b.id || Date.now().toString() + Math.random().toString(36).substring(2, 5);
        await run(`
          INSERT INTO bookings (id, user_id, barber, service, date, time, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          bookingId,
          userId,
          b.barber,
          b.service,
          b.date,
          b.time,
          b.status || 'waiting',
          b.createdAt || new Date().toISOString()
        ]);
      }
      console.log('Migration completed successfully.');
    }
  } catch (error) {
    console.error('Error during data migration:', error);
  }
}

// API methods
async function getAllBookings() {
  return all(`
    SELECT b.id, b.barber, b.service, b.date, b.time, b.status, b.created_at as createdAt,
           u.name, u.phone, u.id as userId
    FROM bookings b
    JOIN users u ON b.user_id = u.id
    ORDER BY b.date DESC, b.time DESC
  `);
}

async function getBookingById(id) {
  return get(`
    SELECT b.id, b.barber, b.service, b.date, b.time, b.status, b.created_at as createdAt,
           u.name, u.phone, u.id as userId
    FROM bookings b
    JOIN users u ON b.user_id = u.id
    WHERE b.id = ?
  `, [id]);
}

async function createBooking({ name, phone, barber, service, date, time }) {
  // Find or create user
  let user = await get(`SELECT id FROM users WHERE phone = ?`, [phone]);
  let userId;
  if (!user) {
    const res = await run(`INSERT INTO users (name, phone) VALUES (?, ?)`, [name, phone]);
    userId = res.id;
  } else {
    userId = user.id;
    // Update name if it changed
    await run(`UPDATE users SET name = ? WHERE id = ?`, [name, userId]);
  }

  const bookingId = Date.now().toString();
  await run(`
    INSERT INTO bookings (id, user_id, barber, service, date, time, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)
  `, [bookingId, userId, barber, service, date, time, new Date().toISOString()]);

  return getBookingById(bookingId);
}

async function updateBookingStatus(id, status) {
  if (status === 'serving') {
    const booking = await getBookingById(id);
    if (booking) {
      await run(`
        UPDATE bookings
        SET status = 'completed'
        WHERE barber = ? AND status = 'serving' AND id != ?
      `, [booking.barber, id]);
    }
  }
  await run(`UPDATE bookings SET status = ? WHERE id = ?`, [status, id]);
  return getBookingById(id);
}

async function getUserProfileByPhone(phone) {
  return get(`SELECT * FROM users WHERE phone = ?`, [phone]);
}

async function getUserBookings(userId) {
  return all(`
    SELECT id, barber, service, date, time, status, created_at as createdAt
    FROM bookings
    WHERE user_id = ?
    ORDER BY date DESC, time DESC
  `, [userId]);
}

async function getUserPaymentMethods(userId) {
  return all(`
    SELECT id, card_type as cardType, last4, cardholder_name as cardholderName, expiry, created_at as createdAt
    FROM payment_methods
    WHERE user_id = ?
    ORDER BY id DESC
  `, [userId]);
}

async function addPaymentMethod({ userId, cardType, last4, cardholderName, expiry }) {
  const res = await run(`
    INSERT INTO payment_methods (user_id, card_type, last4, cardholder_name, expiry)
    VALUES (?, ?, ?, ?, ?)
  `, [userId, cardType, last4, cardholderName, expiry]);

  return get(`SELECT id, card_type as cardType, last4, cardholder_name as cardholderName, expiry FROM payment_methods WHERE id = ?`, [res.id]);
}

async function deletePaymentMethod(id, userId) {
  return run(`DELETE FROM payment_methods WHERE id = ? AND user_id = ?`, [id, userId]);
}

module.exports = {
  initDb,
  getAllBookings,
  getBookingById,
  createBooking,
  updateBookingStatus,
  getUserProfileByPhone,
  getUserBookings,
  getUserPaymentMethods,
  addPaymentMethod,
  deletePaymentMethod
};
