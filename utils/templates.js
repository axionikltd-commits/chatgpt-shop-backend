export function orderCreatedEmail(order) {
  return `
    <h2>🛍️ Order Confirmed</h2>
    <p>Order ID: <b>${order.orderId}</b></p>
    <p>Status: ${order.deliveryStatus}</p>
    <p>We’ll notify you when it ships 🚚</p>
  `;
}
