// ===============================
// Axionik AI – ChatGPT Shop Backend
// ===============================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

dotenv.config();

// --------------------------------------------------
// App setup
// --------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------
// Redis setup (Upstash)
// --------------------------------------------------
console.log("🔌 Connecting to Redis...");
const redis = Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});
console.log("✅ Redis client created");

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------
app.get("/health", (req, res) => {
  console.log("💓 Health check hit");
  res.json({ status: "ok" });
});

// --------------------------------------------------
// SERVE OPENAPI SPEC FOR CHATGPT ACTIONS
// --------------------------------------------------
app.get("/openapi.yaml", (req, res) => {
  console.log("📄 OpenAPI spec requested");
  res.sendFile(path.join(__dirname, "openapi.yaml"));
});

// --------------------------------------------------
// CHAT START (SESSION CREATION)
// --------------------------------------------------
app.post("/chat-start", async (req, res) => {
  console.log("🚀 /chat-start called");
  console.log("📥 Body:", req.body);

  try {
    const { intent, color, size, budget } = req.body;

    const sessionId = randomUUID();

    const payload = {
      session: sessionId,
      filters: {
        intent: intent?.toLowerCase(),
        color: color?.toLowerCase(),
        size,
        budget: Number(budget),
        createdAt: Date.now()
      },
      count: 0,
      products: []
    };

    console.log("🧠 Creating session:", payload);

    await redis.set(`chat:session:${sessionId}`, JSON.stringify(payload), {
      ex: 1800 // 30 minutes
    });

    console.log("✅ Session stored:", sessionId);

    res.json(payload);
  } catch (err) {
    console.error("❌ /chat-start error:", err);
    res.status(500).json({ error: "Failed to start session" });
  }
});

// --------------------------------------------------
// START SHOPPING SESSION (CHATGPT ACTION)
// --------------------------------------------------
app.get("/chat-checkout", async (req, res) => {
  console.log("🛍️ /chat-checkout called");
  console.log("🔎 Query:", req.query);

  try {
    const sessionId = randomUUID();

    const payload = {
      session: sessionId,
      filters: {
        intent: req.query.intent?.toLowerCase(),
        color: req.query.color?.toLowerCase(),
        size: req.query.size,
        budget: Number(req.query.budget),
        createdAt: Date.now()
      },
      count: 0,
      products: []
    };

    console.log("🧠 Creating chat session:", payload);

    await redis.set(`chat:session:${sessionId}`, JSON.stringify(payload), {
      ex: 1800
    });

    console.log("✅ Chat session created:", sessionId);

    // IMPORTANT: JSON ONLY (NO REDIRECT)
    res.json({
      session: sessionId,
      next: "/shop"
    });
  } catch (err) {
    console.error("❌ /chat-checkout error:", err);
    res.status(500).json({ error: "Failed to create chat session" });
  }
});

// --------------------------------------------------
// FETCH PRODUCTS FOR SESSION
// --------------------------------------------------
app.get("/shop", async (req, res) => {
  console.log("🛒 /shop called");
  console.log("🔎 Query:", req.query);

  try {
    const { session } = req.query;

    if (!session) {
      console.error("❌ Missing session parameter");
      return res.status(400).json({
        session: null,
        count: 0,
        products: []
      });
    }

    const rawSession = await redis.get(`chat:session:${session}`);
    console.log("📦 Raw session:", rawSession);

    if (!rawSession) {
      console.warn("⚠️ Session not found:", session);
      return res.json({
        session,
        count: 0,
        products: []
      });
    }

    const sessionData = JSON.parse(rawSession);
    const filters = sessionData.filters;

    console.log("🎯 Filters:", filters);

    // --------------------------------------------------
    // Load products from Redis
    // --------------------------------------------------
    const productKeys = await redis.keys("product:*");
    console.log("📦 Product keys:", productKeys);

    const products = [];

    for (const key of productKeys) {
      const product = await redis.get(key);
      if (!product) continue;

      const p = JSON.parse(product);

      // Normalize
      const price = Number(p.price);
      const color = p.color?.toLowerCase();

      // Filter logic
      if (filters.color && color !== filters.color) continue;
      if (filters.size && !p.sizes?.includes(filters.size)) continue;
      if (filters.budget && price > filters.budget) continue;

      products.push(p);
    }

    console.log(`✅ Matched products: ${products.length}`);

    // Update session cache
    sessionData.count = products.length;
    sessionData.products = products;

    await redis.set(`chat:session:${session}`, JSON.stringify(sessionData), {
      ex: 1800
    });

    res.json({
      session,
      count: products.length,
      products
    });
  } catch (err) {
    console.error("❌ /shop error:", err);
    res.status(500).json({
      session: req.query.session,
      count: 0,
      products: []
    });
  }
});

// --------------------------------------------------
// ADD TO CART
// --------------------------------------------------
app.post("/add-to-cart", async (req, res) => {
  console.log("➕ /add-to-cart called");
  console.log("📥 Body:", req.body);

  try {
    const { session, productId, qty } = req.body;

    const cartKey = `cart:${session}`;
    const cart = (await redis.get(cartKey)) || [];

    cart.push({ productId, qty });

    await redis.set(cartKey, cart, { ex: 1800 });

    console.log("✅ Cart updated:", cart);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ add-to-cart error:", err);
    res.status(500).json({ error: "Add to cart failed" });
  }
});

// --------------------------------------------------
// TRACK ORDER (CHATGPT ACTION)
// --------------------------------------------------
app.get("/chat-track-order", async (req, res) => {
  console.log("📦 /chat-track-order called");
  console.log("🔎 Query:", req.query);

  try {
    const { orderId } = req.query;
    const order = await redis.get(`order:${orderId}`);

    if (!order) {
      return res.json({
        message: "I couldn't find your order."
      });
    }

    const parsed = JSON.parse(order);

    res.json({
      message: `Your order is currently ${parsed.deliveryStatus}.`
    });
  } catch (err) {
    console.error("❌ track-order error:", err);
    res.status(500).json({
      message: "Unable to track order right now."
    });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🚀 Server booting...");
  console.log(`✅ Server running on port ${PORT}`);
});
