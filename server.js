import express from "express";
import cors from "cors";
import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

/* ================================
   REDIS SETUP
================================ */
console.log("🔌 Connecting to Redis...");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

console.log("✅ Redis client created");

/* ================================
   HEALTH CHECK
================================ */
app.get("/health", (req, res) => {
  console.log("💓 Health check hit");
  res.json({ status: "ok" });
});

/* ================================
   CHAT START (Session Creation)
================================ */
app.post("/chat-start", async (req, res) => {
  console.log("🚀 /chat-start called");
  console.log("📥 Body:", req.body);

  const { intent, color, size, budget } = req.body;

  const sessionId = randomUUID();

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

  console.log("🧠 Session payload:", payload);

  await redis.set(`chat:session:${sessionId}`, payload, { ex: 1800 });

  console.log("💾 Session stored:", `chat:session:${sessionId}`);

  res.json(payload);
});

/* ================================
   SHOP (PRODUCT MATCHING)
================================ */
app.get("/shop", async (req, res) => {
  const { session } = req.query;
  console.log("🛒 /shop called with session:", session);

  const sessionKey = `chat:session:${session}`;
  const sessionData = await redis.get(sessionKey);

  console.log("📦 Session fetched:", sessionData);

  if (!sessionData) {
    console.log("❌ Session not found");
    return res.status(404).json({ error: "Session not found" });
  }

  const { color, size, budget, intent } = sessionData.filters;

  console.log("🔍 Filters:");
  console.log({ color, size, budget, intent });

  const keys = await redis.keys("product:*");
  console.log("📚 Product keys:", keys);

  let matched = [];

  for (const key of keys) {
    const product = await redis.get(key);
    console.log("➡ Checking product:", product.id);

    const productColor = product.color?.toLowerCase();
    const productCategory = product.category?.toLowerCase();
    const productPrice = Number(product.price);
    const productSizes = product.sizes || [];

    const intentMatch =
      !intent || productCategory.includes("tshirt");

    const colorMatch =
      !color || productColor === color;

    const sizeMatch =
      !size || productSizes.includes(size);

    const budgetMatch =
      !budget || productPrice <= budget;

    console.log("🔎 Match results:", {
      intentMatch,
      colorMatch,
      sizeMatch,
      budgetMatch,
    });

    if (intentMatch && colorMatch && sizeMatch && budgetMatch) {
      console.log("✅ PRODUCT MATCHED:", product.id);
      matched.push(product);
    } else {
      console.log("❌ Product rejected:", product.id);
    }
  }

  sessionData.products = matched;
  sessionData.count = matched.length;

  await redis.set(sessionKey, sessionData, { ex: 1800 });

  console.log("📤 Final matched products:", matched.length);

  res.json(sessionData);
});

/* ================================
   CHAT TRACK ORDER
================================ */
app.get("/chat-track-order", async (req, res) => {
  const { orderId } = req.query;
  console.log("📦 Track order:", orderId);

  const order = await redis.get(`order:${orderId}`);

  if (!order) {
    return res.json({
      message: "I couldn’t find your order.",
    });
  }

  res.json({
    message: `Your order is currently ${order.deliveryStatus}`,
    order,
  });
});

/* ================================
   SERVER START
================================ */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
