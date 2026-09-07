const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const auth = require("../middleware/auth");

const router = express.Router();

// ✅ Signup Route
router.post("/signup", async (req, res) => {
  const { name, username, password, role } = req.body;

  try {
    let user = await User.findOne({ username });
    if (user) return res.status(400).json({ msg: "Username already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    user = new User({ name, username, password: hashedPassword, role });

    await user.save();
    res.json({ msg: "User registered successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// ✅ Login with Username & Password ONLY
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    // Trim the username — a trailing space typed into the login box was
    // reaching the query as "admin " and failing to match
    const user = await User.findOne({ username: String(username || "").trim() });
    if (!user) return res.status(400).json({ msg: "Invalid username or password" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid username or password" });

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "30d" });

    res.json({ token, user: { id: user.id, name: user.name, username: user.username, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// ✅ Get Current User (refresh hone par user wapis lane ke liye)
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ msg: "User not found" });
    res.json({ id: user.id, name: user.name, username: user.username, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

module.exports = router;
