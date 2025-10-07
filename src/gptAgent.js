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
      ...recentMessages,
      { role: "user", content: userMessage }
    ],
    temperature: 0
  });
try {
    return JSON.parse(response.choices[0].message.content).step;
  } catch {
    return 1; // fallback default
  }
}

// Dynamically fetch tools for each step in workflow.
// Key = step number, value = array of tools to use
// For step 1, we use scryfall search and local singlecard storage
// For step 2, we use the tracker tools fetched from the backend
async function getToolsForStep(step) {
  if (step === 1) {
    // Return scryfall_search and local_singlecard tools only for step 1
    return [...scryfallTool, ...singlecardTool, ...vectorStoreTool];
  }
  if (step === 2) {
    // Dynamically fetch tracker tools for step 2
    return await fetchTrackerFunctions();
  }
}

// Key = Step number, value = system prompt content
const systemContentMap = {
  "1": `
    You are a helpful Magic: The Gathering search agent.
    You will use the scryfall_search tool to find possible card printings based on user input.
    This tool returns an array of set_code and collector_number objects. Information about these objects is found using vector_store_search.
    You then follow up with questions to the user to narrow down the search results to a single printing.
    Always narrow down searches until a single printing is found.
    You are NOT allowed to decide the printing yourself. If there are multiple results in the tool results data, you MUST ask the user to clarify.
    Once you have narrowed down to a single printing, you MUST call the local_singlecard tool using the set_code and collector_number from the scryfall data.
    Once the local_singlecard tool has been called, you MUST ask the user about what operations they wish to perform on that card in relation to their collection:
    Add, remove, update quantity, check if there are already foil or non-foil copies in the collection, etc.
  `,
  "2": `
    You are a helpful Magic: The Gathering collection tracker agent.
    You will be provided with a single card printing in the message history, identified by a prior call to the local_singlecard tool.
    You can do CRUD operations on the collection using the information from that single card.
    Rules:
    - You MUST inspect the last user message to determine what operation to perform.
    - You MUST always use the tracker_tools to perform any collection operation. 
    - Never say you performed an action unless you have called the appropriate tracker tool and received a successful tool response.
    - If the user's intent is clear (for example, "add 2 foil copies of Ancient Tomb from Ultimate Masters"), IMMEDIATELY call the appropriate tracker tool without asking for confirmation or clarification.
    - If the user's intent is not clear, clarify with the user.
    - When you use tracker_createCard or tracker_updateCard, you MUST always include the "amount" field. 
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
  await ensureOpenAIClient();
  incomingMessages = Array.isArray(incomingMessages) ? incomingMessages : [];

  // Step 1: classify workflow step
  let intent = await classifyStep(userInput, incomingMessages);
  let tools = await getToolsForStep(intent);
  let systemContent = systemContentMap[intent] || "You are a helpful assistant.";

  console.log("Step:", intent);
  console.log("Using tools:", tools.map(t => t.name));
  console.log("System prompt:", systemContent);
  console.log("Last user input:", userInput);

  // --- Clean message history to minimize tokens ---
  const nonSystem = incomingMessages.filter(m => m.role !== 'system');
  const lastUsers = nonSystem.filter(m => m.role === 'user').slice(-3);
  const lastAssistants = nonSystem.filter(m => m.role === 'assistant' && !m.tool_calls).slice(-3);

  let lastLocalIdx = -1;
  let lastScryfallIdx = -1;

  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const m = nonSystem[i];
    if (m.role === 'assistant' && m.tool_calls) {
      if (m.tool_calls.find(tc => tc.function.name === 'local_singlecard')) lastLocalIdx = i;
      if (m.tool_calls.find(tc => tc.function.name === 'scryfall_search')) lastScryfallIdx = i;
    }
  }

  const preservedSet = new Set([...lastUsers, ...lastAssistants]);

  if (lastLocalIdx >= 0) {
    preservedSet.add(nonSystem[lastLocalIdx]);
    if (nonSystem[lastLocalIdx + 1]?.role === 'tool') preservedSet.add(nonSystem[lastLocalIdx + 1]);
  }

  if (lastLocalIdx < 0 && lastScryfallIdx >= 0) {
    preservedSet.add(nonSystem[lastScryfallIdx]);
    if (nonSystem[lastScryfallIdx + 1]?.role === 'tool') preservedSet.add(nonSystem[lastScryfallIdx + 1]);
  }

  const preservedMessages = nonSystem.filter(m => preservedSet.has(m));
  console.log("Preserved messages:", preservedMessages);

  // --- Initial assistant call using Responses API ---
  let response = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: systemContent },
      ...preservedMessages,
      { role: "user", content: userInput }
    ],
    tools: tools,
    tool_choice: "auto",
    temperature: 0.2,
  });

  console.log("Initial response:", response);

  let messages = [
    { role: "system", content: systemContent },
    ...preservedMessages,
    { role: "user", content: userInput },
  ];
  let assistantMessage = response.output?.find(o => o.type === "message");
  if (assistantMessage) messages.push(assistantMessage);

  console.log("Initial assistant message:", assistantMessage);
  // Filter for tool calls (function_call type)
  let functionCalls = response.output.filter(o => o.type === "function_call");
  messages.push(...functionCalls);
  while (functionCalls.length > 0) {
    const toolResponses = [];

    for (const fc of functionCalls) {
      const toolName = fc.name;
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
      const result = toolName.startsWith("tracker_")
        ? await executor(toolName, args)
        : await executor(args);

      messages.push({
        call_id: fc.call_id,
        type: "function_call_output",
        output: typeof result === "string" ? result : JSON.stringify(result)
      });

      // Step-switch logic if needed
      if (toolName === "local_singlecard") {
        intent = 2;
        // Optional: prune previous messages
        // messages = [
        //   { role: "system", content: systemContent },
        //   ...messages.filter(m => m.role === "user").slice(-1),
        //   ...messages.filter(m => m.role === "assistant").slice(-1),
        // ];
      }
    }
    console.log("Messages after tool executions:", messages);

    // Call OpenAI again with updated messages
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

  return { messages };
}


module.exports = { sendMessage};