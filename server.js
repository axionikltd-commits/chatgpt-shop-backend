/**
 * AXIONIK – FULL PRODUCTION BACKEND
 * Catalog + Cart + Payments + Orders + Delivery + Refunds + Admin + ChatGPT Tracking
 */

import express from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import Stripe from "stripe";
import { Redis } from "@upstash/redis";

const app = express();
const PORT = process.env.PORT || 3000;

/* ===================== CLIENTS ===================== */

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* ===================== MIDDLEWARE ===================== */

app.use(express.json());

/* ===================== HEALTH ===================== */

app.get("/", (_, res) => {
  res.send("Axionik backend is running 🚀");
});

/* ===================== CHATGPT SESSION ===================== */

app.get("/chat-checkout", async (req, res) => {
  const { intent, color, size, budget, source } = req.query;
  if (source !== "chatgpt" || !intent)
    return res.status(400).send("Invalid request");

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
});

/* ===================== SHOP ===================== */

app.get("/shop", async (req, res) => {
  const session = await redis.get(`chat:session:${req.query.session}`);
  if (!session) return res.status(404).send("Session expired");

  const ids = (await redis.get("products:index")) || [];
  const products = await Promise.all(ids.map(id => redis.get(`product:${id}`)));

  const filtered = products.filter(p => {
    if (!p) return false;
    if (!p.category.toLowerCase().includes(session.intent)) return false;
    if (session.color && p.color !== session.color) return false;
    if (session.size && !p.sizes.includes(session.size)) return false;
    if (session.budget && p.price > session.budget) return false;
    return p.quantity > 0;
  });

  res.json({ count: filtered.length, products: filtered });
});

/* ===================== CART ===================== */

app.post("/add-to-cart", async (req, res) => {
  const { session, productId, qty } = req.body;
  const product = await redis.get(`product:${productId}`);
  if (!product || product.quantity < qty)
    return res.status(400).send("Stock issue");

  const key = `cart:session:${session}`;
  const cart = (await redis.get(key)) || { items: [] };

  const existing = cart.items.find(i => i.productId === productId);
  existing ? (existing.qty += qty) : cart.items.push({ productId, qty });

  await redis.set(key, cart, { ex: 1800 });
  res.json({ success: true, cart });
});

/* ===================== CHECKOUT ===================== */

app.post("/checkout", async (req, res) => {
  const { session, gateway } = req.body;
  const cart = await redis.get(`cart:session:${session}`);
  if (!cart || !cart.items.length) return res.status(400).send("Cart empty");

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
    deliveryStatus: "processing",
    createdAt: Date.now(),
  };

  if (gateway === "razorpay") {
    const rp = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: orderId,
    });
    baseOrder.razorpayOrderId = rp.id;
    await redis.set(`order:pending:${orderId}`, baseOrder);
    return res.json({ gateway, orderId, razorpayOrderId: rp.id });
  }

  if (gateway === "stripe") {
    const s = await stripe.checkout.sessions.create({
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
    baseOrder.stripeSessionId = s.id;
    await redis.set(`order:pending:${orderId}`, baseOrder);
    return res.json({ gateway, orderId, checkoutUrl: s.url });
  }

  res.status(400).send("Invalid gateway");
});

/* ===================== STRIPE WEBHOOK ===================== */

app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === "checkout.session.completed") {
      const orderId = event.data.object.metadata.orderId;
      await finalizeOrder(orderId);
    }

    res.json({ ok: true });
  }
);

/* ===================== FINALIZE ORDER ===================== */

async function finalizeOrder(orderId) {
  const key = `order:pending:${orderId}`;
  const order = await redis.get(key);
  if (!order || order.status === "paid") return;

  for (const i of order.items) {
    const pKey = `product:${i.productId}`;
    const p = await redis.get(pKey);
    p.quantity -= i.qty;
    await redis.set(pKey, p);
  }

  order.status = "paid";
  order.paidAt = Date.now();

  await redis.set(`order:paid:${orderId}`, order);
  await redis.del(key);
}

/* ===================== DELIVERY STATUS ===================== */

app.post("/admin/order/:orderId/status", async (req, res) => {
  const { status } = req.body; // processing | shipped | delivered
  const key = `order:paid:${req.params.orderId}`;
  const order = await redis.get(key);
  if (!order) return res.status(404).send("Order not found");

  order.deliveryStatus = status;
  order.updatedAt = Date.now();
  await redis.set(key, order);

  res.json({ success: true, order });
});

/* ===================== REFUNDS ===================== */

app.post("/admin/order/:orderId/refund", async (req, res) => {
  const order = await redis.get(`order:paid:${req.params.orderId}`);
  if (!order) return res.status(404).send("Order not found");

  order.status = "refunded";
  order.refundedAt = Date.now();
  await redis.set(`order:refunded:${order.orderId}`, order);
  res.json({ success: true });
});

/* ===================== ORDER TRACKING ===================== */

app.get("/order/:orderId", async (req, res) => {
  const paid = await redis.get(`order:paid:${req.params.orderId}`);
  if (paid) return res.json(paid);

  const pending = await redis.get(`order:pending:${req.params.orderId}`);
  if (pending) return res.json(pending);

  res.status(404).send("Order not found");
});

/* ===================== CHATGPT ORDER QUERY ===================== */

app.get("/chat-track-order", async (req, res) => {
  const { orderId } = req.query;
  const order = await redis.get(`order:paid:${orderId}`);
  if (!order) return res.json({ message: "I couldn’t find your order 😕" });

  res.json({
    message: `Your order is ${order.deliveryStatus}.`,
    orderId,
    deliveryStatus: order.deliveryStatus,
  });
});

/* ===================== ADMIN DASHBOARD ===================== */

app.get("/admin/orders", async (_, res) => {
  const keys = await redis.keys("order:paid:*");
  const orders = await Promise.all(keys.map(k => redis.get(k)));
  res.json({ count: orders.length, orders });
});

/* ===================== START ===================== */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
