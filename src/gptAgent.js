/* 

This class is a basic implementation of an AI agent, using OpenAI's API and models to manage my Magic: The Gathering card collection.
For the actual card collection management, I built a separate application. This application exposes an API for the usual CRUD operations. 

The agent uses a 2-step process: 

First, it helps the user find a specific Magic: The Gathering card.
It uses Scryfall's API to gather information about MTG cards and scryfall API outputs to ensure data validity. 
Once a specific card has been identified, the agent moves to step 2.

Second, the agent uses the collected details as inputs for my card collection tracker API. 
This API performs CRUD operations on my card collection database.

This implementation is stateless: We rely on message history as being passed in the POST request to (re)construct state, and control the workflow.

*/

const { OpenAI } = require('openai');
const { scryfallTool, singlecardTool, vectorStoreTool, fetchTrackerFunctions } = require("./tools.js");
const { toolExecutors } = require("./executors.js");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

// Get openAI API key from AWS secrets manager:
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
    // For running locally:
    openaiApiKey = process.env.OPENAI_API_KEY;
  }
}
let client = null;

// Instantiate the OpenAI client:
async function ensureOpenAIClient() {
  if (!openaiApiKey) {
    await initOpenAIApiKey();
  }
  if (!client) {
    client = new OpenAI({
      apiKey: openaiApiKey 
    });
  }
}

