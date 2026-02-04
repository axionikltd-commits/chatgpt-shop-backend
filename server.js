/**
 * Axionik – ChatGPT → Shopping Backend
 * FINAL: Razorpay + Stripe + Webhooks + Inventory
 */

import express from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import Stripe from "stripe";
import { Redis } from "@upstash/redis";

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Redis
 */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * Razorpay
 */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * Stripe
 */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/**
 * Middleware
 */
app.use(express.json());

/**
 * Health
 */
app.get("/", (_, res) => {
  res.send("Axionik backend is running 🚀");
});

/**
 * ChatGPT → Session
 */
app.get("/chat-checkout", async (req, res) => {
  try {
    const { intent, color, size, budget, source } = req.query;
    if (source !== "chatgpt" || !intent) return res.status(400).send("Invalid");

    const sessionId = crypto.randomUUID();

    await redis.set(
      `chat:session:${sessionId}`,
      {
        intent,
        color,
        size,
        budget: budget ? Number(budget) : null,
        createdAt: Date.now(),
      },
      { ex: 1800 }
    );

    res.redirect(`/shop?session=${sessionId}`);
  } catch {
    res.status(500).send("Server error");
  }
});

/**
 * Shop
 */
app.get("/shop", async (req, res) => {
  try {
    const { session } = req.query;
    const sessionData = await redis.get(`chat:session:${session}`);
    if (!sessionData) return res.status(404).send("Invalid session");

    const ids = (await redis.get("products:index")) || [];
    const products = await Promise.all(
      ids.map(id => redis.get(`product:${id}`))
    );

    const filtered = products.filter(p => {
      if (!p) return false;
      if (!p.category.toLowerCase().includes(sessionData.intent)) return false;
      if (sessionData.color && p.color !== sessionData.color) return false;
      if (sessionData.size && !p.sizes.includes(sessionData.size)) return false;
      if (sessionData.budget && p.price > sessionData.budget) return false;
      if (p.quantity <= 0) return false;
      return true;
    });

    res.json({ count: filtered.length, products: filtered });
  } catch {
    res.status(500).send("Server error");
  }
});

/**
 * Add to cart
 */
app.post("/add-to-cart", async (req, res) => {
  try {
    const { session, productId, qty } = req.body;
    const product = await redis.get(`product:${productId}`);
    if (!product || product.quantity < qty)
      return res.status(400).send("Stock issue");

    const key = `cart:session:${session}`;
    const cart = (await redis.get(key)) || { items: [] };

    const existing = cart.items.find(i => i.productId === productId);
    if (existing) existing.qty += qty;
    else cart.items.push({ productId, qty });

    await redis.set(key, cart, { ex: 1800 });
    res.json({ success: true, cart });
  } catch {
    res.status(500).send("Server error");
  }
});

/**
 * Checkout
 */
app.post("/checkout", async (req, res) => {
  try {
    const { session, gateway } = req.body;
    const cart = await redis.get(`cart:session:${session}`);
    if (!cart || cart.items.length === 0)
      return res.status(400).send("Cart empty");

    let amount = 0;
    const items = [];

    for (const i of cart.items) {
      const p = await redis.get(`product:${i.productId}`);
      if (!p || p.quantity < i.qty) return res.status(400).send("Stock changed");
      amount += p.price * i.qty;
      items.push({ ...i, price: p.price, name: p.name });
    }

    const orderId = crypto.randomUUID();
    const baseOrder = {
      orderId,
      session,
      items,
      amount,
      status: "pending",
      createdAt: Date.now(),
    };

    // Razorpay
    if (gateway === "razorpay") {
      const rp = await razorpay.orders.create({
        amount: amount * 100,
        currency: "INR",
        receipt: orderId,
      });
      baseOrder.razorpayOrderId = rp.id;
      await redis.set(`order:pending:${orderId}`, baseOrder);
      return res.json({
        gateway: "razorpay",
        orderId,
        razorpayOrderId: rp.id,
        key: process.env.RAZORPAY_KEY_ID,
        amount,
      });
    }

    // Stripe
    if (gateway === "stripe") {
      const sessionStripe = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: items.map(i => ({
          price_data: {
            currency: "inr",
            product_data: { name: i.name },
            unit_amount: i.price * 100,
          },
          quantity: i.qty,
        })),
        success_url: "https://axionikai.com/success",
        cancel_url: "https://axionikai.com/cancel",
        metadata: { orderId },
      });
      baseOrder.stripeSessionId = sessionStripe.id;
      await redis.set(`order:pending:${orderId}`, baseOrder);
      return res.json({
        gateway: "stripe",
        orderId,
        checkoutUrl: sessionStripe.url,
      });
    }

    res.status(400).send("Invalid gateway");
  } catch {
    res.status(500).send("Server error");
  }
});

/**
 * 🔒 STRIPE WEBHOOK
 */
app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const sig = req.headers["stripe-signature"];
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      if (event.type === "checkout.session.completed") {
        const { orderId } = event.data.object.metadata;
        const orderKey = `order:pending:${orderId}`;
        const order = await redis.get(orderKey);
        if (!order || order.status === "paid") return res.json({ ok: true });

        for (const i of order.items) {
          const pKey = `product:${i.productId}`;
          const p = await redis.get(pKey);
          p.quantity -= i.qty;
          await redis.set(pKey, p);
        }

        order.status = "paid";
        order.paidAt = Date.now();

        await redis.set(`order:paid:${orderId}`, order);
        await redis.del(orderKey);
      }

      res.json({ received: true });
    } catch (err) {
      console.error(err.message);
      res.status(400).send("Webhook error");
    }
  }
);

/**
 * Start
 */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
