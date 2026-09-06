const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Supplier = require("../models/supplier");
const SupplierLedger = require("../models/SupplierLedger");
const auth = require("../middleware/auth");
const { isPaged, getPageParams, pagedResponse } = require("../utils/paginate");

// ==========================================
// 1. BASIC CRUD (Create, Read, Update, Delete)
// ==========================================

// @route   POST /api/supplier
// @desc    Naya Supplier add karna aur optional opening balance entry dalna
router.post("/", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const {
      name, companyName, phone, altPhone, address, city, email,
      openingBalance, totalAmount, paidAmount,
      supplierType, drugLicenseNo, ntn, strn, creditDays, notes
    } = req.body;

    if (!name || !companyName || !phone) {
      return res.status(400).json({ msg: "Name, Company Name, and Phone are required fields" });
    }

    // Support both openingBalance (preferred) and totalAmount/paidAmount for initial setup
    const initialOpening = Number(openingBalance) || 0;
    const initialPurchase = Number(totalAmount) || 0;
    const initialPaid = Number(paidAmount) || 0;

    const supplier = new Supplier({
      name,
      companyName,
      phone,
      altPhone,
      address,
      city,
      email,
      supplierType: supplierType || "Distributor",
      drugLicenseNo,
      ntn,
      strn,
      creditDays: Number(creditDays) || 0,
      notes,
      openingBalance: initialOpening,
      totalPurchase: initialPurchase,
      totalPaid: initialPaid,
      totalAmount: initialPurchase, // for compatibility
      paidAmount: initialPaid,       // for compatibility
      user: req.user.id
    });

    // Save supplier to generate ID and trigger pre-save hook for balance calculation
    await supplier.save({ session });

    // If there is any initial transaction or opening balance, record in ledger
    if (initialOpening > 0) {
      const openingLedger = new SupplierLedger({
        supplier: supplier._id,
        transactionType: "Opening Balance",
        description: "Opening Balance",
        credit: initialOpening,
        runningBalance: supplier.balance,
        user: req.user.id
      });
      await openingLedger.save({ session });
    }

    if (initialPurchase > 0) {
      const purchaseLedger = new SupplierLedger({
        supplier: supplier._id,
        transactionType: "Purchase",
        description: "Initial Purchase Balance",
        credit: initialPurchase,
        runningBalance: supplier.balance,
        user: req.user.id
      });
      await purchaseLedger.save({ session });
    }

    if (initialPaid > 0) {
      const paymentLedger = new SupplierLedger({
        supplier: supplier._id,
        transactionType: "Payment",
        description: "Initial Paid Balance",
        debit: initialPaid,
        runningBalance: supplier.balance,
        user: req.user.id
      });
      await paymentLedger.save({ session });
    }

    await session.commitTransaction();
    res.status(201).json(supplier);
  } catch (err) {
    await session.abortTransaction();
    console.error("Supplier creation error:", err.message);
    res.status(500).json({ msg: "Server Error: Supplier creation failed" });
  } finally {
    session.endSession();
  }
});

// @route   GET /api/supplier
// @desc    Saray suppliers ki list dekhna
router.get("/", auth, async (req, res) => {
  try {
    const { search } = req.query;
    const query = { user: req.user.id };
    if (search) {
      query.$or = [
        { name:        { $regex: search, $options: "i" } },
        { companyName: { $regex: search, $options: "i" } },
        { phone:         { $regex: search, $options: "i" } },
        { city:          { $regex: search, $options: "i" } },
        { drugLicenseNo: { $regex: search, $options: "i" } }
      ];
    }

    if (!isPaged(req)) {
      const suppliers = await Supplier.find(query).sort({ createdAt: -1 });
      return res.json(suppliers);
    }

    const { page, limit, skip } = getPageParams(req);
    const aggMatch = { ...query, user: new mongoose.Types.ObjectId(req.user.id) };
    const [data, total, balanceAgg] = await Promise.all([
      Supplier.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Supplier.countDocuments(query),
      Supplier.aggregate([
        { $match: aggMatch },
        { $group: { _id: null, totalBalance: { $sum: "$balance" } } }
      ])
    ]);

    const totalBalance = balanceAgg[0]?.totalBalance || 0;
    res.json(pagedResponse(data, total, page, limit, { totalBalance }));
  } catch (err) {
    console.error("Fetch suppliers error:", err.message);
    res.status(500).json({ msg: "Server Error" });
  }
});

