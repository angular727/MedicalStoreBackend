// Clears the admin user's products so the demo medicines can be seeded again.
// Usage: node scripts/resetProducts.js

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const Product = require("../models/Product");
const User = require("../models/User");

const OWNER = process.env.SEED_ADMIN_USERNAME || "admin";

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const owner = await User.findOne({ username: OWNER });
    if (!owner) {
      console.error(`❌ User "${OWNER}" not found.`);
      process.exit(1);
    }
    const { deletedCount } = await Product.deleteMany({ user: owner._id });
    console.log(`🗑️  Deleted ${deletedCount} products of "${OWNER}"`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
})();
