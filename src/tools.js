const Swagger = require('swagger-client');

const scryfallTool = [
{
  "type": "function",
  "function": {
    "name": "scryfall_search",
    "description": "Search Magic: The Gathering cards on Scryfall using different filters (name, color, oracle text, etc.). Returns possible card printings.",
    "parameters": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Card name (exact or partial). Example: 'Stomping Ground'."
        },
        "oracle_text": {
          "type": "string",
          "description": "Filter by words in rules text (Oracle text). Example: 'proliferate'."
        },
        "colors": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": ["W", "U", "B", "R", "G"]
          },
          "description": "Restrict results to specific colors. Example: ['R', 'G']."
        },
        "set": {
          "type": "string",
          "description": "Optional set code or name, e.g. 'GPT' or 'Guildpact'."
        },
        "page": {
          "type": "integer",
          "description": "Results page number (default = 1)."
        },
        "order": {
          "type": "string",
          "enum": ["name", "set", "released", "rarity", "color", "usd", "tix", "eur", "cmc", "power", "toughness", "edhrec", "penny", "artist"],
          "description": "Sort order. Default: 'name'."
        },
        "dir": {
          "type": "string",
          "enum": ["auto", "asc", "desc"],
          "description": "Sort direction."
        }
      }
    }
  }
}
]

const singlecardTool = [
{
  "type": "function",
  "function": {
    "name": "local_singlecard",
    "description": "Call this function when a single card printing has been unambiguously identified. Store the set code, collector number, and image URL, to transition to the next phase.",
    "parameters": {
      "type": "object",
      "properties": {
        "set_code": {
          "type": "string",
          "description": "Card set code (e.g. 'GPT')."
        },
        "collector_number": {
          "type": "string",
          "description": "Card collector number (e.g. '123')."
        },
        "image_url": {
          "type": "string",
          "description": "URL of the normal card image."
        }
      },
      "required": ["set_code", "collector_number", "image_url"]
    }
  }
}
]

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
          if (param.in === "body" && param.schema) {
            bodySchema = param.schema;
          } else {
            paramProps[param.name] = {
              type: param.schema?.type || "string",
              description: param.description || ""
            };
            if (param.required) requiredParams.push(param.name);
          }
        });

        // If body schema exists, add it as a 'body' property
        if (bodySchema) {
          paramProps.body = bodySchema;
          requiredParams.push("body");
        }

        functions.push({
          type: "function",
          function: {
            name: details.operationId ? `tracker_${details.operationId}` : `tracker_${method}_${path.replace(/[\/{}]/g, "_")}`,
            description: details.description || `Tracker API call for ${method.toUpperCase()} ${path}`,
            parameters: {
              type: "object",
              properties: paramProps,
              required: requiredParams
            }
          }
        });
      }
    }
    console.log("Fetched tracker functions:", functions);
    return functions;
  } catch (err) {
    return [];
  }
}

module.exports = { scryfallTool, singlecardTool, fetchTrackerFunctions };



