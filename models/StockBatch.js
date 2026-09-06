const mongoose = require("mongoose");

// One live batch of one medicine.
//
// A medical store never holds "20 Panadol" — it holds "12 of batch PN-7701
// expiring Dec 2028" and "8 of batch PN-8802 expiring Mar 2029". This is that
// row. Product.currentStock stays as the running total of these, so every
// existing screen keeps working while batches carry the detail.
const stockBatchSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },

  batchNo:    { type: String, default: "", trim: true },
  expiryDate: { type: Date, default: null },

  // Remaining quantity, in the product's own sale unit (Box for a pack
  // medicine, Piece for a single one). Fractional because a pack can be
  // opened and sold loose.
  quantity: { type: Number, required: true, default: 0 },

  // What this batch cost and what it was meant to sell for
  purchaseRate: { type: Number, default: 0 },
  salePrice:    { type: Number, default: 0 },

  // Where it came from, so a purchase edit or void can find its own rows
  purchase: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", default: null },

  user:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now }
});

// Nearest expiry first — this is the order stock is sold in (FEFO)
stockBatchSchema.index({ user: 1, product: 1, expiryDate: 1 });

module.exports = mongoose.models.StockBatch || mongoose.model("StockBatch", stockBatchSchema);
