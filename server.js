import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { randomUUID, createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

/* ============================
   REDIS (NO .env)
============================ */
const redis = new Redis({
  url: "https://YOUR_UPSTASH_URL",
  token: "YOUR_UPSTASH_TOKEN",
});

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
   CHAT CHECKOUT (SESSION)
============================ */
app.get("/chat-checkout", async (req, res) => {
  console.log("🔥 /chat-checkout HIT", req.query);

  try {
    const { intent, color, size, budget, email } = req.query;

    if (!email) {
      return res.json({
        status: "EMAIL_REQUIRED",
        message: "Please provide your email address to start shopping.",
      });
    }

    const normalizedEmail = email.toLowerCase();
    const userId = createHash("sha256").update(normalizedEmail).digest("hex");
    const session = randomUUID();

    const sessionData = {
      session,
      userId,
      email: normalizedEmail,
      filters: {
        intent,
        color,
        size,
        budget: budget ? Number(budget) : null,
      },
      createdAt: Date.now(),
      products: [],
      count: 0,
    };

    await redis.set(`chat:session:${session}`, sessionData, { ex: 1800 });

    res.json(sessionData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to start session" });
  }
});

/* ============================
   SHOP (PRODUCT SEARCH)
============================ */
app.get("/shop", async (req, res) => {
  console.log("🛍️ /shop HIT", req.query);

  const { session } = req.query;
  if (!session) return res.status(400).json({ error: "session required" });

  const sessionKey = `chat:session:${session}`;
  const sessionData = await redis.get(sessionKey);

  if (!sessionData) return res.status(404).json({ error: "Session not found" });

  const { color, size, budget } = sessionData.filters;

  const keys = await redis.keys("product:*");
  const products = [];

  for (const key of keys) {
    const product = await redis.get(key);
    if (!product) continue;

    const match =
      (!color || product.color?.toLowerCase() === color.toLowerCase()) &&
      (!size || product.sizes?.includes(size)) &&
      (!budget || product.price <= budget);

    if (match) products.push(product);
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
  if (!cart || cart.items.length === 0)
    return res.status(400).json({ error: "Cart is empty" });

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

  res.json({ success: true, orderId });
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
    orderId,
    deliveryStatus: order.deliveryStatus,
    email: order.email,
  });
});

/* ============================
   START SERVER
============================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
