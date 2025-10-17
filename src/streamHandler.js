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
const { scryfallTool, vectorStoreTool, fetchTrackerFunctions } = require("./tools.js");
const { toolExecutors } = require("./executors.js");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
//const fs = require('fs');

/* HELPER FUNCTIONS */

// Get openAI API key:
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
    // When running locally, we just use the environment variable:
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

// Interpret the user's intent and classify which step of the process we need to execute:
// async function classifyStep(userMessage, recentMessages = []) {
//   await ensureOpenAIClient();
//   const filteredMessages = recentMessages
//     .filter(m =>
//       m.role === 'user' ||
//       m.role === 'assistant' ||
//       m.type === 'function_call_output' ||
//       m.type === 'function_call'
//     );
//   // This transformation is needed to use completions API instead of responses API.
//   const transformedMessages = filteredMessages.map(m => {
//     if (m.type === 'function_call_output') {
//       return {
//         role: 'tool',
//         tool_call_id: m.call_id,
//         content: m.output
//       };
//     }
//     if (m.type === 'function_call') {
//       return {
//         role: 'assistant',
//         content: null,
//         tool_calls: [{
//           id: m.call_id,
//           type: 'function',
//           function: { name: m.name, arguments: m.arguments }
//         }]
//       };
//     }
//     return m;
//   });
//   // Do the actual classification:
//   const response = await client.chat.completions.create({
//     model: "gpt-4o-mini",
//     messages: [
//       {
//         role: "system",
//         content: `
//           You are an intent classifier for a 2-step process:
//           1 = Determine card using scryfall_search tool and local_singlecard tools.
//           2 = Perform operation on the determined card using tracker_tools.
//           Rules:
//           - You MUST use the scryfall_search tool result in the message history to determine if one or more card has been identified.
//           - If the user is talking about cards that do not exist in the last scryfall_search result, return 1.
//           - If the user describes operations on cards (add, create, delete, update, etc.) return 2.
//           Output ONLY JSON like: {"step":1}
//           `
//       },
//       ...transformedMessages,
//       { role: "user", content: userMessage }
//     ],
//     temperature: 0
//   });
// try {
//     return JSON.parse(response.choices[0].message.content).step;
//   } catch {
//     return 1;
//   }
// }

// Fetch tools for each step in workflow.
// Key = step number, value = array of tools to use
// For step 1, we use and local singlecard storage
// For step 2, we use the tracker tools fetched from the backend
async function getTools( toolset ) {
  if ( toolset === 'search' ) {
    return [...scryfallTool, ...vectorStoreTool];
  }
  if ( toolset === 'full' ) {
    const trackerTools = await fetchTrackerFunctions();
    return [...scryfallTool, ...vectorStoreTool, ...trackerTools];
  }
}

