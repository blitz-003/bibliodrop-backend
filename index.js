console.log("require type:", typeof require);
console.log("module type:", typeof module);

require("dotenv").config();

const requireAuth = require("./middleware/requireAuth.js");
const requireRole = require("./middleware/requireRole.js");

console.log(typeof requireAuth);
console.log(typeof requireRole);

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");
const app = express();

app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "biblio_drop/books",
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      },
    );

    streamifier.createReadStream(buffer).pipe(stream);
  });
}

const Book = require("./models/book.model");

app.get("/", (req, res) => {
  res.send("BiblioDrop Backend Running");
});

app.get("/books", async (req, res) => {
  try {
    const { search, category, available } = req.query;

    let query = {};

    //  Search by title (case-insensitive)
    if (search) {
      query.title = { $regex: search, $options: "i" };
    }

    // Category filter
    if (category) {
      query.category = category;
    }

    // Availability filter (convert string → boolean)
    if (available !== undefined) {
      query.available = available === "true";
    }

    const books = await Book.find(query);

    res.json(books);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/books/:id", async (req, res) => {
  console.log(req.params.id);
  try {
    const book = await Book.findById(req.params.id);

    if (!book) {
      return res.status(404).json({ message: "Book not found" });
    }

    res.json(book);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/books/:id", async (req, res) => {
  try {
    const deleted = await Book.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ message: "Book not found" });
    }

    res.json({ message: "Book deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(
  "/books",
  requireAuth,
  requireRole("librarian"), // IMPORTANT (must run before route)
  upload.single("coverImage"),
  async (req, res) => {
    try {
      // 1. file check
      const file = req.file;

      if (!file) {
        return res.status(400).json({
          message: "Cover image is required",
        });
      }

      // 2. upload to cloudinary
      const uploadResult = await uploadToCloudinary(file.buffer);

      // 3. get authenticated user (from middleware)
      const user = req.user;

      if (!user) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      // 4. build book object safely
      const book = {
        title: req.body.title,
        author: req.body.author,
        description: req.body.description,
        category: req.body.category,

        coverImage: uploadResult.secure_url,

        // optional numeric field
        deliveryFee: req.body.deliveryFee ? Number(req.body.deliveryFee) : 0,

        // default system fields
        availabilityStatus: req.body.availabilityStatus || "available",
        publishStatus: req.body.publishStatus || "published",

        // ✅ FIXED: from authenticated user (NOT req.body)
        ownerId: user.id,
        ownerName: user.name,
        ownerEmail: user.email,

        // default rating system
        totalReviews: 0,
        averageRating: 0,
      };

      // 5. save
      const savedBook = await Book.create(book);

      res.status(201).json(savedBook);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

app.get(
  "/dashboard/inventory",
  requireAuth,
  requireRole("librarian"),
  async (req, res) => {
    try {
      const user = req.user;

      // 📦 get only books created by this librarian
      const books = await Book.find({
        createdBy: user._id,
      }).sort({ createdAt: -1 });

      // 🧠 optional: compute stock fields safely
      const formatted = books.map((b) => ({
        _id: b._id,
        title: b.title,
        category: b.category,
        coverImage: b.coverImage,

        deliveryFee: b.deliveryFee,

        availabilityStatus: b.availabilityStatus,

        // if you don’t have stock system yet, fallback safely
        totalCopies: b.totalCopies || 0,
        stock: b.stock || 0,

        createdAt: b.createdAt,
      }));

      return res.status(200).json(formatted);
    } catch (err) {
      return res.status(500).json({
        message: err.message,
      });
    }
  },
);

async function main() {
  try {
    await mongoose.connect(process.env.DB_URL);

    console.log("MongoDB Connected");

    app.listen(process.env.PORT, () => {
      console.log(`Server running on port ${process.env.PORT}`);
    });
  } catch (err) {
    console.log(err);
  }
}

main();
