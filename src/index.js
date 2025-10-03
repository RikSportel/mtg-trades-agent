const express = require('express');
const axios = require('axios');
const cors = require('cors');
const gptAgent = require('./gptAgent');
const app = express();
// Allowed origins (prod + local dev)
const allowedOrigins = [
  "https://mttgagent.rikspor.tel",
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
    const agent = gptAgent(); // Call useAgent to get the agent object
    // Pass both message and messages to sendMessage
    const updatedMessages = await agent.sendMessage(message, messages);
    res.json({ messages: updatedMessages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// app.listen(port, () => {
//   console.log(`Server is running on port ${port}`);
// });

module.exports = app;
