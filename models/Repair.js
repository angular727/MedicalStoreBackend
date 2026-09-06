const mongoose = require("mongoose");

const repairSchema = new mongoose.Schema({
  repairCode:     { type: String, default: "" }, // e.g. RP-3722

  customer:       { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null }, // linked registered customer (optional)
  customerName:   { type: String, required: true },
  customerPhone:  { type: String, default: "" },
  customerCNIC:   { type: String, default: "" }, // ID Card / CNIC number

  productName:    { type: String, required: true }, // machine/item being repaired
  modelNumber:    { type: String, default: "" },
  serialNo:       { type: String, default: "" },

  issue:          { type: String, required: true }, // problem description
  status: {
    type: String,
    enum: ["Pending", "In Progress", "Completed", "Delivered"],
    default: "Pending"
  },

  receivedDate:   { type: Date, default: Date.now },
  completedDate:  { type: Date, default: null },

  estimatedCost:  { type: Number, default: 0 },
  totalCost:      { type: Number, default: 0 },
  amountReceived: { type: Number, default: 0 },

  technician:     { type: String, default: "" },
  notes:          { type: String, default: "" },

  user:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Repair || mongoose.model("Repair", repairSchema);
