const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const CustomerLedger = require("../models/CustomerLedger");
const Sale = require("../models/Sale");
const auth = require("../middleware/auth");
const { isPaged, getPageParams, pagedResponse } = require("../utils/paginate");

// ==========================================
// Helper: run a transaction with auto-retry on transient
// MongoDB conflicts ("Write conflict ... yielding is disabled").
// Same pattern as routes/sale.js — Atlas shared tiers throw these
// intermittently and retry is the officially recommended handling.
// ==========================================
async function withTxnRetry(fn, maxRetries = 4) {
  let attempt = 0;
  while (true) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const result = await fn(session);
      await session.commitTransaction();
      session.endSession();
      return result;
    } catch (err) {
      try { await session.abortTransaction(); } catch (e) {}
      session.endSession();

      const labels = err.errorLabels || [];
      const transient = labels.includes("TransientTransactionError") ||
                        labels.includes("UnknownTransactionCommitResult");
      const writeConflict = err.code === 112 || /write conflict/i.test(err.message || "");

      if ((transient || writeConflict) && attempt < maxRetries) {
        attempt++;
        await new Promise(r => setTimeout(r, 60 * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ==========================================
// 1. ADD NEW CUSTOMER
// ==========================================
router.post("/", auth, async (req, res) => {
  try {
    const {
      name, phone, address, city, email, openingBalance, isWalking,
      customerType, age, gender, allergies, conditions, creditLimit, notes
    } = req.body;

    // Normalize once — an absent opening balance used to become NaN and then
    // blew up the ledger entry below, so a customer could not be saved at all
    const opening = Number(openingBalance) || 0;

    const customer = new Customer({
      name,
      phone,
      address,
      city,
      email,
      openingBalance: opening,
      isWalking,
      customerType: customerType || (isWalking ? "Walk-in" : "Regular"),
      age: age !== undefined && age !== null && age !== "" ? Number(age) : null,
      gender: gender || "",
      allergies: allergies || "",
      conditions: conditions || "",
      creditLimit: Number(creditLimit) || 0,
      notes: notes || "",
      user: req.user.id
    });

    const savedCustomer = await customer.save();

    if (opening !== 0) {
      const ledgerEntry = new CustomerLedger({
        customer: savedCustomer._id,
        transactionType: "Opening Balance",
        description: "Initial Balance at time of registration",
        debit: opening > 0 ? opening : 0,
        credit: opening < 0 ? Math.abs(opening) : 0,
        runningBalance: opening,
        user: req.user.id
      });
      await ledgerEntry.save();
    }

    res.status(201).json(savedCustomer);
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 2. GET ALL CUSTOMERS
// ==========================================
router.get("/", auth, async (req, res) => {
  try {
    const { search } = req.query;
    const query = { user: req.user.id };
    if (search) {
      query.$or = [
        { name:  { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { city:  { $regex: search, $options: "i" } }
      ];
    }

    if (!isPaged(req)) {
      const customers = await Customer.find(query).sort({ createdAt: -1 });
      return res.json(customers);
    }

    const { page, limit, skip } = getPageParams(req);
    const aggMatch = { ...query, user: new mongoose.Types.ObjectId(req.user.id) };
    const [data, total, balanceAgg] = await Promise.all([
      Customer.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Customer.countDocuments(query),
      Customer.aggregate([
        { $match: aggMatch },
        { $group: { _id: null, totalBalance: { $sum: "$balance" } } }
      ])
    ]);

    const totalBalance = balanceAgg[0]?.totalBalance || 0;
    res.json(pagedResponse(data, total, page, limit, { totalBalance }));
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 3. GET SINGLE CUSTOMER (Ab Edit sahi kaam karega)
// ==========================================
router.get("/:id", auth, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, user: req.user.id });
    if (!customer) return res.status(404).json({ msg: "Customer not found" });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 4. UPDATE CUSTOMER (Sirf Profile Info update karega)
// ==========================================
router.put("/:id", auth, async (req, res) => {
  try {
    const {
      name, phone, address, city, email, isWalking,
      customerType, age, gender, allergies, conditions, creditLimit, notes
    } = req.body;

    // Only profile fields are updatable here — balances belong to the ledger
    const fields = { name, phone, address, city, email, isWalking, customerType, gender, allergies, conditions, notes };
    if (age !== undefined) fields.age = (age === "" || age === null) ? null : Number(age);
    if (creditLimit !== undefined) fields.creditLimit = Number(creditLimit) || 0;
    Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

    const updatedCustomer = await Customer.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $set: fields },
      { new: true }
    );

    if (!updatedCustomer) return res.status(404).json({ msg: "Customer not found" });
    res.json(updatedCustomer);
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 5. CUSTOMER PAYMENT
// ==========================================
router.post("/payment", auth, async (req, res) => {
  try {
    const { customerId, amount, note, transactionType, date } = req.body;
    const amt = Number(amount);
    if (!amt || amt <= 0) throw new Error("Amount must be greater than 0");
    const type = transactionType || "Payment";
    const txnDate = date ? new Date(date) : new Date();

    const currentBalance = await withTxnRetry(async (session) => {
      const customer = await Customer.findOne({ _id: customerId, user: req.user.id }).session(session);
      if (!customer) throw new Error("Customer not found");

      if (type !== "Payment") {
        // Naya udhaar diya (on account, not tied to a specific invoice) → totalSale barha
        customer.totalSale += amt;
        await customer.save({ session });

        await new CustomerLedger({
          customer: customerId,
          transactionType: type,
          description: note || "Credit Sale / Udhaar",
          debit: amt,
          credit: 0,
          runningBalance: customer.balance,
          date: txnDate,
          user: req.user.id
        }).save({ session });

        return customer.balance;
      }

      // Customer ne paisa diya → sabse pehle uske purane (oldest) pending
      // invoices par apply karein (FIFO), taake har Sale ka amountReceived —
      // aur is se Sales History ka Received/Balance Due — hamesha sync rahe.
      customer.totalPaid += amt;
      await customer.save({ session });

      let remaining = amt;
      const openSales = await Sale.find({
        customer: customerId,
        user: req.user.id,
        $expr: { $lt: ["$amountReceived", "$grandTotal"] }
      }).sort({ createdAt: 1 }).session(session);

      for (const sale of openSales) {
        if (remaining <= 0) break;
        const due = sale.grandTotal - sale.amountReceived;
        if (due <= 0) continue;
        const applied = Math.min(due, remaining);

        sale.amountReceived += applied;
        await sale.save({ session });
        remaining -= applied;

        await new CustomerLedger({
          customer: customerId,
          transactionType: "Payment",
          description: note
            ? `${note} — Invoice #${sale.invoiceNumber}`
            : `Payment received against Invoice #${sale.invoiceNumber}`,
          debit: 0,
          credit: applied,
          runningBalance: customer.balance,
          referenceId: sale._id,
          date: txnDate,
          user: req.user.id
        }).save({ session });
      }

      // Sab invoices settle hone ke baad bhi kuch bache to woh general
      // advance/on-account credit hai, kisi ek invoice se linked nahi.
      if (remaining > 0) {
        await new CustomerLedger({
          customer: customerId,
          transactionType: "Payment",
          description: note || "Cash/Bank Received (Advance)",
          debit: 0,
          credit: remaining,
          runningBalance: customer.balance,
          date: txnDate,
          user: req.user.id
        }).save({ session });
      }

      return customer.balance;
    });

    res.json({ msg: "Transaction recorded", currentBalance });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 6. CUSTOMER LEDGER
// ==========================================
router.get("/ledger/:id", auth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ msg: "Customer not found" });

    const rows = await CustomerLedger.find({ customer: req.params.id, user: req.user.id })
      .sort({ date: 1, _id: 1 });

    // Recompute running balance sequentially so the column is always correct
    // (debit = sale/charge raises balance, credit = payment lowers it)
    let running = 0;
    const ledger = rows.map((e) => {
      running += (e.debit || 0) - (e.credit || 0);
      const obj = e.toObject();
      obj.runningBalance = running;
      return obj;
    });

    const totalDebit = ledger.reduce((s, e) => s + (e.debit || 0), 0);
    const totalCredit = ledger.reduce((s, e) => s + (e.credit || 0), 0);
    res.json({
      customerName: customer.name,
      phone: customer.phone,
      openingBalance: customer.openingBalance,
      currentBalance: customer.balance,
      totalDebit,
      totalCredit,
      ledger
    });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 7. DELETE CUSTOMER (only if no linked sales)
// ==========================================
router.delete("/:id", auth, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, user: req.user.id });
    if (!customer) return res.status(404).json({ msg: "Customer not found" });

    const Sale = require("../models/Sale");
    const saleCount = await Sale.countDocuments({ customer: req.params.id, user: req.user.id });
    if (saleCount > 0) {
      return res.status(400).json({
        msg: "This customer has existing sales and cannot be deleted. Please delete the related sales first."
      });
    }

    await CustomerLedger.deleteMany({ customer: req.params.id, user: req.user.id });
    await customer.deleteOne();
    res.json({ msg: "Customer deleted successfully" });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

module.exports = router;