/**
 * Axionik – ChatGPT → Shopping Backend
 * Stable production version
 */

import express from "express";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Redis client (INLINE)
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
      intent,
      color: color || null,
      size: size || null,
      budget: budget ? Number(budget) : null,
      createdAt: Date.now(),
    };

    await redis.set(
      `chat:session:${sessionId}`,
      sessionPayload,
      { ex: 1800 }
    );

    return res.redirect(`/shop?session=${sessionId}`);
  } catch (err) {
    console.error("chat-checkout error:", err);
    return res.status(500).send("Server error");
  }
});

/**
 * Shop – Load products using products:index
 */
app.get("/shop", async (req, res) => {
  try {
    const { session } = req.query;
    if (!session) return res.status(400).send("Session missing");

    const sessionData = await redis.get(`chat:session:${session}`);
    if (!sessionData)
      return res.status(404).send("Session expired or invalid");

    // Load product IDs
    const productIds = (await redis.get("products:index")) || [];

    // Load products
    const products = await Promise.all(
      productIds.map(id => redis.get(`product:${id}`))
    );

    // Filter products
    const filtered = products.filter((p) => {
      if (!p) return false;

      // Category normalization
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
 * 🟢 ADD TO CART
 * POST /add-to-cart
 */
app.post("/add-to-cart", async (req, res) => {
  try {
    const { session, productId, qty } = req.body;

    if (!session || !productId || !qty) {
      return res.status(400).send("Invalid payload");
    }

    // Validate session
    const sessionData = await redis.get(`chat:session:${session}`);
    if (!sessionData) {
      return res.status(404).send("Session invalid or expired");
    }

    // Load product
    const product = await redis.get(`product:${productId}`);
    if (!product) {
      return res.status(404).send("Product not found");
    }

    if (product.quantity < qty) {
      return res.status(400).send("Insufficient stock");
    }

    // Load cart
    const cartKey = `cart:session:${session}`;
    const cart = (await redis.get(cartKey)) || { items: [] };

    const existingItem = cart.items.find(
      item => item.productId === productId
    );

    if (existingItem) {
      existingItem.qty += qty;
    } else {
      cart.items.push({ productId, qty });
    }

    cart.updatedAt = Date.now();

    // Save cart (30 min TTL)
    await redis.set(cartKey, cart, { ex: 1800 });

    return res.json({
      success: true,
      cart,
    });
  } catch (err) {
    console.error("add-to-cart error:", err);
    return res.status(500).send("Server error");
  }
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
