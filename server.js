import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

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

console.log("✅ Redis client created");

/* ============================
   HEALTH CHECK
============================ */
app.get("/health", (req, res) => {
  console.log("💓 Health check hit");
  res.json({ status: "ok" });
});

/* ============================
   SERVE OPENAPI FILE
============================ */
app.get("/openapi.yaml", (req, res) => {
  console.log("📘 OpenAPI spec requested");
  res.sendFile(path.join(__dirname, "openapi.yaml"));
});

/* ============================
   CHAT CHECKOUT (START SESSION)
   GET /chat-checkout
============================ */
app.get("/chat-checkout", async (req, res) => {
  console.log("🚀 /chat-checkout called");
  console.log("➡️ Query:", req.query);

  try {
    const session = randomUUID();

    const payload = {
      session,
      filters: {
        intent: (req.query.intent || "").toLowerCase(),
        color: (req.query.color || "").toLowerCase(),
        size: req.query.size || "",
        budget: Number(req.query.budget || 0),
        createdAt: Date.now(),
      },
      count: 0,
      products: [],
    };

    console.log("📝 Saving session:", payload);

    await redis.set(`chat:session:${session}`, payload, { ex: 1800 });

    console.log("✅ Session stored:", session);

    // IMPORTANT: ChatGPT Actions expects JSON, NOT redirect
    res.json(payload);
  } catch (err) {
    console.error("❌ chat-checkout failed:", err);
    res.status(500).json({ error: "Failed to start shopping session" });
  }
});

/* ============================
   GET PRODUCTS
   GET /shop?session=xxx
============================ */
app.get("/shop", async (req, res) => {
  console.log("🛍️ /shop called");
  console.log("➡️ Query:", req.query);

  try {
    const { session } = req.query;
    if (!session) {
      console.warn("⚠️ Missing session");
      return res.status(400).json({ error: "session required" });
    }

    const sessionKey = `chat:session:${session}`;
    const sessionData = await redis.get(sessionKey);

    console.log("📦 Session data:", sessionData);

    if (!sessionData) {
      console.warn("❌ Session not found");
      return res.status(404).json({ error: "Session not found" });
    }

    const products = [];

    const keys = await redis.keys("product:*");
    console.log("🔑 Product keys:", keys);

    for (const key of keys) {
      const product = await redis.get(key);

      if (!product) continue;

      const match =
        (!sessionData.filters.color ||
          product.color.toLowerCase() === sessionData.filters.color) &&
        (!sessionData.filters.size ||
          product.sizes.includes(sessionData.filters.size)) &&
        (!sessionData.filters.budget ||
          product.price <= sessionData.filters.budget);

      if (match) products.push(product);
    }

    sessionData.products = products;
    sessionData.count = products.length;

    await redis.set(sessionKey, sessionData, { ex: 1800 });

    console.log(`✅ ${products.length} products matched`);

    res.json({
      session,
      count: products.length,
      products,
    });
  } catch (err) {
    console.error("❌ /shop failed:", err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

/* ============================
   ADD TO CART
   POST /add-to-cart
============================ */
app.post("/add-to-cart", async (req, res) => {
  console.log("🛒 /add-to-cart called");
  console.log("➡️ Body:", req.body);

  try {
    const { session, productId, qty } = req.body;

    const cartKey = `cart:${session}`;
    const cart = (await redis.get(cartKey)) || [];

    cart.push({ productId, qty });

    await redis.set(cartKey, cart, { ex: 1800 });

    console.log("✅ Cart updated:", cart);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ add-to-cart failed:", err);
    res.status(500).json({ error: "Add to cart failed" });
  }
});

/* ============================
   RAZORPAY CHECKOUT (STUB)
============================ */
app.post("/checkout/razorpay", async (req, res) => {
  console.log("💳 /checkout/razorpay called");
  console.log("➡️ Body:", req.body);

  try {
    const { session } = req.body;

    if (!session) {
      return res.status(400).json({ error: "session required" });
    }

    // Fetch cart
    const cartKey = `cart:${session}`;
    const cart = await redis.get(cartKey);

    if (!cart || cart.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    // 🔥 CREATE ORDER
    const orderId = `ORD-${Date.now()}`;

    const order = {
      orderId,
      session,
      items: cart,
      paymentStatus: "PAID",
      deliveryStatus: "PROCESSING",
      createdAt: Date.now(),
    };

    // Store order
    await redis.set(`order:${orderId}`, order);

    console.log("📦 Order created:", order);

    res.json({
      success: true,
      orderId,
      message: "Payment successful, order created",
    });
  } catch (err) {
    console.error("❌ Checkout failed:", err);
    res.status(500).json({ error: "Checkout failed" });
  }
});

/* ============================
   TRACK ORDER
   GET /chat-track-order
============================ */
app.get("/chat-track-order", async (req, res) => {
  console.log("📦 /chat-track-order called");
  console.log("➡️ Query:", req.query);

  const { orderId } = req.query;
  if (!orderId) {
    return res.json({ message: "Order ID required" });
  }

  const order = await redis.get(`order:${orderId}`);

  if (!order) {
    return res.json({ message: "I couldn't find your order." });
  }

  res.json({
    message: `Your order is currently ${order.deliveryStatus}`,
  });
});

/* ============================
   START SERVER
============================ */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
