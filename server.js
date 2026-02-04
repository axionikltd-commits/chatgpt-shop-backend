/**
 * Axionik – ChatGPT → Shopping Backend
 * Render-safe, single-file runtime
 */

import express from "express";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Create Redis client INLINE (no imports, no path issues)
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
 * ChatGPT → checkout handoff
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

    await redis.set(
      `chat:session:${sessionId}`,
      {
        intent,
        color: color || null,
        size: size || null,
        budget: budget ? Number(budget) : null,
        createdAt: Date.now(),
      },
      { ex: 1800 }
    );

    return res.redirect(`/shop?session=${sessionId}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

/**
 * Shop – load products using session intent
 */
app.get("/shop", async (req, res) => {
  try {
    const { session } = req.query;
    if (!session) return res.status(400).send("Session missing");

    const sessionData = await redis.get(`chat:session:${session}`);
    if (!sessionData)
      return res.status(404).send("Session expired or invalid");

    const products = (await redis.get("products:all")) || [];

    const filtered = products.filter((p) => {
      if (sessionData.intent && p.category !== sessionData.intent) return false;
      if (sessionData.color && p.color !== sessionData.color) return false;
      if (sessionData.size && !p.sizes.includes(sessionData.size)) return false;
      if (sessionData.budget && p.price > sessionData.budget) return false;
      if (p.stock <= 0) return false;
      return true;
    });

    return res.json({
      session,
      filters: sessionData,
      count: filtered.length,
      products: filtered,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
