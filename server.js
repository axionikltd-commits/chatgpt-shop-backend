import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

/* ============================
   REDIS (NO .env)
============================ */
console.log("🔌 Connecting to Redis...");

const redis = new Redis({
  url: "https://relieved-hedgehog-56308.upstash.io",
  token: "Adv0AAIncDExMDM0M2JlYzVhYTY0NjIyYTcwYjYxZDU5ZWY4OGYyM3AxNTYzMDg",
});

console.log("✅ Redis connected");

/* ============================
   HELPERS
============================ */
function userIdFromEmail(email) {
  return crypto
    .createHash("sha256")
    .update(email.toLowerCase())
    .digest("hex");
}

/* ============================
   HEALTH
============================ */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* ============================
   OPENAPI
============================ */
app.get("/openapi.yaml", (req, res) => {
  res.sendFile(path.join(__dirname, "openapi.yaml"));
});

/* ============================
   CHAT CHECKOUT (GET)
============================ */
app.get("/chat-checkout", async (req, res) => {
  console.log("🔥 /chat-checkout HIT", req.query);

  try {
    const { intent, color, size, budget, email, images } = req.query;

    if (!email) {
      return res.json({
        status: "EMAIL_REQUIRED",
        message: "Please provide your email address to start shopping.",
      });
    }

    const normalizedEmail = email.toLowerCase();
    const userId = userIdFromEmail(normalizedEmail);
    const session = crypto.randomUUID();

    const sessionData = {
      session,
      userId,
      email: normalizedEmail,
      filters: {
        intent,
        color,
        size,
        budget: budget ? Number(budget) : null,
        images,
      },
      createdAt: Date.now(),
      products: [],
      count: 0,
    };

    await redis.set(`chat:session:${session}`, sessionData, { ex: 1800 });

    await redis.set(`user:${userId}`, {
      userId,
      email: normalizedEmail,
      lastActive: Date.now(),
    });

    res.json(sessionData);
  } catch (err) {
    console.error("❌ chat-checkout failed", err);
    res.status(500).json({ error: "Failed to start session" });
  }
});

/* ============================
   SHOP
============================ */
app.get("/shop", async (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: "session required" });

  const sessionKey = `chat:session:${session}`;
  const sessionData = await redis.get(sessionKey);
  if (!sessionData) return res.status(404).json({ error: "Session not found" });

  const { color, size, budget } = sessionData.filters;

  const keys = await redis.keys("product:*");
  const products = [];

  for (const key of keys) {
    const p = await redis.get(key);
    if (!p) continue;

    const match =
      (!color || p.color?.toLowerCase() === color.toLowerCase()) &&
      (!size || p.sizes?.includes(size)) &&
      (!budget || p.price <= budget);

    if (match) products.push(p);
  }

  sessionData.products = products;
  sessionData.count = products.length;

  await redis.set(sessionKey, sessionData, { ex: 1800 });

  res.json({
    session,
    count: products.length,
    products,
  });
});

/* ============================
   ADD TO CART
============================ */
app.post("/add-to-cart", async (req, res) => {
  const { session, productId, qty } = req.body;

  const sessionData = await redis.get(`chat:session:${session}`);
  if (!sessionData) return res.status(404).json({ error: "Session not found" });

  const cartKey = `cart:${session}`;
  const cart = (await redis.get(cartKey)) || {
    userId: sessionData.userId,
    email: sessionData.email,
    items: [],
  };

  cart.items.push({ productId, qty, addedAt: Date.now() });
  await redis.set(cartKey, cart, { ex: 1800 });

  res.json({ success: true });
});

/* ============================
   CHECKOUT
============================ */
app.post("/checkout/razorpay", async (req, res) => {
  const { session } = req.body;

  const sessionData = await redis.get(`chat:session:${session}`);
  if (!sessionData) return res.status(404).json({ error: "Session not found" });

  const cart = await redis.get(`cart:${session}`);
  if (!cart || cart.items.length === 0) {
    return res.status(400).json({ error: "Cart is empty" });
  }

  const orderId = `ORD-${Date.now()}`;

  const order = {
    orderId,
    userId: sessionData.userId,
    email: sessionData.email,
    items: cart.items,
    paymentStatus: "PAID",
    deliveryStatus: "PROCESSING",
    createdAt: Date.now(),
  };

  await redis.set(`order:${orderId}`, order);

  res.json({
    success: true,
    orderId,
    email: sessionData.email,
  });
});

/* ============================
   TRACK ORDER
============================ */
app.get("/chat-track-order", async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.json({ message: "Order ID required" });

  const order = await redis.get(`order:${orderId}`);
  if (!order) return res.json({ message: "Order not found" });

  res.json({
    deliveryStatus: order.deliveryStatus,
    message: `Your order is ${order.deliveryStatus}`,
  });
});

/* ============================
   START
============================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