// Function to interpret the user's intent and classify which step of the process we need to execute:
async function classifyStep(userMessage, recentMessages = []) {
  await ensureOpenAIClient();
  const filteredMessages = recentMessages
    .filter(m =>
      m.role === 'user' ||
      m.role === 'assistant' ||
      m.type === 'function_call_output' ||
      m.type === 'function_call'
    );
  const transformedMessages = filteredMessages.map(m => {
    if (m.type === 'function_call_output') {
      // Transform function_call_output to OpenAI tool call format
      return {
        role: 'tool',
        tool_call_id: m.call_id,
        content: m.output
      };
    }
    if (m.type === 'function_call') {
      // Transform function_call to OpenAI tool call format
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: m.call_id,
          type: 'function',
          function: { name: m.name, arguments: m.arguments }
        }]
      };
    }
    return m;
  });

  //console.log("Classifying step with messages:", transformedMessages);

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
          You are an intent classifier for a 2-step process:
          1 = Determine card using scryfall_search tool and local_singlecard tools.
          2 = Perform operation on the determined card using tracker_tools.
          Rules:
          - You MUST use the local_singlecard tool result in the message history to determine if a card has been identified.
          - If there is NO local_singlecard tool message, the step to return is always 1.
          - If there is a local_singlecard tool message, AND the user wants to operate on that card, return 2.
          Output ONLY JSON like: {"step":1}
          `
      },
      ...transformedMessages,
      { role: "user", content: userMessage }
    ],
    temperature: 0
  });
try {
    return JSON.parse(response.choices[0].message.content).step;
  } catch {
    return 1;
  }
}

// Dynamically fetch tools for each step in workflow.
// Key = step number, value = array of tools to use
// For step 1, we use and local singlecard storage
// For step 2, we use the tracker tools fetched from the backend
async function getToolsForStep(step) {
  if (step === 1) {
    return [...scryfallTool, ...singlecardTool, ...vectorStoreTool];
  }
  if (step === 2) {
    return await fetchTrackerFunctions();
  }
}

// System prompt for each step:
// Key = Step number, value = system prompt content
const systemContentMap = {
  "1": `
    You are a helpful Magic: The Gathering search agent.
    Your goal is to help the user identify a specific and unique printing of a Magic: The Gathering card.
    You have access to file_search to help you find cards, and scryfall_search to which returns accurate and complete information to the user. 
    If scryfall_search returns no results, do not assume your file_search results are correct. Repeat the scryfall_search with different parameters.
    Once a specific set and number has been identified AND this entry exists in the last scryfall_search result, you MUST call the local_singlecard tool with that set code and collector number.
    
    Workflow:
    1. You are provided with user input. Use the file_search tool to find card information based on the user input. If there are no results or too many results to be useful, ask questions for clarification.
    2. Once you have limited the options and derived meaningful parameters for the scryfall_search tool, you MUST use the scryfall_search tool to find accurate possible set values and collector_number values for the potential matches.
    3. Scryfall_search tool results will be shown to the user, who will either confirm one of the options, or provide more details to narrow down the search, which means we repeat from step 1.
    4. Once a single scryfall_search result is identified, you MUST call the 'local_singlecard' tool using the 'set_code' and 'collector_number'.
    5. Ask the user what operation they wish to perform on the chosen card(add, remove, update quantity, etc.).

    Rules:
    - File_search has all data about all cards, but can not be used as an authoritative source. The authoritative source is scryfall_search.
    - Never assume, guess or fabricate: card names, card characteristics, card numbers, set codes or set names.
    - NEVER pass parameters to scryfall_search that have not explicitly been mentioned by the user in their input or previous messages.
    - Do not decide the card_number and set_code when calling local_singlecard yourself. You may not call local_singlecard without the parameter values existing in the last scryfall_search result.
    - You may include human-friendly text alongside structured results, but never make up information.
  `,
  "2": `
    You are a helpful Magic: The Gathering collection tracker agent.
    You will be provided with a single card in the message history, identified by a prior call to the local_singlecard tool.
    You can do CRUD operations on the collection using the information from that single card object: The set_code and collector_number.
    Rules:
    - You MUST inspect the last user messages to determine what operation to perform.
    - You MUST always use the tracker_tools to perform any collection operation. 
    - Never say you performed an action unless you have called the appropriate tracker tool and received a successful tool response.
    - If the user's intent is clear (for example, "add 2 foil copies of Ancient Tomb from Ultimate Masters"), IMMEDIATELY call the appropriate tracker tool without asking for confirmation or clarification.
    - If the user's intent is not clear, clarify with the user.
    - When you use tracker_createCard or tracker_updateCard, you MUST always include the "finishes" object. 
  `
};

/* Main agent function: 
- Classify the step
- Configure the step specific system prompt and tools
- Clean up the message history to minimize token usage
- Pass the relevant information to openAI
- Make sure all tool calls are executed and results are appended to the message history
- Pass the relevant information to openAI including the tool results
- Get the final assistant response and return it to the user
*/

async function sendMessage(userInput, incomingMessages) {
  console.log("\n\nReceived user input:", userInput);
  console.log("Received messages:", incomingMessages);
  await ensureOpenAIClient();
  incomingMessages = Array.isArray(incomingMessages) ? incomingMessages : [];
  // Step 1: Remove the details from scryfall if they exist.
  if (
    incomingMessages.length > 0 &&
    incomingMessages[incomingMessages.length - 1].role === "assistant" &&
    Array.isArray(incomingMessages[incomingMessages.length - 1].content) &&
    incomingMessages[incomingMessages.length - 1].content.every(obj => typeof obj === "object" && obj !== null)
  ) {
    incomingMessages.pop();
  }
  // Step 2: Remove the system message at index 0.
  if (incomingMessages.length > 0 && incomingMessages[0].role === "system") {
    incomingMessages.shift();
  }

  let intent = await classifyStep(userInput, incomingMessages);
  let tools = await getToolsForStep(intent);
  let systemContent = systemContentMap[intent] || "You are a helpful assistant.";
  
  console.log("Step:", intent);

  let messages = [
    { role: "system", content: systemContent },
    ...incomingMessages,
    { role: "user", content: userInput },
  ];
  // --- Initial assistant call using Responses API ---
  let response = await client.responses.create({
    model: "gpt-4o-mini",
    input: messages,
    tools: tools,
    tool_choice: "auto",
    temperature: 0.2,
  });

  console.log("Initial response:", response);

  let assistantMessage = response.output?.find(o => o.type === "message");
  if (assistantMessage) messages.push(assistantMessage);
  
  let functionCalls = response.output.filter(o => o.type === "function_call");
  while (functionCalls.length > 0) {
    let lastToolName = null;
    let lastScryfallResult = [];
    for (const fc of functionCalls) {
      messages.push(fc);
      const toolName = fc.name;
      lastToolName = fc.name;
      const args = fc.arguments ? JSON.parse(fc.arguments) : {};

      // Determine executor
      let executor;
      if (toolName.startsWith("tracker_")) {
        executor = toolExecutors["tracker_dynamic"];
      } else {
        executor = toolExecutors[toolName];
      }

      if (!executor) {
        console.log(`No executor found for tool: ${toolName}`);
        continue;
      }

      // Execute tool
      console.log(`Executing tool: ${toolName} with args:`, args);
      const result = toolName.startsWith("tracker_")
        ? await executor(toolName, args)
        : await executor(args);
      
      if (toolName === "scryfall_search" ) {
        // Remove previous scryfall_search function_call and function_call_output
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (
            ((m.type === "function_call" && m.name === "scryfall_search" && m.call_id !== fc.call_id) ||
            (m.type === "function_call_output" && m.call_id !== fc.call_id && messages.find(msg => msg.call_id === m.call_id && msg.name === "scryfall_search")))
          ) {
            messages.splice(i, 1);
          }
        }
        messages.push({
          call_id: fc.call_id,
          type: "function_call_output",
          output: JSON.stringify(result.summary)
        });
        lastScryfallResult = result;
      } else {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (
            ((m.type === "function_call" && m.name === fc.name && m.call_id !== fc.call_id) ||
            (m.type === "function_call_output" && m.call_id !== fc.call_id && messages.find(msg => msg.call_id === m.call_id && msg.name === fc.name)))
          ) {
            messages.splice(i, 1);
          }
        }
        messages.push({
          call_id: fc.call_id,
          type: "function_call_output",
          output: typeof result === "string" ? result : JSON.stringify(result)
        });
      }

      // Step-switch logic if needed
      if (toolName === "local_singlecard") {
        intent = 2;
        systemContent = systemContentMap[intent];
        tools = await getToolsForStep(intent);
      }
      console.log("Messages after tool executions:", messages);
    }

    // We have scryfall results for the user to pick from, so we do not call OpenAI yet.
    if (lastToolName === "scryfall_search" && Array.isArray(lastScryfallResult.summary) && lastScryfallResult.summary.length > 1) {
      messages.push({
          "role": "assistant",
          "content": lastScryfallResult.details
        });
      functionCalls = [];
    } else {
      const followup = await client.responses.create({
        model: "gpt-4o-mini",
        input: messages,
        tools: tools, 
        tool_choice: "auto",
        temperature: 0.2,
      });
      console.log("Follow-up response:", followup);

      // Extract assistant messages and next function calls
      const newAssistantMessages = followup.output.filter(o => o.type === "message");
      messages.push(...newAssistantMessages);
      functionCalls = followup.output.filter(o => o.type === "function_call");
    }
  }
  return { messages };
}


module.exports = { sendMessage};