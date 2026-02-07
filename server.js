import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

/* =========================
   REDIS (NO .env)
========================= */
const redis = new Redis({
  url: "https://relieved-hedgehog-56308.upstash.io",
  token: "Adv0AAIncDExMDM0M2JlYzVhYTY0NjIyYTcwYjYxZDU5ZWY4OGYyM3AxNTYzMDg",
});

console.log("✅ Redis connected");

/* =========================
   HELPERS
========================= */
const hashUserId = (email) =>
  crypto.createHash("sha256").update(email).digest("hex");

/* =========================
   HEALTH
========================= */
app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

/* =========================
   OPENAPI
========================= */
app.get("/openapi.yaml", (_, res) => {
  res.sendFile(path.join(__dirname, "openapi.yaml"));
});

/* =========================
   CHAT CHECKOUT (GET ONLY)
========================= */
app.get("/chat-checkout", async (req, res) => {
  console.log("🔥 /chat-checkout HIT", req.query);

  try {
    const { intent, color, size, budget, email } = req.query;

    // ✅ EMAIL GATE (NO ERROR)
    if (!email) {
      return res.json({
        status: "EMAIL_REQUIRED",
        message: "Please provide your email address to start shopping.",
      });
    }

    const normalizedEmail = email.toLowerCase();
    const userId = hashUserId(normalizedEmail);
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
      },
      createdAt: Date.now(),
      products: [],
      count: 0,
    };

    await redis.set(`chat:session:${session}`, sessionData, { ex: 1800 });

    await redis.set(
      `user:${userId}`,
      { userId, email: normalizedEmail, lastActive: Date.now() },
      { ex: 86400 }
    );

    return res.json(sessionData);
  } catch (err) {
    console.error(err);
    return res.json({
      status: "RETRY",
      message: "Temporary issue. Please retry.",
    });
  }
});

/* =========================
   SHOP
========================= */
app.get("/shop", async (req, res) => {
  const { session } = req.query;
  if (!session) return res.json({ products: [] });

  const data = await redis.get(`chat:session:${session}`);
  if (!data) return res.json({ products: [] });

  const keys = await redis.keys("product:*");
  const products = [];

  for (const k of keys) {
    const p = await redis.get(k);
    if (!p) continue;

    if (
      (!data.filters.color || p.color === data.filters.color) &&
      (!data.filters.size || p.sizes?.includes(data.filters.size)) &&
      (!data.filters.budget || p.price <= data.filters.budget)
    ) {
      products.push(p);
    }
  }

  data.products = products;
  data.count = products.length;
  await redis.set(`chat:session:${session}`, data, { ex: 1800 });

  res.json({ session, products, count: products.length });
});

/* =========================
   ADD TO CART
========================= */
app.post("/add-to-cart", async (req, res) => {
  const { session, productId, qty } = req.body;

  const sessionData = await redis.get(`chat:session:${session}`);
  if (!sessionData) return res.json({ success: false });

  const cartKey = `cart:${session}`;
  const cart = (await redis.get(cartKey)) || {
    userId: sessionData.userId,
    email: sessionData.email,
    items: [],
  };

  cart.items.push({ productId, qty, at: Date.now() });
  await redis.set(cartKey, cart, { ex: 1800 });

  res.json({ success: true });
});

/* =========================
   CHECKOUT
========================= */
app.post("/checkout/razorpay", async (req, res) => {
  const { session } = req.body;

  const cart = await redis.get(`cart:${session}`);
  const sessionData = await redis.get(`chat:session:${session}`);

  if (!cart || !sessionData) return res.json({ success: false });

  const orderId = `ORD-${Date.now()}`;

  await redis.set(`order:${orderId}`, {
    orderId,
    userId: sessionData.userId,
    email: sessionData.email,
    items: cart.items,
    paymentStatus: "PAID",
    deliveryStatus: "PROCESSING",
    createdAt: Date.now(),
  });

  res.json({ success: true, orderId });
});

/* =========================
   TRACK ORDER
========================= */
app.get("/chat-track-order", async (req, res) => {
  const { orderId } = req.query;
  const order = await redis.get(`order:${orderId}`);

  if (!order) {
    return res.json({ message: "Order not found." });
  }

  res.json({
    orderId,
    deliveryStatus: order.deliveryStatus,
    email: order.email,
  });
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});
