const mongoose = require("mongoose");

const purchaseItemSchema = new mongoose.Schema({
  product:     { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  productType: { type: String, enum: ["single", "pack"], required: true },
  barcode:     { type: String },

  // ── Batch tracking — required for a medical store ──────────────────
  batchNumber: { type: String, required: true },
  expiryDate:  { type: Date, default: null },

  // ── Quantity ──────────────────────────────────────────────────────
  quantity: { type: Number, required: true, min: 1 }, // paid quantity
  bonusQty: { type: Number, default: 0, min: 0 },     // free goods from the distributor (e.g. 10 + 1)

  // ── Rates ─────────────────────────────────────────────────────────
  purchasePrice:   { type: Number, required: true },  // invoice rate per sale unit
  discountPercent: { type: Number, default: 0 },      // trade discount given by the distributor
  discount:        { type: Number, default: 0 },      // discount amount for this line
  netRate:         { type: Number, default: 0 },      // rate after the trade discount
  sellingPrice:    { type: Number, default: 0 },      // retail rate to sell at
  taxPercentage:   { type: Number, default: 0 },

  lineTotal: { type: Number, required: true }
});

const purchaseSchema = new mongoose.Schema({
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
  purchaseNumber: { type: String, required: true },
  date: { type: Date, default: Date.now },
  items: [purchaseItemSchema],
  subTotal: { type: Number, required: true },
  totalTax: { type: Number, default: 0 },
  deliveryCharges: { type: Number, default: 0 },
  grandTotal: { type: Number, required: true },
  amountPaid: { type: Number, default: 0 },
  paymentMethod: { type: String, default: "Cash" },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

module.exports = mongoose.models.Purchase || mongoose.model("Purchase", purchaseSchema);
