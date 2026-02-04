import redis from "./redis.js";

const products = [
  {
    id: "P3001",
    name: "Black Oversized T-Shirt",
    category: "tshirts",
    price: 1299,
    floorPrice: 899,
    quantity: 40,
    sizes: ["M", "L", "XL"]
  },
  {
    id: "P3002",
    name: "White Classic T-Shirt",
    category: "tshirts",
    price: 999,
    floorPrice: 699,
    quantity: 25,
    sizes: ["S", "M", "L"]
  },
  {
    id: "P4001",
    name: "Blue Denim Jeans",
    category: "jeans",
    price: 2199,
    floorPrice: 1799,
    quantity: 20,
    sizes: ["30", "32", "34", "36"]
  },
  {
    id: "P5001",
    name: "Grey Hoodie",
    category: "hoodies",
    price: 2499,
    floorPrice: 1999,
    quantity: 15,
    sizes: ["M", "L", "XL"]
  }
];

async function seed() {
  try {
    console.log("🌱 Seeding products...");

    for (const product of products) {
      const key = `product:${product.id}`;
      await redis.set(key, JSON.stringify(product));
      console.log(`✅ Seeded ${product.name}`);
    }

    console.log("🎉 Product seeding completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Seeding failed:", err);
    process.exit(1);
  }
}

seed();
