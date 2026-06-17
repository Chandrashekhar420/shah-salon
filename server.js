const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shahsalon123';
const ADMIN_TOKEN = 'token_' + Buffer.from(ADMIN_PASSWORD).toString('base64');

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader === `Bearer ${ADMIN_TOKEN}`) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket broadcast to all clients
async function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// WebSockets Connection
wss.on('connection', async (ws) => {
  console.log('Client connected to WebSocket');
  
  // Immediately send current bookings list to newly connected client
  try {
    const bookings = await db.getAllBookings();
    ws.send(JSON.stringify({ type: 'SYNC_BOOKINGS', data: bookings }));
  } catch (err) {
    console.error('WebSocket sync error:', err);
  }

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// REST API Routes

// Get all bookings
app.get('/api/bookings', async (req, res) => {
  try {
    const bookings = await db.getAllBookings();
    res.json(bookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve bookings.' });
  }
});

// Create a new booking
app.post('/api/bookings', async (req, res) => {
  const { name, phone, barber, service, date, time } = req.body;
  if (!name || !phone || !barber || !service || !date || !time) {
    return res.status(400).json({ error: 'Missing required booking fields.' });
  }

  try {
    const newBooking = await db.createBooking({ name, phone, barber, service, date, time });
    
    // Notify all connected clients about the update
    const bookings = await db.getAllBookings();
    broadcast({ type: 'UPDATE_BOOKINGS', data: bookings });
    
    res.status(201).json(newBooking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create booking in database.' });
  }
});

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ token: ADMIN_TOKEN });
  } else {
    res.status(401).json({ error: 'Incorrect password.' });
  }
});

// Update booking status
app.put('/api/bookings/:id', requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['waiting', 'serving', 'completed', 'cancelled'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid or missing status.' });
  }

  try {
    const updatedBooking = await db.updateBookingStatus(id, status);
    if (!updatedBooking) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    // Notify all connected clients about the update
    const bookings = await db.getAllBookings();
    broadcast({ type: 'UPDATE_BOOKINGS', data: bookings });
    
    res.json(updatedBooking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update booking status.' });
  }
});

// Call client (Flash Announcement on TV)
app.post('/api/bookings/:id/call', requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const booking = await db.getBookingById(id);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    // Trigger WebSocket call announcement
    broadcast({
      type: 'CALL_CLIENT',
      data: {
        id: booking.id,
        name: booking.name,
        barber: booking.barber,
        service: booking.service
      }
    });

    res.json({ message: `Calling client ${booking.name}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to broadcast client call.' });
  }
});

// User profile, booking history & payment methods lookup
app.post('/api/users/lookup', async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  try {
    const user = await db.getUserProfileByPhone(phone);
    if (!user) {
      return res.status(404).json({ error: 'No profile found for this phone number. Please book an appointment to register.' });
    }

    const bookings = await db.getUserBookings(user.id);
    const paymentMethods = await db.getUserPaymentMethods(user.id);

    res.json({
      user,
      bookings,
      paymentMethods
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to lookup user profile.' });
  }
});

// Add payment method
app.post('/api/users/payment-methods', async (req, res) => {
  const { phone, cardType, last4, cardholderName, expiry } = req.body;
  if (!phone || !cardType || !last4 || !cardholderName || !expiry) {
    return res.status(400).json({ error: 'Missing required payment details.' });
  }

  try {
    const user = await db.getUserProfileByPhone(phone);
    if (!user) {
      return res.status(404).json({ error: 'User profile not found. Please make a booking first to create a profile.' });
    }

    const newCard = await db.addPaymentMethod({
      userId: user.id,
      cardType,
      last4,
      cardholderName,
      expiry
    });

    res.status(201).json(newCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save payment method.' });
  }
});

// Delete payment method
app.post('/api/users/payment-methods/delete', async (req, res) => {
  const { id, phone } = req.body;
  if (!id || !phone) {
    return res.status(400).json({ error: 'Missing card ID or phone verification.' });
  }

  try {
    const user = await db.getUserProfileByPhone(phone);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    await db.deletePaymentMethod(id, user.id);
    res.json({ success: true, message: 'Card removed successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove payment method.' });
  }
});

// Catch-all route to serve index.html for unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize DB and start server
db.initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Shah's Salon server is running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
});
