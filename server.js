import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/chat-checkout", (req, res) => {
  const { intent, color, size, budget, source } = req.query;

  if (source !== "chatgpt") {
    return res.status(400).send("Invalid source");
  }

  const sessionId = crypto.randomUUID();

  res.send(`
    <h2>Welcome 👋</h2>
    <p>Intent: ${intent}</p>
    <p>Color: ${color}</p>
    <p>Size: ${size}</p>
    <p>Budget: ₹${budget}</p>
    <p>Session ID: ${sessionId}</p>
  `);
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
