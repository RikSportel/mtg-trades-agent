const { OpenAI } = require('openai');
const { scryfallTool, singlecardTool, fetchTrackerFunctions } = require("./tools.js");
const { scryfallSearch, storeSingleCard, toolExecutors } = require("./executors.js");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

// OpenAI agent using REACT_APP_OPENAI_KEY from env vars
// Fetch OpenAI API key from AWS Secrets Manager using ARN from env var
let openaiApiKey = null;
async function initOpenAIApiKey() {
  if (process.env.OPENAI_API_KEY_SECRET_ARN) {
    const secretsClient = new SecretsManagerClient({});
    const secretCommand = new GetSecretValueCommand({
      SecretId: process.env.OPENAI_API_KEY_SECRET_ARN
    });
    const secretResponse = await secretsClient.send(secretCommand);
    openaiApiKey = secretResponse.SecretString;
  } else {
    openaiApiKey = process.env.REACT_APP_OPENAI_KEY;
  }
}
let client = null;

async function ensureOpenAIClient() {
  if (!openaiApiKey) {
    await initOpenAIApiKey();
  }
  if (!client) {
    client = new OpenAI({
      apiKey: openaiApiKey // ⚠️ don’t expose in production
      // only for dev; better to proxy via backend
    });
  }
}

function useAgent() {
  const systemContent = `
  You are a helpful Magic: The Gathering agent.
  Always narrow down searches until a single printing is found.
  You are NOT allowed to decide the printing yourself. If there are multiple results in the scryfall data, you MUST ask the user to clarify.
  Once you have narrowed down to a single printing, you MUST call the local_singlecard tool.
  After that, you MUST use the tracker tools to manage the collection. 
  You can do CRUD operations on the card in the collection. Find out the users intent and execute the appropriate tracker tool.
  Clarify with the user if the intent is not clear. When the intent is known, you can proceed to call the appropriate tracker tool.
  `;
  let messages = [
    { role: "system", content: systemContent }
  ];
  let singleCardInfo = null;
  async function sendMessage(userInput, incomingMessages) {
    await ensureOpenAIClient();
    const allTools = [...scryfallTool, ...singlecardTool];
    const trackerTools = await fetchTrackerFunctions();
    // Use incomingMessages if provided, otherwise start with local messages
    let newMessages = Array.isArray(incomingMessages) ? [...incomingMessages, { role: "user", content: userInput }] : [...messages, { role: "user", content: userInput }];
    messages = newMessages;

    let response;
    let msg;

    if (!singleCardInfo) {
      while (true) {
        // Limit history to last 10 messages
        if (newMessages.length > 10) {
          newMessages = newMessages.slice(newMessages.length - 10);
        }

        // Keep only the latest scryfall_search tool response
        let lastScryfallIndex = -1;
        for (let i = newMessages.length - 1; i >= 0; i--) {
          const m = newMessages[i];
          if (m.role === "tool" && m.content && m.tool_call_id && m.content.includes('"object":"list"')) {
            lastScryfallIndex = i;
            break;
          }
        }
        if (lastScryfallIndex !== -1) {
          newMessages = [
            ...newMessages.slice(0, lastScryfallIndex),
            newMessages[lastScryfallIndex],
            ...newMessages.slice(lastScryfallIndex + 1).filter(m => m.role !== "tool" || !m.content.includes('"object":"list"'))
          ];
        }

        response = await client.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: newMessages,
          tools: allTools,
          tool_choice: "auto"
        });
        msg = response.choices[0].message;

        if (!msg.tool_calls) break;

        const toolResponses = [];
        for (const toolCall of msg.tool_calls) {
          const fnName = toolCall.function.name;
          const fnArgs = JSON.parse(toolCall.function.arguments);
          console.log("Tool call:", fnName, fnArgs);
          let result;
          if (fnName === "local_singlecard") {
            const cardInfo = storeSingleCard(fnArgs);
            singleCardInfo = cardInfo;
            result = cardInfo;
          } else if (fnName === "scryfall_search") {
            result = await scryfallSearch(fnArgs);
            console.log("Scryfall search result:", result);
          }
          toolResponses.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        }

        // Add tool responses to message history
        newMessages = [
          ...newMessages,
          msg, // model's tool request
          ...toolResponses
        ];
        messages = newMessages;
      }
    }

    // If singleCardInfo was just set, start tracker tool loop automatically
    if (singleCardInfo) {
      while (true) {
        if (newMessages.length > 10) {
          newMessages = newMessages.slice(newMessages.length - 10);
          console.log("Trimmed messages for length" + newMessages);
        }
        // Remove orphaned tool message at index 0 if present
        while (newMessages.length > 0 && newMessages[0].role === "tool") {
          newMessages = newMessages.slice(1);
          console.log("Removed orphaned tool message at index 0");
        }

        response = await client.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: newMessages,
          tools: trackerTools,
          tool_choice: "auto"
        });
        msg = response.choices[0].message;

        if (!msg.tool_calls) {
          // Final assistant reply, append and exit loop
          newMessages = [...newMessages, msg];
          messages = newMessages;
          break;
        }

        // Collect all tool responses
        const toolResponses = [];
        for (const toolCall of msg.tool_calls) {
          const fnName = toolCall.function.name;
          const fnArgs = JSON.parse(toolCall.function.arguments);
          let result;
          if (fnName.startsWith("tracker_")) {
            const execFn = toolExecutors["tracker_dynamic"];
            result = await execFn(fnName, fnArgs);
          }
          toolResponses.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
          console.log("ToolResponse:", toolResponses[toolResponses.length - 1]);
        }

        // Only append tool responses after assistant with tool_calls
        const lastAssistantIndex = newMessages.map(m => m.role).lastIndexOf("assistant");
        newMessages = [
          ...newMessages.slice(0, lastAssistantIndex + 1),
          msg, // assistant with tool_calls
          ...toolResponses
        ];
        messages = newMessages;
      }
    }

    messages = [...messages, msg];
  return messages;
  }

  return { messages, sendMessage };
}

module.exports = useAgent;