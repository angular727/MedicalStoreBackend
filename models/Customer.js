const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, default: "" },
  address: { type: String, default: "" },
  city: { type: String, default: "" },
  email: { type: String, default: "" },
  isWalking: { type: Boolean, default: false }, // set for over-the-counter walk-ins

  // ── Patient details a medical store keeps on file ──────────────────
  customerType: {
    type: String,
    enum: ["Walk-in", "Regular", "Doctor", "Clinic", "Hospital", "Staff"],
    default: "Walk-in"
  },
  age:    { type: Number, default: null },
  gender: { type: String, enum: ["", "Male", "Female", "Other"], default: "" },

  // Chronic conditions and allergies — checked before handing over a medicine
  allergies:  { type: String, default: "" },
  conditions: { type: String, default: "" },

  // Credit limit for regular customers who buy on account
  creditLimit: { type: Number, default: 0 },
  notes: { type: String, default: "" },


  openingBalance: { type: Number, default: 0 },
  totalSale: { type: Number, default: 0 },
  totalPaid: { type: Number, default: 0 },
  balance: { type: Number, default: 0 }, // (Opening + TotalSale - TotalPaid)

  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now }
});

// Balance calculate karne ke liye pre-save hook
customerSchema.pre("save", function (next) {
  this.balance = this.openingBalance + this.totalSale - this.totalPaid;
  next();
});

// module.exports = mongoose.model("Customer", customerSchema);
module.exports = mongoose.models.Customer || mongoose.model("Customer", customerSchema);