// @route   GET /api/supplier/:id
// @desc    Get single supplier details
router.get("/:id", auth, async (req, res) => {
  try {
    const supplier = await Supplier.findOne({ _id: req.params.id, user: req.user.id });
    if (!supplier) {
      return res.status(404).json({ msg: "Supplier not found" });
    }
    res.json(supplier);
  } catch (err) {
    console.error("Get supplier error:", err.message);
    res.status(500).json({ msg: "Server Error" });
  }
});

// @route   PUT /api/supplier/:id
// @desc    Supplier details update karna (Basic profile info)
router.put("/:id", auth, async (req, res) => {
  try {
    let supplier = await Supplier.findOne({ _id: req.params.id, user: req.user.id });
    if (!supplier) return res.status(404).json({ msg: "Supplier not found" });

    // Profile updates (avoiding direct balance/ledger override here to keep integrity)
    const {
      name, companyName, phone, altPhone, address, city, email, status,
      supplierType, drugLicenseNo, ntn, strn, creditDays, notes
    } = req.body;

    if (name) supplier.name = name;
    if (companyName) supplier.companyName = companyName;
    if (phone) supplier.phone = phone;
    if (status) supplier.status = status;
    if (supplierType) supplier.supplierType = supplierType;

    // Optional text fields — an empty string is a valid "clear this"
    if (altPhone !== undefined) supplier.altPhone = altPhone;
    if (address !== undefined) supplier.address = address;
    if (city !== undefined) supplier.city = city;
    if (email !== undefined) supplier.email = email;
    if (drugLicenseNo !== undefined) supplier.drugLicenseNo = drugLicenseNo;
    if (ntn !== undefined) supplier.ntn = ntn;
    if (strn !== undefined) supplier.strn = strn;
    if (notes !== undefined) supplier.notes = notes;
    if (creditDays !== undefined) supplier.creditDays = Number(creditDays) || 0;

    await supplier.save();
    res.json(supplier);
  } catch (err) {
    console.error("Update supplier error:", err.message);
    res.status(500).json({ msg: "Server Error" });
  }
});

// @route   PUT /api/supplier/transaction/:id
// @desc    For compatibility with legacy route (direct update of purchase or payment)
router.put("/transaction/:id", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { newPurchaseAmount, newPaymentMade } = req.body;
    let supplier = await Supplier.findOne({ _id: req.params.id, user: req.user.id }).session(session);

    if (!supplier) {
      return res.status(404).json({ msg: "Supplier not found" });
    }

    if (newPurchaseAmount) {
      supplier.totalPurchase += Number(newPurchaseAmount);
      await supplier.save({ session });

      const ledgerEntry = new SupplierLedger({
        supplier: supplier._id,
        transactionType: "Purchase",
        description: "Manual Balance Adjustment (Purchase)",
        credit: Number(newPurchaseAmount),
        runningBalance: supplier.balance,
        user: req.user.id
      });
      await ledgerEntry.save({ session });
    }

    if (newPaymentMade) {
      supplier.totalPaid += Number(newPaymentMade);
      await supplier.save({ session });

      const ledgerEntry = new SupplierLedger({
        supplier: supplier._id,
        transactionType: "Payment",
        description: "Manual Balance Adjustment (Payment)",
        debit: Number(newPaymentMade),
        runningBalance: supplier.balance,
        user: req.user.id
      });
      await ledgerEntry.save({ session });
    }

    await session.commitTransaction();
    res.json(supplier);
  } catch (err) {
    await session.abortTransaction();
    console.error("Supplier transaction error:", err.message);
    res.status(500).json({ msg: "Server Error" });
  } finally {
    session.endSession();
  }
});

// @route   DELETE /api/supplier/:id
// @desc    Delete Supplier only if there are no ledger history (for security/audit)
router.delete("/:id", auth, async (req, res) => {
  try {
    const supplier = await Supplier.findOne({ _id: req.params.id, user: req.user.id });
    if (!supplier) return res.status(404).json({ msg: "Supplier not found" });

    // Check if supplier has non-opening ledger entries
    const ledgerCount = await SupplierLedger.countDocuments({ 
      supplier: req.params.id,
      transactionType: { $ne: "Opening Balance" }
    });

    if (ledgerCount > 0) {
      return res.status(400).json({ 
        msg: "Cannot delete supplier. Active purchase/payment ledger transactions exist. Set status to 'Inactive' instead." 
      });
    }

    // Delete opening balance ledgers first
    await SupplierLedger.deleteMany({ supplier: req.params.id });
    await supplier.deleteOne();
    
    res.json({ msg: "Supplier removed successfully" });
  } catch (err) {
    console.error("Delete supplier error:", err.message);
    res.status(500).json({ msg: "Server Error" });
  }
});


