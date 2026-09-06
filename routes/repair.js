const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Repair = require("../models/Repair");
const Customer = require("../models/Customer");
const CustomerLedger = require("../models/CustomerLedger");
const auth = require("../middleware/auth");
const { isPaged, getPageParams, pagedResponse } = require("../utils/paginate");

// Chota unique repair code banata hai (per user), collision par retry
async function generateRepairCode(userId) {
  for (let i = 0; i < 15; i++) {
    const code = "RP-" + String(Math.floor(1000 + Math.random() * 9000));
    const exists = await Repair.findOne({ repairCode: code, user: userId });
    if (!exists) return code;
  }
  return "RP-" + String(Date.now()).slice(-6); // fallback
}

// Same retry-on-write-conflict helper used in routes/sale.js and routes/customer.js
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

// ── POST /api/repair ─────────────────────────────────────────────────────
router.post("/", auth, async (req, res) => {
  try {
    const body = req.body;

    if (!body.customerName || !body.productName || !body.issue) {
      return res.status(400).json({ msg: "Customer name, product name and issue are required." });
    }

    body.repairCode = await generateRepairCode(req.user.id);
    body.estimatedCost = Number(body.estimatedCost) || 0;
    body.totalCost = Number(body.totalCost) || 0;
    body.amountReceived = Number(body.amountReceived) || 0;
    if (!body.completedDate) body.completedDate = null;
    if (!body.customer) body.customer = null; // "" from an unselected dropdown must not hit ObjectId cast

    const repairId = await withTxnRetry(async (session) => {
      const [repair] = await Repair.create([{ ...body, user: req.user.id }], { session });

      // Registered customer se linked ho to uske khata/ledger mein bhi charge chaRhe
      if (repair.customer) {
        const customer = await Customer.findOne({ _id: repair.customer, user: req.user.id }).session(session);
        if (customer) {
          customer.totalSale += repair.totalCost;
          customer.totalPaid += repair.amountReceived;
          await customer.save({ session });

          await CustomerLedger.create([{
            customer: customer._id,
            transactionType: "Sale",
            description: `Repair Job #${repair.repairCode} — ${repair.productName}`,
            debit: repair.totalCost,
            credit: repair.amountReceived,
            runningBalance: customer.balance,
            referenceId: repair._id,
            user: req.user.id
          }], { session });
        }
      }

      return repair._id;
    });

    const repair = await Repair.findById(repairId);
    res.status(201).json(repair);
  } catch (err) {
    console.error("POST /repair error:", err.message);
    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ msg: "Validation failed", errors });
    }
    res.status(500).json({ msg: err.message || "Server Error: Save failed" });
  }
});

// ── GET /api/repair ───────────────────────────────────────────────────────
router.get("/", auth, async (req, res) => {
  try {
    const { search, status, from, to } = req.query;
    const userFilter = { user: req.user.id };

    const searchFilter = {};
    if (search) {
      searchFilter.$or = [
        { repairCode:    { $regex: search, $options: "i" } },
        { customerName:  { $regex: search, $options: "i" } },
        { customerPhone: { $regex: search, $options: "i" } },
        { customerCNIC:  { $regex: search, $options: "i" } },
        { productName:   { $regex: search, $options: "i" } },
        { serialNo:      { $regex: search, $options: "i" } }
      ];
    }

    const dateFilter = {};
    if (from || to) {
      dateFilter.receivedDate = {};
      if (from) dateFilter.receivedDate.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        dateFilter.receivedDate.$lte = toDate;
      }
    }

    let query = { ...userFilter, ...searchFilter, ...dateFilter };
    if (status) query.status = status;

    if (!isPaged(req)) {
      const repairs = await Repair.find(query).sort({ createdAt: -1 });
      return res.json(repairs);
    }

    const { page, limit, skip } = getPageParams(req);
    const countBase = { ...userFilter, ...searchFilter, ...dateFilter };
    const [data, total, all, pending, inProgress, completed, delivered, costAgg] = await Promise.all([
      Repair.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Repair.countDocuments(query),
      Repair.countDocuments(countBase),
      Repair.countDocuments({ ...countBase, status: "Pending" }),
      Repair.countDocuments({ ...countBase, status: "In Progress" }),
      Repair.countDocuments({ ...countBase, status: "Completed" }),
      Repair.countDocuments({ ...countBase, status: "Delivered" }),
      Repair.aggregate([
        { $match: { ...countBase, user: new mongoose.Types.ObjectId(req.user.id) } },
        { $group: { _id: null, totalCost: { $sum: "$totalCost" }, totalReceived: { $sum: "$amountReceived" } } }
      ])
    ]);

    const totalCost = costAgg[0]?.totalCost || 0;
    const totalReceived = costAgg[0]?.totalReceived || 0;
    res.json(pagedResponse(data, total, page, limit, {
      all, pending, inProgress, completed, delivered,
      totalCost, totalReceived, totalDue: totalCost - totalReceived
    }));
  } catch (err) {
    console.error("GET /repair error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error: Fetch failed" });
  }
});

