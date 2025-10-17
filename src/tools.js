const Swagger = require('swagger-client');

const scryfallTool = [
  {
    type: "function",
    name: "scryfall_search",
    description: "Search Magic: The Gathering cards on Scryfall using different filters (name, color, oracle text, etc.). Returns possible card printings.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Card name (exact or partial). Example: 'Stomping Ground'."
        },
        type: {
          type: "string",
          description: "Filter by card type. Examples: 'creature', 'instant', 'sorcery', 'enchantment', 'artifact', 'planeswalker', 'land'."
        },
        reserved: {
          type: "boolean",
          description: "Set to true to restrict results to only cards on the Reserved List."
        },
        oracle_text: {
          type: "string",
          description: "Filter by words in rules text (Oracle text). Examples: 'proliferate', 'flying', 'vigilance'."
        },
        colors: {
          type: "array",
          items: {
            type: "string",
            enum: ["W", "U", "B", "R", "G"]
          },
          description: "Restrict results to specific color cards. W=White, U=Blue, B=Black, R=Red, G=Green. Multiple colors can be specified. Example: ['R', 'G']. The user should explicitly mention these colors. Note that if the user mentions colors for a card that is of type land, the user is wrong and you should not pass colors to the tool."
        },
        set: {
          type: "string",
          description: "Optional set code or name, e.g. 'GPT' or 'Guildpact' as mentioned by the user."
        },
        page: {
          type: "integer",
          description: "Results page number"
        },
        order: {
          type: "string",
          enum: ["name", "set", "released", "rarity", "color", "usd", "tix", "eur", "cmc", "power", "toughness", "edhrec", "penny", "artist"],
          description: "Sort order. Default: 'name'."
        },
        dir: {
          type: "string",
          enum: ["auto", "asc", "desc"],
          description: "Sort direction."
        }
      },
      additionalProperties: false
    }
  }
];

const vectorStoreTool = [
  {
    type: "file_search",
    vector_store_ids: ["vs_68e4d320b04c8191a374759b35b2376d","vs_68f1231a32488191b7e63671b8b8b264"]
  }
]

// const singlecardTool = [
//   {
//     type: "function",
//     name: "local_singlecard",
//     description: "Call this function when a single card printing has been unambiguously identified. Store the set code, collector number, and image URL, to transition to the next phase.",
//     parameters: {
//       type: "object",
//       properties: {
//         set_code: {
//           type: "string",
//           description: "Card set code (e.g. 'GPT')."
//         },
//         collector_number: {
//           type: "string",
//           description: "Card collector number (e.g. '123')."
//         }
//       },
//       required: ["set_code", "collector_number"]
//     }
//   }
// ];

async function fetchTrackerFunctions() {
  const apiUrl = process.env.MTG_BACKEND_API_URL;
  const swaggerUrl = `${apiUrl}/api-docs/swagger.json`;
  try {
    const client = await Swagger(swaggerUrl);
    const paths = client.spec.paths;
    const functions = [];
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, details] of Object.entries(methods)) {
        // Collect parameters by location
        const paramProps = {};
        let requiredParams = [];
        let bodySchema = null;

        (details.parameters || []).forEach(param => {
          paramProps[param.name] = {
            type: param.schema?.type || "string",
            description: param.description || ""
          };
          if (param.required) requiredParams.push(param.name);
        });

        if (details.requestBody?.content?.["application/json"]?.schema) {
          const bodySchema = details.requestBody.content["application/json"].schema;
          Object.assign(paramProps, bodySchema.properties || {});
          if (bodySchema.required) {
            requiredParams.push(...bodySchema.required);
          }
        }

        functions.push({
          type: "function",
          name: details.operationId ? `tracker_${details.operationId}` : `tracker_${method}_${path.replace(/[\/{}]/g, "_")}`,
          description: details.description || `Tracker API call for ${method.toUpperCase()} ${path}`,
          parameters: {
            type: "object",
            properties: paramProps,
            required: requiredParams
          }
        });
      }
    }
    //console.log("Fetched tracker functions:", JSON.stringify(functions, null, 2));
    return functions;
  } catch (err) {
    return [];
  }
}

module.exports = { scryfallTool, vectorStoreTool, fetchTrackerFunctions };



