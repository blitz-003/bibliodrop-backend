require("dotenv").config();

const requireAuth = require("./middleware/requireAuth.js");
const requireRole = require("./middleware/requireRole.js");

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Transaction = require("./models/Transaction");

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

// B. STRIPE WEBHOOK ENDPOINT (Must sit BEFORE express.json())
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error(`Webhook Signature Verification Failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle successful checkouts
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { bookId, userId } = session.metadata;

      try {
        // 1. Log payment into the transactions log
        const newTransaction = await Transaction.create({
          stripeSessionId: session.id,
          bookId,
          userId,
          amountPaid: session.amount_total / 100,
          currency: session.currency,
          status: "completed",
        });

        // Fetch the book title and user details from DB or session context
        const bookDetails = await Book.findById(bookId);

        // 2. Create the Delivery document automatically starting as "pending"
        await Delivery.create({
          transactionId: newTransaction._id,
          stripeSessionId: session.id,
          bookId,
          bookTitle: bookDetails ? bookDetails.title : "Unknown Book",
          userId: userId,
          userName: session.customer_details?.name || "Client", // Extracted from Stripe billing checkout
          deliveryFee: session.amount_total / 100,
          status: "pending",
        });

        // 3. Decrement stock
        await Book.findByIdAndUpdate(bookId, {
          $inc: { availableStock: -1 },
        });

        console.log(
          `Fulfillment and delivery document instantiated for Book: ${bookId}`,
        );
      } catch (dbErr) {
        console.error("Database update error during webhook process:", dbErr);
        return res.status(500).send("Internal Database Update Error");
      }
    }

    res.status(200).json({ received: true });
  },
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const Delivery = require("./models/Delivery");

// A. USER: Get delivery history logs
app.get("/deliveries/history", requireAuth, async (req, res) => {
  try {
    const userDeliveries = await Delivery.find({ userId: req.user.id }).sort({
      createdAt: -1,
    });
    res.json(userDeliveries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B. LIBRARIAN: Fetch all deliveries across system queue lines
app.get(
  "/deliveries/manage",
  requireAuth,
  requireRole("librarian"),
  async (req, res) => {
    try {
      const queue = await Delivery.find().sort({ createdAt: -1 });
      res.json(queue);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// C. LIBRARIAN: Update Fulfillment State Machine (Pending -> Dispatched -> Delivered)
app.patch(
  "/deliveries/:id/status",
  requireAuth,
  requireRole("librarian"),
  async (req, res) => {
    try {
      const { status } = req.body;
      if (!["dispatched", "delivered"].includes(status)) {
        return res
          .status(400)
          .json({ message: "Invalid workflow state sequence." });
      }

      const updatedDelivery = await Delivery.findByIdAndUpdate(
        req.params.id,
        { status, updatedAt: new Date() },
        { new: true },
      );

      res.json(updatedDelivery);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// A. USER: Get delivery history logs
app.get("/deliveries/history", requireAuth, async (req, res) => {
  try {
    const userDeliveries = await Delivery.find({ userId: req.user.id }).sort({
      createdAt: -1,
    });
    res.json(userDeliveries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B. LIBRARIAN: Fetch all deliveries across system queue lines
app.get(
  "/deliveries/manage",
  requireAuth,
  requireRole("librarian"),
  async (req, res) => {
    try {
      const queue = await Delivery.find().sort({ createdAt: -1 });
      res.json(queue);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// C. LIBRARIAN: Update Fulfillment State Machine (Pending -> Dispatched -> Delivered)
app.patch(
  "/deliveries/:id/status",
  requireAuth,
  requireRole("librarian"),
  async (req, res) => {
    try {
      const { status } = req.body;
      if (!["dispatched", "delivered"].includes(status)) {
        return res
          .status(400)
          .json({ message: "Invalid workflow state sequence." });
      }

      const updatedDelivery = await Delivery.findByIdAndUpdate(
        req.params.id,
        { status, updatedAt: new Date() },
        { new: true },
      );

      res.json(updatedDelivery);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);
app.post("/create-checkout-session", requireAuth, async (req, res) => {
  try {
    const { bookId, title, deliveryFee, coverImage } = req.body;
    const userId = req.user.id; // Pulled from your authentication middleware validation

    // Stripe expects values in the smallest currency denomination (cents)
    const amountInCents = Math.round(Number(deliveryFee) * 100);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Delivery Fee: ${title}`,
              images: [coverImage],
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: {
        bookId,
        userId,
      },
      success_url: `http://localhost:3000/dashboard/payment/success`,
      cancel_url: `http://localhost:3000/dashboard/payment/cancel`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Checkout generation crashed:", err);
    res.status(500).json({ error: err.message });
  }
});
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

    query.publishStatus = "approved";

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
    console.log(book);

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

