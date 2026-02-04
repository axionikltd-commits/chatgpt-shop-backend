/**
 * Axionik – ChatGPT → Shopping Backend
 * Stable production version (Render compatible)
 */

import express from "express";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Redis client (INLINE – avoids all path issues)
 */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

app.use(express.json());

/**
 * Health check
 */
app.get("/", (req, res) => {
  res.send("Axionik backend is running 🚀");
});

/**
 * ChatGPT → Checkout handoff
 * Creates a session and stores intent in Redis
 */
app.get("/chat-checkout", async (req, res) => {
  try {
    const { intent, color, size, budget, source } = req.query;

    if (source !== "chatgpt") {
      return res.status(400).send("Invalid source");
    }
    if (!intent) {
      return res.status(400).send("Missing intent");
    }

    const sessionId = crypto.randomUUID();

    const sessionPayload = {
      intent,                 // e.g. "tshirt"
      color: color || null,   // "black"
      size: size || null,     // "M"
      budget: budget ? Number(budget) : null,
      createdAt: Date.now(),
    };

    await redis.set(
      `chat:session:${sessionId}`,
      sessionPayload,
      { ex: 1800 } // 30 mins
    );

    return res.redirect(`/shop?session=${sessionId}`);
  } catch (err) {
    console.error("chat-checkout error:", err);
    return res.status(500).send("Server error");
  }
});

/**
 * Shop route
 * Reads products dynamically from Redis (product:*)
 */
app.get("/shop", async (req, res) => {
  try {
    const { session } = req.query;
    if (!session) return res.status(400).send("Session missing");

    const sessionData = await redis.get(`chat:session:${session}`);
    if (!sessionData)
      return res.status(404).send("Session expired or invalid");

    // 1️⃣ Get product IDs from index
    const productIds = (await redis.get("products:index")) || [];

    // 2️⃣ Fetch products by ID
    const products = await Promise.all(
      productIds.map(id => redis.get(`product:${id}`))
    );
    console.log("DEBUG productIds:", productIds);
    console.log("DEBUG products length:", products.length);
    console.log("DEBUG sample product:", products[0]);
    // 3️⃣ Filter
    const filtered = products.filter((p) => {
      if (!p) return false;

      if (
        sessionData.intent &&
        !p.category.toLowerCase().includes(sessionData.intent.toLowerCase())
      ) return false;

      if (sessionData.color && p.color !== sessionData.color) return false;

      if (sessionData.size && !p.sizes.includes(sessionData.size)) return false;

      if (sessionData.budget && p.price > sessionData.budget) return false;

      if (p.quantity <= 0) return false;

      return true;
    });

    return res.json({
      session,
      filters: sessionData,
      count: filtered.length,
      products: filtered,
    });
  } catch (err) {
    console.error("shop error:", err);
    return res.status(500).send("Server error");
  }
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
