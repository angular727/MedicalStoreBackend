// Wipes every transaction and master record, keeping only the login user.
// Usage: node scripts/resetAll.js
// Use before a fresh end-to-end test, or to hand over a clean database.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const COLLECTIONS = [
  "products",
  "suppliers",
  "customers",
  "purchases",
  "sales",
  "purchasereturns",
  "salereturns",
  "supplierledgers",
  "customerledgers",
  "stocklogs",
  "repairs"
];

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    console.log("Connected to DB:", mongoose.connection.name);

    const existing = (await mongoose.connection.db.listCollections().toArray()).map(c => c.name);

    for (const name of COLLECTIONS) {
      if (!existing.includes(name)) continue;
      const { deletedCount } = await mongoose.connection.db.collection(name).deleteMany({});
      console.log(`  cleared ${name}: ${deletedCount}`);
    }

    const users = await mongoose.connection.db.collection("users").countDocuments();
    console.log(`\nUsers kept: ${users}`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
})();
