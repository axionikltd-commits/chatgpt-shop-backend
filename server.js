import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------------------------------------------------
   BOOT
--------------------------------------------------- */
console.log("🚀 Booting server...");

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------------------------------------
   REDIS (Upstash – CORRECT WAY)
--------------------------------------------------- */
console.log("🔌 Connecting to Redis...");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

console.log("✅ Redis client ready");

/* ---------------------------------------------------
   HEALTH
--------------------------------------------------- */
app.get("/health", (req, res) => {
  console.log("💓 Health check hit");
  res.json({ status: "ok" });
});

/* ---------------------------------------------------
   OPENAPI (ChatGPT Actions)
--------------------------------------------------- */
app.get("/openapi.yaml", (req, res) => {
  console.log("📄 OpenAPI spec requested");
  res.sendFile(path.join(__dirname, "openapi.yaml"));
});

/* ---------------------------------------------------
   CHAT START (SESSION CREATION)
--------------------------------------------------- */
app.post("/chat-start", async (req, res) => {
  console.log("🟢 /chat-start called");
  console.log("📥 Body:", req.body);

  try {
    const { intent, color, size, budget } = req.body;

    const sessionId = uuidv4();

    const sessionData = {
      session: sessionId,
      filters: {
        intent,
        color,
        size,
        budget,
        createdAt: Date.now(),
      },
      count: 0,
      products: [],
    };

    await redis.set(`chat:session:${sessionId}`, sessionData, {
      ex: 60 * 30, // 30 min
    });

    console.log("✅ Session stored:", sessionId);

    res.json(sessionData);
  } catch (err) {
    console.error("❌ chat-start failed:", err);
    res.status(500).json({ error: "Failed to start chat session" });
  }
});

/* ---------------------------------------------------
   PRODUCT SEARCH (CRITICAL FIX)
--------------------------------------------------- */
app.get("/shop", async (req, res) => {
  console.log("🛒 /shop called");
  console.log("🔍 Query:", req.query);

  try {
    const { session } = req.query;
    if (!session) {
      console.warn("⚠️ Missing session");
      return res.status(400).json({ error: "Session required" });
    }

    const sessionKey = `chat:session:${session}`;
    const sessionData = await redis.get(sessionKey);

    console.log("📦 Session data:", sessionData);

    if (!sessionData) {
      console.warn("⚠️ Session not found");
      return res.status(404).json({ error: "Session not found" });
    }

    const { color, size, budget } = sessionData.filters;

    console.log("🎯 Applying filters:", { color, size, budget });

    const keys = await redis.keys("product:*");
    console.log("📚 Product keys:", keys);

    let products = [];

    for (const key of keys) {
      const product = await redis.get(key);
      if (!product) continue;

      const matches =
        (!color || product.color?.toLowerCase() === color.toLowerCase()) &&
        (!size || product.sizes?.includes(size)) &&
        (!budget || product.price <= budget);

      if (matches) {
        products.push(product);
      }
    }

    console.log(`✅ ${products.length} products matched`);

    sessionData.products = products;
    sessionData.count = products.length;

    await redis.set(sessionKey, sessionData, { ex: 60 * 30 });

    res.json({
      session,
      count: products.length,
      products,
    });
  } catch (err) {
    console.error("❌ shop failed:", err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

/* ---------------------------------------------------
   ADD TO CART
--------------------------------------------------- */
app.post("/add-to-cart", async (req, res) => {
  console.log("➕ /add-to-cart called");
  console.log("📥 Body:", req.body);

  try {
    const { session, productId, qty } = req.body;
    const cartKey = `cart:${session}`;

    const cart = (await redis.get(cartKey)) || [];
    cart.push({ productId, qty });

    await redis.set(cartKey, cart, { ex: 60 * 30 });

    console.log("🛍️ Cart updated:", cart);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ add-to-cart failed:", err);
    res.status(500).json({ error: "Add to cart failed" });
  }
});

/* ---------------------------------------------------
   CHECKOUT (RAZORPAY STUB)
--------------------------------------------------- */
app.post("/checkout/razorpay", async (req, res) => {
  console.log("💳 /checkout/razorpay called");
  res.json({
    url: "https://razorpay.com/checkout/mock",
  });
});

/* ---------------------------------------------------
   ORDER TRACKING
--------------------------------------------------- */
app.get("/chat-track-order", async (req, res) => {
  console.log("📦 /chat-track-order called");
  console.log("🔍 Query:", req.query);

  const { orderId } = req.query;
  const order = await redis.get(`order:${orderId}`);

  if (!order) {
    return res.json({ message: "I couldn't find your order." });
  }

  res.json({
    message: `Your order is currently ${order.deliveryStatus}`,
  });
});

/* ---------------------------------------------------
   START SERVER
--------------------------------------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