// ==========================================
// 2. SUPPLIER PAYMENTS (Paisa dena)
// ==========================================

// @route   POST /api/supplier/payment
// @desc    Supplier ko cash/bank payment karna aur Ledger update karna (Robust Audit Trail)
router.post("/payment", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { supplierId, amount, paymentMethod, note, date, transactionType } = req.body;

    if (!supplierId || !amount) {
      return res.status(400).json({ msg: "Supplier ID and Amount are required" });
    }

    const supplier = await Supplier.findOne({ _id: supplierId, user: req.user.id }).session(session);
    if (!supplier) {
      return res.status(404).json({ msg: "Supplier not found" });
    }

    const amt = Number(amount);
    const type = transactionType || "Payment";

    if (type === "Payment") {
      // Aap ne supplier ko paisa diya → totalPaid barha → balance kama
      supplier.totalPaid += amt;
    } else if (type === "Purchase") {
      // Naya udhaar liya → totalPurchase barha → balance barha
      supplier.totalPurchase += amt;
    }
    await supplier.save({ session });

    const ledgerEntry = new SupplierLedger({
      supplier: supplierId,
      transactionType: type,
      description: type === "Payment"
        ? `Payment via ${paymentMethod || "Cash"}. ${note || ""}`.trim()
        : `Credit Purchase. ${note || ""}`.trim(),
      date: date ? new Date(date) : Date.now(),
      debit:  type === "Payment"  ? amt : 0,
      credit: type === "Purchase" ? amt : 0,
      runningBalance: supplier.balance,
      user: req.user.id
    });
    await ledgerEntry.save({ session });

    await session.commitTransaction();
    res.json({
      msg: "Transaction recorded successfully",
      supplierName: supplier.name,
      currentBalance: supplier.balance
    });
  } catch (err) {
    await session.abortTransaction();
    console.error("Payment registration error:", err.message);
    res.status(500).json({ msg: err.message || "Payment registration failed" });
  } finally {
    session.endSession();
  }
});


// ==========================================
// 3. SUPPLIER REPORTS (Ledger / Statement)
// ==========================================

// @route   GET /api/supplier/ledger/:id
// @desc    Supplier ka mukammal Khata (Statement) report with filters
router.get("/ledger/:id", auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let filter = { supplier: req.params.id, user: req.user.id };

    if (startDate && endDate) {
      filter.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
    } else if (startDate) {
      filter.date = { $gte: new Date(startDate) };
    } else if (endDate) {
      filter.date = { $lte: new Date(endDate) };
    }

    const rows = await SupplierLedger.find(filter).sort({ date: 1, _id: 1 });
    const supplier = await Supplier.findOne({ _id: req.params.id, user: req.user.id });

    if (!supplier) {
      return res.status(404).json({ msg: "Supplier not found" });
    }

    // Recompute running balance sequentially so the column is always correct
    // (credit = bill/purchase raises what we owe, debit = payment lowers it)
    let running = 0;
    let totalBill = 0;   // sum of credit column (purchases + opening carried forward)
    let totalPaid = 0;   // sum of debit column (payments made)
    const transactions = rows.map((e) => {
      running += (e.credit || 0) - (e.debit || 0);
      totalBill += (e.credit || 0);
      totalPaid += (e.debit || 0);
      const obj = e.toObject();
      obj.runningBalance = running;
      return obj;
    });

    res.json({
      supplierName: supplier.name,
      company: supplier.companyName,
      summary: {
        opening: supplier.openingBalance,
        // Derived from the actual ledger rows so cards, columns and footer all reconcile
        totalPurchases: totalBill,
        totalPaid: totalPaid,
        balanceDue: totalBill - totalPaid
      },
      ledger: transactions
    });
  } catch (err) {
    console.error("Supplier ledger fetch error:", err.message);
    res.status(500).json({ msg: "Report Generation Error" });
  }
});

module.exports = router;