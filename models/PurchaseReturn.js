const mongoose = require("mongoose");

const purchaseReturnItemSchema = new mongoose.Schema({
  product:     { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  productName: { type: String, default: "" },

  // Batch details carried over from the purchase line — a medical store
  // always returns goods against a specific batch
  batchNumber: { type: String, default: "" },
  expiryDate:  { type: Date, default: null },

  quantity: { type: Number, required: true, min: 1 },  // total pieces going back
  paidQty:  { type: Number, default: 0 },              // of those, how many were paid for
  freeQty:  { type: Number, default: 0 },              // bonus pieces — returned without credit

  purchasePrice: { type: Number, required: true, min: 0 }, // invoice rate
  netRate:       { type: Number, default: 0 },             // rate after trade discount — what gets credited
  lineTotal:     { type: Number, required: true }
}, { _id: false });

const purchaseReturnSchema = new mongoose.Schema({
  originalPurchase: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", required: true },
  purchaseNumber:   { type: String, default: "" },     // original purchase invoice #
  returnNumber:     { type: String, required: true },  // e.g. PR-1042
  supplier:         { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
  supplierName:     { type: String, default: "" },
  date:             { type: Date, default: Date.now },
  items:            [purchaseReturnItemSchema],
  totalAmount:      { type: Number, required: true },
  reason:           { type: String, default: "" },
  user:             { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

module.exports = mongoose.models.PurchaseReturn || mongoose.model("PurchaseReturn", purchaseReturnSchema);
