const express = require('express');
const axios = require('axios');
const cors = require('cors');
const gptAgent = require('./gptAgent');
const app = express();
app.use(cors());
app.use(express.json());
app.options('*', cors()); // Enable pre-flight for all routes
app.use((err, req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://mtgagent.rikspor.tel");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "OPTIONS,POST,GET");
  res.status(err.status || 500).json({ error: err.message });
});
const port = 8080;

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.post('/', async (req, res) => {
  try { 
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Missing message in request body' });
    }
    const agent = gptAgent(); // Call useAgent to get the agent object
    const response = await agent.sendMessage(message);
    res.json({ result: response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
