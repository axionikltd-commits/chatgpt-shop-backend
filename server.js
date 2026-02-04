import express from "express";
import cors from "cors";
import Stripe from "stripe";
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

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

    const data = await redis.get(`chat:session:${session}`);
    if (!data) return res.json({ message: "Session expired" });

    const products = [];

    const keys = await redis.keys("product:*");

    for (const key of keys) {
      const p = await redis.get(key);
      if (
        p.color === data.filters.color &&
        p.price <= data.filters.budget &&
        p.sizes.includes(data.filters.size)
      ) {
        products.push(p);
      }
    }

    data.products = products;
    data.count = products.length;

    await redis.set(`chat:session:${session}`, data, { ex: 1800 });

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Shop failed" });
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

/* ------------------ STRIPE CHECKOUT ------------------ */

app.post("/checkout/stripe", async (req, res) => {
  try {
    const { session } = req.body;

    const cart = await redis.get(`cart:${session}`);
    if (!cart || cart.length === 0) {
      return res.status(400).json({ error: "Cart empty" });
    }

    const lineItems = [];

    for (const item of cart) {
      const product = await redis.get(`product:${item.productId}`);

      lineItems.push({
        price_data: {
          currency: "inr",
          product_data: {
            name: product.name,
          },
          unit_amount: product.price * 100,
        },
        quantity: item.qty,
      });
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: `${process.env.BASE_URL}/order-success?session=${session}`,
      cancel_url: `${process.env.BASE_URL}/order-cancel`,
    });

    /* Create order */
    const orderId = randomUUID();

    await redis.set(`order:${orderId}`, {
      orderId,
      session,
      status: "paid",
      deliveryStatus: "processing",
      createdAt: Date.now(),
    });

    res.json({ checkoutUrl: checkoutSession.url, orderId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stripe checkout failed" });
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