// System prompt for each step:
// Key = Step number, value = system prompt content
const systemContentMap = {
  "1": `
    You are a helpful Magic: The Gathering assistant: You can help the user find cards, interactions and combos, answer rules questions, and manage their collection. 
    For **searching cards**, your goal is to help the user identify specific and unique printings of Magic: The Gathering cards, and manage their collection in relation to these cards.

    You have access to the following tools:
    - file_search: There are separate vector stores for various contexts: You have access to all rules information (Authoritative), and all important card details (Non-authoritative, use scryfall_search to confirm).
    - scryfall_search: the authoritative source for ACCURATE and COMPLETE information about cards.
    - tracker_*: tool that allow you to manage and get information on the user's card collection.
    
    ### Workflow:
    1. Upon receiving user input, determine if the user is asking a generic queestion, looking for cards outside of the collection, or about cards inside the collection.
    2. If the user is talking about these cards in relation to their collection, you MUST use tracker_getAllCards or tracker_getCard tools to verify if the user has these cards.
    3. Do not announce this to the user - Simply call the tools. Ask for clarification if the results are too broad (more than 20 results)
    4. **ALWAYS** ensure a scryfall_search to get ACCURATE and COMPLETE card data before using other tracker_* tools: The result consists of accurate collector numbers and set codes to use when calling tracker_ tools.
    5. If scryfall_search returns no results, do **not** assume file_search is correct. Retry scryfall_search with modified parameters.
    6. Scryfall_search results are presented to the user for confirmation or refinement; This step does not involve you directly. If the user wants to narrow the search, repeat the process starting from step 1.
    7. Once one or more cards from the scryfall_search results are clearly identified, **use the appropriate tracker_* tool(s)** to perform the requested operations (add, remove, update, etc.).
   
    ### Rules for searching cards:
    - File_search has all data about all cards, but is **NEVER AUTHORITATIVE** and functions as a reference to help interpret user input. 
    - Scryfall_search is the **ONLY** authoritative source of card data.
    - The tracker_getAllCards and tracker_getCard tools are **AUTHORITATIVE** for the user's collection contents. They key under which they are stored consists of setcode:cardnumber.
    - **NEVER assume, guess or fabricate:** card names, card characteristics, card numbers, set codes or set names.
    - **NEVER** pass parameters to scryfall_search that have not explicitly been mentioned by the user in their input or previous messages.
    - You may include human-friendly text alongside structured results, but never make up information.
    - When the user asks about one specific card in their collection, you must use include all details you have about the card in your response, including finishes, conditions, notes, etc.
    
    ### Rules for using tools with the tracker_ prefix:
    - You MUST inspect the last user messages to determine what operations to perform.
    - You MUST always use the tracker_tools to perform any collection operation. 
    - **NEVER** say you performed an action unless you have called the appropriate tracker tool and received a successful tool response.
    - If the user's intent is clear (for example, "add 2 foil copies of Ancient Tomb from Ultimate Masters"), IMMEDIATELY call the appropriate tracker tool without asking for confirmation or clarification.
    - If the user's intent is not clear, clarify with the user.
    - When you use tracker_createCard or tracker_updateCard, you MUST always include the "finishes" object. This also applies to calling tracker_batch with create or update operations included.
    - **NEVER** decide the card_number(s) and set_code(s) yourself when dealing with the tracker_* tools. 
      Setcode and cardnumber MUST come from scryfall_search results when making tracker_createCard or tracker_batch (with create operations included) function calls.  
      Setcode and cardnumber MUST come from tracker_getAllCards results when making tracker_delete or tracker_update function calls. 

    ### Behavioral rules:
    - Do **not** say "I will use my tools" or "I plan to search." Instead, call the tool directly.
    - Respond conversationally only when clarifying, summarizing, or confirming final results.
    - After using a tracker_* tool, you MUST return the result to the user. 
    - When you have sufficient data to act, act immediately.    
   `//,
  // "2": `
  //   You are a helpful Magic: The Gathering collection tracker agent.
  //   You will be provided with card information in the message history, identified by prior calls to the scryfall_search tool and the user messages.
  //   You can do CRUD operations on the collection using the information from a single card: The setCode and cardNumber.
  //   You also have a batch endpoint to allow for orchestrating multiple operations in one function_call. Cards passed to this operation MUST exist by card number and set code in the last scryfall_search result.
  //   Rules:
  //   - You MUST inspect the last user messages to determine what operation to perform.
  //   - You MUST always use the tracker_tools to perform any collection operation. 
  //   - Never say you performed an action unless you have called the appropriate tracker tool and received a successful tool response.
  //   - If the user's intent is clear (for example, "add 2 foil copies of Ancient Tomb from Ultimate Masters"), IMMEDIATELY call the appropriate tracker tool without asking for confirmation or clarification.
  //   - If the user's intent is not clear, clarify with the user.
  //   - When you use tracker_createCard or tracker_updateCard, you MUST always include the "finishes" object. This also applies to calling tracker_batch with create or update operations included.
  // `
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

async function sendMessage(req, res) {
  const userInput = req.body.message;
  let incomingMessages = req.body.messages || [];
  

  //Set up streaming response headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ step: "Initializing OpenAI client..." })}\n\n`);
  await ensureOpenAIClient();
  incomingMessages = Array.isArray(incomingMessages) ? incomingMessages : [];
  // Clean-up Step 1: Remove the details from scryfall if they exist.
  if (
    incomingMessages.length > 0 &&
    incomingMessages[incomingMessages.length - 1].role === "assistant" &&
    Array.isArray(incomingMessages[incomingMessages.length - 1].content) &&
    incomingMessages[incomingMessages.length - 1].content.every(obj => typeof obj === "object" && obj !== null)
  ) {
    incomingMessages.pop();
  }
  // Clean-up Step 2: Remove the system message at index 0.
  if (incomingMessages.length > 0 && incomingMessages[0].role === "system") {
    incomingMessages.shift();
  }
  // Clean-up Step 3: Remove any consecutive duplicate user messages (keep the latest)
    if (incomingMessages.length > 0 && incomingMessages[0].role === "developer") {
    incomingMessages.shift();
  }
  // Preserve only the last 5 user and assistant messages
  const preservedMessages = [];
  let count = 0;
  for (let i = incomingMessages.length - 1; i >= 0 && count < 5; i--) {
    const m = incomingMessages[i];
    if (m.role === "user" || m.role === "assistant") {
      preservedMessages.unshift(m);
      count++;
    }
  }
  // Add back any non-user/assistant messages (e.g., function_call, function_call_output)
  const otherMessages = incomingMessages.filter(
    m => m.role !== "user" && m.role !== "assistant"
  );
  incomingMessages = [...otherMessages, ...preservedMessages];

  //res.write(`data: ${JSON.stringify({ step: "Classifying step..." })}\n\n`);
  //let intent = await classifyStep(userInput, incomingMessages); 
  //res.write(`data: ${JSON.stringify({ step: intent === 1 ? "Step 1: finding cards" : "Step 2: manage card in collection" })}\n\n`);
  res.write(`data: ${JSON.stringify({ step: "Preparing tools and context..." })}\n\n`);
  
  let tools = [];
  //Get tool set based on whether we already have scryfall results:
  for (let i = incomingMessages.length - 1; i >= 0; i--) {
    const m = incomingMessages[i];
    if (
      ((m.type === "function_call" && m.name === "scryfall_search") ||
      (m.type === "function_call_output" && incomingMessages.find(msg => msg.call_id === m.call_id && msg.name === "scryfall_search")))
    ) {
      //We have a scryfall_search call or output, set tools to "full" and break
      tools = await getTools("full");
      break;
    } else {
      tools = await getTools("full"); //await getTools("search");
    }
  }
  if (tools.length === 0) {
    tools = await getTools("full"); //await getTools("search");
  }
  // Determine which system prompt to use (step 1 or 2)
  let systemContent = systemContentMap["1"];

  //let systemContent = systemContentMap[intent] || "You are a helpful assistant.";

  res.write(`data: ${JSON.stringify({ step: "Setting up conversational context..." })}\n\n`);
  let messages = [
    { role: "system", content: systemContent },
    { role: "developer", content: "Do not explain or announce your actions. When a tool call is required, invoke the tool immediately without prefacing it with text like 'I'll search for' or 'Please hold on'." },
    ...incomingMessages,
    { role: "user", content: userInput },
  ];
  // --- Initial assistant call using Responses API ---
  res.write(`data: ${JSON.stringify({ step: "Contacting OpenAI..." })}\n\n`);
  const stream = client.responses.stream({
    model: "gpt-4o-mini",
    input: messages,
    tools: tools,
    tool_choice: "auto",
    temperature: 0.2,
    stream: true
  });

  for await (const event of stream) {
    //fs.appendFileSync('streamHandler.log', JSON.stringify(event) + '\n');
    if (event.type === "response.output_item.added") {
      if (event.item.type === "file_search_call") { 
        res.write(`data: ${JSON.stringify({ step: "Searching Vector Stores for card and/or rules information." })}\n\n`);
      }
      if (event.item.type === "function_call") {
        res.write(`data: ${JSON.stringify({ step: `Executing ${event.item.name}` })}\n\n`);
      }
    } else if (event.type === "response.function_call_arguments.done") {
      res.write(`data: ${JSON.stringify({ step: `Passing arguments: ${event.arguments}` })}\n\n`);
    } else if (event.type === "response.completed") {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    }
  }

  let response = await stream.finalResponse();
  //res.write(`data: ${JSON.stringify({ response })}\n\n`);
  res.write(`data: ${JSON.stringify({ step: "Processing response..." })}\n\n`);
  response.output = response.output.map(item => {
    if (item.type === "function_call" && "parsed_arguments" in item) {
      // Remove only the parsed_arguments field, keep everything else unchanged
      const { parsed_arguments, ...rest } = item;
      return rest;e
    }
    return item;
  });

  let assistantMessage = response.output?.find(o => o.type === "message");
  if (assistantMessage) messages.push(assistantMessage);
  
  let functionCalls = response.output.filter(o => o.type === "function_call");
  while (functionCalls.length > 0) {
    res.write(`data: ${JSON.stringify({ step: "Executing tools..." })}\n\n`);
    let lastToolName = null;
    let lastScryfallResult = [];
    for (const fc of functionCalls) {
      messages.push(fc);
      const toolName = fc.name;
      lastToolName = fc.name;
      const args = fc.arguments ? JSON.parse(fc.arguments) : {};
      res.write(`data: ${JSON.stringify({ step: `Executing tool: ${toolName} with arguments: ${JSON.stringify(args)}` })}\n\n`);
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
        res.write(`data: ${JSON.stringify({ step: `scryfall_search returned ${Array.isArray(result.summary) ? result.summary.length : 0} results` })}\n\n`);
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
        res.write(`data: ${JSON.stringify({ step: `${toolName} execution completed` })}\n\n`);
        messages.push({
          call_id: fc.call_id,
          type: "function_call_output",
          output: typeof result === "string" ? result : JSON.stringify(result)
        });
        messages.push({ role: "developer", content: "You have just completed a tracker_ operation. Do not assume the user has uploaded any data, or mention file uploads. Just summarize what was done, or ask what to do next instead." });
      }

      // Allow tracker tools when we have a scryfall search result:
      if (toolName === "scryfall_search" && Array.isArray(result.summary) && result.summary.length > 0) {
        tools = await getTools("full");
      }
      //console.log("Messages after tool executions:", messages);
    }

    // We have scryfall results for the user to pick from, so we do not call OpenAI yet.
    if (lastToolName === "scryfall_search" && Array.isArray(lastScryfallResult.summary) && lastScryfallResult.summary.length > 1) {
      messages.push({
          "role": "assistant",
          "content": lastScryfallResult.details
        });
      functionCalls = [];
    } else {
      res.write(`data: ${JSON.stringify({ step: "Contacting OpenAI for follow-up..." })}\n\n`);
      const followupStream = await client.responses.stream({
        model: "gpt-4o-mini",
        input: messages,
        tools: tools, 
        tool_choice: "auto",
        temperature: 0.2,
        stream: true
      });

      for await (const event of followupStream) {
        //fs.appendFileSync('streamHandler.log', JSON.stringify(event) + '\n');
        if (event.type === "response.output_item.added") {
          if (event.item.type === "file_search_call") {
            res.write(`data: ${JSON.stringify({ step: "Searching Vector DB for card information." })}\n\n`);
          }
          if (event.item.type === "function_call") {
            res.write(`data: ${JSON.stringify({ step: `Executing ${event.item.name}` })}\n\n`);
          }
        } else if (event.type === "response.function_call_arguments.done") {
          res.write(`data: ${JSON.stringify({ step: `Passing arguments: ${event.arguments}` })}\n\n`);
        } else if (event.type === "response.completed") {
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        }
      }

      let followupResponse = await followupStream.finalResponse();
      res.write(`data: ${JSON.stringify({ step: "Processing response..." })}\n\n`);
      
      followupResponse.output = followupResponse.output.map(item => {
        if (item.type === "function_call" && "parsed_arguments" in item) {
        // Remove only the parsed_arguments field, keep everything else unchanged
          const { parsed_arguments, ...rest } = item;
          return rest;
        }
        return item;
      });
     
      // Extract assistant messages and next function calls
      const newAssistantMessages = followupResponse.output.filter(o => o.type === "message");
      messages.push(...newAssistantMessages);
      functionCalls = followupResponse.output.filter(o => o.type === "function_call");
    }
  }
  res.write(`data: ${JSON.stringify({ step: "Finalizing response..." })}\n\n`);
  res.write(`data: ${JSON.stringify(messages)}` + '\n\n');
  res.end();
  //return { messages };
}


module.exports = { sendMessage};