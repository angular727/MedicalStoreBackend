require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bodyParser = require("body-parser");

// Routes
const authRoutes = require("./routes/auth");
const supplierRoutes = require("./routes/supplier");
const productRoutes = require("./routes/product");

const app = express();

// ✅ Open CORS — allow requests from any origin
app.use(cors()); // ⚠️ Public access — frontend kahin se bhi request kar sakta

app.use(bodyParser.json());

// ---------- MongoDB Connection (cached for serverless, race-condition safe) ----------
let cachedConnection = null;

async function connectDB() {
  // Agar already connected hai, foran return karo
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  // Agar connection process already chal raha hai, usi promise ka wait karo
  if (cachedConnection) {
    return cachedConnection;
  }

  cachedConnection = mongoose
    .connect(process.env.MONGO_URI, {
      bufferCommands: false,
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 10,
    })
    .then((conn) => {
      console.log("✅ MongoDB Connected...!");
      return conn;
    })
    .catch((err) => {
      console.log("❌ MongoDB Error:", err);
      cachedConnection = null; // reset so next request can retry
      throw err;
    });

  return cachedConnection;
}

// ---------- Temporary diagnostic ----------
// Reports the SHAPE of MONGO_URI, never the secret itself, so a mismatch
// between the local .env and the deployed environment can be pinpointed.
// Sits above the connect middleware so it answers even when the DB is down.
// Remove once the deployment is confirmed working.
app.get("/api/_diag", (req, res) => {
  const crypto = require("crypto");
  const uri = process.env.MONGO_URI;
  if (!uri) return res.json({ mongoUri: "MISSING", jwtSecretSet: !!process.env.JWT_SECRET });

  const m = uri.match(/^mongodb(\+srv)?:\/\/([^:]+):([^@]+)@([^/?]+)\/([^?]*)/);
  if (!m) {
    return res.json({ mongoUri: "UNPARSEABLE", length: uri.length, startsWith: uri.slice(0, 20) });
  }

  const pwd = m[3];
  res.json({
    length: uri.length,
    srv: !!m[1],
    username: m[2],
    passwordLength: pwd.length,
    // Hash, not the password — lets us compare against local without exposing it
    passwordSha256: crypto.createHash("sha256").update(pwd).digest("hex").slice(0, 12),
    host: m[4],
    database: m[5] || "(none)",
    hasWhitespace: /\s/.test(uri),
    jwtSecretSet: !!process.env.JWT_SECRET
  });
});

// Har request se pehle connection guaranteed complete honi chahiye
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    return res.status(503).json({ error: "Database connection failed. Try again." });
  }
});

// Test Route
app.get("/api/status", (req, res) => {
  res.json({ status: "true" });
});

// Main Routes
app.use("/api/auth", authRoutes);
app.use("/api/supplier", require("./routes/supplier"));
app.use("/api/purchase", require("./routes/purchase"));
app.use("/api/product", productRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customer", require("./routes/customer"));
app.use("/api/sale", require("./routes/sale"));
app.use("/api/sale-return", require("./routes/saleReturn"));
app.use("/api/purchase-return", require("./routes/purchaseReturn"));
app.use("/api/filter", require("./routes/filter"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/repair", require("./routes/repair"));

// Local server
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  connectDB().then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running locally at http://localhost:${PORT}`);
    });
  });
}

// For Vercel
module.exports = app;