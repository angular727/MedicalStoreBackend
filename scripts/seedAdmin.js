// Admin user seed script
// Usage: node scripts/seedAdmin.js
// If the admin already exists, this just resets their password.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");

const NAME = process.env.SEED_ADMIN_NAME || "Administrator";
const USERNAME = process.env.SEED_ADMIN_USERNAME || "admin";
const PASSWORD = process.env.SEED_ADMIN_PASSWORD || "admin";

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    console.log("✅ Connected to DB:", mongoose.connection.name);

    const hashedPassword = await bcrypt.hash(PASSWORD, 10);
    const existing = await User.findOne({ username: USERNAME });

    if (existing) {
      existing.name = NAME;
      existing.password = hashedPassword;
      existing.role = "admin";
      await existing.save();
      console.log(`♻️  Admin already existed — password has been reset (username: ${USERNAME})`);
    } else {
      await User.create({ name: NAME, username: USERNAME, password: hashedPassword, role: "admin" });
      console.log(`✅ Admin created (username: ${USERNAME})`);
    }

    const total = await User.countDocuments();
    console.log("👥 Total users:", total);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
})();
