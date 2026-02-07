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
  url: "https://YOUR_UPSTASH_URL",
  token: "YOUR_UPSTASH_TOKEN",
});

console.log("✅ Redis connected");

/* ============================
   HEALTH
============================ */
app.get("/health", (req, res) => {
  console.log("💓 Health check");
  res.json({ status: "ok" });
});

/* ============================
   OPENAPI
============================ */
app.get("/openapi.yaml", (req, res) => {
  console.log("📘 OpenAPI requested");
  res.sendFile(path.join(__dirname, "openapi.yaml"));
});

/* ============================
   CHAT CHECKOUT (SESSION + USER)
============================ */
app.get("/chat-checkout", async (req, res) => {
  console.log("🚀 /chat-checkout");
  console.log("➡️ Query:", req.query);

  try {
    const { intent, color, size, budget, email } = req.query;

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const normalizedEmail = email.toLowerCase();
    const userId = `user:${normalizedEmail}`;
    const session = randomUUID();

    const sessionData = {
      session,
      userId,
      email: normalizedEmail,
      filters: {
        intent: intent?.toLowerCase(),
        color: color?.toLowerCase(),
        size,
        budget: budget ? Number(budget) : null,
        createdAt: Date.now(),
      },
      count: 0,
      products: [],
    };

    await redis.set(`chat:session:${session}`, sessionData, { ex: 1800 });

    // idempotent user record
    await redis.set(userId, {
      userId,
      email: normalizedEmail,
      lastActive: Date.now(),
    });

    console.log("✅ Session created:", session);

    res.json(sessionData);
  } catch (err) {
    console.error("❌ chat-checkout failed", err);
    res.status(500).json({ error: "Failed to start session" });
  }
});

/* ============================
   SHOP (PRODUCT SEARCH)
============================ */
app.get("/shop", async (req, res) => {
  console.log("🛍️ /shop");
  console.log("➡️ Query:", req.query);

  try {
    const { session } = req.query;
    if (!session) {
      return res.status(400).json({ error: "session required" });
    }

    const sessionKey = `chat:session:${session}`;
    const sessionData = await redis.get(sessionKey);

    if (!sessionData) {
      return res.status(404).json({ error: "Session not found" });
    }

    const { color, size, budget } = sessionData.filters;

    const keys = await redis.keys("product:*");
    const products = [];

    for (const key of keys) {
      const product = await redis.get(key);
      if (!product) continue;

      const match =
        (!color || product.color?.toLowerCase() === color) &&
        (!size || product.sizes?.includes(size)) &&
        (!budget || product.price <= budget);

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
    console.error("❌ /shop failed", err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

/* ============================
   ADD TO CART (USER LINKED)
============================ */
app.post("/add-to-cart", async (req, res) => {
  console.log("🛒 /add-to-cart");
  console.log("➡️ Body:", req.body);

  try {
    const { session, productId, qty } = req.body;

    const sessionData = await redis.get(`chat:session:${session}`);
    if (!sessionData) {
      return res.status(404).json({ error: "Session not found" });
    }

    const cartKey = `cart:${session}`;
    const cartData = (await redis.get(cartKey)) || {
      userId: sessionData.userId,
      email: sessionData.email,
      items: [],
    };

    cartData.items.push({
      productId,
      qty,
      addedAt: Date.now(),
    });

    await redis.set(cartKey, cartData, { ex: 1800 });

    console.log("✅ Cart updated for", sessionData.email);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ add-to-cart failed", err);
    res.status(500).json({ error: "Add to cart failed" });
  }
});

/* ============================
   CHECKOUT (ORDER CREATED)
============================ */
app.post("/checkout/razorpay", async (req, res) => {
  console.log("💳 /checkout/razorpay");
  console.log("➡️ Body:", req.body);

  try {
    const { session } = req.body;

    const sessionData = await redis.get(`chat:session:${session}`);
    if (!sessionData) {
      return res.status(404).json({ error: "Session not found" });
    }

    const cartData = await redis.get(`cart:${session}`);
    if (!cartData || cartData.items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const orderId = `ORD-${Date.now()}`;

    const order = {
      orderId,
      userId: sessionData.userId,
      email: sessionData.email,
      items: cartData.items,
      paymentStatus: "PAID",
      deliveryStatus: "PROCESSING",
      createdAt: Date.now(),
    };

    await redis.set(`order:${orderId}`, order);

    console.log("📦 Order created:", orderId);

    res.json({
      success: true,
      orderId,
      email: sessionData.email,
      message: "Payment successful. Order created.",
    });
  } catch (err) {
    console.error("❌ checkout failed", err);
    res.status(500).json({ error: "Checkout failed" });
  }
});

/* ============================
   TRACK ORDER
============================ */
app.get("/chat-track-order", async (req, res) => {
  console.log("📦 /chat-track-order");
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
    message: `Your order for ${order.email} is currently ${order.deliveryStatus}`,
    deliveryStatus: order.deliveryStatus,
  });
});

/* ============================
   UPDATE DELIVERY STATUS (ADMIN)
============================ */
app.post("/admin/update-order-status", async (req, res) => {
  console.log("🚚 /admin/update-order-status");
  console.log("➡️ Body:", req.body);

  const { orderId, status } = req.body;
  const allowed = ["PROCESSING", "SHIPPED", "DELIVERED"];

  if (!orderId || !allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const orderKey = `order:${orderId}`;
  const order = await redis.get(orderKey);

  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  order.deliveryStatus = status;
  order.updatedAt = Date.now();

  await redis.set(orderKey, order);

  console.log("✅ Order updated:", orderId, status);

  res.json({
    success: true,
    orderId,
    deliveryStatus: status,
  });
});

/* ============================
   START SERVER
============================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
