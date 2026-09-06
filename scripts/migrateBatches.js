// Builds the batch ledger for stock that already exists.
// Usage: node scripts/migrateBatches.js
//
// Run once after moving to batch-wise stock. Safe to run again — a medicine
// that already has batch rows is left alone.
//
// Where possible each medicine's stock is rebuilt from its purchase history
// (so old deliveries keep their real batch and expiry). Anything left over
// becomes a single opening batch carrying the medicine's own batch/expiry.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const Product = require("../models/Product");
const Purchase = require("../models/purchase");
const StockBatch = require("../models/StockBatch");

const round = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    console.log("Connected to DB:", mongoose.connection.name, "\n");

    const products = await Product.find({});
    let built = 0, skipped = 0, empty = 0;

    for (const p of products) {
      const already = await StockBatch.countDocuments({ product: p._id });
      if (already > 0) {
        skipped++;
        console.log(`  skip   ${p.productName} — already has ${already} batch row(s)`);
        continue;
      }

      const stock = round(p.currentStock || 0);
      if (stock <= 0) {
        empty++;
        continue;
      }

      // What the purchase history says came in, oldest first
      const purchases = await Purchase.find({ "items.product": p._id, user: p.user }).sort({ date: 1 });
      const deliveries = [];
      for (const pur of purchases) {
        for (const it of pur.items) {
          if (String(it.product) !== String(p._id)) continue;
          deliveries.push({
            batchNo: it.batchNumber || "",
            expiryDate: it.expiryDate || null,
            qty: round((it.quantity || 0) + (it.bonusQty || 0)),
            rate: it.netRate || it.purchasePrice || 0,
            purchase: pur._id
          });
        }
      }

      // Fill the stock we hold from the newest deliveries backwards — older
      // stock is the stock most likely already sold
      let left = stock;
      const rows = [];
      for (const d of deliveries.reverse()) {
        if (left <= 0) break;
        const take = round(Math.min(d.qty, left));
        rows.push({ ...d, qty: take });
        left = round(left - take);
      }

      // Anything the purchase history cannot account for (opening stock, or
      // manual adjustments) becomes one batch on the medicine's own details
      if (left > 0) {
        rows.push({
          batchNo: p.batchNo || "OPENING",
          expiryDate: p.expiryDate || null,
          qty: left,
          rate: p.unitPrice || 0,
          purchase: null
        });
      }

      for (const r of rows) {
        await StockBatch.create({
          product: p._id,
          user: p.user,
          batchNo: r.batchNo,
          expiryDate: r.expiryDate,
          quantity: r.qty,
          purchaseRate: r.rate,
          salePrice: p.salePrice || 0,
          purchase: r.purchase
        });
      }

      built++;
      console.log(`  built  ${p.productName.padEnd(26)} ${stock} -> ${rows.length} batch(es): ` +
        rows.map(r => `${r.batchNo || "—"}×${r.qty}`).join(", "));
    }

    console.log(`\nDone. Built: ${built} | Already had batches: ${skipped} | No stock: ${empty}`);

    // Prove the ledger adds up to what the medicines say
    console.log("\nVerifying totals...");
    let mismatch = 0;
    for (const p of await Product.find({})) {
      const rows = await StockBatch.find({ product: p._id });
      const sum = round(rows.reduce((s, b) => s + b.quantity, 0));
      if (sum !== round(p.currentStock || 0)) {
        mismatch++;
        console.log(`  MISMATCH ${p.productName}: product ${p.currentStock} vs batches ${sum}`);
      }
    }
    console.log(mismatch === 0 ? "  every medicine matches its batches" : `  ${mismatch} mismatch(es)`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
})();
