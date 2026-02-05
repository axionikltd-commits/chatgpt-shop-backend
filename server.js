/**
 * Axionik AI – Shop Backend
 * Fully traced server.js
 * Node 18+ / Render compatible
 */

import express from "express";
import cors from "cors";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

const app = express();

/* -------------------------------------------------- */
/* BASIC SETUP                                        */
/* -------------------------------------------------- */

app.disable("strict routing"); // allow /path and /path/

app.use(cors());
app.use(express.json());

console.log("🚀 Server booting…");

/* -------------------------------------------------- */
/* REDIS SETUP                                        */
/* -------------------------------------------------- */

console.log("🔌 Connecting to Redis…");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

console.log("✅ Redis client created");

/* -------------------------------------------------- */
/* HEALTH CHECK                                       */
/* -------------------------------------------------- */

app.get("/", (req, res) => {
  console.log("✅ Health check hit");
  res.json({
    status: "OK",
    service: "Axionik AI Shop Backend",
    time: new Date().toISOString(),
  });
});

/* -------------------------------------------------- */
/* CHAT START                                         */
/* -------------------------------------------------- */

app.post(["/chat-start", "/chat-start/"], async (req, res) => {
  console.log("🟢 /chat-start called");
  console.log("📥 Body:", req.body);

  try {
    const { intent, color, size, budget } = req.body;

    const sessionId = crypto.randomUUID();
    console.log("🆔 Generated sessionId:", sessionId);

    const payload = {
      session: sessionId,
      filters: {
        intent: intent?.toLowerCase(),
        color: color?.toLowerCase(),
        size: size?.toUpperCase(),
        budget: Number(budget),
        createdAt: Date.now(),
      },
      count: 0,
      products: [],
    };

    console.log("🧾 Session payload:", payload);

    await redis.set(
      `chat:session:${sessionId}`,
      JSON.stringify(payload),
      { ex: 1800 }
    );

    console.log("💾 Session stored in Redis");

    res.json(payload);
  } catch (err) {
    console.error("❌ /chat-start error:", err);
    res.status(500).json({ error: "chat-start failed" });
  }
});

/* -------------------------------------------------- */
/* FETCH PRODUCTS (FILTERING LOGIC)                   */
/* -------------------------------------------------- */

app.get("/products", async (req, res) => {
  console.log("🟢 /products called");
  console.log("📥 Query:", req.query);

  try {
    const { color, size, budget } = req.query;

    const keys = await redis.keys("product:*");
    console.log(`🔍 Found ${keys.length} product keys`);

    const products = [];

    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;

      const product = typeof raw === "string" ? JSON.parse(raw) : raw;
      products.push(product);
    }

    console.log("📦 Loaded products:", products.length);

    const filtered = products.filter((p) => {
      const match =
        (!color || p.color?.toLowerCase() === color.toLowerCase()) &&
        (!size || p.sizes?.includes(size.toUpperCase())) &&
        (!budget || Number(p.price) <= Number(budget));

      if (!match) {
        console.log("❌ Product filtered out:", p.id);
      }

      return match;
    });

    console.log("✅ Filtered products:", filtered.length);

    res.json({
      count: filtered.length,
      products: filtered,
    });
  } catch (err) {
    console.error("❌ /products error:", err);
    res.status(500).json({ error: "product fetch failed" });
  }
});

/* -------------------------------------------------- */
/* CHAT SHOP (SESSION → PRODUCTS)                     */
/* -------------------------------------------------- */

app.get("/shop", async (req, res) => {
  console.log("🟢 /shop called");
  console.log("📥 Query:", req.query);

  try {
    const { session } = req.query;
    if (!session) {
      console.warn("⚠️ No session provided");
      return res.status(400).json({ error: "session missing" });
    }

    const rawSession = await redis.get(`chat:session:${session}`);
    console.log("📄 Raw session:", rawSession);

    if (!rawSession) {
      console.warn("❌ Session not found in Redis");
      return res.status(404).json({ error: "session not found" });
    }

    const sessionData =
      typeof rawSession === "string"
        ? JSON.parse(rawSession)
        : rawSession;

    console.log("🧠 Parsed session:", sessionData);

    const { color, size, budget } = sessionData.filters;

    const productRes = await fetch(
      `${req.protocol}://${req.get("host")}/products?color=${color}&size=${size}&budget=${budget}`
    );

    const productJson = await productRes.json();
    console.log("🛒 Product search result:", productJson);

    sessionData.products = productJson.products;
    sessionData.count = productJson.count;

    await redis.set(
      `chat:session:${session}`,
      JSON.stringify(sessionData),
      { ex: 1800 }
    );

    console.log("💾 Session updated with products");

    res.json(sessionData);
  } catch (err) {
    console.error("❌ /shop error:", err);
    res.status(500).json({ error: "shop failed" });
  }
});

/* -------------------------------------------------- */
/* ORDER TRACKING (CHATGPT: WHERE IS MY ORDER?)       */
/* -------------------------------------------------- */

app.get("/chat-track-order", async (req, res) => {
  console.log("🟢 /chat-track-order called");
  console.log("📥 Query:", req.query);

  try {
    const { orderId } = req.query;
    if (!orderId) {
      return res.status(400).json({ error: "orderId missing" });
    }

    const raw = await redis.get(`order:${orderId}`);
    console.log("📦 Raw order:", raw);

    if (!raw) {
      return res.json({ message: "I couldn't find your order." });
    }

    const order = typeof raw === "string" ? JSON.parse(raw) : raw;

    res.json({
      message: `Your order is currently ${order.deliveryStatus}`,
      order,
    });
  } catch (err) {
    console.error("❌ track-order error:", err);
    res.status(500).json({ error: "order tracking failed" });
  }
});

/* -------------------------------------------------- */
/* START SERVER                                       */
/* -------------------------------------------------- */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
