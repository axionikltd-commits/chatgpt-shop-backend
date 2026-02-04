import express from "express";
import cors from "cors";
import { Redis } from "@upstash/redis";

const app = express();
app.use(cors());
app.use(express.json());

// --------------------
// Redis
// --------------------
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

// --------------------
// Helpers
// --------------------
const normalize = (v) => String(v || "").toLowerCase();

// --------------------
// 1. SEARCH PRODUCTS (ChatGPT calls this)
// --------------------
app.post("/chat-search", async (req, res) => {
  try {
    const { session, filters } = req.body;

    const color = normalize(filters.color);
    const size = normalize(filters.size);
    const budget = Number(filters.budget || 0);

    const keys = await redis.keys("product:*");
    const results = [];

    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;

      const product = JSON.parse(raw);

      const productColor = normalize(product.color);
      const productSizes = product.sizes.map(normalize);
      const productPrice = Number(product.price);

      if (
        productColor === color &&
        productSizes.includes(size) &&
        productPrice <= budget
      ) {
        results.push(product);
      }
    }

    const payload = {
      session,
      filters,
      count: results.length,
      products: results
    };

    await redis.set(`chat:session:${session}`, JSON.stringify(payload), {
      ex: 1800
    });

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed" });
  }
});

// --------------------
// 2. ADD TO CART
// --------------------
app.post("/add-to-cart", async (req, res) => {
  try {
    const { session, productId, qty } = req.body;
    const key = `cart:${session}`;

    const raw = await redis.get(key);
    const cart = raw ? JSON.parse(raw) : [];

    cart.push({ productId, qty });

    await redis.set(key, JSON.stringify(cart), { ex: 1800 });

    res.json({ success: true, cart });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Add to cart failed" });
  }
});

// --------------------
// 3. CHECKOUT (mock – payment later)
// --------------------
app.post("/checkout", async (req, res) => {
  try {
    const { session } = req.body;

    const cartRaw = await redis.get(`cart:${session}`);
    if (!cartRaw) {
      return res.status(400).json({ error: "Cart empty" });
    }

    const orderId = `ORD-${Date.now()}`;

    const order = {
      orderId,
      session,
      deliveryStatus: "processing",
      createdAt: Date.now()
    };

    await redis.set(`order:${orderId}`, JSON.stringify(order), {
      ex: 86400
    });

    res.json({
      success: true,
      orderId,
      message: "Order placed successfully"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Checkout failed" });
  }
});

// --------------------
// 4. ORDER TRACKING (ChatGPT: “Where is my order?”)
// --------------------
app.get("/chat-track-order", async (req, res) => {
  try {
    const { orderId } = req.query;

    const raw = await redis.get(`order:${orderId}`);
    if (!raw) {
      return res.json({ message: "I couldn't find your order." });
    }

    const order = JSON.parse(raw);

    res.json({
      message: `Your order is currently ${order.deliveryStatus}.`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Tracking failed" });
  }
});

// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
