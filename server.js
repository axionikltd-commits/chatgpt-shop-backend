import express from "express";
import cors from "cors";
import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

/* ------------------ INIT ------------------ */

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/* ------------------ HEALTH ------------------ */

app.get("/", (req, res) => {
  res.send("Axionik Shop Backend running");
});

/* ------------------ CHAT CHECKOUT ------------------ */
/* Creates a session from ChatGPT intent */

app.get("/chat-checkout", async (req, res) => {
  try {
    const { intent, color, size, budget } = req.query;

    const sessionId = randomUUID();

    const payload = {
      session: sessionId,
      filters: {
        intent,
        color,
        size,
        budget: Number(budget),
        createdAt: Date.now(),
      },
      count: 0,
      products: [],
    };

    await redis.set(`chat:session:${sessionId}`, payload, { ex: 1800 });

    res.redirect(`/shop?session=${sessionId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

/* ------------------ SHOP SEARCH ------------------ */

app.get("/shop", async (req, res) => {
  try {
    const { session } = req.query;
    if (!session) {
      return res.status(400).json({ error: "Session required" });
    }

    const chat = await redis.get(`chat:session:${session}`);
    if (!chat) {
      return res.json({
        session,
        count: 0,
        products: []
      });
    }

    const { intent, color, size, budget } = chat.filters;

    // 🔑 Fetch all products
    const keys = await redis.keys("product:*");
    const products = await Promise.all(
      keys.map((k) => redis.get(k))
    );

    const normalizedIntent = intent?.toLowerCase();

    const filtered = products.filter((p) => {
      if (!p) return false;

      // Category / intent match
      if (
        normalizedIntent &&
        !p.category?.toLowerCase().includes(normalizedIntent)
      ) {
        return false;
      }

      // Color match
      if (
        color &&
        p.color?.toLowerCase() !== color.toLowerCase()
      ) {
        return false;
      }

      // Size match (ARRAY!)
      if (
        size &&
        !Array.isArray(p.sizes) &&
        !p.sizes?.includes(size)
      ) {
        return false;
      }

      if (
        size &&
        Array.isArray(p.sizes) &&
        !p.sizes.includes(size)
      ) {
        return false;
      }

      // Budget match
      if (
        budget &&
        Number(p.price) > Number(budget)
      ) {
        return false;
      }

      // Stock check
      if (Number(p.quantity) <= 0) {
        return false;
      }

      return true;
    });

    res.json({
      session,
      filters: chat.filters,
      count: filtered.length,
      products: filtered
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


/* ------------------ ADD TO CART ------------------ */

app.post("/add-to-cart", async (req, res) => {
  try {
    const { session, productId, qty } = req.body;

    if (!session || !productId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const cartKey = `cart:${session}`;
    const cart = (await redis.get(cartKey)) || [];

    cart.push({ productId, qty: qty || 1 });

    await redis.set(cartKey, cart, { ex: 1800 });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Add to cart failed" });
  }
});

/* ------------------ ORDER TRACKING (CHATGPT) ------------------ */

app.get("/chat-track-order", async (req, res) => {
  try {
    const { orderId } = req.query;

    const order = await redis.get(`order:${orderId}`);

    if (!order) {
      return res.json({
        message: "I couldn’t find your order.",
      });
    }

    res.json({
      message: `Your order is currently ${order.deliveryStatus}.`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Tracking failed" });
  }
});

/* ------------------ ADMIN: UPDATE DELIVERY STATUS ------------------ */

app.post("/admin/update-status", async (req, res) => {
  try {
    const { orderId, status } = req.body;

    const order = await redis.get(`order:${orderId}`);
    if (!order) return res.status(404).json({ error: "Order not found" });

    order.deliveryStatus = status;
    await redis.set(`order:${orderId}`, order);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Update failed" });
  }
});

/* ------------------ START SERVER ------------------ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