app.get(
  "/adminApproval",
  requireAuth,
  requireRole("admin"), // Ensures only admins can see this list
  async (req, res) => {
    try {
      console.log("backend here");
      // Find all books where publishStatus matches "pending"
      const pendingBooks = await Book.find({ publishStatus: "pending" }).sort({
        createdAt: 1,
      }); // Oldest pending items first

      // Return the array of books
      res.status(200).json(pendingBooks);
    } catch (err) {
      console.error("Error fetching approval books:", err);
      res.status(500).json({
        error: "Failed to fetch pending books",
        details: err.message,
      });
    }
  },
);

app.patch(
  "/books/:bookId/status", // Matches your frontend URL parameter exactly
  requireAuth,
  requireRole("admin"), // Protects this route so only admins can execute approvals
  async (req, res) => {
    try {
      const { bookId } = req.params;
      const { publishStatus } = req.body;

      // 1. Validation Check
      if (!["approved", "rejected"].includes(publishStatus)) {
        return res.status(400).json({
          message: "Invalid status value. Must be 'approved' or 'rejected'.",
        });
      }

      // 2. Database Update
      // Swapping findByIdAndUpdate's target property to match 'publishStatus'
      const updatedBook = await Book.findByIdAndUpdate(
        bookId,
        {
          publishStatus: publishStatus,
          updatedAt: new Date(),
        },
        { new: true }, // Returns the newly updated book document
      );

      // 3. Fallback check if ID is invalid or missing
      if (!updatedBook) {
        return res.status(404).json({ message: "Target book not found" });
      }

      // 4. Return the updated document back to your frontend TanStack mutation
      res.status(200).json(updatedBook);
    } catch (err) {
      console.error("Error updating book publication status:", err);
      res.status(500).json({
        error: "Internal server error while updating status",
        details: err.message,
      });
    }
  },
);

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

      const bookData = {
        title: req.body.title,
        author: req.body.author,
        description: req.body.description,
        category: req.body.category,

        coverImage: uploadResult.secure_url,

        deliveryFee: Number(req.body.deliveryFee),

        totalStock: Number(req.body.stock),
        availableStock: Number(req.body.stock),

        publishStatus: "pending",
        deliveryStatus: "available",

        ownerId: user.id,
        ownerName: user.name,
        ownerEmail: user.email,

        totalReviews: 0,
        averageRating: 0,

        createdAt: new Date(),
        updatedAt: new Date(),
      };

      console.log("okay upto here");

      const savedBook = await Book.create(bookData);

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

      // get only books created by this librarian
      const books = await Book.find({
        createdBy: user._id,
      }).sort({ createdAt: -1 });

      //  optional: compute stock fields safely
      // const formatted = books.map((b) => ({
      //   _id: b._id,
      //   title: b.title,
      //   category: b.category,
      //   coverImage: b.coverImage,

      //   deliveryFee: b.deliveryFee,

      //   availabilityStatus: b.availabilityStatus,

      //   // if you don’t have stock system yet, fallback safely
      //   totalCopies: b.totalCopies || 0,
      //   stock: b.stock || 0,

      //   createdAt: b.createdAt,
      // }));

      return res.status(200).json(books);
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
