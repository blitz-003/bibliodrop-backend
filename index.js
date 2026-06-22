require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");
const app = express();

app.use(cors());
app.use(express.json());

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
    const books = await Book.find();
    res.json(books);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/books/:id", async (req, res) => {
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

// app.post("/books", upload.any(), (req, res) => {
//   console.log(req.files);
//   res.send("OK");
// });
app.post("/books", upload.single("image"), async (req, res) => {
  try {
    // 1. get file from request
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        message: "Image is required",
      });
    }

    // 2. upload to cloudinary
    const uploadResult = await uploadToCloudinary(file.buffer);

    // 3. build book object
    const book = {
      title: req.body.title,
      author: req.body.author,
      description: req.body.description,
      category: req.body.category,
      deliveryFee: Number(req.body.deliveryFee),
      coverImage: uploadResult.secure_url,
    };

    // 4. save to MongoDB
    const savedBook = await Book.create(book);

    res.status(201).json(savedBook);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

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
