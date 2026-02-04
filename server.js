/**
 * Axionik – ChatGPT → Shopping Backend
 * Node.js + Express + Upstash Redis
 */

import "dotenv/config";           // 🔴 REQUIRED to load .env
import express from "express";
import crypto from "crypto";
import { redis } from "./redis.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

/**
 * Health check
 */
app.get("/", (req, res) => {
  res.send("Axionik backend is running 🚀");
});

/**
 * 🟢 CHATGPT → CHECKOUT HANDOFF
 * Example:
 * /chat-checkout?intent=tshirt&color=black&size=M&budget=2500&source=chatgpt
 */
app.get("/chat-checkout", async (req, res) => {
  try {
    const { intent, color, size, budget, source } = req.query;

    // Validate source
    if (source !== "chatgpt") {
      return res.status(400).send("Invalid source");
    }

    if (!intent) {
      return res.status(400).send("Missing intent");
    }

    // Create session
    const sessionId = crypto.randomUUID();

    const sessionPayload = {
      intent,
      color: color || null,
      size: size || null,
      budget: budget ? Number(budget) : null,
      createdAt: Date.now()
    };

    // Store session in Redis (30 min TTL)
    await redis.set(
      `chat:session:${sessionId}`,
      sessionPayload,
      { ex: 1800 }
    );

    // 🔴 IMPORTANT: Always redirect (NO HTML HERE)
    return res.redirect(`/shop?session=${sessionId}`);

  } catch (error) {
    console.error("chat-checkout error:", error);
    return res.status(500).send("Server error");
  }
});

/**
 * 🟢 SHOP – Load products using session intent
 * Example:
 * /shop?session=UUID
 */
app.get("/shop", async (req, res) => {
  try {
    const { session } = req.query;

    if (!session) {
      return res.status(400).send("Session missing");
    }

    // Load session from Redis
    const sessionData = await redis.get(`chat:session:${session}`);
    if (!sessionData) {
      return res.status(404).send("Session expired or invalid");
    }

    // Load products
    const products = (await redis.get("products:all")) || [];

    // Filter products
    const filteredProducts = products.filter((p) => {
      if (sessionData.intent && p.category !== sessionData.intent) return false;
      if (sessionData.color && p.color !== sessionData.color) return false;
      if (sessionData.size && !p.sizes.includes(sessionData.size)) return false;
      if (sessionData.budget && p.price > sessionData.budget) return false;
      if (p.stock <= 0) return false;
      return true;
    });

    return res.json({
      source: "chatgpt",
      session,
      filters: sessionData,
      count: filteredProducts.length,
      products: filteredProducts
    });

  } catch (error) {
    console.error("shop error:", error);
    return res.status(500).send("Server error");
  }
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