// ── GET /api/repair/:id ───────────────────────────────────────────────────
router.get("/:id", auth, async (req, res) => {
  try {
    const repair = await Repair.findOne({ _id: req.params.id, user: req.user.id });
    if (!repair) return res.status(404).json({ msg: "Repair record not found" });
    res.json(repair);
  } catch (err) {
    console.error("GET /repair/:id error:", err.message);
    if (err.kind === "ObjectId") return res.status(400).json({ msg: "Invalid ID format" });
    res.status(500).json({ msg: "Server Error" });
  }
});

// ── PUT /api/repair/:id ───────────────────────────────────────────────────
router.put("/:id", auth, async (req, res) => {
  try {
    const body = req.body;
    if (body.estimatedCost != null) body.estimatedCost = Number(body.estimatedCost);
    if (body.totalCost != null) body.totalCost = Number(body.totalCost);
    if (body.amountReceived != null) body.amountReceived = Number(body.amountReceived);
    if (body.completedDate === "") body.completedDate = null;
    if (body.customer === "") body.customer = null;

    const updatedId = await withTxnRetry(async (session) => {
      const oldRepair = await Repair.findOne({ _id: req.params.id, user: req.user.id }).session(session);
      if (!oldRepair) throw new Error("Repair record not found.");

      // Purane linked customer par asar reverse karein
      if (oldRepair.customer) {
        const oldCust = await Customer.findById(oldRepair.customer).session(session);
        if (oldCust) {
          oldCust.totalSale -= oldRepair.totalCost;
          oldCust.totalPaid -= oldRepair.amountReceived;
          await oldCust.save({ session });
        }
      }
      await CustomerLedger.deleteMany({ referenceId: oldRepair._id }).session(session);

      const updated = await Repair.findOneAndUpdate(
        { _id: req.params.id, user: req.user.id },
        { $set: body },
        { new: true, runValidators: true, session }
      );

      // Naye (ya wohi) linked customer par naya asar apply karein
      if (updated.customer) {
        const newCust = await Customer.findOne({ _id: updated.customer, user: req.user.id }).session(session);
        if (newCust) {
          newCust.totalSale += updated.totalCost;
          newCust.totalPaid += updated.amountReceived;
          await newCust.save({ session });

          await CustomerLedger.create([{
            customer: newCust._id,
            transactionType: "Sale Update",
            description: `Updated Repair Job #${updated.repairCode} — ${updated.productName}`,
            debit: updated.totalCost,
            credit: updated.amountReceived,
            runningBalance: newCust.balance,
            referenceId: updated._id,
            user: req.user.id
          }], { session });
        }
      }

      return updated._id;
    });

    const updated = await Repair.findById(updatedId);
    res.json(updated);
  } catch (err) {
    console.error("PUT /repair error:", err.message);
    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ msg: "Validation failed", errors });
    }
    if (err.message === "Repair record not found.") {
      return res.status(404).json({ msg: err.message });
    }
    res.status(500).json({ msg: err.message || "Update failed" });
  }
});

