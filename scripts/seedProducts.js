// Demo medicines seed script
// Usage: node scripts/seedProducts.js   (creates 5 demo medicines owned by the admin user)
// A medicine that already exists (same name + batch) is skipped.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const Product = require("../models/Product");
const Supplier = require("../models/supplier");
const User = require("../models/User");

const OWNER = process.env.SEED_ADMIN_USERNAME || "admin";

// Puts the expiry N months from today
const monthsFromNow = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d;
};

const MEDICINES = [
  {
    productName: "Panadol 500mg",
    genericName: "Paracetamol",
    brand: "GSK",
    category: "Tablet",
    strength: "500mg",
    type: "pack",
    unitLabel: "Tablet",
    packLabel: "Box",
    unitsPerPack: 200,
    looseSale: true,
    looseSalePrice: 3,
    unitPrice: 420,
    salePrice: 500,
    initialStock: 25,
    minStock: 5,
    batchNo: "PN-4471",
    expiryDate: monthsFromNow(20),
    shelfNo: "R-01",
    barcode: "8964000101234"
  },
  {
    productName: "Augmentin 625mg",
    genericName: "Amoxicillin + Clavulanic Acid",
    brand: "GSK",
    category: "Tablet",
    strength: "625mg",
    type: "pack",
    unitLabel: "Tablet",
    packLabel: "Strip",
    unitsPerPack: 6,
    looseSale: true,
    looseSalePrice: 78,
    unitPrice: 385,
    salePrice: 440,
    initialStock: 18,
    minStock: 4,
    batchNo: "AG-2210",
    expiryDate: monthsFromNow(2), // near expiry — exercises the warning badge in the list
    shelfNo: "R-02",
    barcode: "8964000105678"
  },
  {
    productName: "Brufen Syrup 120ml",
    genericName: "Ibuprofen",
    brand: "Abbott",
    category: "Syrup",
    strength: "120ml",
    type: "single",
    unitLabel: "Bottle",
    packLabel: "Box",
    unitsPerPack: 1,
    looseSale: false,
    looseSalePrice: null,
    unitPrice: 155,
    salePrice: 185,
    initialStock: 12,
    minStock: 3,
    batchNo: "BF-9033",
    expiryDate: monthsFromNow(14),
    shelfNo: "R-05",
    barcode: "8964000109012"
  },
  {
    productName: "Ceftriaxone 1g Injection",
    genericName: "Ceftriaxone Sodium",
    brand: "Sami Pharma",
    category: "Injection",
    strength: "1g",
    type: "single",
    unitLabel: "Vial",
    packLabel: "Box",
    unitsPerPack: 1,
    looseSale: false,
    looseSalePrice: null,
    unitPrice: 240,
    salePrice: 290,
    initialStock: 3,
    minStock: 6, // low stock — exercises the red alert in the list
    batchNo: "CT-1187",
    expiryDate: monthsFromNow(9),
    shelfNo: "Fridge-A",
    barcode: "8964000103456"
  },
  {
    productName: "Polyfax Skin Ointment 20g",
    genericName: "Polymyxin B + Bacitracin",
    brand: "GSK",
    category: "Cream / Ointment",
    strength: "20g",
    type: "single",
    unitLabel: "Tube",
    packLabel: "Box",
    unitsPerPack: 1,
    looseSale: false,
    looseSalePrice: null,
    unitPrice: 310,
    salePrice: 365,
    initialStock: 9,
    minStock: 2,
    batchNo: "PX-5520",
    expiryDate: monthsFromNow(26),
    shelfNo: "R-08",
    barcode: "8964000107890"
  }
];

// Short unique 4-digit product code (per user)
async function generateProductCode(userId) {
  for (let i = 0; i < 15; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const exists = await Product.findOne({ productCode: code, user: userId });
    if (!exists) return code;
  }
  return String(Date.now()).slice(-6);
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    console.log("✅ Connected to DB:", mongoose.connection.name);

    const owner = await User.findOne({ username: OWNER });
    if (!owner) {
      console.error(`❌ User "${OWNER}" not found. Run this first: npm run seed:admin`);
      process.exit(1);
    }

    // A distributor to buy from — purchase entry needs at least one
    const DISTRIBUTOR = { name: 'Ali Traders', companyName: 'Ali Pharma Distributors', phone: '0300-1234567', address: 'Main Bazar, City' };
    const existingSup = await Supplier.findOne({ companyName: DISTRIBUTOR.companyName, user: owner._id });
    if (existingSup) {
      console.log('⏭️  Distributor already exists:', DISTRIBUTOR.companyName);
    } else {
      await Supplier.create({ ...DISTRIBUTOR, user: owner._id });
      console.log('✅ Added distributor:', DISTRIBUTOR.companyName);
    }

    let created = 0, skipped = 0;
    for (const med of MEDICINES) {
      const exists = await Product.findOne({
        productName: med.productName,
        batchNo: med.batchNo,
        user: owner._id
      });

      if (exists) {
        skipped++;
        console.log(`⏭️  Already exists: ${med.productName}`);
        continue;
      }

      const product = new Product({
        ...med,
        productCode: await generateProductCode(owner._id),
        user: owner._id
      });
      await product.save();
      created++;
      console.log(`✅ Added: ${med.productName} (${med.category}, ${med.type})`);
    }

    const total = await Product.countDocuments({ user: owner._id });
    console.log(`\n📦 Created: ${created} | Skipped: ${skipped} | Total products: ${total}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
})();
