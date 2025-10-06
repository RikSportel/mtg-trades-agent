const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { sendMessage } = require('./gptAgent');
const app = express();
// Allowed origins (prod + local dev)
const allowedOrigins = [
  "https://mtgagent.rikspor.tel",
  "http://localhost:3000"
];

// Configure CORS middleware
app.use(cors({
  origin: (origin, callback) => {
    // If no origin (like curl or Postman) allow it
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["Content-Length", "Content-Range"],
  maxAge: 3600
}));
app.use(express.json());

const port = 8080;

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.post('/', async (req, res) => {
  try { 
    const { message, messages } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Missing message in request body' });
    }
    
    const updatedMessages = await sendMessage(message, messages);
    res.json({ messages: updatedMessages.messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// app.listen(port, () => {
if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
  // Running in AWS Lambda, do not start server
} else {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}
// });

module.exports = app;