// ── POST /api/repair/:id/payment (Receive Payment against a repair job) ────
router.post("/:id/payment", auth, async (req, res) => {
  try {
    const { amount, note, date } = req.body;
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ msg: "Amount must be greater than 0" });

    const repairId = await withTxnRetry(async (session) => {
      const repair = await Repair.findOne({ _id: req.params.id, user: req.user.id }).session(session);
      if (!repair) throw new Error("Repair record not found");

      const balanceDue = (repair.totalCost || 0) - (repair.amountReceived || 0);
      if (amt > balanceDue) throw new Error("Amount cannot exceed the balance due");

      repair.amountReceived += amt;
      if (!repair.notes) repair.notes = "";
      const label = `Payment received: Rs. ${amt}${note ? " — " + note : ""} (${date ? new Date(date).toLocaleDateString() : new Date().toLocaleDateString()})`;
      repair.notes = repair.notes ? `${repair.notes}\n${label}` : label;
      await repair.save({ session });

      // Registered customer se linked ho to uska khata bhi update karein
      if (repair.customer) {
        const customer = await Customer.findOne({ _id: repair.customer, user: req.user.id }).session(session);
        if (customer) {
          customer.totalPaid += amt;
          await customer.save({ session });

          await CustomerLedger.create([{
            customer: customer._id,
            transactionType: "Payment",
            description: note
              ? `${note} — Repair Job #${repair.repairCode}`
              : `Payment received against Repair Job #${repair.repairCode}`,
            debit: 0,
            credit: amt,
            runningBalance: customer.balance,
            referenceId: repair._id,
            date: date ? new Date(date) : new Date(),
            user: req.user.id
          }], { session });
        }
      }

      return repair._id;
    });

    const repair = await Repair.findById(repairId);
    res.json(repair);
  } catch (err) {
    console.error("POST /repair/:id/payment error:", err.message);
    if (err.message === "Repair record not found" || err.message === "Amount cannot exceed the balance due") {
      return res.status(err.message === "Repair record not found" ? 404 : 400).json({ msg: err.message });
    }
    res.status(500).json({ msg: err.message || "Payment record karne mein masla hua" });
  }
});

// ── PATCH /api/repair/:id/status (quick status change) ─────────────────────
router.patch("/:id/status", auth, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ["Pending", "In Progress", "Completed", "Delivered"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ msg: "Invalid status value" });
    }

    const repair = await Repair.findOne({ _id: req.params.id, user: req.user.id });
    if (!repair) return res.status(404).json({ msg: "Repair record not found" });

    repair.status = status;
    if ((status === "Completed" || status === "Delivered") && !repair.completedDate) {
      repair.completedDate = new Date();
    }

    await repair.save();
    res.json(repair);
  } catch (err) {
    console.error("PATCH /repair/:id/status error:", err.message);
    res.status(500).json({ msg: err.message || "Status update failed" });
  }
});

// ── DELETE /api/repair/:id ────────────────────────────────────────────────
router.delete("/:id", auth, async (req, res) => {
  try {
    const found = await withTxnRetry(async (session) => {
      const repair = await Repair.findOne({ _id: req.params.id, user: req.user.id }).session(session);
      if (!repair) return false;

      if (repair.customer) {
        const customer = await Customer.findById(repair.customer).session(session);
        if (customer) {
          customer.totalSale -= repair.totalCost;
          customer.totalPaid -= repair.amountReceived;
          await customer.save({ session });
        }
        await CustomerLedger.deleteMany({ referenceId: repair._id }).session(session);
      }

      await repair.deleteOne({ session });
      return true;
    });

    if (!found) return res.status(404).json({ msg: "Repair record not found" });
    res.json({ msg: "Repair record deleted successfully" });
  } catch (err) {
    console.error("DELETE /repair error:", err.message);
    res.status(500).json({ msg: err.message || "Delete failed" });
  }
});

module.exports = router;
